# Release notes

## 2.0.3 — The LRCLIB dump, and pinning that means it

### What changed

**Fixed: searching the LRCLIB dump froze the app.** One keystroke could stop the window, the tray and the Discord presence for minutes. The query asked SQLite to join and sort every matching row before taking thirty, and the last word typed is prefix-matched — so two letters matched millions of tracks in a 120 GB file. Measured on a 31.9M-track dump, a two-letter search never finished at all; it was killed after seven minutes. The FTS scan is now capped before anything is joined, and the join order is pinned, because left to itself the planner drove from the lyrics table and scanned every row with lyrics in the dump. The same two-letter search returns in 259ms. A trailing single letter is dropped rather than paid for: FTS5 has to open a cursor on every term in the index starting with that letter, hundreds of thousands of them, however selective the rest of the query is.

**The dump now runs on its own thread.** better-sqlite3 is synchronous, so even a fast query on a file that size is time the main thread is not painting. The dump lives in a worker (`electron/lrclib-worker.ts`), and the whole of its SQL moved with it. During a 753ms query the main thread ticked 36 times, worst gap 23ms — it no longer stops at all. The playback lookup went across too, so a track change never blocks the presence either.

**The drop folder is the instruction.** A dump left under the name it was downloaded under, or renamed, is still plainly the one that was put there — the largest SQLite file in the folder is used, whatever it is called. Renaming a 100 GB file is not something to make someone do twice.

**The two databases are now told apart by name.** The dump is `lrclib-dump.sqlite3` and the imported-lyrics store is `custom-lyrics.sqlite3`. They used to be `db.sqlite3`, which says nothing, and `lrclib-custom.sqlite3`, near-identical to the `lrclib-*.sqlite3` names a downloaded dump arrives under — close enough that the auto-detection itself confused them and reported a dump was loaded while every search came back empty. Existing installs are read under the old names, and the imported-lyrics store is renamed once on startup.

**Pinning a player is exclusive again, everywhere.** It was already exclusive among Windows' own media sessions, but the browser extension outranked all of them, so pinning Spotify while a tab played changed nothing. Every source now answers to the pin: the extension, Spicetify, and the OS sessions alike. A pin binds a player and not a transport, so the extension reporting the same service as the pinned session still counts as that player — pinning a tab keeps the extension's better data rather than throwing it away.

**Fixed: Discord kept showing the previous player.** Each platform announces under its own Discord application, so changing player closes the IPC socket and opens a new one, and the reconnect published the idle presence instead of the track that was already playing. Nothing republished until the next heartbeat — long enough for pinning to look like it did nothing, and long enough for the new player's track to appear under the old one's name. It now republishes the moment the socket is ready. Changing player a few times in a row also used to make Discord refuse connections for tens of seconds; App ID changes are coalesced, so a burst costs one reconnect and the presence keeps flowing meanwhile.

**New: Spotify's own lyrics, through Spicetify.** The client's lyrics endpoint is reachable only from inside the client, which is exactly where the Spicetify extension runs — so it fetches them on song change and hands them over. Only line-synced lyrics are used; an unsynced blob stamps every line at zero and would show the whole song at once. Tracks with no lyrics answer 404, which is the normal case for a good part of the catalogue and passes silently to the existing providers. Lyrics that arrive before the track starts are now used rather than stored and forgotten, and the loopback endpoint admits the Spotify client on the lyrics path — it did not, so the whole thing would have failed with a 403 nobody would ever have seen.

**Presence changes are logged.** One line per genuine change, heartbeats silent, so "Discord is showing the wrong player" can be answered from the log instead of guessed at.


## 2.0.0 — Desktop app

Vybecord is now a single desktop application. Detection is native, the interface lives in the window, and there is nothing left to install into Spotify or your browser.

### What changed

**One source, no setup.** The Spicetify extension, the Tampermonkey userscripts and the PowerShell SMTC reader are all gone. Playback is read directly from the Windows media session API through a native addon, so any app that publishes to it — Spotify, browser tabs, VLC, foobar2000, MusicBee, AIMP, Apple Music, Tidal — is detected the moment you press play.

**No PowerShell process.** The old reader spawned a long-running `powershell.exe`, which is what attracted most of the antivirus false positives. Nothing spawns a shell now.

**No HTTP server.** The dashboard on `localhost:8888` is replaced by the app window, and its routes by IPC. The port is gone, and with it the whole class of "any page in any browser could POST to it" concern that the Origin and Host checks existed to hold shut.

**Faster start.** Roughly 300ms to a live presence, down from several seconds waiting on the PowerShell reader to initialise WinRT.

**New: player picker.** The Players page lists every media session Windows reports. When several things play at once, pin the presence to the one you actually mean instead of relying on the priority order.

**New: Spotify ad filter.** Ad breaks no longer land on your Discord profile. Spotify marks them in no way at all — it swaps the session metadata for the advertiser's — so this is a heuristic built on duration: every ad observed ran 30 seconds, while the shortest of 44 consecutive real tracks sampled ran 83. A short track that belongs to the album already playing is left alone, so interludes and skits still show. On by default, under Settings → Detection.

**Cover art is looked up on a music CDN, and never uploaded.** Discord's image proxy refuses to fetch from free file hosts — it accepts the activity, then shows a "?" on the profile while the URL opens fine in a browser. The album is now looked up on Deezer's public API (no key) and Discord is given that CDN URL; uploading was removed entirely — it was also tried through a Discord webhook, and Discord refused its own CDN links too. Tracks on no catalogue show the default placeholder. Deezer was picked on measured coverage against 44 real tracks: 41 found and all with the right artist, against 24 found and 20 right for the iTunes Search API.

**Cover hosting avoids anonymous file hosts flagged by antivirus.** uguu.se was briefly used as a fallback and Bitdefender blocked it as an infected web resource, naming Vybecord as the process that reached it. Anonymous hosts carry other people's malware, so vendors block the whole domain. Host reputation is now a stated requirement for anything in that chain.

**Fixed: the progress bar drifting and jumping backwards.** Anchors were being reset from position readings Spotify had already served — it reports `lastUpdatedTime` as the read time, not the measurement time, so a stale value looked fresh. The bar sawtoothed by up to 2.6 seconds. Anchors now only move on a genuinely new reading, and the window's own clock counts from a timestamp instead of adding a fixed step per tick, which was quietly losing time under load.

**Fixed: YouTube captions never ran for browser playback.** The retired userscripts declared `media_source: 'youtube'`; the OS session reports only "MSEdge" and publishes the video title as the track and the channel as the artist, with nothing naming the site. The caption path required a literal 'youtube' and so was unreachable for browser tabs — which is where nearly all YouTube listening happens. Browser sessions now qualify, and the caption search resolves the actual video, which restores the direct "watch this video" link the userscript used to supply. Captions in "auto" mode also follow the system language instead of a hardcoded French-then-English order.

**Better metadata from browser tabs.** A media session says what is playing but not which site it is on, so SoundCloud arrives indistinguishable from YouTube and the SoundCloud-specific parsing was unreachable. Those rules — stripping producer credits, handling `//` and `|` separators, preferring the artist in the title over the uploading account — now apply to every browser tab, since the conventions are shared and harmless elsewhere. "Juice WRLD - Lucid Dreams (prod. Nick Mira)" uploaded by "JuiceWorlddd" now resolves to the right artist and a clean title.

**yt-dlp ships with the app.** YouTube captions need it and there is no alternative — the public timedtext endpoint, the InnerTube player API and scraping the watch page were each measured, and all three return the track list and then zero bytes for the track itself, even from inside a real YouTube page with the right origin and cookies. YouTube requires a proof-of-origin token its own player generates. So the binary is bundled, downloaded at build time and verified against the release's SHA2-256SUMS. Your own copy still wins if you drop it in the app's bin folder. The installer grows by 17MB.

**Missing yt-dlp is now visible.** Captions need it, and without it the feature did nothing while its switch still read as on — indistinguishable from a bug, with the reason buried in a log. Settings → Lyrics now reports whether it was found, and offers a download link plus a folder to drop it in, so nobody has to edit their PATH.

**Captions pick a language you can read.** Manual subtitles outranked auto-generated ones regardless of language, so an English talk whose only manual track was Italian played its captions in Italian. A readable language now comes first, falling back to a manual track in any language only when nothing else exists. With the extension installed, captions are also fetched from the exact video rather than searched for by title.

**New: optional browser extension.** Windows reports what is playing but never where, so a SoundCloud tab and a YouTube tab are indistinguishable to it. The extension in `extension/` reads the page directly and restores what the retired userscripts provided: the site, the canonical track link, position from the page's own audio element, and live-stream uptime, for Spotify web, YouTube, SoundCloud, Bandcamp, Twitch and Kick. Each site has its own switch in the extension's options. The six scrapers are the original userscripts carried over unchanged behind a small compatibility shim, so their proven logic was not re-derived. The app listens on 127.0.0.1:8888 only while the integration is enabled, answers six push paths and nothing else, and accepts only extension origins.

**New: window UI.** Now playing, Players, Stats, History, Lyrics library, Settings, Last.fm and Report, in a frameless window with dark and light themes. Closes to the tray so the presence keeps running.

### What you lose

The OS media session exposes less than the push sources did. These fields are simply not available any more:

- Playlist / album context (which playlist a track is playing from)
- Shuffle and repeat state
- Artist profile images
- Canonical track, album and artist URLs — presence buttons that relied on them now fall back or are omitted

Everything the lyrics pipeline needs — title, artist, album, duration, position — is exposed, so synced lyrics are unaffected.

YouTube caption lookup no longer receives a video ID (the userscript used to supply it), so it searches by title and artist instead. Matching is best-effort.

Kick and Twitch detection is removed: a live stream in a browser now appears as a browser session like any other tab.

### Upgrading

Your `config.json`, lyrics database, listening history and flagged list carry over unchanged. Installed builds move their data to `%APPDATA%\Vybecord`.

You can uninstall the Spicetify extension and the Tampermonkey userscripts — they no longer do anything.

### For developers

- Electron 41, pinned exactly: better-sqlite3 publishes prebuilt binaries per Electron ABI, and only up to a given one. `npm install` fetches the matching prebuild, so **Visual Studio Build Tools are no longer required** to build the app.
- The WinRT addon runs on a worker thread. Electron's main thread is an STA COM apartment, where the media session calls block forever with no error to catch.
- `npm run dist` produces the NSIS installer in `release/`.

---

## 1.x — Console edition

The previous generation ran as a console application with a web dashboard on `localhost:8888`, and detected playback through three separate integrations: a Spicetify extension for Spotify, Tampermonkey userscripts for YouTube, SoundCloud, Bandcamp, Twitch and Kick, and a PowerShell-based Windows media session reader for everything else.

Those releases remain available on the [releases page](https://github.com/TheUnknownMurda/VybecordTS/releases) for anyone who depends on the metadata the push sources provided.
