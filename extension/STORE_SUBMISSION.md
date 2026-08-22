# Store submission

Everything the Chrome Web Store and Edge Add-ons dashboards ask for, with the
answers already written. Paste the blocks as they are.

Build the packages first:

```
node scripts/pack-extension.mjs
```

That writes two zips — manifest at the root, forward-slash entry paths, the
markdown left out:

- `release/vybecord-extension-<version>.zip` — **upload this one.** Chromium
  manifest, so nothing in it draws a warning from either dashboard.
- `release/vybecord-extension-<version>-firefox.zip` — the same extension with
  the background declared as an event page, since Firefox has no Manifest V3
  service workers. Not for these two stores.

---

## Listing

**Name** — `Vybecord`

**Summary / short description** (132 characters max)

```
Sends what you are playing on Spotify, YouTube, SoundCloud, Bandcamp, Twitch and Kick to the Vybecord desktop app.
```

**Category** — Entertainment

**Privacy policy URL**

```
https://theunknownmurda.github.io/VybecordTS/privacy/
```

**Support / homepage URL**

```
https://theunknownmurda.github.io/VybecordTS/
```

**Detailed description**

```
Vybecord shows what you are listening to on your Discord profile, with lyrics
that scroll in time with the song.

This extension is the part that reads what is playing in your browser. It works
with Spotify, YouTube and YouTube Music, SoundCloud, Bandcamp, Twitch and Kick,
and hands that over to the Vybecord desktop app running on the same computer.

It needs the desktop app to do anything at all — download it from
https://theunknownmurda.github.io/VybecordTS/

Each of the six sites has its own switch, so you can report your music without
reporting your streams, or the other way round. Your listening is sent to one
place only — the app on your own machine, at 127.0.0.1. There is no server, no
account, and no analytics. On Kick, the extension additionally asks Kick's own
site for the stream's start time, the same way the page you have open does.

Open source: https://github.com/TheUnknownMurda/VybecordTS
```

---

## Single purpose

Chrome requires one sentence, and rejects extensions whose stated purpose is
broader than what the code does.

```
Read the metadata of the media currently playing on six supported sites and
send it to the Vybecord desktop application on the same computer, so it can be
displayed as the user's Discord status.
```

---

## Permission justifications

Each of these is a separate box in the Chrome dashboard.

**`storage`**

```
Stores six on/off switches, one per supported site, so the user's choice of
which sites to report survives a browser restart. Nothing else is stored.
```

**Host permission — `http://127.0.0.1:8888/*`**

```
This is the local address of the Vybecord desktop application, which the user
installs separately. The extension posts the currently playing track to it.
127.0.0.1 is the loopback address, so this traffic never leaves the user's
machine. It is the only host the extension requests permission to contact, and
the extension does nothing at all when the desktop app is not running.
```

**Content scripts on the six supported sites**

```
The extension reads the title, artist, album, artwork address, playback
position and duration of what is playing, from the page the user already has
open. This is the data the extension exists to report; without access to these
sites there is nothing to read. No other site is matched, and the extension
does not read credentials, cookies, or anything the user has typed.

On kick.com only, the content script also makes one same-origin request, to
Kick's own /api/v1/channels/<channel> endpoint, to read the stream's start
time — which the page does not otherwise expose, and which is needed to show
how long a stream has been running. It is the same request the Kick page
makes for itself, to the site the user is already on, and it requires no host
permission. The response is read for a single timestamp field; nothing from
it is stored or forwarded anywhere except that timestamp, which goes to the
desktop app with the rest of the stream data.
```

---

## What these answers depend on

Two of the claims above are properties of the code rather than promises, and
both can be broken by a plausible change. They are written down because the
failure mode is silent — the listing carries on saying something that has
quietly stopped being true.

**"The only host the extension is permitted to contact."** Holds as long as
`host_permissions` in `manifest.json` lists `http://127.0.0.1:8888/*` and
nothing else. `src/gm-shim.js` additionally refuses to send anywhere else and
says so in the console, so a call added to a site script fails visibly instead
of widening what the extension does. Adding a host means rewriting this section,
the detailed description above, and the privacy policy at
`website/privacy/index.html` — the policy states the extension is *technically
incapable* of reaching anything else, which is a stronger claim than a
permission list and a worse one to leave stale.

**"Does not read credentials."** Holds as long as no script lifts a session
token out of a page. The Tampermonkey originals did exactly that on Spotify, to
reach the official lyrics API, by patching `window.fetch` and `XMLHttpRequest`.
The port dropped it because a content script's isolated world patches its own
copies and never sees the page's requests. Restoring the feature would mean
injecting a MAIN-world script to bridge the token back out — at which point this
answer is false and **Authentication information** has to be ticked in the
disclosure below. `src/sites/spotify.js` records why that trade was declined:
the desktop app sources lyrics itself, from providers that are not Premium-only.

---

## Data handling disclosure

There is a real subtlety here, and it is worth answering deliberately.

Chrome defines collection as *transmitting data off the user's device*. This
extension transmits the user's data only to `127.0.0.1`, which by definition
never leaves the machine — so a strict reading is that it collects nothing.

The one request that does leave the machine sends none of it: on kick.com the
content script asks Kick, same-origin, for the current channel's stream start
time. It carries the channel name that is already in the address bar and no
user data, and it goes to the site the user is on rather than to us. Say so if
it comes up — a reviewer reading `sites/kick.js` will see the call, and a
disclosure that pretends it is not there is worse than the call itself.

Reviewers do not always read it that way, and under-disclosing is what gets an
extension pulled. So disclose it, and explain:

- Tick **Website content** — the extension does read data out of the page.
- Leave every other category unticked. None of them apply: no PII, no
  authentication information, no location, no web history, no personal
  communications, no financial or health data.

All three certifications are true and can be ticked:

- Not being sold to third parties
- Not being used or transferred for purposes unrelated to the single purpose
- Not being used or transferred to determine creditworthiness or for lending

If a reviewer asks for more, this is the explanation:

```
The only recipient of the user's playback data is a desktop application running
on the same computer, reached over the loopback interface at 127.0.0.1. No data
reaches a remote server operated by us or by anyone else — there is no backend,
no account system, and no analytics of any kind. What the user does with the
desktop app afterwards, including displaying a Discord status, is that
application's function and is disclosed in its own documentation.

The extension makes one request to a site: on kick.com it reads the current
channel's stream start time from Kick's own public channel endpoint, because
the page does not expose it. That request is same-origin, identical to one the
Kick page itself makes, carries only the channel name already visible in the
address bar, and its response is used for a single timestamp.
```

---

## Screenshots

At least one is required. 1280×800 or 640×400 for Chrome; 1366×768 for Edge.

The options page is the obvious subject — it shows the six site switches and
the connection status, which is the whole interface. Open the extension's
options in a tab, with the desktop app running so the status reads connected,
and capture it at one of the sizes above.

A second screenshot showing a Discord profile with the status live makes the
point of the extension clear in a way the options page alone cannot.

---

## After it is published

Replace the "load unpacked" flow with a link to the listing. The reasoning in
`electron/extension-install.ts` says exactly this: genuine one-click install
needs a store listing, after which the app can simply open it. Once the URLs
exist, that module's job becomes a single `shell.openExternal`.

Publishing also ends the "developer mode extensions" warning that Edge and
Chrome show on every start — that warning is a property of unpacked
extensions, and a store install is not one.
