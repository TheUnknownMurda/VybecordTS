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

Vybecord keeps running in the notification area, next to the clock. Click the icon to bring the window back, or right-click → **Quit** to actually exit. The same right-click menu works without opening the window: it shows the song playing, opens any page (**Go to**), and has switches for **Show on Discord**, **Show lyrics** (one per presence when there are several), **Translate lyrics on Discord**, the number of **Presences**, which players are detected (**Detection**, one switch per platform as in Settings), **Hide when paused**, **Hide when I’m away**, **Hide during Spotify ads** and **Launch at sign-in**, plus **Check for updates**. They are the same settings as in the window.

You can change this under **Settings → App & window → Close to tray**. The same page has **Theme** (dark or light) and **Accent colour**, the green of the buttons, switches and links: pick a swatch or any colour, and the background takes its tint too (Emerald, the default, keeps the original neutral background). Your Discord card keeps Discord's own colours.

### After an update

Updates download on their own and install when you quit. The first time you open the window on the new version, **What's new** shows what changed, with a link to the full release notes. It shows once; **Settings → About → What's new** brings it back.

### The pages

| Page | What it does |
| --- | --- |
| **Now playing** | Two sides, like a mirror. **On your screen**, on the left: the current track (cover, title, artist, album, player and progress; paused, it stays on the card with its bar stopped, until you close the player or switch its detection off) and the scrolling lyrics (click them for the whole song, or **Big lyrics** to fill the window with them, Spotify style; **Esc** closes it). Lyrics found without timings show as plain text you can scroll, marked **Words only**. **On Discord**, on the right: your card as your friends see it, with its **Source** menu, which picks the player it follows. **Click any part of the card** (or **Customize**) to change it: what the lines show, the verb, the icon on the cover, your button… In the middle, switches with an arrow toward the side they change: **Visible** takes your status off Discord or puts it back, **Lyrics** turns them on or off on both sides, **Romanise** and one of the two **Translate** act on Discord, the other **Translate** on the window, and **Hide on Discord when** covers pauses, being away and Spotify ads. **Why?** says what is keeping your card off Discord, with a button to fix it. |
| **Lyrics** | Your own lyrics library: **My lyrics**, **Blocked** (lyrics you marked as wrong) and the offline **LRCLIB dump**. **Add lyrics** imports or writes new ones. |
| **Activity** | What you listened to over 7 days, 30 days, 12 months or all time: time listened, a chart, top artists and tracks, and your recent plays (**See all** opens the full history). It updates by itself as songs finish. |
| **Settings** | Discord presence, Lyrics & translation, Detection, Integrations (browser extension, Spotify through Spicetify or your own Spotify app, Last.fm), App & window, and About. The search box finds any setting. |
| **Help & setup** | The setup checklist, at the bottom of the sidebar. |

The bottom of the sidebar also says whether Discord is connected and what is being detected.

Tip: keys **1–4** jump between Now playing, Lyrics, Activity and Settings. **Ctrl+Q** quits.

---

## Common problems

### Nothing is detected

On **Now playing**, open the **Source** menu. It lists every player Windows reports; if it is empty, your player does not talk to Windows.

**How to check:** press a media key (play/pause) on your keyboard. If the Windows volume overlay shows the track name, Vybecord can see it too. If it shows nothing, Vybecord cannot see it either — that is a limitation of the player, not the app.

### The status does not show on Discord

- On **Now playing**, click **Why?**, top right: it checks everything between the song and your card and says what is in the way, with a button that fixes it.
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

An **age-restricted** video shows "🔞 CC unavailable": YouTube gives its captions only to a signed-in, age-verified account. If you watch it in a browser with the extension, turn on **Share my YouTube sign-in for captions** in the extension's options (off by default; your browser asks for permission). The extension then hands your YouTube cookies to Vybecord, only for videos that come back age-restricted, and the captions replace the 🔞 line a few seconds later. Vybecord keeps the cookies in memory only. A browser that isn't signed in to YouTube has nothing to lend.

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

### With nothing playing, my card says "Nothing playing"

Once no player has anything at all, presence 1 shows **Listening to Vybecord · Nothing playing** with the Vybecord logo. For its first five seconds Discord's Active Now list still shows the last player's icon beside it; then the card moves onto Vybecord's own application and the icon follows. To show nothing at all instead, turn on **Hide when paused**.

### The cover does not show on Discord (but shows in the window)

The window reads the artwork straight off your disk. Discord cannot — it needs a URL. So Vybecord publishes the cover your player shows (Spotify's, Apple Music's, or the one inside a local file) to its own cover store, and Discord loads it from there: never the audio, and with camera and location tags stripped first. That is **Settings → Integrations → Cover images → Publish the player's cover**, on by default.

Only when there is no such cover — that switch is off, or the player gave none — does Vybecord look the album up on a public music catalogue (Deezer, then Apple's iTunes) instead.

So a placeholder on Discord means one of two things: that switch is off and the track is in no catalogue, or it is a live stream, which is never looked up.

### Getting more detail from browser playback

Windows tells Vybecord what is playing, not which website it is on: a SoundCloud tab and a YouTube tab look identical.

The optional browser extension fixes that. **Settings → Integrations → Browser extension** walks you through it:

- **Chrome, Edge, Brave, Opera, Vivaldi** — click **Open the extension folder**, open your browser's extensions page (the card copies its address for you), turn on **Developer mode**, click **Load unpacked** and pick that folder.
- **Firefox 140 or newer** (also Zen, LibreWolf, Waterfox, Floorp) — download `vybecord-extension-<version>-firefox.zip` from the [releases page](https://github.com/TheUnknownMurda/VybecordTS/releases/latest), open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on** and pick the zip. Firefox removes temporary add-ons when it closes.
- **Safari** isn't supported: there is no Safari for Windows.

Its icon opens a settings page with a switch per site — Spotify, YouTube, SoundCloud, Bandcamp, Twitch, Kick — all on by default, and the optional **Share my YouTube sign-in for captions** switch (off by default, see the captions section above).

With it, each site is identified properly, the presence links straight to the track, and the progress bar reads the page's own audio element instead of the coarser system position. Without it, everything below still applies.

### Spotify details without Spicetify

Spicetify is the fullest way to read Spotify, but it patches the Spotify app. If you have **Spotify Premium** and would rather not, Vybecord can ask Spotify's own API instead, with a Spotify app of your own. **Settings → Integrations → Spotify → Spotify without Spicetify** walks you through it:

1. On the [Spotify developer dashboard](https://developer.spotify.com/dashboard), create an app (any name and description). Where it asks which APIs you plan to use, tick **Web API**.
2. In the app's settings, add this Redirect URI, exactly: `http://127.0.0.1:8889/callback`. The card has a **Copy** button for it.
3. Paste the app's **Client ID** into the card and click **Save**. There is no secret to copy.
4. Click **Sign in with Spotify** and approve the page that opens in your browser. It only lets the app see what you are playing.

You then get the real cover, every artist, the playlist, shuffle and repeat and the exact position, on whatever device you play (the PC, the web player, your phone). Spotify's own lyrics are the one thing it cannot give: lyrics come from the usual sources. A track change shows within a few seconds rather than instantly. While Spicetify is reporting, this stands by.

Spotify only runs such an app while its owner (you) has Premium. If the card says Spotify refused, add your Spotify e-mail under **User Management** in the app's settings. Spotify ends the sign-in six months after you signed in, so the card warns you two weeks ahead; sign in again then. If Spotify's page says **INVALID_CLIENT: Invalid redirect URI**, the Redirect URI in your app isn't exactly the one above.

### SoundCloud shows as a browser, not as SoundCloud

Without the browser extension, Windows tells Vybecord what is playing but not which website it is on: a SoundCloud tab and a YouTube tab look identical. Install the extension (above) and SoundCloud is announced as SoundCloud, with a link to the track.

Even without it, the track and artist are parsed with SoundCloud's conventions in mind, so an upload titled "Artist - Track (prod. Someone)" resolves to the right artist rather than the uploading account. Lyrics, cover art and the presence itself are unaffected — they key on the track and artist, not the site. Until the site is identified, that tab is governed by the **Other browser tabs** switch under **Settings → Detection** rather than the **SoundCloud** one.

### Twitch and Kick

With the extension, a Twitch or Kick tab gets a card for whatever it is on:

- **A live channel** — the channel, the stream's title, the category, and how long it has been live.
- **An offline channel** — the channel and **Offline**, with its last stream's title on the cover. It only takes a card nothing else wants, so music always comes first. To have such a tab show nothing at all, turn off **Offline channels** under **Settings → Detection**.
- **A past broadcast or a clip** — the channel, the video's title and a progress bar. These used to show up as YouTube.

The channel's name and picture come from Twitch itself (and from Kick's own site on Kick), so a card no longer opens on somebody else's name or on your own avatar while the page loads. The picture stays the channel's, the category shows when you hover it, and clicking it opens the category's page (Just Chatting, the game being played…). On Kick that link needs the extension 2.2.3 or later; before that, the picture opens the channel. After updating Vybecord, click the reload arrow on the extension in your browser's extensions page so it picks up the new version.

**Kick captions as lyrics.** Turn on captions (**CC**) in Kick's player and, on a live channel or a past broadcast, what is said shows on the card the way a song's lyrics do: the line before on top and, under it, the line being said, growing word by word as the player shows them. The **Now playing** window marks them **Live captions** (just **Captions** on a past broadcast). It works with both kinds Kick offers: captions that come with the stream, and the ones Chrome makes from the stream's sound. The extension reads them off the player, so it only sees them while they are on, and the card goes back to the stream's title when nobody has spoken for 25 seconds. Skip ahead or back in a past broadcast and the lines start over from where you land. With translation on, each line is translated once it is complete. When people talk fast, Kick's own player skips lines it has no room for, and those can't reach the card either. The **Lyrics** switch turns them off like any lyrics. Twitch streams and past broadcasts, and clips on either site, have no lyrics.

### YouTube Shorts

With the extension (2.2.2 or later), a Short gets a card of its own instead of passing as a browser tab:

- **[Shorts]** before the Short's title, and its hashtags after it, wherever the title had them (#shorts itself goes: [Shorts] already says it);
- its channel, which opens the channel's page. When the extension cannot read the link off the page, Vybecord asks YouTube for it, so the link can come a few seconds after the Short;
- the Short's own picture, upright, rather than a strip of it between two blurred bands;
- **YouTube Shorts** as the third line, and the Short's own progress bar, from its start to its end, which starts over with every loop;
- **Watching**, or **Listening to** if you prefer: that is **Settings → Discord presence → Activity type for Shorts**, also a click away on the card's verb in **Now playing**. It covers every card, and everything that is not a Short keeps its own verb;
- the button opens the Short.

A Short is never looked up as a song: its title is not a song's name, and a song playing under it is a few seconds from the middle, which a song's timings would not follow. If the Short has captions on YouTube, what is said shows on the card, like a video's. Shorts stay out of the listening history, **Activity** and Last.fm, the way an offline channel does. Without the extension, Windows only sees a browser tab, and a Short shows the way it used to.

### Two things playing at once

On **Now playing**, open the **Source** menu and pick the one you want announced. It stays pinned until you pick **Automatic**.

Or show them all. **Settings → Discord presence → Several presences** puts up to five cards on your profile: the song in Spotify on presence 1, the video in the browser on presence 2, a stream in another tab on presence 3, say. The highest-ranked thing playing is presence 1 (a music app beats a video, a video beats an unnamed tab), the next is presence 2, and so on. With more than one:

- Tabs of the same site are separate things: four Twitch streams open side by side take four cards. A Discord application carries one card, so once the platform's own applications are taken the others borrow one — the default Vybecord application, then a platform application nothing is on — and the card names its platform in the header either way. Discord's **Active Now** list shows the borrowed application's logo, though, so a card goes back to its platform's application as soon as one is free.
- **Lyrics on presence N** picks which cards sing along — any combination.
- **Activity type on presence N** gives each card its own verb: *Listening* for the song, *Watching* for the stream. Cards 2 to 5 say the same as presence 1 until you change them.
- **Now playing** shows every card on its **On Discord** side; click a small one to see its lyrics and draw it whole. Its **Source** menu pins that presence to a player, so it never swaps with another, and clicking its parts changes them.
- The listening history (and so **Activity**) and Last.fm follow presence 1 only.
- With lyrics on two cards or more, the cards can swap places on your profile at each line: Discord puts the card that changed last on top, and Vybecord cannot hold the order. The window warns you when lyrics go on a second card. A *Playing* card always sits above *Listening* and *Watching* ones.

Each card is a Discord application of its own. Spotify, SoundCloud and Apple Music have one each, YouTube three, and Kick and Twitch five each, so up to five Kick or Twitch streams all keep their logo; a card whose platform has no application left borrows a free one. With the default that makes seventeen applications for five cards at most, so there is nothing to set up.

---

## FAQ

**Does this need Spotify Premium?**
No. Vybecord reads what Windows already knows, and Spicetify works with a free account too. Premium only matters if you choose to read Spotify through its API instead of Spicetify (see *Spotify details without Spicetify*).

**Do I need Spicetify or a browser extension?**
No. Older versions did; this one does not. Both are optional extras: Spicetify adds instant track changes, Spotify's own lyrics and the DJ (the card names it, and the DJ's voice between songs gets no lyrics and no history) (set it up under **Settings → Integrations → Spotify**), and the browser extension tells Vybecord which site a tab is on. With Premium, your own Spotify app gives most of what Spicetify gives without touching Spotify.

**What does it work with?**
Anything that appears in the Windows media overlay: Spotify, browser tabs (YouTube, SoundCloud, Deezer…), VLC, foobar2000, MusicBee, AIMP, Apple Music, Tidal, Amazon Music.

**Does my data leave my PC?**
Track and artist names go to the lyrics services (LRCLib, Netease, Musixmatch, Genius) to look lyrics up, to Deezer and Apple's iTunes to find the album cover (and, for Apple Music, the album page the cover opens on Discord, as Spotify's does), and to Discord for the status. The cover your player shows (Spotify's, Apple Music's, a local file's) is published to Vybecord's cover store, stripped of its metadata, and only when there is none is a catalogue asked — switch that off under **Settings → Integrations → Cover images**. For a Twitch channel, the channel name goes to Twitch to get its title, picture and stream start. If you turn on translation, the lyric lines go to the translation service; if you enable Last.fm, your plays go there; if you sign in with your own Spotify app, Vybecord asks Spotify what you are playing. Your history, settings and imported lyrics stay local. The full list is in the [privacy policy](https://theunknownmurda.github.io/VybecordTS/privacy/).

**Where are my files?**
In `%APPDATA%\Vybecord` — paste that into Explorer.

**I'm coming from VybecordTS 1.x — do I lose anything?**
Your config, lyrics database and history all carry over. Windows alone does not expose playlist context, shuffle/repeat state or clickable track links; the optional Spicetify and browser extensions bring them back. Uninstall the old 1.x Spicetify extension and the Tampermonkey scripts — the new Spicetify extension is set up from Settings instead.

---

## Support

Something broken? Use **Settings → About → Report a problem** in the app (also on **Help & setup**), or open an issue on [GitHub](https://github.com/TheUnknownMurda/VybecordTS/issues).
