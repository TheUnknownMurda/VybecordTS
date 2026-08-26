<div align="center">

# Vybecord

**Discord Rich Presence with real-time synced lyrics — one desktop app, working from the first track.**

</div>

---

## What it is

Vybecord watches whatever is playing on your PC and puts it on your Discord profile, with the current lyric line updating as the song plays.

It reads the **Windows media session API** — the same one behind the volume-key overlay. Anything that publishes to it is detected automatically: Spotify, a browser tab, VLC, foobar2000, MusicBee, AIMP, Apple Music, Deezer, Tidal. Nothing to set up and no config file to hand-edit.

Two optional extensions go further where the OS falls short: [Spicetify](#the-spicetify-extension) for the Spotify client, and [the browser extension](#the-browser-extension) for music in a tab. Neither is required, and nothing changes if you skip them.

## Features

- **Zero-setup detection** — install, run, done. Detection is native, with nothing to configure.
- **Real-time synced lyrics** — millisecond-accurate scheduling, shown in the window and on your Discord presence.
- **Local lyrics library** — import your own `.lrc` files; they beat every online provider.
- **Player picker** — several things playing at once? Pin the presence to the one you mean.
- **Spotify ad filter** — your status clears during ad breaks instead of announcing the advertiser.
- **Away-aware** — the presence comes down once Discord marks you idle and goes back up on the first keypress, the way Discord's own Spotify integration behaves.
- **Private sessions are respected** — turn one on in Spotify and the presence disappears with it. Needs the Spicetify extension: nothing outside the client can see that switch.
- **Optional Spicetify extension** — Spotify's own timed lyrics, event-driven track changes, and artwork straight from the client. One button in Settings installs it.
- **Optional browser extension** — adds what Windows cannot report: which site a tab is on, track links, exact position, live-stream uptime.
- **Listening history & stats** — session top tracks, a persistent log, and a "wrapped" summary over any range.
- **Last.fm scrobbling** — optional.
- **Translation & romanisation** — translate lyrics live, or romanise Japanese/Korean.
- **Runs in the tray** — close the window and the presence keeps going.

## Requirements

- **Windows 10 version 1809 (build 17763) or later** — the media session API does not exist before that.
- **Discord desktop app**, running. (The web app has no local IPC pipe to connect to.)
- Nothing else. [yt-dlp](https://github.com/yt-dlp/yt-dlp) ships with the app for the YouTube caption fallback; to override it with your own copy, drop `yt-dlp.exe` in `%APPDATA%\Vybecord\bin` — Settings → Lyrics says which it found, and offers the folder if it found neither.

## Install

Grab `Vybecord-<version>-setup.exe` from the [releases page](https://github.com/TheUnknownMurda/VybecordTS/releases) and run it. Start playing music; the presence appears on its own.

Everything else is in the window — settings, lyrics library, history, Last.fm. There is no web dashboard to open; the loopback port the extensions push to is opened only while you have them enabled.

---

## How detection works

```
Windows media session (WinRT)
          │  media / timeline / playback events
          ▼
   media worker thread ──────► NativeMediaSource ──► VybecordBackend
                                (priority, anchors,      │
                                 title cleanup)          ├──► LyricsEngine ──► Discord IPC
                                                         └──► IPC ──► window
```

Two details worth knowing:

**The addon runs on a worker thread.** Electron's main thread is a single-threaded COM apartment (STA); WinRT's session calls expect a multi-threaded one and simply never return there. A worker thread gets its own apartment, so the addon behaves. Everything else — priority, timing, title parsing — stays on the main thread.

**Position is extrapolated, not polled.** Players publish a timeline update only every few seconds — Spotify does so every 4.5s. Each update becomes an anchor: a position paired with a monotonic timestamp. The reported position is extrapolated from that anchor while playing, and a background resync every 3 seconds catches seeks from players that do not announce them.

The subtlety is that a resync must ignore a reading it has already seen. Spotify reports `lastUpdatedTime` as the moment the value was *read*, not the moment it was measured, so a resync landing between publishes looks like a fresh reading that happens to be two seconds behind. Re-anchoring on it threw away correctly extrapolated time and made the progress bar sawtooth — climb for three seconds, snap backwards, climb again. Anchors therefore only move on a position value the player has not served before.

### Spotify advertisements

Spotify publishes no flag for an ad break: it simply swaps the media session's metadata for the advertiser's, which is why an unfiltered presence ends up announcing "Monster Energy" as if it were a song.

The filter (on by default, *Settings → Detection*) keys on duration, because that is the only thing every ad has in common. Ads come in two shapes and only one is recognisable from its text:

- the brand written into both title and artist — "Monster Energy" / "Monster Energy"
- marketing copy as the title, brand as the artist — "Join now: 50 free spins…" / "PlayOJO", "Saturday 7PM ET" / "CBC"

Every ad observed ran 30 seconds. Across 44 consecutive real tracks sampled from ordinary listening, the shortest ran 83. So a Spotify track under a minute is treated as an ad.

The one thing that would otherwise catch by mistake is a genuine short track — an album interlude or a skit. Those are distinguishable: an interlude belongs to the album playing around it, whereas an ad never shares an album with the music it interrupts. That check is what protects them.

The trade is deliberate and it runs the opposite way from the obvious one: this errs toward hiding a very short track rather than announcing an advertiser. It rests on how Spotify fills these fields, which is not a contract — if Spotify changes them, this needs revisiting. Music Presence carries the same caveat for the same reason.

While an ad plays the window says so explicitly, so the gap in your status does not look like a bug.

### The Spicetify extension

Windows says Spotify is playing and little else. [Spicetify](https://spicetify.app/) loads code inside the Spotify client itself, which is the only place some of this can be read at all.

The extension in [`spicetify-extension/`](spicetify-extension/) reports the track the moment it changes — an event, not a 400ms poll — along with exact progress, every artist, playlist context, and the album-art CDN URL, so no cover has to be looked up on a public catalogue.

It also supplies **Spotify's own timed lyrics**. That endpoint answers only from inside the client, which is exactly where this runs. Only line-synced lyrics are taken: an unsynced blob stamps every line at zero and would show the whole song at once. Tracks with no lyrics answer 404 — the normal case for a good part of the catalogue — and pass silently to the other sources.

**Settings → Spotify via Spicetify** does the setup in one press: it copies the file, runs `spicetify config extensions vybecord.js`, then `spicetify apply`. All three matter, and stopping after one of them looks exactly like "it does not work". Installing Spicetify itself is left to you — its installer is a script downloaded and executed from the internet, and the app will not run that on your behalf.

### The browser extension

Windows reports *what* is playing but never *where*: a SoundCloud tab and a YouTube tab are indistinguishable, both arriving as "MSEdge" with the page title as the track and the uploading account as the artist.

The optional extension in [`extension/`](extension/) reads the page directly and supplies the site, the canonical link, position from the page's own audio element, and live-stream start times, for Spotify web, YouTube, SoundCloud, Bandcamp, Twitch and Kick. Each site has its own switch in the extension's options.

It reaches the app over `127.0.0.1:8888`, opened only while **Settings → Detection → Accept data from the extension** is on. That endpoint answers POST on six push paths and nothing else, and accepts only `chrome-extension://` / `moz-extension://` origins — a scheme the browser sets and a web page cannot forge. There is no settings API on it and nothing readable, so the worst a hostile extension could do is lie about what you are listening to.

Push sources outrank the media session for the same playback; without the extension installed, nothing changes.

### Player priority

When several sessions play at once, the highest priority wins: Spotify (10) → Apple Music / Deezer / Tidal (9) → Amazon Music (8) → local players such as VLC, foobar2000, MusicBee (5) → browser tabs (1). Override it from the **Players** page.

## Lyrics sources

Tried in order, first match wins:

1. **Spotify's own lyrics** — only when the Spicetify extension is installed and Spotify has line-synced lyrics for that track. Much of the catalogue has none, and those fall straight through to the next source.
2. **Your local library** — custom lyrics you imported.
3. **Local LRCLIB dump** — optional offline database (set its path in Settings).
4. **Online race** — LRCLib, Netease and Musixmatch queried in parallel; the first good answer is used.
5. **YouTube captions** — fallback for YouTube playback, when enabled.

Note that (1) really does sit above your own library: the pushed lyrics are folded into the cache before the provider chain runs, so on a Spotify track that Spotify has lyrics for, an imported `.lrc` is not consulted.

Flagged a bad match with **Wrong lyrics**? That result is never reused for that track. Clear flags under Lyrics → Flagged.

---

## Development

```bash
npm install
npm run dev
```

`npm install` runs `scripts/fetch-native.mjs`, which downloads the better-sqlite3 binary built for Electron's ABI. **No Visual Studio Build Tools required.**

| Script | What it does |
| --- | --- |
| `npm run dev` | Build once, then launch |
| `npm run watch` | Rebuild on change (run `npx electron .` alongside) |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `electron/` |
| `npm run dist` | Build the NSIS installer into `release/` |
| `npm run dist:dir` | Package without an installer (faster, for testing) |
| `npm run rebuild` | Re-fetch the native binaries |

### Why Electron is pinned

`package.json` pins an exact Electron version rather than a range. better-sqlite3 publishes prebuilt binaries per Electron ABI and only up to a given one; drifting past it would silently push everyone onto the compile-from-source path, which needs a full C++ toolchain. When bumping Electron, check that a matching prebuild exists first.

### Layout

```
electron/
  main.ts           window, tray, lifecycle, single instance
  preload.ts        contextBridge — the renderer's entire API
  ipc.ts            every IPC channel (replaces the old HTTP routes)
  media-worker.ts   hosts the WinRT addon off the main thread
src/
  backend.ts        orchestrator: source → lyrics → Discord
  core/             media source, Discord IPC, providers, DB, Last.fm, …
  sync/             lyrics scheduling engine
ui/
  index.html        window shell
  styles.css        theme tokens (dark + light)
  src/              renderer: state, router, one module per page
```

The renderer is bundled to a classic script: the window loads over `file://`, where Chromium refuses ES module imports.

### Data locations

| | Development | Installed |
| --- | --- | --- |
| Config, DB, logs | repo root | `%APPDATA%\Vybecord` |

---

## Configuration

Everything is in **Settings**. `config.json` is written on save; hand-editing works but is rarely necessary.

A few keys have no UI:

| Key | Purpose |
| --- | --- |
| `bug_report_webhook` | Discord webhook URL that enables in-app bug reports |
| `lastfm_api_key` / `lastfm_api_secret` | Last.fm credentials (also settable in the window) |
| `discord_app_id` | Override the built-in per-platform application IDs |

### Cover art on Discord

Discord's presence needs a URL for the artwork; Windows only hands over a file on disk. Vybecord looks the album up on a public music CDN — Deezer first, then Apple's iTunes Search — and gives Discord that URL. Nothing is uploaded, and nothing leaves the machine but a track and artist name.

Uploading the local file was the obvious approach and it does not work. Discord accepts the presence without complaint and then quietly refuses to fetch the image, so the profile shows a "?" while the same URL opens fine in a browser. That was confirmed against a free public file host and against Discord's own CDN through a user webhook — both refused. Anonymous file hosts also draw antivirus blocks, since they carry everyone's uploads.

Deezer leads on measured coverage. Against 44 tracks from real listening:

| | Found | Right artist |
| --- | --- | --- |
| Deezer | 41/44 | 41 |
| iTunes Search | 24/44 | 20 |

Most of the gap is the query: Deezer accepts a structured `artist:"…" track:"…"` search, while iTunes takes free text and drifts onto karaoke and tribute records — it answered "Oh Dear" by 808Cash with Johnny Cash. A confidently wrong cover is worse than none, so the artist is verified against the result before it is used, and iTunes is only consulted after Deezer misses.

Spotify's version markers are stripped before searching — "Lovesick - Bonus" finds nothing anywhere, "Lovesick" is the first hit, and the same applies to the far more common "- Remastered 2011" and "- Radio Edit". With that, 42 of the 44 resolve; the remaining two are on no catalogue at all and fall back to the default placeholder.

The window itself always shows the artwork straight from the player, which is correct by definition. None of this affects it.

## Troubleshooting

**Nothing is detected.** Check the **Players** page. If it is empty, the app you are using does not publish to the Windows media session API — press a media key and see whether the Windows volume overlay shows the track. If it does not, Vybecord cannot see it either.

**The presence does not appear.** Discord must be the desktop app and already running. The title bar shows a Discord dot; if it is red, Vybecord could not reach the IPC pipe.

**Lyrics are out of sync.** Use the offset control on Now playing. Some players report position lazily, which the 3-second resync corrects but cannot eliminate.

**Wrong lyrics.** Hit **Wrong lyrics** to blacklist that match, or import the correct `.lrc` under Lyrics → Import.

**Lyrics never load.** Check that Show lyrics is on, and that the track is actually identifiable — browser tabs publish whatever the page says, which is often a video title rather than an artist and a song.

**The presence vanishes when I turn on a Spotify private session.** Deliberate, under **Settings → Presence → Hide during a Spotify private session**. It only works with the Spicetify extension installed, because the media session Windows publishes is identical either way — the switch exists nowhere the app can otherwise reach. Turn the setting off if you use private sessions to keep a listen out of your Spotify recommendations rather than for privacy.

**The presence vanishes when I step away.** That is **Settings → Presence → Hide when away**, on by default: after ten minutes without keyboard or mouse input — the same delay after which Discord flips you to Idle — the status is taken down, and touching the machine puts it straight back. Change the delay there, or turn it off.

---

## Migrating from VybecordTS 1.x

The console edition detected playback through a Spicetify extension, Tampermonkey userscripts, and a PowerShell SMTC reader, and was configured through a dashboard served on `localhost:8888`. All of that is gone: detection is native and the UI is the window. A Spicetify extension returned in 2.0.3, but as an optional enhancement rather than the way Spotify is detected.

What that costs: playlist context, shuffle/repeat state, artist images and canonical track URLs are not exposed by the OS, so those fields are empty unless one of the optional extensions supplies them. Presence buttons that relied on them fall back or are omitted. Everything the lyrics pipeline needs — title, artist, album, duration, position — is exposed, so synced lyrics are unaffected.

Your `config.json`, lyrics database, listening history and flagged list all carry over unchanged. The Tampermonkey userscripts can go, and so can the 1.x Spicetify extension — the one shipped from 2.0.3 does a different job and is installed from Settings rather than by hand.

## License

MIT — see [LICENSE](LICENSE).
