

# PoD

Discord self-bot that joins your voice channel and plays Plex movies or TV episodes (video + audio) with simple chat commands. Perfect for streaming your Plex library directly into any server you control.

---

## 🍴 Homelab fork notes (StonyTark1117)

This is a personal fork of [TheNameIsNigel/PoD](https://github.com/TheNameIsNigel/PoD), kept as a backup of a working deployment. Sync upstream with `git fetch upstream && git merge upstream/main`. It diverges from upstream in a few ways that matter for reinstallation:

**Requirements (stricter than upstream):**
- **Node.js 22.x** (not v16). `@dank074/discord-video-stream@6.0.0` needs Node's global `WebSocket`.
- FFmpeg with `h264_nvenc`/`hevc_nvenc` if using GPU encode (see NVENC below).

**Pinned dependencies (`package.json`):** `@dank074/discord-video-stream@6.0.0` (v6 ships the **DAVE/E2EE** support Discord enforced on 2026-03-02 — older versions get voice close code **4017** and never stream) and `discord.js-selfbot-v13@^3.7.1` (v1.x crashes on Discord's modern READY payload).

**⚠️ Required patch after every `npm install`** (`node_modules` is intentionally not committed): v6's `dist/media/newApi.js` adds an `azmq` audio filter whose escaping breaks FFmpeg 5.1.x (`No option name near '//...:42069'` → *Conversion failed*). Comment out the `command.audioFilters('azmq=...')` line. Without this, audio streams fail to start.

**Config additions over upstream** (`config.example.json`):
- `allowedGuilds`: array of guild IDs. **Auth is guild-based** — anyone messaging in a listed guild may drive the bot; `acceptedAuthors` is kept only as an owner override (e.g. DM control).
- `autoplay` (default `true`): on a clean end-of-episode, roll into the next episode. Guarded so an intentional stop or a crash never auto-advances (only a genuine EOF that played long enough does).
- `streamOpts.nvenc` (`true`/`false`): use `h264_nvenc` (GPU) vs `libx264` (CPU). For GPU on an LXC you must pass the device through and `ldconfig` the NVIDIA libs inside the container.

**Extra commands beyond upstream:** `!pqp <season>-<episode>` (jump to a specific episode), `!pautoplay on|off` (toggle auto-advance at runtime). `!pplay` also accepts `SxxExx` / `NxNN` and strips `(YYYY)` from titles, e.g. `!pplay house s3e1`.

**Never commit `config.json`** — it holds live Discord and Plex tokens. Only `config.example.json` (placeholders) belongs in git.

---

## 🔑 Features

- **Search & Play**: `!pplay Agents of S.H.I.E.L.D ` finds movies or TV shows in Plex and starts streaming.  
- **Playlist Support**: For TV shows, builds a season playlist and auto-advances through episodes.  
- **Playback Controls**:  
  - `!prestart` – Restart the current item from the top  
  - `!ppause` – Pause the stream (video frame freezes)  
  - `!pnext` / `!pback` – Skip forward or back one episode  
  - `!pstop` – Stop streaming and disconnect  

---

## 🚀 Prerequisites

- **Node.js** v16 or newer  
- **FFmpeg** installed and available on your `PATH`  
- A **Plex Media Server** with an access token  

---

## 🛠 Installation

1. **Clone this repo**  
   ```bash
   git clone https://github.com/TheNameIsNigel/PoD.git
   cd PoD
``

2. **Install dependencies**

   ```bash
   npm update
   ```

3. **Create your config**

 Copy `config.example.json` to `config.json` and fill in your credentials (see below).

4. **Run the bot**

   ```bash
   npm start
   ```

---

## ⚙️ Configuration (`config.json`)
````
{
  "token": "YOUR_DISCORD_USER_TOKEN",
  "acceptedAuthors": ["YOUR_USER_ID"],
  "plex": {
    "host": "http://your.plex.server:32400",
    "token": "YOUR_PLEX_TOKEN"
  },
  "streamOpts": {
    "width": 1280,
    "height": 720,
    "fps": 15,
    "bitrateKbps": 1000,
    "maxBitrateKbps": 1200,
    "hardware_acceleration": true,
    "videoCodec": "h264"
  }
}
````
* **token**: Your Discord bot user token (has to be an actual Discord account, not a bot app)
* **acceptedAuthors**: Array of user IDs allowed to control the bot.
* **plex.host**: URL of your Plex server
* **plex.token**: Your Plex access token
* **streamOpts**: FFmpeg / stream settings

---

## 🎮 Usage

In any text channel:

!pplay <movie-or-show-name>   # Search Plex & start streaming
!prestart                     # Restart current movie/episode
!ppause                       # Pause the stream
!pnext                        # Next episode (TV only)
!pback                        # Previous episode (TV only)
!pstop                        # Stop streaming & leave VC

**Example**:

!pplay The Mandalorian
// → Joins your voice channel and plays S01 E01 of The Mandalorian
!pnext
// → Skips to S01E02
!ppause
// → Pauses the stream
!pstop
// → Stops & disconnects

---

## 🐛 Troubleshooting

* **No video/audio?**

  * Verify FFmpeg: `ffmpeg -version`
  * Check your Plex credentials and server URL.
* **Permissions errors?**

  * Ensure your bot account can join voice channels and go live.

---

## 🤝 Contributing

PRs and issues are welcome! Feel free to open a feature request or submit a bug-fix.

---

## 📄 License

This project is licensed under the **PoDRSL License**. See [LICENSE](LICENSE) for details.

---

## 🤝 Credits

This project uses the [Discord-video-stream](https://github.com/Discord-RE/Discord-video-stream) library from dank074, as well as the [discord.js-selfbot-v13 library](https://discordjs-self-v13.netlify.app/).

```
```
