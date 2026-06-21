const { Client, StageChannel } = require("discord.js-selfbot-v13");
const { Streamer, prepareStream, playStream, Utils, Encoders } = require("@dank074/discord-video-stream");
const config = require("./config.json");

const client = new Client({ checkUpdate: false });
const streamer = new Streamer(client);

process.on("message", async playbackCtx => {
  console.debug("[stream-child] Received playbackCtx:", playbackCtx);

  let failed = false;
  try {
    await client.login(config.token);
    console.debug("[stream-child] Logged in");

    const { guildId, channelId } = playbackCtx.voiceChannel;
    console.debug("[stream-child] Joining VC", guildId, channelId);
    // Safety bound: a normal join resolves in ~1s. If Discord ever changes the
    // voice protocol again (e.g. the DAVE/4017 enforcement that broke v5), the
    // handshake can hang forever — fail loudly after 60s instead of wedging.
    await Promise.race([
      streamer.joinVoice(guildId, channelId),
      new Promise((_, rej) => setTimeout(() => rej(new Error("joinVoice timed out after 60s (voice gateway handshake never completed)")), 60000))
    ]);

    const vc = streamer.client.user.voice.channel;
    if (vc instanceof StageChannel) {
      await client.user.voice?.setSuppressed(false);
    }

    const season = playbackCtx.currentSeason + 1;
    const episode = playbackCtx.currentEpisode + 1;
    const item = playbackCtx.seasons[playbackCtx.currentSeason].episodes[playbackCtx.currentEpisode];
    console.debug(`[stream-child] Streaming S${season}E${episode}:`, item.title);

    // NOTE: do NOT call streamer.signalVideo() here. That signals a *camera*
    // feed (self_video=true) and suppresses the Go-Live tile. For go-live,
    // playStream({type:"go-live"}) calls streamer.createStream()/signalStream()
    // internally, which is the correct signal. (See Streamer.js: signalVideo
    // takes a single boolean; the old 3-arg call passed guildId as the flag.)

    // Encoder selection: NVENC (P600 GPU) when config.streamOpts.nvenc is true,
    // else software x264. Flip the config flag to fall back to CPU if the GPU
    // passthrough ever breaks. P600 is a Quadro = no NVENC session limit.
    const useNvenc = config.streamOpts.nvenc === true;
    const encoder = useNvenc
      ? Encoders.nvenc({ preset: "p4", spatialAq: true })
      : Encoders.software({ x264: { preset: "superfast", tune: "film" } });
    console.debug("[stream-child] encoder:", useNvenc ? "h264_nvenc (GPU)" : "libx264 (CPU)");

    const controller = new AbortController();
    const { command, output } = prepareStream(
      item.filePath,
      {
        width: config.streamOpts.width,
        height: config.streamOpts.height,
        frameRate: config.streamOpts.fps,
        bitrateVideo: config.streamOpts.bitrateKbps,
        bitrateVideoMax: config.streamOpts.maxBitrateKbps,
        hardwareAcceleratedDecoding: config.streamOpts.hardware_acceleration,
        videoCodec: Utils.normalizeVideoCodec(config.streamOpts.videoCodec),
        encoder,
        includeAudio: true,
        bitrateAudio: config.audioBitrateKbps
      },
      controller.signal
    );

    command.on("start", cmdLine => console.debug("[stream-child][ffmpeg] start:", cmdLine));
    command.on("error", err => console.error("[stream-child][ffmpeg] error:", err));
    command.on("end", () => console.debug("[stream-child][ffmpeg] end"));

    console.debug("[stream-child] Calling playStream (go-live)");
    await playStream(output, streamer, { type: "go-live" }, controller.signal);
    console.debug("[stream-child] playStream completed");

  } catch (err) {
    console.error("[stream-child] Uncaught error:", err);
    failed = true;            // signal parent: abnormal end (join/login/ffmpeg fail) -> suppress autoplay
  } finally {
    try {
      console.debug("[stream-child] Cleaning up");
      streamer.stopStream();
      streamer.leaveVoice();
    } catch (e) {
      console.error("[stream-child] Cleanup error:", e);
    }
    // Exit 0 only when playStream resolved normally (clean EOF -> parent may autoplay);
    // exit 1 when the try threw, so the parent never autoplays after a crash.
    console.debug("[stream-child] Exiting code", failed ? 1 : 0);
    process.exit(failed ? 1 : 0);
  }
});
