const path = require("path");
const { Client, StageChannel } = require("discord.js-selfbot-v13");
const { Streamer, prepareStream, demux, Utils, Encoders } = require("@dank074/discord-video-stream");
const config = require("./config.json");

// VideoStream/AudioStream aren't in the package's public `exports` map, but an
// absolute-path require bypasses the exports gate (Node 22). We need them to pipe
// media directly into an already-open Go-Live connection — the whole point of
// this rewrite — instead of letting playStream() create+tear-down a tile per file.
const MEDIA_DIR = path.join(__dirname, "node_modules/@dank074/discord-video-stream/dist/media");
const { VideoStream } = require(path.join(MEDIA_DIR, "VideoStream.js"));
const { AudioStream } = require(path.join(MEDIA_DIR, "AudioStream.js"));

const client = new Client({ checkUpdate: false });
const streamer = new Streamer(client);

let conn = null;            // the persistent Go-Live StreamConnection (createStream once)
let curController = null;   // AbortController for the currently-playing item's ffmpeg
let curVStream = null;      // current VideoStream writer (into `conn`)
let curAStream = null;      // current AudioStream writer (into `conn`)
let playGen = 0;            // generation counter; every play/stop bumps it to invalidate stale work

function send(msg) { try { process.send(msg); } catch (e) {} }

// Packetizer must match the codec we ENCODE to (config.streamOpts.videoCodec),
// since that's what the demuxer sees coming back out of ffmpeg.
function packetizerFor(codec) {
  switch ((codec || "h264").toLowerCase()) {
    case "h265": case "hevc": return "H265";
    case "vp8": return "VP8";
    case "vp9": return "VP9";
    case "av1": return "AV1";
    default: return "H264";
  }
}

function buildEncoder() {
  // NVENC (P600 GPU) when config.streamOpts.nvenc is true, else software x264.
  // P600 is a Quadro = no NVENC session limit. Flip the flag to force CPU fallback.
  return config.streamOpts.nvenc === true
    ? Encoders.nvenc({ preset: "p4", spatialAq: true })
    : Encoders.software({ x264: { preset: "superfast", tune: "film" } });
}

// Cut the currently-playing item WITHOUT touching the Go-Live connection: abort
// its ffmpeg and destroy its media writers. The tile + voice stay up.
function stopCurrentMedia() {
  playGen++;  // any in-flight playItem for the old generation will bail
  if (curController) { try { curController.abort(); } catch (e) {} curController = null; }
  if (curVStream) { try { curVStream.destroy(); } catch (e) {} curVStream = null; }
  if (curAStream) { try { curAStream.destroy(); } catch (e) {} curAStream = null; }
  // Announce the video track as stopped (video_ssrc:0). playItem() re-announces it
  // (off->on) once the next episode's frames are ready. Without this off->on cycle,
  // Discord clients keep the old video SSRC marked "active" while the RTP actually
  // gapped, so their decoder stalls and freezes on the last frame until a manual
  // exit/rejoin. The audio SSRC is never toggled, so audio plays straight through.
  if (conn) { try { conn.mediaConnection.setVideoAttributes(false); } catch (e) {} }
}

// Log in, join voice, and open the Go-Live stream — ONCE per child lifetime.
async function ensureSession(ctx) {
  if (conn) return;
  await client.login(config.token);
  console.debug("[stream-child] Logged in");
  const { guildId, channelId } = ctx.voiceChannel;
  console.debug("[stream-child] Joining VC", guildId, channelId);
  // Safety bound: a normal join resolves in ~1s. If Discord changes the voice
  // protocol again (cf. the DAVE/4017 enforcement), fail loudly after 60s.
  await Promise.race([
    streamer.joinVoice(guildId, channelId),
    new Promise((_, rej) => setTimeout(() => rej(new Error("joinVoice timed out after 60s")), 60000))
  ]);
  const vc = streamer.client.user.voice.channel;
  if (vc instanceof StageChannel) {
    await client.user.voice?.setSuppressed(false);
  }
  // Open the Go-Live tile exactly once. We reuse this `conn` for every episode,
  // which is what keeps the watch-together alive across transitions.
  conn = await streamer.createStream();
  console.debug("[stream-child] Go-Live stream created (persistent)");
}

// Stream one file into the existing `conn`. Resolves nothing; signals the parent
// via "started" / "ended" / "failed" IPC messages. Mirrors the core of the
// library's playStream() but WITHOUT createStream()/stopStream() around it.
async function playItem(item) {
  const myGen = ++playGen;  // claim this generation
  const controller = new AbortController();
  curController = controller;

  const useNvenc = config.streamOpts.nvenc === true;
  console.debug(`[stream-child] Streaming S? "${item.title}" via`, useNvenc ? "h264_nvenc" : "libx264");

  const { command, output } = prepareStream(item.filePath, {
    width: config.streamOpts.width,
    height: config.streamOpts.height,
    frameRate: config.streamOpts.fps,
    bitrateVideo: config.streamOpts.bitrateKbps,
    bitrateVideoMax: config.streamOpts.maxBitrateKbps,
    hardwareAcceleratedDecoding: config.streamOpts.hardware_acceleration,
    videoCodec: Utils.normalizeVideoCodec(config.streamOpts.videoCodec),
    encoder: buildEncoder(),
    includeAudio: true,
    bitrateAudio: config.audioBitrateKbps
  }, controller.signal);

  let ffmpegErrored = false;
  command.on("start", c => console.debug("[stream-child][ffmpeg] start:", c));
  command.on("error", err => {
    // Aborting (switching/stop) kills ffmpeg and surfaces as an error — ignore those.
    if (controller.signal.aborted || myGen !== playGen) return;
    ffmpegErrored = true;
    console.error("[stream-child][ffmpeg] error:", err && err.message ? err.message : err);
  });
  command.on("end", () => console.debug("[stream-child][ffmpeg] end"));

  let video, audio;
  try {
    ({ video, audio } = await demux(output, { format: "nut" }));
  } catch (err) {
    if (controller.signal.aborted || myGen !== playGen) return;
    console.error("[stream-child] demux failed:", err && err.message ? err.message : err);
    return send({ type: "failed", title: item.title });
  }
  if (myGen !== playGen) return;  // superseded while demuxing — drop it
  if (!video) return send({ type: "failed", title: item.title });

  conn.setPacketizer(packetizerFor(config.streamOpts.videoCodec));
  conn.mediaConnection.setSpeaking(true);
  conn.mediaConnection.setVideoAttributes(true, {
    width: config.streamOpts.width,
    height: config.streamOpts.height,
    fps: config.streamOpts.fps
  });

  const vStream = new VideoStream(conn);
  curVStream = vStream;
  video.stream.pipe(vStream);
  if (audio) {
    const aStream = new AudioStream(conn);
    curAStream = aStream;
    audio.stream.pipe(aStream);
    vStream.syncStream = aStream;
  }

  send({ type: "started", title: item.title });

  vStream.once("finish", () => {
    // Switched away (abort / newer item) -> not a real end; the parent already moved on.
    if (controller.signal.aborted || myGen !== playGen) return;
    if (ffmpegErrored) return send({ type: "failed", title: item.title });
    console.debug("[stream-child] item finished (EOF):", item.title);
    send({ type: "ended", title: item.title });
  });
}

function shutdown(code = 0) {
  stopCurrentMedia();
  try { if (conn) streamer.stopStream(); } catch (e) {}
  try { streamer.leaveVoice(); } catch (e) {}
  console.debug("[stream-child] Shutting down, code", code);
  process.exit(code);
}

process.on("message", async cmd => {
  if (!cmd || typeof cmd !== "object") return;
  try {
    if (cmd.type === "play") {
      await ensureSession(cmd.ctx);
      stopCurrentMedia();      // cut any current item (tile stays up)
      await playItem(cmd.item);
    } else if (cmd.type === "stop") {
      shutdown(0);
    }
  } catch (err) {
    console.error("[stream-child] fatal:", err && err.message ? err.message : err);
    // Couldn't even establish the session -> exit so the parent reports failure.
    if (!conn) {
      send({ type: "failed", title: cmd && cmd.item && cmd.item.title, fatal: true });
      process.exit(1);
    }
    send({ type: "failed", title: cmd && cmd.item && cmd.item.title });
  }
});
