# VybecordTS

**Discord Rich Presence with real-time synced lyrics — TypeScript edition.**

Zero-bloat backend focused on performance. Event-driven lyrics sync engine with sub-millisecond precision.

---

## Features

- **Discord Rich Presence** — Song, artist, album art, and synced lyrics on your Discord profile
- **Multi-Source Support** — Spotify, YouTube, YouTube Music, SoundCloud, Bandcamp, and any SMTC-compatible player
- **Synced Lyrics** — LRCLib, Netease Cloud Music, YouTube Closed Captions (auto-generated & manual)
- **High-Precision Sync** — `setTimeout`-based scheduling with drift correction, not polling
- **Spicetify Integration** — Push-based Spotify data (instant track change, no API delay)
- **YouTube Integration** — Tampermonkey userscript for precise video sync & CC lyrics
- **Web Dashboard** — Live glassmorphism UI with karaoke lyrics, stats, and album art theming
- **Config Hot-Reload** — Edit `config.json` while running, changes apply instantly

---

## Prerequisites

| Requirement | Version | Required | Notes |
|---|---|---|---|
| **Node.js** | 20.0+ | ✅ Yes | [nodejs.org](https://nodejs.org/) |
| **npm** | 10+ | ✅ Yes | Comes with Node.js |
| **Discord** | Desktop app | ✅ Yes | Must be running for RPC |
| **Windows** | 10/11 | ✅ Yes | SMTC requires Windows |
| **yt-dlp** | Latest | ⬜ Optional | For YouTube CC lyrics — [github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) |
| **Spotify Developer App** | — | ⬜ Optional | Only for Spotify API mode (Premium users) |
| **Tampermonkey** | Latest | ⬜ Optional | For YouTube userscript integration |
| **Spicetify** | Latest | ⬜ Optional | For push-based Spotify integration |

---

## Quick Start (Users)

**No coding required.** Download and run.

1. **Download** the latest release (`VybecordTS.zip`) from [Releases](https://github.com/TheUnknownMurda/VybecordTS/releases)
2. **Extract** the zip anywhere (Desktop, Documents, etc.)
3. **Double-click** `VybecordTS.exe`
4. **Your browser opens automatically** with the setup wizard — follow the steps:
   - Create a Discord app at [discord.com/developers](https://discord.com/developers/applications) and paste the Application ID
   - Choose **Free** (any music player) or **Premium** (Spotify API)
5. **Done.** Play music and your Discord status updates with lyrics.

> Dashboard always available at **http://127.0.0.1:8888** — change settings, view stats, import custom lyrics.

---

## Developer Setup

### 1. Clone & Install

```bash
git clone https://github.com/TheUnknownMurda/VybecordTS.git
cd VybecordTS
npm install
```

### 2. Create a Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → name it (e.g. "Vybecord")
3. Copy the **Application ID** — you'll need it in config

### 3. Configure

On first run, VybecordTS auto-creates `config.json` and opens a **setup wizard** in the dashboard. You can also edit it manually:

```json
{
  "discord_app_id": "YOUR_DISCORD_APP_ID",
  "rpc_enabled": true,
  "show_lyrics": true,
  "detect_all_media": true,
  "user_tier": "free"
}
```

> **Free users (no Spotify Premium):** Set `"user_tier": "free"` — uses Windows SMTC to detect any media player.
>
> **Premium users:** Set `"user_tier": "premium"` and add Spotify credentials:
> ```json
> {
>   "user_tier": "premium",
>   "spotify_client_id": "YOUR_SPOTIFY_CLIENT_ID",
>   "spotify_client_secret": "YOUR_SPOTIFY_CLIENT_SECRET"
> }
> ```
> Get credentials at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) → Create App → set redirect URI to `http://127.0.0.1:8888/callback`.

### 4. Install yt-dlp (optional — YouTube CC lyrics)

```bash
# Option A: winget
winget install yt-dlp

# Option B: pip
pip install yt-dlp

# Option C: download binary
# Place yt-dlp.exe in your PATH
```

Verify: `yt-dlp --version`

### 5. Run

```bash
# Development (auto-reload)
npm run dev

# Production build
npm run build
npm start

# Build distributable .exe
npm run build:exe
```

Dashboard: **http://127.0.0.1:8888** (auto-opens on startup)

---

## Optional Integrations

### Spicetify Extension (Spotify)

Push-based integration — instant track changes, full metadata, no API polling.

1. Install [Spicetify](https://spicetify.app/)
2. Copy the extension:
   ```bash
   cp spicetify-extension/vybecord.js "$(spicetify -c | Split-Path)/Extensions/"
   spicetify config extensions vybecord.js
   spicetify apply
   ```
3. Restart Spotify — the extension connects automatically

### YouTube Userscript (Tampermonkey)

Precise video sync — exact `currentTime`, direct video ID, instant seek detection.

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser
2. Open Tampermonkey Dashboard → **+** (new script)
3. Paste the contents of `tampermonkey/vybecord-youtube.user.js`
4. Save (**Ctrl+S**) — active immediately on YouTube & YouTube Music

> When the userscript is active, VybecordTS automatically uses it instead of SMTC for YouTube sources. Falls back to SMTC if the userscript stops pushing (>10s).

### Spotify Userscript (Tampermonkey)

Enhanced Spotify Web Player integration — artist images, precise progress, instant metadata.

1. Open Tampermonkey Dashboard → **+** (new script)
2. Paste the contents of `tampermonkey/vybecord-spotify.user.js`
3. Save (**Ctrl+S**) — active on `open.spotify.com`

> Provides richer metadata than SMTC alone (artist art, album art, Spotify URLs).

### SoundCloud Userscript (Tampermonkey)

Push-based SoundCloud integration — track metadata, artwork, and precise playback state.

1. Open Tampermonkey Dashboard → **+** (new script)
2. Paste the contents of `tampermonkey/vybecord-soundcloud.user.js`
3. Save (**Ctrl+S**) — active on `soundcloud.com`

> Overrides SMTC for SoundCloud with higher-quality metadata and instant track change detection.

---

## Config Options

| Key | Default | Description |
|---|---|---|
| `discord_app_id` | — | **Required.** Discord Application ID |
| `rpc_enabled` | `true` | Enable/disable Discord Rich Presence |
| `show_lyrics` | `true` | Show synced lyrics on Discord profile |
| `detect_all_media` | `true` | Detect non-Spotify sources (YouTube, SoundCloud, etc.) |
| `user_tier` | `"auto"` | `"auto"` / `"premium"` / `"free"` |
| `rpc_only_when_playing` | `false` | Clear presence when music stops |
| `dance_mode` | `false` | Animated GIF icon for Spotify |
| `lyrics_offset_ms` | `0` | Manual lyrics timing offset (negative = earlier) |
| `poll_interval_ms` | `3000` | Polling interval in ms |
| `rpc_button1_label` | — | First RPC button label |
| `rpc_button1_url` | — | First RPC button URL |
| `rpc_button2_label` | — | Second RPC button label |
| `rpc_activity_type` | `2` | Discord activity type (2 = Listening) |
| `rpc_details_url` | `"auto"` | Clickable details field link target |
| `rpc_state_url` | `"auto"` | Clickable state field link target |
| `rpc_large_url` | `"auto"` | Clickable album art link target |

---

## Source Priority

VybecordTS uses multiple data sources with automatic priority:

| Priority | Source | When |
|---|---|---|
| 1 | **Spicetify** (push) | Spicetify extension active + Spotify playing |
| 2 | **YouTube Userscript** (push) | Tampermonkey userscript active + YouTube playing |
| 3 | **Spotify API** (poll) | Premium user without Spicetify |
| 4 | **Desktop SMTC** (poll) | Fallback — any Windows media player |

Higher-priority sources override lower ones automatically. If a push source goes stale (>10s), it falls back to the next available source.

---

## Lyrics Sources

| Priority | Source | Type |
|---|---|---|
| 1 | **Local DB** | SQLite FTS5 + custom imported lyrics |
| 2 | **LRCLib** | Direct + fuzzy lookup |
| 3 | **Netease Cloud Music** | Parallel race with LRCLib |
| 4 | **Last.fm Autocorrect** | Retry with corrected title/artist |
| 5 | **YouTube CC** | Closed captions via yt-dlp (YouTube sources) |

---

## Architecture

```
src/
├── index.ts                    # Entry point, graceful shutdown
├── backend.ts                  # Main orchestrator, poll loop, multi-source
├── core/
│   ├── types.ts                # TrackData, LyricLine, DiscordActivity, Config
│   ├── config.ts               # JSON config with file watcher
│   ├── logger.ts               # Console + file logger
│   ├── spotify.ts              # Spotify OAuth + playback API
│   ├── spicetify-source.ts     # Push-based Spotify source
│   ├── youtube-source.ts       # Push-based YouTube source (userscript)
│   ├── desktop-source.ts       # Windows SMTC via PowerShell
│   ├── discord-ipc.ts          # Discord IPC (named pipes, zero deps)
│   ├── provider.ts             # Multi-provider lyrics engine
│   ├── youtube-captions.ts     # YouTube CC via yt-dlp
│   ├── local-lyrics-db.ts      # SQLite FTS5 lyrics database
│   ├── lyrics-blacklist.ts     # Wrong lyrics flagging (SHA-256)
│   ├── lrc-parser.ts           # LRC format parser + binary search
│   ├── lastfm.ts               # Last.fm track/artist correction
│   └── similarity.ts           # Jaro-Winkler string similarity
├── sync/
│   └── lyrics-engine.ts        # High-precision lyrics scheduler + RPC builder
└── web/
    ├── server.ts               # HTTP + SSE server, API routes
    └── dashboard.html          # Glassmorphism web dashboard
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Missing DISCORD_CLIENT_ID" | Add `discord_app_id` to `config.json` |
| No lyrics found | Install `yt-dlp` for YouTube CC, check internet connection |
| SMTC not detecting media | Enable "Show media controls" in Windows Settings → System → Notifications |
| Discord not showing presence | Ensure Discord desktop app is running (not web) |
| Spotify auth fails | Check client ID/secret, redirect URI must be `http://127.0.0.1:8888/callback` |
| YouTube userscript not working | Check Tampermonkey is enabled, allow `@connect 127.0.0.1` |
| Lyrics out of sync | Adjust `lyrics_offset_ms` in config (negative = earlier) |

---

## License

Proprietary — Copyright (c) 2025 TheUnknownMurda. All rights reserved.
