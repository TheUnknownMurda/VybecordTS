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
site about the channel or video you have open, the same way the page does.

Optional, and off unless you turn it on: YouTube serves captions of an
age-restricted video only to a signed-in, age-verified account. One switch lets
the extension hand your youtube.com cookies to the desktop app when such a video
comes back restricted, so the app can fetch that one video's captions signed
in. Your browser asks for the permission when you turn it on; the cookies go
only to the app on your own machine, which keeps them in memory and uses them
for nothing else.

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

The optional YouTube cookie switch sits inside that purpose rather than beside
it: it exists so the app can show the captions of the video being reported in
that same status. Say so if a reviewer asks.

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

**`cookies` — optional, requested only when the user turns the switch on**

```
Off by default, and not granted at install: it is an optional permission that
the browser asks the user for when they turn on "Share my YouTube sign-in for
captions" in the extension's options. YouTube serves the captions of an
age-restricted video only to a signed-in, age-verified account, and the
Vybecord desktop app shows those captions as lyrics. When the app reports that
the video playing has come back age-restricted, the extension reads the
youtube.com cookies and posts them to the desktop app at 127.0.0.1, which uses
them to fetch that one video's captions and keeps them in memory only. No
cookie of any other site is read, and no cookie leaves the user's machine.
Turning the switch off removes the permission.
```

**Optional host permission — `https://*.youtube.com/*`**

```
Requested together with `cookies`, and only then: the browser lets an
extension read a site's cookies only with access to that site. The extension
makes no request to youtube.com with it; the content script already runs there
under its normal match pattern.
```

**Content scripts on the six supported sites**

```
The extension reads the title, artist, album, artwork address, playback
position and duration of what is playing, from the page the user already has
open. This is the data the extension exists to report; without access to these
sites there is nothing to read. No other site is matched, and the content
scripts do not read credentials, cookies, or anything the user has typed (the
optional cookie switch above works through the cookies API, not the page).
It reads these pages and never writes to them: nothing is inserted, hidden,
removed or restyled.

On kick.com, when the user has turned captions on in Kick's player, the
content script also reads the text of the player's caption overlay, so the
desktop app can show what is being said as the stream's lyrics. It is read off
the page like everything else, sent only to the desktop app, and nothing is
read while captions are off.

On kick.com only, the content script also makes same-origin requests to
Kick's own API (/api/v1/channels/<channel>, /api/v1/video/<id> or
/api/v2/clips/<id>, for whatever the tab is showing), to read the channel's
name and picture, the stream's title, category, live status and start time —
which the page does not reliably expose. They are the same requests the Kick
page makes for itself, to the site the user is already on, and they require no
host permission. Those fields are all that is read from the response, and they
go nowhere except, like everything else the extension reports, to the
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

**"Reads these pages and never writes to them."** Holds as long as no site
script touches the DOM. Today none does: the only `.style` reference in
`src/sites/` reads a background-image URL to find the artwork, and there is no
`appendChild`, `innerHTML`, `remove()`, `setAttribute` or `classList` write
anywhere. It was not always so -- `sites/kick.js` used to strip cookie banners,
including inside iframes, which was both undeclared and well outside a metadata
reporter's single purpose. Anything that changes a page again makes this
sentence false, and moves the extension into a category reviewers read
differently.

**"Reads cookies only when the user turns it on."** Holds as long as `cookies`
and `https://*.youtube.com/*` stay under `optional_permissions` and
`optional_host_permissions` in `manifest.json`, and `src/background.js` posts
them only to `/api/youtube-cookies` on 127.0.0.1, only the youtube.com jar, and
only when the app's reply asks for them. Moving either permission into the
required lists would grant them at install to everybody, and the description,
the justification above and the privacy policy would all become false at once.

**"The content scripts do not read credentials."** Holds as long as no script
lifts a session token out of a page. The Tampermonkey originals did exactly that on Spotify, to
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
content script asks Kick, same-origin, about the channel, video or clip open
in the tab. It carries the id that is already in the address bar and no
user data, and it goes to the site the user is on rather than to us. Say so if
it comes up — a reviewer reading `sites/kick.js` will see the call, and a
disclosure that pretends it is not there is worse than the call itself.

Reviewers do not always read it that way, and under-disclosing is what gets an
extension pulled. So disclose it, and explain:

- Tick **Website content** — the extension does read data out of the page.
- Tick **Authentication information** — with the optional switch on, the
  extension hands the youtube.com session cookies to the desktop app. The
  dashboard asks what the extension *can* do, not what it does by default.
- Leave every other category unticked. None of them apply: no PII, no
  location, no web history, no personal communications, no financial or
  health data.

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

The extension makes one request to a site: on kick.com it asks Kick's own
API about the channel, past broadcast or clip open in the tab -- its name,
picture, title, category, live status and start time -- because the page does
not expose them reliably. That request is same-origin, identical to one the
Kick page itself makes, carries only the channel name or video id already
visible in the address bar, and only those fields are read from the response.

The optional cookie switch is off by default and its permissions are not
granted at install. When the user turns it on, and only when the desktop app
reports an age-restricted video, the extension reads the youtube.com cookies
and posts them to the same desktop app at 127.0.0.1, which needs a signed-in
session to fetch that video's captions. They are never sent to any server.
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

## Firefox Add-ons (AMO)

Upload `release/vybecord-extension-<version>-firefox.zip`, not the Chromium one.
The listing text, permission answers and privacy policy above apply unchanged.

Only a copy signed by Mozilla stays installed in Firefox; anything else is a
temporary add-on, dropped when the browser closes. Signing does not require a
public listing: AMO can sign an **unlisted** version, which is then shipped as an
`.xpi` from the releases page instead of the store. Either way it goes through
an AMO account.

**Data collection.** Since 2025-11-03 AMO refuses a new extension that does not
declare `browser_specific_settings.gecko.data_collection_permissions`, and
Mozilla's `addons-linter` flags its absence. The manifest declares
`"required": ["websiteContent"]`, and Firefox shows that on the install prompt,
plus `"optional": ["authenticationInfo"]` for the YouTube cookie switch, which
the options page requests together with the cookie permission.
`"none"` would have been the strict reading, as with Chrome above, since
nothing leaves the machine. But Mozilla counts data handled outside the browser
as transmitted, and the desktop app is outside the browser, so the same
deliberate answer is given here as in the Chrome disclosure: the extension reads
website content and hands it on. Nothing else is declared, for the reasons given
there.

The key is understood from Firefox 140, which is also why `strict_min_version`
is 140 (see the extension README for the other reason). `npx addons-linter
release/vybecord-extension-<version>-firefox.zip` must report no errors before
an upload, and one warning only: `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`,
because Firefox for Android learned the key in 142. Android does not matter
here, since there is no desktop app on a phone to send anything to: on AMO,
leave **Firefox for Android** unticked under compatibility.

## Opera add-ons

addons.opera.com takes the Chromium zip as it is. It is optional: Opera can
install from the Chrome Web Store too, so the Chrome listing reaches Opera users
on its own, and Opera's review queue is slow.

## After it is published

Replace the "load unpacked" flow with a link to the listing. The reasoning in
`electron/extension-install.ts` says exactly this: genuine one-click install
needs a store listing, after which the app can simply open it. Once the URLs
exist, that module's job becomes a single `shell.openExternal`.

Publishing also ends the "developer mode extensions" warning that Edge and
Chrome show on every start — that warning is a property of unpacked
extensions, and a store install is not one.
