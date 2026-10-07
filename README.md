<div align="center">

# Vybecord

**Discord Rich Presence for whatever is playing on your Windows PC, with synced lyrics updating line by line.**

[![Latest release](https://img.shields.io/github/v/release/TheUnknownMurda/VybecordTS?label=release)](https://github.com/TheUnknownMurda/VybecordTS/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/TheUnknownMurda/VybecordTS/total)](https://github.com/TheUnknownMurda/VybecordTS/releases)
[![License: MIT](https://img.shields.io/github/license/TheUnknownMurda/VybecordTS)](LICENSE)
![Platform: Windows 10 1809+ x64](https://img.shields.io/badge/platform-Windows%2010%201809%2B%20x64-0078D6)
![Electron 41](https://img.shields.io/badge/Electron-41-47848F)

[Website](https://theunknownmurda.github.io/VybecordTS/) ·
[Download](https://github.com/TheUnknownMurda/VybecordTS/releases/latest) ·
[User guide](USER_GUIDE.md) ·
[Guide utilisateur (FR)](GUIDE_UTILISATEUR.md) ·
[Release notes](RELEASE_NOTES.md) ·
[Report a bug](https://github.com/TheUnknownMurda/VybecordTS/issues)

</div>

---

Vybecord is a Windows desktop app (Electron + TypeScript). It reads the Windows media session (the same source the volume-key overlay uses), finds synced lyrics for the track, and publishes the track and the current lyric line to your Discord profile. It works with Spotify, browser tabs, VLC, foobar2000 and any other player that appears in that overlay, with nothing to configure. An optional Spicetify extension and an optional browser extension add details that Windows does not report.

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Privacy and network access](#privacy-and-network-access)
- [Interfaces](#interfaces)
- [Development](#development)
- [Testing](#testing)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)
- [Migrating from VybecordTS 1.x](#migrating-from-vybecordts-1x)
- [Roadmap](#roadmap)
- [License](#license)
- [Credits](#credits)
- [Support](#support)

## Features

**Detection**

- **No setup.** Native detection through the Windows media session API. Anything that publishes to it is picked up: Spotify, Apple Music, Deezer, Tidal, Amazon Music, VLC, foobar2000, MusicBee, AIMP, Winamp, MediaMonkey, and media playing in Chrome, Edge, Firefox, Brave, Opera, Vivaldi or Zen.
- **Event-driven.** Track changes come in as events. Between the player's infrequent position updates, the playback position is extrapolated, and it is resynchronised every 3 seconds.
- **Player picker.** When several things are playing, a ranking decides which one wins. You can also pin a specific player, and each platform has its own on/off switch.
- **Spotify ad filter.** Your status clears during ad breaks so the advertiser isn't shown on your profile.
- **Optional Spicetify extension.** Track changes arrive the moment they happen, with exact progress, every artist, playlist context, CDN artwork, and Spotify's own timed lyrics. The app installs it for you from Settings.
- **Optional browser extension** for Chrome, Edge, Brave, Opera, Vivaldi and Firefox. It identifies the site (Spotify Web, YouTube, YouTube Music, SoundCloud, Bandcamp, Twitch, Kick) and adds the canonical link, the exact position and live-stream uptime.

**Discord presence**

- The current lyric line goes on the card, with the next line under it. The cover tooltip shows the title, artist, album and playlist.
- **Up to five presence cards at once.** For example: Spotify on card 1, a YouTube video on card 2, a Twitch stream on card 3. Each card has its own lyrics switch and can be pinned to its own player.
- **A Discord application per platform**, so the card header reads *Spotify*, *YouTube*, *SoundCloud*, *Apple Music*, *Twitch* or *Kick*. Seven applications are built in, and you can add up to four spare ones.
- **Customisable card.** You choose the activity type (Listening / Playing / Watching / Competing), what the one-line status shows (including a custom template), the small-icon style, and one custom button. The title, artist and cover are clickable.
- **Cover art.** Released music gets its cover from Deezer, with the iTunes Search API as fallback. Artwork that exists only in your own files can be published to Vybecord's cover store (a switch in Settings).
- **Away-aware.** The presence goes down when your machine has been idle long enough for Discord to mark you Idle (10 minutes by default), and comes back on the first key press.

**Lyrics**

- **Several sources, tried in order:** your own library, then Spotify's lyrics (with Spicetify), then an offline LRCLIB dump, then LRCLIB, Netease and Musixmatch in parallel, then an LRCLIB fuzzy search, then YouTube captions. When there are no synced lyrics, a plain-text version (from LRCLIB or Genius) is shown in the window.
- **Lyrics library.** Paste timed `.lrc` lyrics or untimed text, then time it with the built-in *Sync while playing* tool. You can edit and delete entries and search an offline LRCLIB dump.
- **Corrections.** Mark a wrong match so it is never used for that track again. Timing offsets are saved per track.
- **Translation** into 16 languages, in the window and optionally on Discord. **Romanisation** of Japanese (kanji included), Korean, Chinese, Cyrillic, Greek, Thai, Arabic, Devanagari, Georgian and Armenian.

**App**

- Frameless window with dark and light themes. The app runs in the system tray, so closing the window doesn't stop the presence.
- Listening history (up to 10,000 plays) shown on the **Activity** page over 7 days, 30 days, 12 months or all time: time listened per day, top artists and tracks, and the full log.
- Optional Last.fm scrobbling, with a queue for scrobbles made while offline.
- Automatic updates from GitHub Releases. They install when you quit the app.

## How it works

```
Windows media session (WinRT) ──► media worker thread ──► NativeMediaSource ──┐
Spicetify extension (inside Spotify) ──┐                                       │
Browser extension (content scripts) ───┴──► 127.0.0.1:8888 push server ───────┤
                                                                               ▼
                                                                    VybecordBackend
                                                     ranks every source, assigns up to five
                                                     presence slots, fetches lyrics and covers
                                                                               │
                              ┌────────────────────────────────────────────────┤
                              ▼                                                ▼
                 LyricsEngine (one per slot)                         Electron window (IPC)
                 schedules each lyric line
                              │
                              ▼
               Discord IPC pipe (one socket per Discord application)
```

- The WinRT addon runs on a **worker thread**. Electron's main thread is a single-threaded COM apartment, and in that apartment the media-session calls never return.
- **Position is extrapolated, not polled.** Players publish their position only every few seconds (Spotify about every 4.5 s). Each update becomes an *anchor* (a position plus a monotonic timestamp). The position is projected forward from the anchor and resynchronised every 3 s. The anchor only moves when the player reports a value it hasn't reported before.
- **The extensions talk to the app over loopback** (`127.0.0.1:8888`), and only extension origins are accepted. See [Extension push endpoint](#extension-push-endpoint).
- **Lyrics are scheduled, not polled.** The engine sets a timer for the exact moment the next line starts, compensates for measured Discord IPC latency, and recalibrates when the player reports a seek.

## Requirements

| Requirement | Why |
| --- | --- |
| **Windows 10 version 1809 (build 17763) or later, x64** | The media session API does not exist before 1809. The installer is x64 only. |
| **Discord desktop app, running** | Rich Presence goes through Discord's local IPC pipe, which the web version of Discord doesn't have. |
| **Activity sharing enabled in Discord** | Discord only shows the activity if it is allowed under *User Settings → Activity Privacy*. |

Nothing else is needed. [yt-dlp](https://github.com/yt-dlp/yt-dlp) (used for YouTube captions) and the Japanese dictionary for romanisation come with the installer.

The following are optional:

- [Spicetify](https://spicetify.app/), for the Spotify integration.
- A Chromium-based browser or Firefox 121+, for the browser extension.
- About 40 GB to download an LRCLIB dump, and well over 100 GB of disk space once it is unpacked.
- A Last.fm API account, for scrobbling.

## Installation

### 1. Install the app

1. Download `Vybecord-<version>-setup.exe` from the [latest release](https://github.com/TheUnknownMurda/VybecordTS/releases/latest).
2. Run it. The installer asks whether to install for you only (the default, in `%LOCALAPPDATA%\Programs\Vybecord`) or for all users, lets you change the folder, and creates Start menu and desktop shortcuts.
3. Start Vybecord and play some music. The presence shows up on its own.

> **SmartScreen warning?** The installer is not code-signed. Click **More info → Run anyway**.

Your settings and data are stored in `%APPDATA%\Vybecord`. See [Data folder](#data-folder).

### 2. Optional: Spotify via Spicetify

Windows reports little about Spotify beyond the title and artist. [Spicetify](https://spicetify.app/) runs code inside the Spotify client. Vybecord's Spicetify extension ([`spicetify-extension/vybecord.js`](spicetify-extension/vybecord.js)) uses that access to report track changes the moment they happen, along with exact progress, every artist, playlist context, the album-art CDN URL, and **Spotify's own line-synced lyrics**.

1. Install the Spicetify CLI yourself, using its official PowerShell installer. Vybecord won't run a script downloaded from the internet for you, so read it before you run it:

   ```powershell
   iwr -useb https://raw.githubusercontent.com/spicetify/cli/main/install.ps1 | iex
   ```

2. In Vybecord, open **Settings → Integrations → Spotify** and click **Set up automatically**. It copies `vybecord.js` into `%APPDATA%\spicetify\Extensions`, runs `spicetify config extensions vybecord.js`, then runs `spicetify apply`. **Spotify closes and reopens.**
3. Once Spotify is running, the card shows **Connected**.

After an app update, the card may show **Update needed**. Spotify keeps running the old copy of the extension until you click **Run setup again**.

The equivalent manual commands, after copying the file into the Extensions folder:

```powershell
spicetify config extensions vybecord.js
spicetify apply
```

The extension also adds a Vybecord entry to the Spicetify Marketplace's *Installed* tab.

### 3. Optional: browser extension

Windows reports *what* is playing in a browser, but not *which site* it's on: a SoundCloud tab and a YouTube tab both show up as just "the browser". The extension in [`extension/`](extension/) reads the page instead. It supports Spotify Web, YouTube and YouTube Music, SoundCloud, Bandcamp, Twitch and Kick, and adds the site, the canonical link, the exact position (read from the page's own media element) and the live-stream start time. The extension isn't published on any browser store, so you load it manually.

**Chrome, Edge, Brave, Opera, Vivaldi**

1. Get the extension folder in one of these ways:
   - in Vybecord: **Settings → Integrations → Browser extension → Open the extension folder** (this is the copy that ships with the app), or
   - download `vybecord-extension-<version>.zip` from the [latest release](https://github.com/TheUnknownMurda/VybecordTS/releases/latest) and unzip it.
2. Open your browser's extensions page (`chrome://extensions`, `edge://extensions`, `brave://extensions`, `opera://extensions` or `vivaldi://extensions`). Browsers don't let other apps open these pages, so Settings gives you a button that copies the address.
3. Turn on **Developer mode**, click **Load unpacked**, and select the folder.

**Firefox 121+**

1. Download `vybecord-extension-<version>-firefox.zip` from the [latest release](https://github.com/TheUnknownMurda/VybecordTS/releases/latest).
2. Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on** and select the zip.

Firefox removes temporary add-ons when it closes. Use the `-firefox.zip` package, not the unpacked folder: the folder's manifest declares a Manifest V3 service worker, and Firefox doesn't run those.

The extension's toolbar icon opens its options, where each site has its own switch (all are on by default). The app listens for the extension only while **Settings → Integrations → Browser extension → Accept data from the extension** is on (the default).

### 4. Optional: offline LRCLIB lyrics dump

[LRCLIB](https://lrclib.net) publishes its full database. With a local copy, lyrics lookups take about a millisecond and work offline, and the database can be searched under **Lyrics → LRCLIB dump**.

1. Download the newest `.sqlite3.gz` from <https://lrclib.net/db-dumps> (about 40 GB).
2. Unpack it with 7-Zip or any gzip tool. You get a single `.sqlite3` file, well over 100 GB.
3. Then either:
   - move it to `%APPDATA%\Vybecord\LRCLIB Dump\`. Any file name works, because the largest SQLite file in that folder is used (`lrclib-dump.sqlite3` is the expected name). **Lyrics → LRCLIB dump → Open the dump folder** opens the folder for you. Or:
   - leave it where it is and paste its full path into **Settings → Lyrics & translation → LRCLIB dump path**. Paths copied from Explorer with surrounding quotes are accepted.
4. **Restart Vybecord.** The dump is only opened at startup.

Queries against the dump run on their own worker thread, so even a 100 GB+ file never freezes the window or the presence.

### Updates

Packaged builds check GitHub Releases 5 seconds after launch and then every 6 hours. When an update is available, it is downloaded in the background and installed the next time you quit. A banner in the window, and **Settings → App & window → Updates**, let you restart into it right away. Updates are turned off when running from source.

### Uninstall

Uninstall *Vybecord* from **Windows Settings → Apps**. Your data in `%APPDATA%\Vybecord` is not removed. Delete that folder yourself to remove it. If you installed the Spicetify extension, remove it with:

```powershell
spicetify config extensions vybecord.js-
spicetify apply
```

## Usage

### First launch and the tray

The first time, Vybecord opens on **Help & setup**: a checklist that ticks itself off once the Discord app is open and something is playing, followed by the optional add-ons. After that it opens on **Now playing**. People upgrading with listening history already recorded skip the checklist; it stays at the bottom of the sidebar.

Vybecord connects to Discord in the background. The bottom of the sidebar shows two status lines: whether **Discord** is connected (and, when it is, whether your status is live or why it is hidden), and whether media is being **detected** (and from which source).

Closing the window hides it to the notification area, and the presence keeps running. Click the tray icon to bring the window back. Right-click it and choose **Quit**, or press **Ctrl+Q** in the window, to exit for good. The same menu shows presence 1's song, opens a page (**Go to**), and switches `rpc_enabled` (**Show on Discord**), the lyrics of every presence in play together (**Lyrics on Discord**), `rpc_translate_lyrics`, `presence_count` (**Presences**), `rpc_only_when_playing`, `rpc_hide_when_away`, `filter_spotify_ads` and `launch_on_startup`; its last item checks for an update, or restarts to install one that is ready.

### The window

| Key | Page | What it does |
| --- | --- | --- |
| `1` | **Now playing** | One card for the track: its cover, title, artist and album, the player it comes from, whether it is paused (a paused song stays on the card, its bar stopped where it paused) or live, chips for shuffle, repeat, a local file or being away, and the progress bar. Under a line in the same card, **What your friends see** previews your Discord card, with two quick switches beside it: **Presence** (`rpc_enabled`) and **Lyrics** (the shown presence's `show_lyrics` key) (the song's progress bar shows once, above it; a stream's live time stays in the preview). Then the scrolling lyrics, or, for lyrics found without timings, the words as plain text to scroll, marked **Words only** (the timing row and **Copy .lrc** step aside for them). With several presences, a strip of cards picks which one the page shows. The **Source** menu lists every media session Windows reports and pins the presence to one, or puts it back on **Automatic**. Above the lyrics, **Big lyrics** fills the window with them, Spotify style (large lines on the cover's colour, following the song; **Esc** closes it), **Full lyrics** lists every line with its timestamp, and **Copy .lrc** copies them. Under them you can adjust the timing offset and report wrong lyrics. |
| `2` | **Lyrics** | Your lyrics library, with three tabs: **My lyrics**, **Blocked** (lyrics you marked as wrong) and **LRCLIB dump**. **Add lyrics** opens the import form. |
| `3` | **Activity** | Your listening over **7 days**, **30 days**, **12 months** or **All time**: time listened, tracks played, different artists, a chart of listening time, top artists, top tracks and recently played. **See all** opens the full log, with the time actually listened for each play. The page refreshes itself when a track changes. Dates are in English, on the 12- or 24-hour clock of the system's language. |
| `4` | **Settings** | Six categories: **Discord presence**, **Lyrics & translation**, **Detection**, **Integrations** (browser extension, Spotify through Spicetify, Last.fm, cover images), **App & window**, and **About**. A search box filters every setting. Changes apply immediately. |
| | **Help & setup** | The setup checklist, at the bottom of the sidebar. |

The number keys don't change pages while a text field has focus. **Report a problem** and **Quit** are under **Settings → About**.

### Choosing what is announced

When several players are active, the highest-ranked one wins:

| Rank | Source |
| --- | --- |
| Highest | Anything reported by the Spicetify or browser extension, in this order: Spotify, YouTube / YouTube Music, SoundCloud, Bandcamp, Kick, Twitch |
| 10 | Spotify |
| 9 | Apple Music, Deezer, Tidal |
| 8 | Amazon Music |
| 7 | SoundCloud, Bandcamp, YouTube Music (identified browser tab) |
| 6 | YouTube, Twitch, Kick (identified browser tab) |
| 5 | VLC, foobar2000, MusicBee, AIMP, Winamp, MediaMonkey |
| 1 | Any other app, or a browser tab whose site could not be identified |

Windows Media Player (both the classic and the new app), Groove Music, Movies & TV and the Microsoft Store SoundCloud app are never announced. That SoundCloud app reports no position or duration, so use SoundCloud in a browser with the extension instead.

- **Pinning.** On **Now playing**, pick a player in the **Source** menu to pin it. While a pin is active, only that player is announced, even over the extensions. Pick **Automatic** to go back to ranking. A pinned player is announced even if its platform's switch is off.
- **Detection switches** are under **Settings → Detection → Players**. If you turn off **Detect everything**, only dedicated music apps are announced: Spotify, Apple Music, Deezer, Tidal and Amazon Music.

### Several presences

**Settings → Discord presence → Several presences → Presences at once** goes from 1 to 5. The highest-ranked source goes on presence 1, the next one on presence 2, and so on. Two tabs on the same site count separately, so four Twitch streams take four cards.

- **Lyrics on presence N** chooses which cards show lyrics.
- **Now playing** shows every card. Click one to see its lyrics, its Discord preview and its controls; the **Source** menu then pins that presence to a player.
- The listening history (and so **Activity**) and Last.fm only follow **presence 1**.

Discord shows one card per application. Each card publishes under its platform's own application. When that application is already in use by a higher card, the card borrows another one: first the default Vybecord application, then your **spare application IDs** (up to four), then any built-in platform application nobody is using. The card header still names the real platform. You only need spare IDs if you want more than the seven built-in applications can cover, or if you'd rather not borrow. To get one, create an application at <https://discord.com/developers/applications> and paste its Application ID. If no application is free, the card stays off Discord (it still shows in the window) and the log says why.

### Lyrics

**Sources, first match wins:**

1. **Your library**: lyrics you added under **Lyrics → Add lyrics** or fixed. These always win.
2. **Spotify's own lyrics**, only with the Spicetify extension and only when Spotify has line-synced lyrics for the track. Many tracks have none and go on to the next source.
3. **Local LRCLIB dump**, if one is loaded.
4. **Online race**: LRCLIB, Netease Cloud Music and Musixmatch are queried in parallel, and the first valid answer wins.
5. **LRCLIB fuzzy search**, with scoring.
6. **YouTube captions**, only for YouTube and unidentified browser tabs, and only when everything above found nothing.

If none of these finds synced lyrics, plain lyrics (LRCLIB, then Genius) are shown in the window only, marked **Words only**, never on Discord. Live streams are never looked up.

**Fixing lyrics**

- **Wrong words.** On **Now playing**, click **Wrong lyrics?** under the lyrics and choose **The words are wrong**. That version is never used for this track again, and the next source gets a chance. You can undo it under **Lyrics → Blocked** with **Allow again**.
- **Wrong timing.** Choose **The timing is off** in the same place. The lines are copied into the lyrics editor, where you can re-time them and save your own copy.
- **Offsets.** The **−250 / +250 / Reset** buttons on **Now playing** set an offset for the track that is playing, and it is remembered for that track (up to 1,000 tracks). **Settings → Lyrics & translation → Default timing offset** is the default for tracks you haven't corrected. Negative values show lines earlier.

**Importing.** Under **Lyrics → Add lyrics**, **Fill from current track** copies the playing track's details and its lyrics, if any. Paste lyrics that already have `[mm:ss.xx]` timestamps and save. Or paste plain text, start the song, and use **Sync while playing** to time each line as it's sung, with undo, skip and adjustable tap compensation.

**Translation and romanisation** are under **Settings → Lyrics & translation**:

- *Translate in this window* and *Translate on Discord too*. Target languages: English, French, Spanish, German, Portuguese, Italian, Russian, Japanese, Korean, Chinese, Arabic, Hindi, Turkish, Polish, Dutch, Swedish.
- *Romanise Japanese / Korean* also covers the other scripts listed under [Features](#features). Japanese text containing kanji uses the bundled kuromoji dictionary, which is only loaded when it is needed.

**YouTube captions** are under **Settings → Lyrics & translation → YouTube captions**. They need yt-dlp, which ships with the app. The card shows which copy is in use. To use your own copy, put `yt-dlp.exe` in `%APPDATA%\Vybecord\bin`, which is checked first. After that come the bundled copy, then `PATH`. Captions in *Automatic* follow your system language, then English. Age-restricted videos need a **Cookies file** (a `cookies.txt` exported from your browser). Without the browser extension, the video is found by searching for its title. With it, the exact video is used.

### Cover art on Discord

Discord needs a URL for the cover, but Windows hands Vybecord a file on disk. So:

1. Released music is looked up on **Deezer** first, then on the **iTunes Search API**. Only the track and artist name are sent, and the artist of the result is checked so that a wrong cover is never used. Version markers such as "- Remastered 2011" are removed before searching.
2. Artwork that exists only in your own files (rips, demos, DJ sets) can be **published to Vybecord's cover store** so Discord can show it. Only the image is sent. EXIF, XMP and comment metadata are removed first, and the image is stored under the SHA-256 of its bytes. This is on by default. Turn it off under **Settings → Integrations → Cover images**, and those tracks fall back to the default placeholder.

The window always shows the cover straight from the player.

### Spotify advertisements

Spotify doesn't mark its ads in any way: it simply replaces the track details with the advertiser's. The filter (**Settings → Discord presence → Hide during Spotify ads**, on by default) works mostly from duration:

- Any Spotify "track" of 60 seconds or less counts as an ad, **unless** it belongs to the album that was already playing. That exception protects interludes and skits.
- A track whose title equals its artist (for example "Monster Energy" / "Monster Energy") and that is 55 seconds or shorter also counts as an ad.
- So do titles or artists that Spotify itself labels as an advertisement.

These thresholds come from observation: every ad seen ran 30 s, and the shortest of 44 real tracks sampled ran 83 s. The filter prefers to hide a very short track rather than show an advertiser. While an ad plays, the window says so, and ads are never counted in the history or on Last.fm.

### Away and paused

- **Hide when I'm away** (on by default) takes the presence down after **Away after** minutes without keyboard or mouse input (10 by default, which matches Discord's own idle delay), and puts it back on the first input. The music isn't affected.
- **Hide when paused** (off by default) clears the presence as soon as playback stops.

Both are under **Settings → Discord presence → Visibility**.

### Last.fm scrobbling

1. Create an API account at <https://www.last.fm/api/account/create>.
2. Under **Settings → Integrations → Last.fm**, paste the **API key** and **Shared secret**, then click **Save credentials**.
3. Click **1. Authorise in browser**, approve the request on Last.fm, then click **I approved it — finish**.

A track is scrobbled when it is longer than 30 seconds and has played for half its length or 4 minutes, whichever comes first. Paused time doesn't count. Scrobbles that fail to send are queued in `lastfm-queue.json` (up to 500) and sent again later. Only presence 1 is scrobbled, and live streams never are.

### Reporting a problem

**Settings → About → Report a problem** (also linked from **Help & setup**) sends a summary, a category, optional details and, if you allow it, the current track to the maintainer through a Discord webhook built into official builds. Reports are limited to one every 30 seconds and 20 a day, and duplicates are blocked. Builds made without a webhook show a link to [GitHub issues](https://github.com/TheUnknownMurda/VybecordTS/issues) instead.

## Configuration

Everything has a control in **Settings**, except the few keys marked *config only* below.

### Data folder

| Mode | Location |
| --- | --- |
| Installed | `%APPDATA%\Vybecord` |
| From source (`npm run dev`) | the repository root (the current working directory) |

| File / folder | Contents |
| --- | --- |
| `config.json` | All settings (see below). |
| `custom-lyrics.sqlite3` | Your imported lyrics. Created on first run. |
| `LRCLIB Dump\` | Drop folder for an LRCLIB dump. |
| `listening-history.json` | Listening log, up to 10,000 entries. |
| `flagged-lyrics.json` | Lyrics you marked as wrong. |
| `lyrics-offsets.json` | Timing offsets per track, up to 1,000 tracks. |
| `lyrics-cache.json` | Lyrics already found, up to 500 tracks for 30 days, so a song heard again shows its lyrics at once. The **Clear lyrics cache** button in **Settings** empties it. |
| `translate-cache.json` | Translation cache, up to 5,000 lines. |
| `lastfm-session.txt`, `lastfm-queue.json` | Last.fm session and scrobbles waiting to be sent. |
| `window-state.json` | Last window position and size. Delete it to reset. |
| `logs\vybecord.log` | Log file. It is renamed to `vybecord.old.log` when it reaches 5 MB. |
| `bin\` | Put your own `yt-dlp.exe` here to override the bundled one. |
| `envs\.env` | Optional environment variables (see [Environment variables](#environment-variables)). |

The current track's artwork is also written to `%TEMP%\vybecord_thumb.jpg`.

### config.json reference

`config.json` is created with the defaults on first run and saved atomically whenever a setting changes. The app watches it and reloads it, so you can edit it by hand while the app is running. Unknown keys are dropped. An invalid value (wrong type, out of range) is ignored and the default is kept, with a warning in the log.

**Discord presence** (Settings → Discord presence)

| Key | Default | Accepted values | Setting |
| --- | --- | --- | --- |
| `rpc_enabled` | `true` | boolean | Show my activity on Discord (master switch) |
| `rpc_only_when_playing` | `false` | boolean | Hide when paused |
| `rpc_hide_when_away` | `true` | boolean | Hide when I'm away |
| `away_after_minutes` | `10` | 1–120 (the UI offers 5, 10, 15, 30, 60) | Away after |
| `filter_spotify_ads` | `true` | boolean | Hide during Spotify ads |
| `rpc_show_playlist` | `true` | boolean | Name the playlist |
| `rpc_activity_type` | `2` | `0` Playing, `2` Listening, `3` Watching, `5` Competing | Activity type |
| `rpc_status_display` | `"app"` | `app`, `title`, `title_artist`, `artist_title`, `artist`, `album`, `details`, `state`, `custom`, `playlist` (config only) | Status line |
| `rpc_status_template` | `"{title} - {artist}"` | up to 128 characters; placeholders `{title}` `{artist}` `{album}` `{playlist}` `{platform}` | Status template (used when `rpc_status_display` is `custom`) |
| `presence_count` | `1` | 1–5 | Several presences → Presences at once |
| `show_lyrics_2` … `show_lyrics_5` | `true` | boolean | Lyrics on presence 2–5 |
| `discord_app_id_2` … `discord_app_id_5` | `""` | up to 32 characters | Spare application ID 1–4 |
| `dance_mode`, `radiate_mode`, `purple_rad_mode`, `blue_rad_mode`, `rouge_mode`, `bleeding_mode`, `random_icon_mode`, `lrc_off_mode`, `hide_small_icon` | `false` | boolean, at most one `true` | Small icon |
| `rpc_button1_label` | `""` | up to 128 characters (cut to 32 on the card) | Buttons → Your button's label (empty hides the button) |
| `rpc_button1_url` | `""` | up to 512 characters | Buttons → Your button's link |
| `discord_app_id` | `""` | up to 32 characters | *config only*: replaces the built-in default Discord application |

The second presence button is fixed. It links to what is playing and is labelled with the platform ("Listen on Spotify", "Watch on YouTube", …).

**Lyrics & translation** (Settings → Lyrics & translation)

| Key | Default | Accepted values | Setting |
| --- | --- | --- | --- |
| `show_lyrics` | `true` | boolean | Show lyrics (presence 1; with one presence it is also **Lyrics on the card** under Discord presence) |
| `romanize_lyrics` | `false` | boolean | Romanise Japanese and Korean |
| `lyrics_offset_ms` | `0` | −60000 to 60000 | Default timing offset: for tracks without their own offset |
| `lrclib_dump_path` | `""` | up to 1024 characters | LRCLIB dump path (**restart required**) |
| `cc_enabled` | `true` | boolean | Use captions as lyrics |
| `cc_lang` | `"auto"` | `auto` or a language code | Caption language |
| `cc_cookies_file` | `""` | up to 512 characters | Cookies file |
| `translate_lyrics` | `false` | boolean | Translate in this window |
| `rpc_translate_lyrics` | `false` | boolean | Translate on Discord too |
| `translate_target_lang` | `"en"` | `en` `fr` `es` `de` `pt` `it` `ru` `ja` `ko` `zh` `ar` `hi` `tr` `pl` `nl` `sv` | Translate to |

**Detection** (Settings → Detection)

| Key | Default | Accepted values | Setting |
| --- | --- | --- | --- |
| `detect_all_media` | `true` | boolean | Detect everything (off = dedicated music apps only) |
| `detect_spotify`, `detect_apple_music`, `detect_youtube`, `detect_soundcloud`, `detect_browser`, `detect_twitch`, `detect_kick`, `detect_other_apps` | `true` | boolean | Per-platform switches |

**Integrations** (Settings → Integrations)

| Key | Default | Accepted values | Setting |
| --- | --- | --- | --- |
| `extension_enabled` | `true` | boolean | Browser extension → Accept data from the extension (opens `127.0.0.1:8888`) |
| `lastfm_api_key`, `lastfm_api_secret` | not set | strings | Last.fm. The secret is never sent back to the window in clear text. |
| `art_upload_enabled` | `true` | boolean | Cover images → Publish artwork that exists only on this PC |
| `art_upload_url` | `"https://vybecord-art.vybecord.workers.dev"` | up to 256 characters | *config only*: the cover store to publish to (see [`worker/`](worker/)) |

**App & window** (Settings → App & window)

| Key | Default | Accepted values | Setting |
| --- | --- | --- | --- |
| `theme` | `"dark"` | `dark`, `light` | Theme |
| `minimize_to_tray` | `true` | boolean | Close to tray |
| `tray_enabled` | `true` | boolean | Show tray icon |
| `start_minimized` | `false` | boolean | Start hidden |
| `launch_on_startup` | `false` | boolean | Launch at sign-in. The app starts at Windows sign-in without opening its window. |
| `poll_interval_ms` | `1000` | 400–60000 | Update interval. Only affects progress updates, not track changes. |

**Other**

| Key | Default | Notes |
| --- | --- | --- |
| `bug_report_webhook` | not set | *config only*: overrides the built-in report webhook. It must be a `https://discord.com/api/webhooks/…` URL. |
| `first_run_completed` | `false` | Internal. |

### Environment variables

At startup the app loads `envs\.env` from the [data folder](#data-folder), if the file exists. The process environment works too.

| Variable | Read | Effect |
| --- | --- | --- |
| `DISCORD_CLIENT_ID` | at runtime | Default Discord application, used when `discord_app_id` is empty. |
| `LASTFM_API_KEY`, `LASTFM_API_SECRET` | at runtime | Last.fm credentials, used when the config keys are empty. |
| `VYBECORD_LOG_LEVEL` | at runtime | `debug`, `info` (default), `warn` or `error`. |
| `BUG_REPORT_WEBHOOK` | **at build time** | Discord webhook built into the main bundle for the Report page. It is read from the environment or from `envs/.env` at the repository root. If it isn't set, in-app reporting is turned off in that build. Anyone can read it from the packaged app, so it is not a secret. |

Example `envs\.env`:

```dotenv
VYBECORD_LOG_LEVEL=debug
```

## Privacy and network access

Your history, imported lyrics, settings and Last.fm session stay on your machine. Network requests are made only for the following:

| Destination | When | What is sent |
| --- | --- | --- |
| Discord (local IPC pipe) | Always | The presence. |
| `lrclib.net`, `music.163.com` (Netease), `apic-desktop.musixmatch.com` | Lyrics lookup | Track, artist, album, duration. |
| `genius.com` | Plain-lyrics fallback | Track and artist. |
| `api.deezer.com`, `itunes.apple.com` | Cover lookup | Track and artist. |
| `vybecord-art.vybecord.workers.dev` | Cover publishing (`art_upload_enabled`) | The cover image only, with its metadata removed. |
| YouTube (through yt-dlp) | YouTube captions | Video title and channel, or the video ID. |
| `gql.twitch.tv` | Twitch stream through the extension | Channel name, to get the real stream start time. |
| Google Translate, Lingva mirrors, MyMemory | Translation turned on | The lyric lines. |
| `ws.audioscrobbler.com` (Last.fm) | Scrobbling turned on | Plays. |
| GitHub Releases | Update checks (installed builds) | Nothing beyond the request itself. |
| The maintainer's Discord webhook | Only when you send a report | The report's contents. |

The browser extension sends data to `127.0.0.1:8888` and nowhere else. The one exception: on kick.com it asks Kick's own API for the stream start time. The full policy is on the [website](https://theunknownmurda.github.io/VybecordTS/privacy/).

## Interfaces

### Extension push endpoint

The app runs a small HTTP server ([`src/web/push-server.ts`](src/web/push-server.ts)) for the Spicetify and browser extensions. It runs only while `extension_enabled` is `true`.

- **Bind:** `127.0.0.1:8888`, loopback only. If the port is busy, the server retries 5 times, 4 seconds apart. After that, Settings shows **Port 8888 unavailable**.
- **Paths (POST only):** `/api/spicetify`, `/api/youtube`, `/api/soundcloud`, `/api/bandcamp`, `/api/twitch`, `/api/kick`, `/api/spotify-lyrics`.
- **Allowed origins:** `chrome-extension://…`, `moz-extension://…` and `safari-web-extension://…`. The Spotify client (`https://xpui.app.spotify.com`) is accepted only on `/api/spicetify` and `/api/spotify-lyrics`. A web page can't fake its origin, so no web page can push.
- **Body:** a JSON object of at most 32 KB, received within 5 seconds.
- **Responses:** `200 {"ok":true}`, `204` for CORS preflight, `400` for bad JSON, `403` for a disallowed origin, `404` for anything else. Nothing can be read through it, and it exposes no settings.

You can check that it is running and rejects requests without an extension origin:

```powershell
curl.exe -i -X POST http://127.0.0.1:8888/api/youtube -H "Content-Type: application/json" -d "{}"
# HTTP/1.1 403 Forbidden
# {"error":"origin not allowed"}
```

### Renderer bridge

The window has no Node access and no network access (its CSP sets `connect-src 'none'`). Its whole API is the `window.vybecord` object exposed by [`electron/preload.ts`](electron/preload.ts). Every method maps to one `ipcMain.handle` channel in [`electron/ipc.ts`](electron/ipc.ts). Backend events (`trackUpdate`, `progressUpdate`, `lyricsUpdate`, `plainLyricsUpdate`, `activityUpdate`, `statusUpdate`, `configUpdate`, `updateStatus`, `fatal`) arrive through `vybecord.on(event, cb)`, which returns an unsubscribe function. Track, progress, lyrics and activity events include the index of the presence they belong to.

### Cover store

[`worker/`](worker/) is the Cloudflare Worker and R2 bucket behind `art_upload_url`. It accepts `GET`, `HEAD` and `PUT` on `/c/<sha256>.jpg` and `/c/<sha256>.png`. The server recomputes the hash, determines the type from the file's magic bytes (JPEG and PNG only), limits files to 512 KB, and rate-limits writes per IP. Deployment and running instructions are in [`worker/README.md`](worker/README.md).

## Development

### Prerequisites

- Windows 10 1809+ x64. The media source is Windows-only, so you can't run the app meaningfully anywhere else.
- [Node.js](https://nodejs.org/) 20 or newer (`engines.node` is `>=20.0.0`) and npm.
- Git.
- The Discord desktop app, to see the presence.

You **don't need** Visual Studio Build Tools: `npm install` downloads a prebuilt `better-sqlite3` binary for the pinned Electron version.

### Getting started

```powershell
git clone https://github.com/TheUnknownMurda/VybecordTS.git
cd VybecordTS
git checkout desktop-app
npm install
npm run dev
```

Releases are built from the `desktop-app` branch. `main` is the default branch and is what the website deploys from.

`npm install` runs `postinstall` → [`scripts/fetch-native.mjs`](scripts/fetch-native.mjs), which runs `prebuild-install` for the Electron version in `package.json`. If no prebuild exists for that version, the script tells you to either choose an Electron version that has one or install the Build Tools and run `npx @electron/rebuild -f -w better-sqlite3`. If `prebuild-install` could not run at all, it prints why instead.

For YouTube captions in development, download yt-dlp once into `vendor/`:

```powershell
npm run fetch:ytdlp
```

### npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Builds once, then runs `electron .`. |
| `npm run build` | Builds into `dist-electron/` without launching. |
| `npm run watch` | Rebuilds on every change. Run `npx electron .` alongside it, and restart Electron to pick up main-process changes. |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `electron/`. |
| `npm run rebuild` | Downloads the native `better-sqlite3` binary again (same as `postinstall`). |
| `npm run fetch:ytdlp` | Downloads the latest `yt-dlp.exe` into `vendor/`, checks it against the release's `SHA2-256SUMS`, and skips the download if that version is already there. |
| `npm run dist` | `fetch:ytdlp` + build + `electron-builder --win`, producing the NSIS installer in `release/`. |
| `npm run dist:dir` | Same, but produces an unpacked app only (`release/win-unpacked/`). Faster, for testing. |

[`run.bat`](run.bat) is a shortcut for `npm run dev`.

### Development caveats

- **Close the installed Vybecord first.** Both copies use the same single-instance lock (the app name is `Vybecord`), so if the installed app is running, `npm run dev` exits silently and the installed window comes to the front instead. The installed app also holds port 8888.
- **Data lives at the repository root** in development: `config.json`, `custom-lyrics.sqlite3`, `logs/`, and so on. These are separate from the installed app's `%APPDATA%\Vybecord`. The user-data files are in `.gitignore`.
- **`better-sqlite3` is built for Electron's ABI**, so plain `node` can't load it. To run a one-off script against a database, put the script in the repository and run it through Electron. Clear the variable afterwards, or `npm run dev` in the same shell will start Electron as plain Node:

  ```powershell
  $env:ELECTRON_RUN_AS_NODE = "1"
  npx electron .\my-script.cjs
  Remove-Item Env:ELECTRON_RUN_AS_NODE
  ```

- Renderer warnings and errors go to `logs/vybecord.log` in development. Automatic updates are turned off.

### Project structure

```
electron/                    Electron main process
  main.ts                    window, tray, single instance, login item, startup wiring
  preload.ts                 contextBridge: the renderer's entire API (window.vybecord)
  ipc.ts                     every ipcMain channel, bug-report rate limiting
  media-worker.ts            hosts the WinRT media-session addon off the main thread
  lrclib-worker.ts           runs LRCLIB dump queries off the main thread
  updater.ts                 electron-updater against GitHub Releases
  away-watch.ts              idle detection (powerMonitor) for "Hide when away"
  window-state.ts            remembers window bounds
  spicetify-install.ts       Spicetify detection and one-click setup
  extension-install.ts       browser detection and "Load unpacked" helpers
src/
  backend.ts                 orchestrator: sources → ranking → presence slots → lyrics → Discord
  core/                      media source, push sources (Spicetify, YouTube, SoundCloud, Bandcamp,
                             Twitch, Kick), Discord IPC and socket pool, lyrics providers, local
                             DBs, cover art, art upload, Last.fm, history, translation,
                             romanisation, captions, config, logger
  sync/lyrics-engine.ts      timed line scheduling and Discord activity building
  web/push-server.ts         loopback endpoint for the extensions
ui/                          renderer (vanilla JS, bundled into one classic script)
  index.html, styles.css     window shell and theme tokens (dark and light)
  src/                       state, router, one module per page
spicetify-extension/         vybecord.js, the Spicetify extension
extension/                   browser extension (Manifest V3), see extension/README.md
worker/                      Cloudflare Worker + R2 cover store, see worker/README.md
website/                     static website (GitHub Pages)
scripts/                     build, native fetch, yt-dlp fetch, extension packaging, latest.yml
assets/                      app icon, Spicetify Marketplace preview
manifest.json                Spicetify Marketplace manifest for the extension
```

### Architecture notes

- **Build** ([`scripts/build-electron.mjs`](scripts/build-electron.mjs), esbuild): the main process is bundled as ESM (`main.mjs`). The preload and the two workers are bundled as CommonJS (`.cjs`), because `package.json` declares `"type": "module"`. The renderer is bundled into a single IIFE (`ui/app.js`), because the window loads over `file://`, where Chromium blocks ES module imports. Native and path-sensitive packages (`better-sqlite3`, `@coooookies/windows-smtc-monitor`, `music-metadata`, `electron-updater`, `kuromoji`) are not bundled.
- **Packaging** (`build` in `package.json`): the workers and native addons are unpacked from the asar, because a worker can't be started from inside an archive. yt-dlp, the kuromoji dictionary, the browser extension and the Spicetify extension ship as `extraResources`.
- **Presence slots.** The backend holds five `PresenceSlot`s. On every poll and every push, `reconcile()` collects all candidates, ranks them, applies pins, and assigns them to slots. Slots move between positions rather than restarting, so a demoted track keeps its lyrics engine, its Discord socket and its place in the song.
- **Discord applications.** Switching application is debounced by 1.5 seconds, because Discord refuses connections for a while after rapid reconnects. A socket is kept per application in `DiscordPool` and shared between slots.

### Building the installer

```powershell
npm run dist
```

This produces:

- `release/Vybecord-<version>-setup.exe`: an NSIS installer for x64. It installs per user by default and lets the user choose the folder.
- `release/Vybecord-<version>-setup.exe.blockmap`.
- `release/latest.yml`: what installed copies read to detect an update.
- `release/win-unpacked/`: the unpacked app.

The `BUG_REPORT_WEBHOOK` variable is built in at this point (see [Environment variables](#environment-variables)), and the build log says whether it was found. If `latest.yml` and the installer ever disagree, regenerate it from the installer on disk:

```powershell
node scripts/make-latest-yml.mjs
```

### Browser extension packages

```powershell
node scripts/pack-extension.mjs
```

This writes `release/vybecord-extension-<version>.zip` (Chromium) and `release/vybecord-extension-<version>-firefox.zip`. The Firefox package is the same code with `background.scripts` instead of a service worker. The extension has its own version number in [`extension/manifest.json`](extension/manifest.json). The icons are generated from the website's logo by [`scripts/make-extension-icons.ps1`](scripts/make-extension-icons.ps1) (`pwsh scripts/make-extension-icons.ps1`).

### Website

[`website/`](website/) is a static site. [`.github/workflows/pages.yml`](.github/workflows/pages.yml) deploys it to GitHub Pages on every push to `main` that touches `website/`. The download page reads the latest release from the GitHub API, so a new version only needs a release, not a deploy.

### Why Electron is pinned

`package.json` pins an exact Electron version (`41.10.5`). `better-sqlite3` publishes prebuilt binaries per Electron ABI, but only up to a certain version. Moving past it would quietly send every contributor down the build-from-source path, which needs a C++ toolchain. Before upgrading Electron, check that a matching `better-sqlite3` prebuild exists.

## Testing

There is **no automated test suite** in the repository, and no CI for the app. The only workflow deploys the website. Before submitting a change:

1. **Type-check:** `npm run typecheck` must finish without errors.
2. **Build:** `npm run build` must succeed.
3. **Run it:** `npm run dev`, play something, and check the presence, the window and `logs/vybecord.log`. For detail, set `VYBECORD_LOG_LEVEL=debug` in `envs/.env`. The log records every presence change (`[NEW TRACK]`, `[LYRICS]`, `[DISCORD]`, …).
4. **Installer changes:** `npm run dist:dir`, then run `release/win-unpacked/Vybecord.exe`.

## Contributing

Bug reports and pull requests are welcome.

- **Issues:** include your Vybecord version (**Settings → About**), the player and site involved, and the relevant part of `%APPDATA%\Vybecord\logs\vybecord.log`.
- **Branches:** work from `desktop-app` and open pull requests against it.
- **Before opening a PR:** run `npm run typecheck` and `npm run build`, and test the change in the running app (see [Testing](#testing)).
- **Commit messages** are in English, and describe in one sentence what was wrong from the user's point of view (for example *"Two Twitch tabs were one card flipping between two streams"*). Release commits read `Release <x.y.z>: <summary>`.
- **Code style:** TypeScript `strict`, ES2022, ESM. Comments explain *why*, including rejected alternatives and measurements, rather than restating the code. Match the surrounding style.
- **Dependencies:** keep them to a minimum. Native modules must ship prebuilt binaries for the pinned Electron, and nothing should require a compiler.
- **Never commit user data:** `config.json`, the SQLite stores, history, logs and `envs/` are ignored for a reason.

<details>
<summary><b>Release checklist (maintainers)</b></summary>

Releases are made by hand from `desktop-app`. There is no release CI.

1. Bump the version: `npm version <x.y.z> --no-git-tag-version`.
2. Commit: `Release <x.y.z>: <summary>`.
3. Build: `npm run dist`.
4. If `extension/` changed, bump `extension/manifest.json` and run `node scripts/pack-extension.mjs`. Otherwise, reuse the previous extension zips.
5. Tag with the bare version (no `v` prefix), then push the branch and the tag:

   ```powershell
   git tag <x.y.z>
   git push origin desktop-app
   git push origin <x.y.z>
   ```

6. Publish the release with **all five assets**:

   ```powershell
   gh release create <x.y.z> --title "Vybecord <x.y.z>" --notes-file <notes.md> `
     release/latest.yml `
     release/Vybecord-<x.y.z>-setup.exe `
     release/Vybecord-<x.y.z>-setup.exe.blockmap `
     release/vybecord-extension-<ext>.zip `
     release/vybecord-extension-<ext>-firefox.zip
   ```

   Without `latest.yml`, installed copies never see the update. Without the extension zips, the download links break.

</details>

## Troubleshooting

**Nothing is detected.** Open the **Source** menu on **Now playing**. If it lists no player, your player doesn't publish to the Windows media session. To check, press a media key: if the Windows volume overlay doesn't show the track, Vybecord can't see it either. If the bottom of the sidebar says detection is unavailable, check that you are on Windows 10 1809 or later.

**The presence doesn't show on Discord.** Discord must be the desktop app and already running. At the bottom of Vybecord's sidebar, Discord must show as connected; the line under it says why the status is hidden, if it is. In Discord, check that activity sharing is allowed under *Activity Privacy*. Also check that **Show my activity on Discord** is on, and that the presence isn't hidden on purpose (away, paused, or a Spotify ad).

**A second (or third…) card never appears.** All applications are in use. Add a **Spare application ID** under **Settings → Discord presence → Several presences**. The log has a `[DISCORD] Presence N has no application of its own` line.

**Lyrics are out of sync.** Use **−250 / +250** on **Now playing**. The offset is saved for that track. Some players report their position infrequently. The 3-second resync limits the error but can't remove it completely.

**Wrong lyrics.** Use **Wrong lyrics?** on **Now playing**, or add the correct lyrics under **Lyrics → Add lyrics**.

**No lyrics.** Check that **Show lyrics** is on. Live streams are never looked up. Browser tabs often publish a video title ("Artist - Title (Official Video)") rather than a clean track name, which makes matching less reliable. The browser extension improves this.

**No YouTube captions.** **Settings → Lyrics & translation → YouTube captions** shows whether yt-dlp was found. Age-restricted videos need a cookies file. Many videos simply have no captions.

**The browser extension shows "Not detected".** Check that **Accept data from the extension** is on and that something is playing in a supported site. If it shows **Port 8888 unavailable**, another program (usually a second copy of Vybecord) holds the port. Close it and reopen Vybecord.

**The Spicetify card shows "Update needed".** The app was updated but Spotify still runs the old extension. Run the setup again.

**The cover shows on the window but not on Discord.** The album isn't in the Deezer or iTunes catalogues and cover publishing is off, or the track is a live stream (streams are never looked up).

**The presence disappears when I step away.** That's **Hide when I'm away**. Change the delay or turn it off under **Settings → Discord presence**.

**`npm run dev` exits immediately with no output.** The installed Vybecord is running. Quit it from the tray first.

**`better_sqlite3.node … was compiled against a different Node.js version`.** Run `npm run rebuild`.

**Collecting logs.** The log is `%APPDATA%\Vybecord\logs\vybecord.log` (installed) or `logs\vybecord.log` (from source). Add `VYBECORD_LOG_LEVEL=debug` to `envs\.env` in the same folder for more detail.

## Migrating from VybecordTS 1.x

The 1.x console edition detected playback through a required Spicetify extension, Tampermonkey userscripts and a PowerShell reader, and was configured through a dashboard on `localhost:8888`. All of that is gone. Detection is native, and the interface is the app window. Both extensions came back later as optional add-ons, installed differently: the Spicetify one from **Settings**, and the browser one in place of the userscripts.

Your `config.json`, lyrics database, listening history and flagged list carry over. Obsolete config keys are dropped automatically, and a `lrclib-custom.sqlite3` store is renamed to `custom-lyrics.sqlite3` on first run. You can uninstall the Tampermonkey userscripts and the 1.x Spicetify extension. The 1.x releases are still on the [releases page](https://github.com/TheUnknownMurda/VybecordTS/releases).

## Roadmap

There is no published roadmap. The repository prepares the following, but none of it is done yet:

- **Browser store listings.** The store submission material is ready in [`extension/STORE_SUBMISSION.md`](extension/STORE_SUBMISSION.md). Once the extension is listed, installing it will take one click instead of *Load unpacked*.
- **A custom domain for the cover store.** [`worker/wrangler.toml`](worker/wrangler.toml) has a commented-out route for it. Covers are addressed by their hash, so changing `art_upload_url` breaks no links.

## License

[MIT](LICENSE) © 2025 TheUnknownMurda

## Credits

Created and maintained by [TheUnknownMurda](https://github.com/TheUnknownMurda).

Vybecord builds on:

- **Lyrics:** [LRCLIB](https://lrclib.net), Netease Cloud Music, Musixmatch, Genius, YouTube captions through [yt-dlp](https://github.com/yt-dlp/yt-dlp).
- **Covers:** the Deezer and iTunes Search APIs.
- **Libraries:** [Electron](https://www.electronjs.org/), [electron-builder / electron-updater](https://www.electron.build/), [@coooookies/windows-smtc-monitor](https://www.npmjs.com/package/@coooookies/windows-smtc-monitor), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), [kuromoji](https://github.com/takuyaa/kuromoji.js), [pinyin-pro](https://github.com/zh-lx/pinyin-pro), [music-metadata](https://github.com/borewit/music-metadata), [dotenv](https://github.com/motdotla/dotenv), [esbuild](https://esbuild.github.io/).
- **Integrations:** [Spicetify](https://spicetify.app/), [Last.fm](https://www.last.fm/api), [Discord Rich Presence](https://discord.com/developers/docs/rich-presence/overview).

Vybecord is not affiliated with Discord, Spotify, or any of the services above.

## Support

- **In the app:** **Settings → About → Report a problem**.
- **Issues:** <https://github.com/TheUnknownMurda/VybecordTS/issues>
- **Website:** <https://theunknownmurda.github.io/VybecordTS/>
- **User guides:** [English](USER_GUIDE.md) · [Français](GUIDE_UTILISATEUR.md)
