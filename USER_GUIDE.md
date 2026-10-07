# Vybecord — Getting started

Vybecord shows what you are listening to on your Discord profile, with the lyrics scrolling in real time.

**Nothing to install into Spotify, nothing to install into your browser.** The app reads Windows' own media player information. Two optional extensions — one for Spotify, one for your browser — add detail, but everything works without them.

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

Your Discord status updates on its own. The first time, Vybecord opens on **Help & setup**, a short checklist that ticks itself off: the Discord app is open, and something is playing. The optional add-ons are listed under it.

> **Windows shows a SmartScreen warning?** The app is not signed with a paid certificate. Click "More info" then "Run anyway".

---

## Day to day

### Closing the window does not quit

Vybecord keeps running in the notification area, next to the clock. Click the icon to bring the window back, or right-click → **Quit** to actually exit.

You can change this under **Settings → App & window → Close to tray**.

### The pages

| Page | What it does |
| --- | --- |
| **Now playing** | The current track (cover, title, artist, album, player and progress), a preview of your Discord card as your friends see it right under it, and the scrolling lyrics (click them for the whole song, or **Big lyrics** to fill the window with them, Spotify style; **Esc** closes it). The **Source** menu picks which player it follows. |
| **Lyrics** | Your own lyrics library: **My lyrics**, **Blocked** (lyrics you marked as wrong) and the offline **LRCLIB dump**. **Add lyrics** imports or writes new ones. |
| **Activity** | What you listened to over 7 days, 30 days, 12 months or all time: time listened, a chart, top artists and tracks, and your recent plays (**See all** opens the full history). |
| **Settings** | Discord presence, Lyrics & translation, Detection, Integrations (browser extension, Spotify, Last.fm), App & window, and About. The search box finds any setting. |
| **Help & setup** | The setup checklist, at the bottom of the sidebar. |

The bottom of the sidebar also says whether Discord is connected and what is being detected.

Tip: keys **1–4** jump between Now playing, Lyrics, Activity and Settings. **Ctrl+Q** quits.

---

## Common problems

### Nothing is detected

On **Now playing**, open the **Source** menu. It lists every player Windows reports; if it is empty, your player does not talk to Windows.

**How to check:** press a media key (play/pause) on your keyboard. If the Windows volume overlay shows the track name, Vybecord can see it too. If it shows nothing, Vybecord cannot see it either — that is a limitation of the player, not the app.

### The status does not show on Discord

- Discord must be the **desktop app**, and must be running
- Look at the bottom of Vybecord's sidebar: if it says **Discord not found**, the connection failed. Restart Discord, then Vybecord. When Discord is connected but nothing shows, the line under it says why (Rich Presence off, hidden while you are away, an ad…).
- In Discord, check **Settings → Activity Privacy → Display current activity** is on

### No lyrics

- Check that **Settings → Lyrics & translation → Show lyrics** is on
- Some tracks simply have no synced lyrics published anywhere
- From a browser tab, the published title is often the video name ("Artist - Title (Official Video)") rather than a clean track title, which makes matching less reliable

### No lyrics on a YouTube video

Captions are a fallback, used only when no synced lyrics exist for the track. They need **yt-dlp**, which now ships with Vybecord — there is nothing to install.

**Settings → Lyrics & translation → YouTube captions** shows which copy is in use. To run your own instead, drop `yt-dlp.exe` in the folder that card opens; it takes priority over the bundled one.

Not every video has captions, and the video has to be findable by its title and channel — the browser tells Windows what is playing, but not which page it is on, so Vybecord searches YouTube for it.

### Lyrics are out of sync

On **Now playing**, use the **−250 / +250** buttons under the lyrics. The offset is saved for that track only, so it is right again the next time the song comes round without pulling every other song off. Tracks you have never corrected use the default under **Settings → Lyrics & translation → Default timing offset**.

### Wrong lyrics

On **Now playing**, click **Wrong lyrics?** under the lyrics and say what is wrong:

- **The words are wrong** — that result will never be reused for this track, and the next source gets its turn. You can undo it under **Lyrics → Blocked** (**Allow again**).
- **The timing is off** — the lines are carried over to the lyrics editor, where **Sync while playing** lets you re-time them against the song and save your own copy. Your copy wins over anything fetched online.

### My status disappears during Spotify ads

That is on purpose. Without the filter your Discord profile would announce "Monster Energy" as though it were a song.

Spotify does not flag its ad breaks — it just swaps the track metadata for the advertiser's. Vybecord spots them by **duration**: every ad observed ran 30 seconds, while the shortest of 44 real tracks sampled ran 83. So a Spotify track under a minute is treated as an ad.

Album interludes and skits are spared: an interlude belongs to the album already playing, an ad never does.

While an ad plays the window says "Advertisement", so you know it is not a bug. You can turn the filter off under **Settings → Discord presence → Hide during Spotify ads**.

### My status disappears when I step away

Deliberate, and adjustable. After ten minutes without keyboard or mouse input — the same delay after which Discord itself flips you to Idle — Vybecord takes the presence down, exactly as Discord's own Spotify integration does. Touch the machine and it comes straight back on whichever line the song has reached.

The music is never interrupted; only the publishing to Discord is paused. **Now playing** says so while that is the case, so an empty profile is never a mystery.

The delay lives in **Settings → Discord presence → Away after**, and the switch just above it, **Hide when I'm away**, turns the whole thing off.

### The cover does not show on Discord (but shows in the window)

The window reads the artwork straight off your disk. Discord cannot — it needs a URL, so Vybecord looks the album up on a public music catalogue (Deezer, then Apple's iTunes) and hands Discord that.

Music that is in no catalogue — your own rips, demos, DJ sets — has artwork nowhere but in your file. For those, Vybecord publishes that one image to its own cover store so Discord can load it: never the audio, and with camera and location tags stripped first. That is **Settings → Integrations → Cover images → Publish artwork that exists only on this PC**, on by default.

So a placeholder on Discord means one of two things: the track is in no catalogue and that switch is off, or it is a live stream, which is never looked up.

### Getting more detail from browser playback

Windows tells Vybecord what is playing, not which website it is on: a SoundCloud tab and a YouTube tab look identical.

The optional browser extension fixes that. **Settings → Integrations → Browser extension** walks you through it:

- **Chrome, Edge, Brave, Opera, Vivaldi** — click **Open the extension folder**, open your browser's extensions page (the card copies its address for you), turn on **Developer mode**, click **Load unpacked** and pick that folder.
- **Firefox 121 or newer** — download `vybecord-extension-<version>-firefox.zip` from the [releases page](https://github.com/TheUnknownMurda/VybecordTS/releases/latest), open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on** and pick the zip. Firefox removes temporary add-ons when it closes.

Its icon opens a settings page with a switch per site — Spotify, YouTube, SoundCloud, Bandcamp, Twitch, Kick — all on by default.

With it, each site is identified properly, the presence links straight to the track, and the progress bar reads the page's own audio element instead of the coarser system position. Without it, everything below still applies.

### SoundCloud shows as a browser, not as SoundCloud

Without the browser extension, Windows tells Vybecord what is playing but not which website it is on: a SoundCloud tab and a YouTube tab look identical. Install the extension (above) and SoundCloud is announced as SoundCloud, with a link to the track.

Even without it, the track and artist are parsed with SoundCloud's conventions in mind, so an upload titled "Artist - Track (prod. Someone)" resolves to the right artist rather than the uploading account. Lyrics, cover art and the presence itself are unaffected — they key on the track and artist, not the site. Until the site is identified, that tab is governed by the **Other browser tabs** switch under **Settings → Detection** rather than the **SoundCloud** one.

### Two things playing at once

On **Now playing**, open the **Source** menu and pick the one you want announced. It stays pinned until you pick **Automatic**.

Or show them all. **Settings → Discord presence → Several presences** puts up to five cards on your profile: the song in Spotify on presence 1, the video in the browser on presence 2, a stream in another tab on presence 3, say. The highest-ranked thing playing is presence 1 (a music app beats a video, a video beats an unnamed tab), the next is presence 2, and so on. With more than one:

- Tabs of the same site are separate things: four Twitch streams open side by side take four cards. A Discord application carries one card, so the others borrow one — the default Vybecord application, then any spare you set, then a platform application nothing is on — and the card names its platform in the header either way.
- **Lyrics on presence N** picks which cards sing along — any combination.
- **Now playing** shows every card; click one to see its lyrics, its Discord preview and its controls. Its **Source** menu pins that presence to a player, so it never swaps with another.
- The listening history (and so **Activity**) and Last.fm follow presence 1 only.

Each card is a Discord application of its own, and Spotify, YouTube, SoundCloud, Apple Music, Kick and Twitch each have one; with the default that is seven, and a card whose own application is taken borrows a free one. Only past seven cards' worth — or if you would rather not borrow — do the **Spare application IDs** matter (create one at discord.com/developers; up to four).

---

## FAQ

**Does this need Spotify Premium?**
No. Vybecord never talks to Spotify's API — it reads what Windows already knows.

**Do I need Spicetify or a browser extension?**
No. Older versions did; this one does not. Both are optional extras: Spicetify adds instant track changes and Spotify's own lyrics (set it up under **Settings → Integrations → Spotify**), and the browser extension tells Vybecord which site a tab is on.

**What does it work with?**
Anything that appears in the Windows media overlay: Spotify, browser tabs (YouTube, SoundCloud, Deezer…), VLC, foobar2000, MusicBee, AIMP, Apple Music, Tidal, Amazon Music.

**Does my data leave my PC?**
Track and artist names go to the lyrics services (LRCLib, Netease, Musixmatch, Genius) to look lyrics up, to Deezer and Apple's iTunes to find the album cover, and to Discord for the status. Artwork that exists only in your own files is published to Vybecord's cover store, stripped of its metadata — switch that off under **Settings → Integrations → Cover images**. If you turn on translation, the lyric lines go to the translation service; if you enable Last.fm, your plays go there. Your history, settings and imported lyrics stay local. The full list is in the [privacy policy](https://theunknownmurda.github.io/VybecordTS/privacy/).

**Where are my files?**
In `%APPDATA%\Vybecord` — paste that into Explorer.

**I'm coming from VybecordTS 1.x — do I lose anything?**
Your config, lyrics database and history all carry over. Windows alone does not expose playlist context, shuffle/repeat state or clickable track links; the optional Spicetify and browser extensions bring them back. Uninstall the old 1.x Spicetify extension and the Tampermonkey scripts — the new Spicetify extension is set up from Settings instead.

---

## Support

Something broken? Use **Settings → About → Report a problem** in the app (also on **Help & setup**), or open an issue on [GitHub](https://github.com/TheUnknownMurda/VybecordTS/issues).
