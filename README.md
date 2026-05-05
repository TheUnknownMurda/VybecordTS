[BETA]
THIS IS MY FIRST EVER GITHUB PUSHED TO PUBLIC SO PLEASE BE COMPREHENSIVE AND REPORT TO ME ANY ISSUES YOU MAY ENCOUNTER

Installation Difficulty (Advanced) 

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

### Option A: Spotify Premium (Recommended)
Official Spotify API integration — most reliable, full metadata, no third-party tools needed.

1. **Download** the latest release (`VybecordTS.zip`) from [Releases](https://github.com/TheUnknownMurda/VybecordTS/releases)
2. **Extract** and run `VybecordTS.exe`
3. **Setup Wizard** opens automatically:
   - Create Discord app at [discord.com/developers](https://discord.com/developers/applications) → paste Application ID
   - Select **Premium** mode
   - Enter Spotify credentials (get them at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) → Create App → Redirect URI: `http://127.0.0.1:8888/callback`)
4. **Authorize** Spotify when prompted
5. **Done** — play music and Discord shows synced lyrics

### Option B: Spotify Free + Spicetify
For Spotify Free users. Requires Spicetify (third-party Spotify modification).

> ⚠️ **WARNING:** While using Spicetify is not against ToS, it is advised that you use it at your own risk. ONLY use Spicetify for the purpose of this app. DO NOT install any Spicetify plugins as it is not required. Some Spicetify plugins may violates Spotify's Terms of Service. Using thoses may result in account suspension. **We are not responsible** for any bans. Use at your own risk and follow Spicetify rules (no ad blocking, no premium feature unlocking).

1. **Install Spicetify** following the [official guide](https://spicetify.app/) **without** ad-blocking extensions
2. **Install VybecordTS** (download, extract, run)
3. **Setup Wizard:**
   - Enter Discord Application ID
   - Select **Free** mode (SMTC will auto-detect Spicetify)
   - Follow the [Spicetify Extension](#spicetify-extension-spotify) section below
4. **Play music** — instant push-based sync via Spicetify

### Option C: Other Music Sources
Use with YouTube, YouTube Music, SoundCloud, Bandcamp, or any Windows media player.

1. **Install VybecordTS**
2. **Setup Wizard** → select **Free** mode
3. **For YouTube:** Install [Tampermonkey userscript](#youtube-userscript-tampermonkey) (recommended for precise sync)
4. **For SoundCloud/Bandcamp:** Install respective [Tampermonkey userscripts](#optional-integrations)
5. **For any player:** Windows SMTC auto-detects most media players automatically

> **Dashboard:** http://127.0.0.1:8888 — settings, stats, custom lyrics import, theme editor

---

## Developer Setup

### 1. Clone & Install

```bash
git clone https://github.com/TheUnknownMurda/VybecordTS.git
cd VybecordTS
npm install
```

### 2. Create a Discord Application

Required for all users:

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → name it (e.g. "Vybecord")
3. Copy the **Application ID** — paste it in the setup wizard or `config.json`

### 3. Choose Your Setup Mode

#### A. Spotify Premium (Official API) — Recommended

Best experience: full metadata, OAuth refresh tokens, no third-party tools.

**First run wizard** (auto-opens at http://127.0.0.1:8888):
- Select **Premium** tier
- Enter Spotify credentials from [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
- Set redirect URI to `http://127.0.0.1:8888/callback`

**Or manual `config.json`:**
```json
{
  "discord_app_id": "YOUR_DISCORD_APP_ID",
  "user_tier": "premium",
  "spotify_client_id": "YOUR_SPOTIFY_CLIENT_ID",
  "spotify_client_secret": "YOUR_SPOTIFY_CLIENT_SECRET",
  "rpc_enabled": true,
  "show_lyrics": true
}
```

#### B. Spotify Free + Spicetify

For users without Spotify Premium. Uses Spicetify extension for push-based data.

> ⚠️ **CRITICAL WARNING:** Spicetify modifies Spotify's client and **violates Spotify's Terms of Service**. Using it, especially with ad blockers or premium feature unlocks, **will likely result in account suspension**. We are **not responsible** for any bans or account issues.
>
> **Use responsibly:** Only use Spicetify for theming and legitimate enhancements. Never block ads or unlock premium features.

**Setup:**
1. Install Spicetify CLI following [official docs](https://spicetify.app/) (DO NOT install ad-blocking extensions)
2. Install the [VybecordTS Spicetify Extension](#spicetify-extension-spotify) below
3. Run VybecordTS setup wizard → select **Free** tier
4. Spicetify will auto-connect via WebSocket on port 5134

**Why Free tier with Spicetify?** Spicetify pushes data directly to VybecordTS (bypassing need for Spotify API). The app detects this as a push source and prioritizes it over SMTC.

#### C. YouTube / SoundCloud / Bandcamp / Any Player

For non-Spotify sources or mixed usage.

**First run wizard** → select **Free** tier.

VybecordTS will:
- Use **Tampermonkey userscripts** for YouTube/SoundCloud/Bandcamp (push-based, precise)
- Fall back to **Windows SMTC** for any other media player (polling-based)

**Recommended userscripts:**
- [YouTube Userscript](#youtube-userscript-tampermonkey) — precise video sync, CC lyrics
- [SoundCloud Userscript](#soundcloud-userscript-tampermonkey) — track metadata, artwork
- [Bandcamp Userscript](#bandcamp-userscript-tampermonkey) — if available

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

## Which Setup Should I Choose?

| Setup | Best For | Requirements | Pros | Cons |
|-------|----------|--------------|------|------|
| **Spotify Premium** | Spotify users with Premium subscription | Spotify Premium + Developer App | Official API, reliable, full metadata | Requires Premium subscription |
| **Spicetify** | Spotify Free users who want instant sync | Spicetify CLI (TOS violation risk) | Push-based, instant changes, no API limits | **Account ban risk** if misused |
| **Tampermonkey** | YouTube/SoundCloud/Bandcamp users | Browser extension | Precise sync, CC lyrics for YouTube | Browser-only, requires extension |
| **SMTC** | Any Windows media player | Windows 10/11 | Works with everything (Groove, iTunes, etc.) | Polling-based, less precise |

### Recommendation by Use Case

- **Spotify Premium user** → Use **Option A** (Official API). Most reliable, no risks.
- **Spotify Free user** → Consider **Option C** (Tampermonkey for web player) or accept the risk of **Option B** (Spicetify).
- **YouTube/YouTube Music** → Use **Option C** with [YouTube Userscript](#youtube-userscript-tampermonkey).
- **SoundCloud/Bandcamp** → Use **Option C** with respective userscripts.
- **Mixed sources** → Use **Option C** (Free tier). VybecordTS auto-switches between push sources and SMTC.

---

## Optional Integrations

### Spicetify Extension (Spotify)

> ⚠️ **WARNING:** Spicetify violates Spotify's Terms of Service. Using it may result in account suspension. **We are not responsible** for any bans. Use at your own risk and follow Spicetify rules (no ad blocking, no premium feature unlocking).

Push-based integration — instant track changes, full metadata, no API polling. **Only for Spotify Free users who cannot use the official API.**

**Prerequisites:**
- Spicetify CLI installed (follow [official guide](https://spicetify.app/))
- **NO ad-blocking extensions** installed (this will get you banned)

**Installation:**

1. Copy the VybecordTS extension:
   ```bash
   cp spicetify-extension/vybecord.js "$(spicetify -c | Split-Path)/Extensions/"
   spicetify config extensions vybecord.js
   spicetify apply
   ```

2. Restart Spotify — the extension connects automatically to VybecordTS on port 5134

3. In VybecordTS, use **Free tier** mode. The app will auto-detect Spicetify as a push source.

**Why use this?** If you don't have Spotify Premium, this provides instant track updates without API polling. However, the **Tampermonkey Spotify userscript** is a safer alternative with no TOS violation.

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
    ├── server.ts               # HTTP + SSE server, API routes, secure bug report webhook
    ├── dashboard-v2.html       # Modern glassmorphism web dashboard (v2)
    └── dashboard.html          # Legacy dashboard (classic UI)
```

---

## Troubleshooting

### Common Issues by Setup Mode

#### Spotify Premium (Official API)

| Problem | Solution |
|---------|----------|
| "Missing DISCORD_CLIENT_ID" | Add `discord_app_id` to `config.json` or use setup wizard |
| Spotify auth fails / "Invalid client" | Check `spotify_client_id` and `spotify_client_secret` match your [Spotify Dashboard](https://developer.spotify.com/dashboard). Ensure redirect URI is exactly `http://127.0.0.1:8888/callback` |
| "User not registered in the Developer Dashboard" | Your Spotify account must be added as a test user in your Spotify app's settings until the app is approved for general use |
| Auth works but no track detected | Ensure Spotify is playing music. Check `user_tier` is set to `"premium"` |

#### Spotify Free + Spicetify

| Problem | Solution |
|---------|----------|
| Spicetify not connecting | Ensure Spicetify CLI is installed and `spicetify apply` was run. Check Windows Firewall isn't blocking port 5134 |
| Extension installed but no data | Restart Spotify completely. Check browser console (F12) for errors on `127.0.0.1:5134` |
| "Spotify modified client detected" / account warning | **Stop using Spicetify immediately**. You likely have ad-blocking extensions. Remove them and use only official Spotify or switch to Tampermonkey userscript |
| Spicetify works but VybecordTS shows SMTC | Ensure Spicetify extension is properly installed. VybecordTS prioritizes push sources, but falls back to SMTC if Spicetify is stale (>10s) |

#### YouTube / Tampermonkey

| Problem | Solution |
|---------|----------|
| Userscript not working | Ensure Tampermonkey extension is enabled. Open Tampermonkey dashboard → check script is enabled. Try reinstalling the script |
| "@connect 127.0.0.1" permission denied | Edit the userscript, find `@connect` lines, ensure `127.0.0.1` is listed. Save and refresh YouTube |
| YouTube detected but lyrics wrong | For YouTube music videos, lyrics may be for the video, not the song. Use the "Flag Wrong Lyrics" button in dashboard |
| yt-dlp errors / no YouTube CC | Install `yt-dlp` and ensure it's in PATH (`yt-dlp --version` should work). Some videos have no CC |

#### General / SMTC

| Problem | Solution |
|---------|----------|
| SMTC not detecting media | Enable "Show media controls" in Windows Settings → System → Notifications. Ensure your media player supports SMTC (most modern players do) |
| Discord not showing presence | Discord desktop app must be running (not the web version). Check Discord Settings → Activity Privacy → "Share detected activities" is ON |
| Lyrics out of sync | Adjust `lyrics_offset_ms` in config (negative = earlier, positive = later). Common offsets: -200ms to +500ms |
| Dashboard not opening | Check port 8888 isn't in use (`netstat -ano \| findstr 8888`). Try manual URL: `http://127.0.0.1:8888` |
| High CPU usage | Reduce `poll_interval_ms` in config (default 1500ms). Check if `yt-dlp` is stuck processing a video |

---

## License

MIT License — Copyright (c) 2025 TheUnknownMurda. See [LICENSE](LICENSE) for details.
