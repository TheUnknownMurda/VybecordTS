[BETA]
THIS IS MY FIRST EVER GITHUB PUSHED TO PUBLIC SO PLEASE BE COMPREHENSIVE AND REPORT TO ME ANY ISSUES YOU MAY ENCOUNTER

LYRICS SYNCRONICITY MAY VARY
1. Vybecord retrieves synchronized lyrics via LRCLib, an open community-driven database.
Important: The accuracy of the synchronization depends entirely on the quality of the .lrc files uploaded by the community users. Some songs have perfectly timed lyrics, while others may have a slight offset or be completely missing.
Import feature: You can easily import your own lyrics (.lrc files) directly into the app using our local import function. They will then be prioritized and will stay perfectly synchronized with your playback.

2. DISCORD HAS A POLLING LIMIT FOR REFRESHING THE RICH PRESENCE.

Installation Difficulty (Advanced) 

# VybecordTS

**Discord Rich Presence with real-time synced lyrics **

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

**No coding required.**

1. **Download** `VybecordTS-Setup.exe` from [Releases](https://github.com/TheUnknownMurda/VybecordTS/releases)
2. **Run it.** It installs to `%APPDATA%\VybecordTS` and needs no administrator rights.
   You can pick another folder, as long as it's one you can write to — VybecordTS
   keeps its config, logs and lyrics database next to the executable.
3. **Optional, on the Spotify page of the wizard:** tick *Install Spicetify and the
   Vybecord extension* if you use the Spotify **desktop app**. Close Spotify first.
4. **VybecordTS starts** and opens the setup page in your browser.
5. **On the setup page:** install Tampermonkey, then click *Install* for each platform
   you actually use. Each button hands the script straight to Tampermonkey.
6. **Play something** — your Discord status follows along, lyrics included.

> **Setup page:** http://127.0.0.1:8888/setup — re-openable at any time
> **Dashboard:** http://127.0.0.1:8888 — settings, stats, custom lyrics import, theme editor

It works out of the box: a default Discord application ID ships with the app, so
there is nothing to create or paste to get started.

### Going further

| Goal | What to do |
|---|---|
| **Spotify desktop, instant sync** | Let the installer set up Spicetify, or see [Spicetify Extension](#spicetify-extension-spotify) |
| **Spotify Premium, official API** | Dashboard → Settings → **Premium** tier, then add your credentials from [developer.spotify.com](https://developer.spotify.com/dashboard) with redirect URI `http://127.0.0.1:8888/callback` |
| **Your own Discord app name** | Create one at [discord.com/developers](https://discord.com/developers/applications) and paste its Application ID in the dashboard settings |
| **YouTube / SoundCloud / Bandcamp / Twitch / Kick** | Install the matching script from the setup page |
| **Anything else on Windows** | Nothing to do — Windows SMTC detects most players automatically |

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

Install the userscripts in one click from the setup page — see
[Tampermonkey Userscripts](#tampermonkey-userscripts).

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

# Build the distributable .exe + the installer
npm run build:exe

# Recompile only the installer (reuses the existing build/VybecordTS/)
npm run build:installer
```

Dashboard: **http://127.0.0.1:8888** (auto-opens on startup)

### 6. Building the installer

`npm run build:exe` produces two things in `build/`:

- `VybecordTS/` — the portable folder (exe + assets)
- `VybecordTS-Setup.exe` — the Inno Setup installer, built from `installer/VybecordTS.iss`

The installer step needs [Inno Setup 6](https://jrsoftware.org/isinfo.php):

```bash
winget install JRSoftware.InnoSetup
```

It's looked up in the usual Program Files locations and in
`%LOCALAPPDATA%\Programs\Inno Setup 6` (where a non-elevated winget puts it).
Set `ISCC_PATH` to override. **If Inno Setup is missing the build still
succeeds** — it just skips the installer and prints how to install it.

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
- **YouTube/YouTube Music** → Use **Option C** with the [YouTube userscript](#tampermonkey-userscripts).
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

**The installer can do all of this for you** — tick *Install Spicetify and the
Vybecord extension* on the Spotify page of the setup wizard, with Spotify closed.
The steps below are the manual equivalent.

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

### Tampermonkey Userscripts

Push-based integration for everything that runs in a browser: exact playback
position, real metadata and artwork, instant track changes and seek detection.

**Install them from the app, not by hand:**

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser
2. Open **http://127.0.0.1:8888/setup** (VybecordTS must be running)
3. Click *Install* next to each platform you use — Tampermonkey takes it from there

The status dot next to each entry turns green as soon as that source starts
sending data, so you can confirm the script works without leaving the page.

| Script | Covers | Notes |
|---|---|---|
| `vybecord-spotify.user.js` | `open.spotify.com` | Web player — no Spicetify, no ToS concern |
| `vybecord-youtube.user.js` | YouTube + YouTube Music | Also enables CC-based lyrics |
| `vybecord-soundcloud.user.js` | `soundcloud.com` | |
| `vybecord-bandcamp.user.js` | `*.bandcamp.com` | |
| `vybecord-twitch.user.js` | `twitch.tv` | Live stream presence |
| `vybecord-kick.user.js` | `kick.com` | Live stream presence |

> A push source always takes priority over SMTC. If a script stops sending for
> more than 10 s, VybecordTS falls back to SMTC on its own.
>
> The raw files live in `tampermonkey/` inside the install folder if you would
> rather paste them into Tampermonkey manually.

---

## Config Options

| Key | Default | Description |
|---|---|---|
| `discord_app_id` | — | Discord Application ID. Optional — a built-in default is used when empty |
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
| `first_run_completed` | `false` | Startup opens `/setup` while false, the dashboard afterwards. Set it back to `false` to see the setup page again |
| `tray_enabled` | `true` | Show the Windows notification-area icon (dashboard / setup / quit). Windows only |

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
