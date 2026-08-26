# Vybecord — Getting started

Vybecord shows what you are listening to on your Discord profile, with the lyrics scrolling in real time.

**Nothing to install into Spotify, nothing to install into your browser.** The app reads Windows' own media player information.

---

## What you need

- **Windows 10 version 1809 or newer** (released late 2018 — if your PC is up to date, you are fine)
- **The Discord desktop app**, installed and running — the browser version will not work
- That is all.

---

## Install

1. Download `Vybecord-<version>-setup.exe` from the [releases page](https://github.com/TheUnknownMurda/VybecordTS/releases)
2. Run it, pick a folder, follow the installer
3. Open Vybecord
4. Play some music

Your Discord status updates on its own. There is no setup step.

> **Windows shows a SmartScreen warning?** The app is not signed with a paid certificate. Click "More info" then "Run anyway".

---

## Day to day

### Closing the window does not quit

Vybecord keeps running in the notification area, next to the clock. Click the icon to bring the window back, or right-click → **Quit** to actually exit.

You can change this under **Settings → App → Close to tray**.

### The pages

| Page | What it does |
| --- | --- |
| **Now playing** | Current track, cover, and the scrolling lyrics — click them for the whole song |
| **Players** | Every detected player — useful when more than one thing is playing |
| **Stats** | Your top tracks and artists this session |
| **History** | Your full listening log, plus a "wrapped" summary |
| **Lyrics** | Your own lyrics library, importing, and flagged tracks |
| **Settings** | Everything else |
| **Last.fm** | Scrobbling, if you want it |

Tip: keys **1–8** jump between pages.

---

## Common problems

### Nothing is detected

Open the **Players** page. If it is empty, your player does not talk to Windows.

**How to check:** press a media key (play/pause) on your keyboard. If the Windows volume overlay shows the track name, Vybecord can see it too. If it shows nothing, Vybecord cannot see it either — that is a limitation of the player, not the app.

### The status does not show on Discord

- Discord must be the **desktop app**, and must be running
- Look at Vybecord's title bar: if the dot next to "Discord" is red, the connection failed. Restart Discord, then Vybecord.
- In Discord, check **Settings → Activity Privacy → Display current activity** is on

### No lyrics

- Check that **Settings → Lyrics → Show lyrics** is on
- Some tracks simply have no synced lyrics published anywhere
- From a browser tab, the published title is often the video name ("Artist - Title (Official Video)") rather than a clean track title, which makes matching less reliable

### No lyrics on a YouTube video

Captions are a fallback, used only when no synced lyrics exist for the track. They need **yt-dlp**, which now ships with Vybecord — there is nothing to install.

**Settings → Lyrics → YouTube captions** shows which copy is in use. To run your own instead, drop `yt-dlp.exe` in the folder that card opens; it takes priority over the bundled one.

Not every video has captions, and the video has to be findable by its title and channel — the browser tells Windows what is playing, but not which page it is on, so Vybecord searches YouTube for it.

### Lyrics are out of sync

On **Now playing**, use the **−250 / +250** buttons under the lyrics. The offset is remembered and applies to later tracks too.

### Wrong lyrics

Click **Wrong lyrics**. That result will never be reused for this track. You can then import the correct file under **Lyrics → Import**, or undo the flag under **Lyrics → Flagged**.

### My status disappears during Spotify ads

That is on purpose. Without the filter your Discord profile would announce "Monster Energy" as though it were a song.

Spotify does not flag its ad breaks — it just swaps the track metadata for the advertiser's. Vybecord spots them by **duration**: every ad observed ran 30 seconds, while the shortest of 44 real tracks sampled ran 83. So a Spotify track under a minute is treated as an ad.

Album interludes and skits are spared: an interlude belongs to the album already playing, an ad never does.

While an ad plays the window says "Advertisement", so you know it is not a bug. You can turn the filter off under **Settings → Detection**.

### My status disappears when I turn on a Spotify private session

Deliberate: you told Spotify not to broadcast what you are listening to, and Vybecord follows. The track keeps playing and the lyrics keep scrolling in the window — only the publishing to Discord stops, and it resumes the moment you leave the private session. **Now playing** shows a crossed-out eye while that is the case.

Anything else you play is unaffected: a YouTube video is still announced during a Spotify private session, which is a statement about Spotify and nothing else.

**This needs the Spicetify extension.** The switch is invisible from outside the client — the media session Spotify publishes to Windows is identical either way — so without the extension Vybecord has no way to know, and the presence stays up. One button installs it, under **Settings → Spotify via Spicetify**.

If you use private sessions to keep a listen out of your Spotify recommendations rather than for privacy, turn the setting off under **Settings → Presence → Hide during a Spotify private session**.

### My status disappears when I step away

Deliberate, and adjustable. After ten minutes without keyboard or mouse input — the same delay after which Discord itself flips you to Idle — Vybecord takes the presence down, exactly as Discord's own Spotify integration does. Touch the machine and it comes straight back on whichever line the song has reached.

The music is never interrupted; only the publishing to Discord is paused. **Now playing** shows a crescent moon while that is the case, so an empty profile is never a mystery.

The delay lives in **Settings → Presence → Away after**, and the switch just above it, **Hide when away**, turns the whole thing off.

### The cover does not show on Discord (but shows in the window)

The window reads the artwork straight off your disk. Discord cannot — it needs a URL, so Vybecord looks the album up on a public music CDN and hands Discord that.

If a track shows the default placeholder instead, it is simply not in the catalogue — usually an unreleased track or a local file. **Settings → Presence → Cover images → Test with the current track** tells you which case you are in.

Uploading your own file does not help: Discord accepts the presence and then refuses to load the image, showing a "?". That was tried both with a public file host and with Discord's own CDN.

### Getting more detail from browser playback

Windows tells Vybecord what is playing, not which website it is on: a SoundCloud tab and a YouTube tab look identical.

The optional extension in the `extension/` folder fixes that. Load it via `chrome://extensions` → Developer mode → **Load unpacked**, and pick that folder. Its icon opens a settings page with a switch per site — Spotify, YouTube, SoundCloud, Bandcamp, Twitch, Kick — all on by default.

With it, each site is identified properly, the presence links straight to the track, and the progress bar reads the page's own audio element instead of the coarser system position. Without it, everything below still applies.

### SoundCloud shows as a browser, not as SoundCloud

Windows tells Vybecord what is playing, not which website it is on: a SoundCloud tab and a YouTube tab look identical. Only the userscripts could tell them apart, and they are gone.

What still works: the track and artist are parsed with SoundCloud's conventions in mind, so an upload titled "Artist - Track (prod. Someone)" resolves to the right artist rather than the uploading account. Lyrics, cover art and the presence itself are unaffected — they key on the track and artist, not the site.

What does not: the per-site toggle under Settings → Detection. Browser playback is governed by the **Browser tabs** switch instead.

### Two things playing at once

Go to **Players** and click the one you want announced. It stays pinned until you click **Automatic**.

---

## FAQ

**Does this need Spotify Premium?**
No. Vybecord never talks to Spotify's API — it reads what Windows already knows.

**Do I need Spicetify or a browser extension?**
No. Older versions did; this one does not.

**What does it work with?**
Anything that appears in the Windows media overlay: Spotify, browser tabs (YouTube, SoundCloud, Deezer…), VLC, foobar2000, MusicBee, AIMP, Apple Music, Tidal, Amazon Music.

**Does my data leave my PC?**
Track and artist names go to the lyrics services (LRCLib, Netease, Musixmatch) to look lyrics up, and to Discord for the status. If you enable Last.fm, they go there too. Your history and imported lyrics stay local.

**Where are my files?**
In `%APPDATA%\Vybecord` — paste that into Explorer.

**I'm coming from VybecordTS 1.x — do I lose anything?**
Your config, lyrics database and history all carry over. You do lose playlist context, shuffle/repeat state and clickable track links: Windows does not expose them. You can uninstall the Spicetify extension and the Tampermonkey scripts.

---

## Support

Something broken? Use the **Report** page in the app, or open an issue on [GitHub](https://github.com/TheUnknownMurda/VybecordTS/issues).
