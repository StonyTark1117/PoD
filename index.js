const { fork } = require("child_process");
const path = require("path");
const http = require("http");
const { Client } = require("discord.js-selfbot-v13");
const axios = require("axios");
const config = require("./config.json");

const COMMANDS = ["!pplay", "!pnext", "!pback", "!pstop", "!pqp", "!pautoplay"];

// Discord reserves "/" for native (bot-application) slash commands, which a
// selfbot/user account can't register — so we stay on "!" and provide a help
// listing for discoverability instead.
const HELP_ALIASES = ["!phelp", "!help", "!pcommands", "!pcmds", "!pod"];
const HELP_TEXT = [
  "🎬 **PoD — Plex on Discord** · available commands:",
  "",
  "▶️ `!pplay <title>` — search Plex & start streaming (movies or TV).",
  "  ↳ understands episodes & years: `!pplay house s3e1`, `!pplay dune (2021)`",
  "⏭️ `!pnext`  ·  ⏮️ `!pback` — next / previous episode (TV shows).",
  "🔢 `!pqp <season>-<episode>` — jump to a specific episode, e.g. `!pqp 2-5`.",
  "📺 `!pautoplay on|off` — auto-advance to the next episode when one ends (default on).",
  "⏹️ `!pstop` — stop streaming & disconnect.",
  "❓ `!phelp` — show this list.",
  "",
  "_Tip: join a voice channel before `!pplay`._"
].join("\n");

// When a TV episode finishes cleanly, optionally roll into the next episode.
// Runtime-mutable via !pautoplay on/off; default comes from config (off if unset).
// Off by default so an unattended crash/disconnect can't burn through a whole show.
let autoplay = config.autoplay === true;
// Suppress autoplay if a "clean" exit happened suspiciously fast (real episodes
// run far longer than this) — a second guard against crash-loops even if the
// child reports success after a mid-stream failure.
const MIN_PLAY_MS = 90 * 1000;

// --- Plex search ---------------------------------------------------------
// /hubs/search is the punctuation-tolerant, app-style ranked search; the old
// /search endpoint required near-exact titles (e.g. "batman bad blood" -> 0,
// only "batman: bad blood" matched). We hub-search, fall back to a per-section
// title substring scan, then rank by how well each title matches the query.
const plexGet = (p, params = {}) =>
  axios.get(`${config.plex.host}${p}`, {
    params: { ...params, "X-Plex-Token": config.plex.token },
    headers: { Accept: "application/json" }
  }).then(r => r.data);

const PLAYABLE = new Set(["movie", "show", "season", "episode"]);
const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Pull an episode target (SxxExx / sN eN / NxNN) and a parenthesized (YYYY)
// disambiguator out of the query so "house s3e1" / "house (2004)" find the show.
// We only strip YEARS in parentheses — bare years can be real titles (e.g. "1917",
// "Blade Runner 2049"), so those are left in the search text.
function parseQuery(rawQuery) {
  let q = rawQuery;
  let epTarget = null;
  const m = q.match(/\b[sS](\d{1,2})\s*[eExX](\d{1,3})\b/) ||
            q.match(/(?:^|\s)(\d{1,2})x(\d{1,3})(?=\s|$)/);
  if (m) {
    epTarget = { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
    q = q.replace(m[0], " ");
  }
  q = q.replace(/\(\s*(?:19|20)\d{2}\s*\)/g, " ").replace(/\s+/g, " ").trim();
  return { query: q || rawQuery.trim(), epTarget };
}

function matchScore(title, query) {
  const t = norm(title), q = norm(query);
  if (!t || !q) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.includes(q)) return 60;
  const qt = q.split(" ").filter(Boolean);
  const hits = qt.filter(w => t.includes(w)).length;
  return qt.length ? (hits / qt.length) * 40 : 0;
}

let _sections = null;
async function playableSections() {
  if (_sections) return _sections;
  const d = await plexGet("/library/sections");
  _sections = (d.MediaContainer?.Directory || [])
    .filter(s => s.type === "movie" || s.type === "show")
    .map(s => s.key);
  return _sections;
}

// Returns playable Plex items ranked best-match first ([] if none).
async function searchPlex(query) {
  // Strip punctuation -> spaces so e.g. "batman:bad blood" matches "Batman: Bad Blood".
  const sq = query.replace(/[^a-zA-Z0-9\s]+/g, " ").replace(/\s+/g, " ").trim() || query;
  let items = [];
  try {
    const d = await plexGet("/hubs/search", { query: sq, limit: 30 });
    items = (d.MediaContainer?.Hub || []).flatMap(h => h.Metadata || []);
  } catch (e) { console.debug("[debug] hubs/search error:", e.message); }
  console.debug("[debug] hubs/search returned", items.length);

  if (!items.some(i => PLAYABLE.has(i.type))) {
    for (const key of await playableSections()) {
      try {
        const d = await plexGet(`/library/sections/${key}/all`, { title: sq });
        items.push(...(d.MediaContainer?.Metadata || []));
      } catch (e) { /* ignore section error */ }
    }
    console.debug("[debug] section fallback total", items.length);
  }

  const seen = new Set();
  return items
    .filter(i => PLAYABLE.has(i.type))
    .filter(i => (i.ratingKey && !seen.has(i.ratingKey)) ? seen.add(i.ratingKey) : !i.ratingKey)
    .map((i, idx) => ({
      i, idx,
      score: matchScore(i.title, query) + (i.type === "movie" || i.type === "episode" ? 3 : 0)
    }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .map(x => x.i);
}

// When nothing matches the whole query, find titles matching individual words
// so we can suggest alternatives (e.g. "dark knight" -> "Batman: Gotham Knight",
// "Transformers: The Last Knight"). Ranked by how many query words each contains.
async function suggestPlex(query) {
  const tokens = [...new Set(
    query.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(w => w.length >= 3)
  )];
  if (!tokens.length) return [];
  const pool = new Map();
  for (const key of await playableSections()) {
    for (const tok of tokens) {
      try {
        const d = await plexGet(`/library/sections/${key}/all`, { title: tok });
        for (const m of (d.MediaContainer?.Metadata || [])) {
          if (PLAYABLE.has(m.type) && m.ratingKey) pool.set(m.ratingKey, m);
        }
      } catch (e) { /* ignore */ }
    }
  }
  return [...pool.values()]
    .map(m => {
      const t = norm(m.title);
      // weight by summed length of matched tokens: rewards both matching more
      // words and matching longer/rarer ones (e.g. "knight" > "dark").
      const weight = tokens.filter(w => t.includes(w)).reduce((s, w) => s + w.length, 0);
      return { m, weight };
    })
    .filter(x => x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.m.title.length - b.m.title.length)
    .slice(0, 5)
    .map(x => x.m);
}
// -------------------------------------------------------------------------

let playbackCtx = null;
let streamProcess = null;

// ---- Persistent stream child --------------------------------------------
// One long-lived stream-child holds the Discord voice connection + Go-Live
// session open for the whole session. We feed it episodes over IPC instead of
// respawning per episode, so autoplay / !pnext / !pqp swap media WITHOUT tearing
// down the Go-Live tile — viewers never have to rejoin the watch-together.
let childChannelId = null;   // voice channel the live child is joined to
let childStopping = false;   // true when WE asked the child to stop (vs. a crash)
let lastStartedAt = 0;       // when the current item actually began playing

// The episode currently selected in playbackCtx, as a child "play" payload.
function currentItem() {
  const s = playbackCtx.seasons[playbackCtx.currentSeason];
  const ep = s.episodes[playbackCtx.currentEpisode];
  const S = s.seasonIndex ?? (playbackCtx.currentSeason + 1);
  const E = ep.epIndex ?? (playbackCtx.currentEpisode + 1);
  return { filePath: ep.filePath, title: ep.title, S, E };
}

function attachChild(child) {
  child.on("message", m => {
    if (!m || typeof m !== "object") return;
    if (m.type === "started") {
      lastStartedAt = Date.now();
      console.debug("[child] started:", m.title);
    } else if (m.type === "ended") {
      onItemEnded();
    } else if (m.type === "failed") {
      onItemFailed(m);
    }
  });
  child.on("exit", (code, sig) => {
    console.debug(`[debug] stream-child exited code=${code} signal=${sig}`);
    const wasStopping = childStopping;
    if (child === streamProcess) { streamProcess = null; childChannelId = null; }
    childStopping = false;
    // An exit we didn't request = the child crashed. Don't autoplay; tell the channel.
    if (!wasStopping) notify(playbackCtx, "⚠️ Stream process crashed — use !pplay to restart.");
  });
}

function ensureChild() {
  if (streamProcess) return streamProcess;
  console.debug("[debug] Forking persistent stream-child");
  const child = fork(
    path.join(__dirname, "stream-child.js"),
    [],
    { stdio: ["inherit","inherit","inherit","ipc"] }
  );
  streamProcess = child;
  childStopping = false;
  attachChild(child);
  return child;
}

// Play the currently-selected episode on the live child (seamless), forking a
// child first if none is running.
function sendPlay() {
  if (!playbackCtx) return;
  const item = currentItem();
  const child = ensureChild();
  childChannelId = playbackCtx.voiceChannel.channelId;
  console.debug(`[debug] -> play S${item.S}E${item.E}: ${item.title}`);
  child.send({ type: "play", ctx: { voiceChannel: playbackCtx.voiceChannel }, item });
}

// Gracefully stop + disconnect the child (it tears down voice/Go-Live and exits).
function stopChild() {
  if (!streamProcess) return;
  childStopping = true;
  try { streamProcess.send({ type: "stop" }); }
  catch (e) { try { streamProcess.kill("SIGKILL"); } catch (e2) {} }
  streamProcess = null;
  childChannelId = null;
}

// Advance playback by `delta` episodes, walking across season boundaries.
// Mutates playbackCtx on success. Returns {ok, S, E, title} or {ok:false} at the ends.
function advanceCtx(delta) {
  if (!playbackCtx) return { ok: false };
  let { currentSeason: cs, currentEpisode: ce, seasons } = playbackCtx;
  ce += delta;
  if (ce < 0 && cs > 0) {
    cs--; ce = seasons[cs].episodes.length - 1;
  } else if (ce >= seasons[cs].episodes.length && cs < seasons.length - 1) {
    cs++; ce = 0;
  }
  if (cs < 0 || cs >= seasons.length ||
      ce < 0 || ce >= seasons[cs].episodes.length) {
    return { ok: false };
  }
  playbackCtx.currentSeason = cs;
  playbackCtx.currentEpisode = ce;
  const S = seasons[cs].seasonIndex ?? (cs + 1);
  const E = seasons[cs].episodes[ce].epIndex ?? (ce + 1);
  return { ok: true, S, E, title: seasons[cs].episodes[ce].title };
}

// Post a message to the text channel the last command came from (the exit
// handler has no `msg` to reply to). Best-effort; never throws into the caller.
async function notify(ctx, text) {
  try {
    const chId = ctx && ctx.textChannelId;
    if (!chId) return;
    const ch = await client.channels.fetch(chId);
    await ch.send(text);
  } catch (e) {
    console.error("[error] notify failed:", e.message);
  }
}

// The child emits "ended" ONLY on a genuine end-of-file (never when we switch
// away to another episode), so this is a clean EOF signal — no exit-code guessing.
function onItemEnded() {
  const ctx = playbackCtx;
  if (!ctx) return;
  const playedMs = Date.now() - (lastStartedAt || Date.now());
  if (!autoplay) { console.debug("[debug] item ended; autoplay off"); return; }
  // Too short to be a real episode -> treat as a glitch; don't burn through the show.
  if (playedMs < MIN_PLAY_MS) {
    console.debug(`[debug] item ended after only ${playedMs}ms — autoplay suppressed`);
    notify(ctx, `⚠️ Episode ended after only ${Math.round(playedMs/1000)}s — autoplay paused. Use !pnext to continue.`);
    return;
  }
  const adv = advanceCtx(1);
  if (!adv.ok) {
    notify(ctx, "📺 Reached the end — nothing left to autoplay.");
    return;
  }
  console.debug(`[debug] Autoplay -> S${adv.S}E${adv.E}: ${adv.title}`);
  notify(ctx, `⏭️ Up next (S${adv.S}E${adv.E}): ${adv.title}`);
  sendPlay();  // seamless — same Go-Live tile, new media
}

// Child couldn't play an item (ffmpeg/demux error). Pause autoplay; keep the
// session open so viewers stay and the user can !pnext / !pplay again.
function onItemFailed(m) {
  if (m && m.fatal) { streamProcess = null; childChannelId = null; }
  notify(playbackCtx, `⚠️ Couldn't play ${m && m.title ? `"${m.title}"` : "that item"} — autoplay paused. Try !pnext or !pplay again.`);
}

// ---- Shared playback logic (used by both ! commands and the control API) ----
// Resolve a query against Plex, build the playback context, and start streaming.
// Returns structured data (never touches Discord) so the slash-command bot and
// the !pplay text handler can both call it and format their own responses.
async function doPlay({ rawQuery, guildId, channelId, textChannelId }) {
  if (!rawQuery || !rawQuery.trim()) return { ok: false, reason: "no-query" };
  if (!guildId || !channelId) return { ok: false, reason: "no-voice" };
  const { query, epTarget } = parseQuery(rawQuery.trim());
  const { host, token } = config.plex;

  const results = await searchPlex(query);
  if (!results.length) {
    const sugg = await suggestPlex(query);
    return { ok: false, reason: "not-found", query, suggestions: sugg.map(m => ({ title: m.title, year: m.year })) };
  }

  let first = results[0];
  if (epTarget) {
    const seriesHit = results.find(r => r.type === "show" || r.type === "season" || r.type === "episode");
    if (seriesHit) first = seriesHit;
  }

  const ctx = {
    seasons: [], currentSeason: 0, currentEpisode: 0,
    textChannelId: textChannelId || null,
    voiceChannel: { guildId, channelId }
  };

  if (first.type === "movie") {
    ctx.seasons.push({ title: first.title, episodes: [{ title: first.title, filePath: first.Media[0].Part[0].file }] });
  } else {
    const showKey = first.grandparentRatingKey || first.parentRatingKey || first.ratingKey;
    const seasonsResp = await axios.get(`${host}/library/metadata/${showKey}/children`, { params: { "X-Plex-Token": token } });
    const seasons = seasonsResp.data.MediaContainer?.Metadata || [];
    for (const s of seasons) {
      const epsResp = await axios.get(`${host}/library/metadata/${s.ratingKey}/children`, { params: { "X-Plex-Token": token } });
      const eps = (epsResp.data.MediaContainer?.Metadata || []).sort((a, b) => a.index - b.index);
      const episodes = eps.map(ep => ({
        title: `${ep.grandparentTitle} S${String(ep.parentIndex).padStart(2, '0')}E${String(ep.index).padStart(2, '0')} – ${ep.title}`,
        filePath: ep.Media[0].Part[0].file,
        epIndex: ep.index
      }));
      ctx.seasons.push({ title: `Season ${s.index}`, seasonIndex: s.index, episodes });
    }
    if (epTarget) {
      const si = ctx.seasons.findIndex(s => s.seasonIndex === epTarget.season);
      const ei = si >= 0 ? ctx.seasons[si].episodes.findIndex(e => e.epIndex === epTarget.episode) : -1;
      if (si < 0 || ei < 0) return { ok: false, reason: "ep-not-found", title: first.title, epTarget };
      ctx.currentSeason = si; ctx.currentEpisode = ei;
    } else if (first.type === "episode") {
      outer: for (let si = 0; si < ctx.seasons.length; si++) {
        const eps = ctx.seasons[si].episodes;
        for (let ei = 0; ei < eps.length; ei++) {
          if (eps[ei].title.includes(first.title)) { ctx.currentSeason = si; ctx.currentEpisode = ei; break outer; }
        }
      }
    }
  }

  playbackCtx = ctx;
  const curSeason = playbackCtx.seasons[playbackCtx.currentSeason];
  const curEp = curSeason.episodes[playbackCtx.currentEpisode];
  const S = curSeason.seasonIndex ?? (playbackCtx.currentSeason + 1);
  const E = curEp.epIndex ?? (playbackCtx.currentEpisode + 1);
  if (childChannelId && childChannelId !== channelId) stopChild();
  sendPlay();
  return { ok: true, type: first.type, title: curEp.title, S, E };
}

// Skip ±1 episode and replay (seamless). Returns the new position or a reason.
function doSkip(delta) {
  if (!playbackCtx) return { ok: false, reason: "nothing" };
  const adv = advanceCtx(delta);
  if (!adv.ok) return { ok: false, reason: "end" };
  sendPlay();
  return { ok: true, S: adv.S, E: adv.E, title: adv.title };
}

// Jump to a specific REAL season/episode number (not array index).
function doJump(season, episode) {
  if (!playbackCtx) return { ok: false, reason: "nothing" };
  const si = playbackCtx.seasons.findIndex(s => (s.seasonIndex ?? -999) === season);
  const ei = si >= 0 ? playbackCtx.seasons[si].episodes.findIndex(e => (e.epIndex ?? -999) === episode) : -1;
  if (si < 0 || ei < 0) return { ok: false, reason: "not-found" };
  playbackCtx.currentSeason = si; playbackCtx.currentEpisode = ei;
  sendPlay();
  const S = playbackCtx.seasons[si].seasonIndex ?? (si + 1);
  const E = playbackCtx.seasons[si].episodes[ei].epIndex ?? (ei + 1);
  return { ok: true, S, E, title: playbackCtx.seasons[si].episodes[ei].title };
}

function nowPlaying() {
  if (!playbackCtx) return { playing: false, autoplay, live: !!streamProcess };
  const s = playbackCtx.seasons[playbackCtx.currentSeason];
  const ep = s.episodes[playbackCtx.currentEpisode];
  return {
    playing: true,
    title: ep.title,
    S: s.seasonIndex ?? (playbackCtx.currentSeason + 1),
    E: ep.epIndex ?? (playbackCtx.currentEpisode + 1),
    autoplay, live: !!streamProcess
  };
}

// Lightweight ranked search for slash-command autocomplete (Doplarr-style):
// returns top-level pickable titles with poster/summary metadata for rich cards.
async function searchSuggest(partial) {
  const { query } = parseQuery(partial || "");
  if (!query || query.length < 2) return [];
  const results = await searchPlex(query).catch(() => []);
  const seen = new Set();
  const out = [];
  for (const r of results) {
    if (r.type !== "movie" && r.type !== "show") continue;
    const key = `${(r.title || "").toLowerCase()}|${r.year || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: r.title,
      year: r.year || null,
      type: r.type,
      ratingKey: r.ratingKey || null,
      thumb: r.thumb || null,
      summary: r.summary || null
    });
    if (out.length >= 20) break;
  }
  return out;
}

// ---- Localhost control API (the slash-command bot's backend) -----------------
// Bound to 127.0.0.1 only and gated by a shared secret, so only a local
// companion process (the real Discord bot) can drive the selfbot.
function startControlApi() {
  const cfg = config.controlApi || {};
  if (!cfg.enabled) { console.debug("[control-api] disabled"); return; }
  const port = cfg.port || 8742;
  const secret = cfg.secret || "";

  const server = http.createServer(async (req, res) => {
    const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    try {
      if (secret && req.headers["x-pod-secret"] !== secret) return reply(401, { ok: false, error: "unauthorized" });
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;

      let body = {};
      if (req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString() || "{}";
        try { body = JSON.parse(raw); } catch (e) { return reply(400, { ok: false, error: "bad json" }); }
      }

      if (req.method === "GET" && p === "/health") return reply(200, { ok: true });
      if (req.method === "GET" && p === "/search") return reply(200, { ok: true, results: await searchSuggest(url.searchParams.get("q") || "") });
      if (req.method === "GET" && p === "/nowplaying") return reply(200, { ok: true, ...nowPlaying() });
      if (req.method === "POST" && p === "/play") return reply(200, await doPlay({ rawQuery: body.query, guildId: body.guildId, channelId: body.channelId, textChannelId: body.textChannelId }));
      if (req.method === "POST" && p === "/next") return reply(200, doSkip(1));
      if (req.method === "POST" && p === "/back") return reply(200, doSkip(-1));
      if (req.method === "POST" && p === "/qp") return reply(200, doJump(parseInt(body.season, 10), parseInt(body.episode, 10)));
      if (req.method === "POST" && p === "/stop") { stopChild(); return reply(200, { ok: true }); }
      if (req.method === "POST" && p === "/autoplay") { autoplay = !!body.on; return reply(200, { ok: true, autoplay }); }
      return reply(404, { ok: false, error: "not found" });
    } catch (err) {
      console.error("[control-api] error:", err && err.message ? err.message : err);
      reply(500, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });
  server.on("error", e => console.error("[control-api] server error:", e.message));
  server.listen(port, "127.0.0.1", () => console.debug(`[control-api] listening on 127.0.0.1:${port}`));
}

const client = new Client({ checkUpdate: false });

client.on("ready", () => {
  console.debug("[debug] Bot ready as", client.user.tag);
});

client.on("messageCreate", async msg => {
  console.debug("[debug] Received from", msg.author.username, "(id=" + msg.author.id + ")", ":", msg.content);
  // Never react to our own (selfbot) messages — prevents command loops on bot replies.
  if (msg.author.id === client.user.id) return;
  if (msg.author.bot) return;
  // Authorization: anyone messaging in a configured stream guild may command the bot;
  // owner IDs in acceptedAuthors are always allowed (e.g. for DM control).
  const inAllowedGuild = msg.guildId && (config.allowedGuilds || []).includes(msg.guildId);
  const isOwner = (config.acceptedAuthors || []).includes(msg.author.id);
  if (!inAllowedGuild && !isOwner) return;

  const raw = msg.content.trim();
  const cmd = COMMANDS.find(c => raw.startsWith(c));
  if (!cmd) {
    const lc = raw.toLowerCase();
    // Explicit help request -> full command menu.
    if (HELP_ALIASES.some(h => lc === h || lc.startsWith(h + " "))) {
      return msg.reply(HELP_TEXT);
    }
    // Looks like one of our commands but isn't recognized (typo) -> nudge.
    if (/^!p[a-z]/i.test(raw)) {
      return msg.reply("❓ Unknown command. Type `!phelp` to see what I can do.");
    }
    return;  // not addressed to us
  }

  console.debug("[debug] Command:", cmd);
  const voice = msg.member?.voice.channel;
  if (cmd === "!pplay" && !voice) {
    return msg.reply("⚠️ Join a voice channel first!");
  }

  try {
    if (cmd === "!pplay") {
      const rawQuery = raw.slice(cmd.length).trim();
      if (!rawQuery) return msg.reply("❌ You must specify a title.");

      // Shared with the slash-command control API — see doPlay().
      const r = await doPlay({
        rawQuery,
        guildId: voice.guild.id,
        channelId: voice.id,
        textChannelId: msg.channel.id
      });
      if (r.ok) return msg.reply(`▶️ Now playing (S${r.S}E${r.E}): ${r.title}`);
      if (r.reason === "ep-not-found") {
        return msg.reply(`❌ Found "${r.title}" but not S${r.epTarget.season}E${r.epTarget.episode}.`);
      }
      if (r.reason === "not-found") {
        if (r.suggestions && r.suggestions.length) {
          const list = r.suggestions.map(m => `• ${m.title}${m.year ? ` (${m.year})` : ""}`).join("\n");
          return msg.reply(`❓ No match for "${r.query}". Did you mean:\n${list}`);
        }
        return msg.reply(`❌ No Plex match for "${r.query}". Try fewer/simpler words.`);
      }
      return msg.reply("❌ Couldn't play that.");
    }

    else if (cmd === "!pnext" || cmd === "!pback") {
      console.debug("[debug] Skip:", cmd);
      if (!playbackCtx) return msg.reply("❌ Nothing playing.");
      const adv = advanceCtx(cmd === "!pnext" ? 1 : -1);
      if (!adv.ok) {
        return msg.reply("⚠️ No more items.");
      }
      await msg.reply(`▶️ Now playing (S${adv.S}E${adv.E}): ${adv.title}`);

      sendPlay();
    }

    else if (cmd === "!pautoplay") {
      const arg = raw.slice(cmd.length).trim().toLowerCase();
      if (arg === "on" || arg === "true" || arg === "1") autoplay = true;
      else if (arg === "off" || arg === "false" || arg === "0") autoplay = false;
      else return msg.reply(`📺 Autoplay is **${autoplay ? "on" : "off"}**. Use \`!pautoplay on\` or \`!pautoplay off\`.`);
      await msg.reply(`📺 Autoplay **${autoplay ? "on" : "off"}**.`);
    }

    else if (cmd === "!pqp") {
      console.debug("[debug] pqp select");
      const parts = raw.slice(cmd.length).trim().split("-").map(x => parseInt(x, 10));
      let si = 0, ei = parts[0] - 1;
      if (parts.length > 1) {
        si = parts[0] - 1;
        ei = parts[1] - 1;
      }
      const seasons = playbackCtx?.seasons || [];
      if (!playbackCtx || si < 0 || si >= seasons.length ||
          ei < 0 || ei >= seasons[si].episodes.length) {
        return msg.reply("❌ Invalid selection.");
      }
      playbackCtx.currentSeason = si;
      playbackCtx.currentEpisode = ei;
      const S2 = seasons[si].seasonIndex ?? (si + 1);
      const E2 = seasons[si].episodes[ei].epIndex ?? (ei + 1);
      const t2 = seasons[si].episodes[ei].title;
      await msg.reply(`▶️ Now playing (S${S2}E${E2}): ${t2}`);

      sendPlay();
    }

    else if (cmd === "!pstop") {
      console.debug("[debug] pstop");
      stopChild();
      await msg.reply("⏹ Stream stopped.");
    }
  } catch (err) {
    console.error("[error]", err);
    await msg.reply(`❌ ${err.message}`);
  }
});

client.login(config.token);

// Start the localhost control API for the slash-command companion bot.
startControlApi();
