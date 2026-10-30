# Vybecord browser extension

Optional. Vybecord works without it — this fills in what Windows cannot tell it.

## Why it exists

The desktop app reads the Windows media session, which reports *what* is playing but never *where*. A SoundCloud tab and a YouTube tab are indistinguishable to it: both arrive as "MSEdge", with the page's title as the track and the uploading account as the artist.

This extension reads the page directly and supplies:

| | What it adds |
| --- | --- |
| **Spotify** (web player) | album, playlist context, shuffle and repeat |
| **YouTube** | the video link, live-stream start time, real channel |
| **SoundCloud** | the actual artist rather than the uploading account, track link |
| **Bandcamp** | album and label metadata |
| **Twitch** / **Kick** | the channel, live or offline; past broadcasts and clips with their position; stream title, category, uptime |

It also reports position from the page's own audio element, which is exact — a browser's media session only publishes one every few seconds.

### What it does not add

Everything above is read out of the page, with one exception noted below, and that is what keeps the extension to the one host permission it asks for — and it rules two things out.

**The exception is Kick.** [`sites/kick.js`](src/sites/kick.js) calls Kick's own API — `/api/v1/channels/…`, `/api/v1/video/…` or `/api/v2/clips/…`, for whatever the tab is on — for the channel's name, picture, title, category, whether it is live and since when. The page says none of that reliably: it renders the previous channel, the sidebar and your own avatar before the one in the address bar. It is a same-origin request on a tab you already have open, made the way the page itself makes it, so it needs no host permission and reaches no host you were not already on. It is the only request this extension makes to anything other than the desktop app. It cannot move to the app the way the Twitch one did: Kick answers only a browser with a real session and returns HTTP 403 to anything else.

**Lyrics.** The desktop app fetches its own, from LRCLib, Netease, Musixmatch and your local database. It does not use Spotify's official lyrics, because reaching that API means taking the OAuth token out of your Spotify session — not something this extension will do for a Premium-only source the app already covers another way.

**Exact Twitch uptime, name and picture.** Twitch's API knows when a stream started; the page does not. So the extension sends an estimate — the moment a tab first saw the channel live — and the desktop app corrects it, asking Twitch's public GraphQL API for the stream's real `createdAt` and caching that per streamer. The same query brings the channel's name and picture, which the page shows late (until it has rendered, the first avatar on it is someone else's — often yours), and for a past broadcast or a clip its title and length. The timer is then right whether you opened the tab at the start or two hours in; until the lookup lands, or if it fails, the estimate stands. Making that request from the app rather than from here is what keeps the extension to the one host permission above.

The same answer also settles *whether* a channel is live. If Twitch says a channel is not streaming, the card says **Offline**, whatever the tab shows; a tab that sees the stream start or end only gets Twitch asked again sooner. Only an explicit answer counts: when Twitch cannot be reached, the page's reading stands rather than the card changing on a failed request.

## Which browsers

| Browser | Package | Notes |
| --- | --- | --- |
| Chrome, Edge, Brave, Vivaldi, Arc | the folder, or `vybecord-extension-<version>.zip` | Load unpacked, stays installed |
| Opera, Opera GX | same | `opera://extensions`, Developer mode, Load unpacked |
| Firefox 140+, and its forks (Zen, LibreWolf, Waterfox, Floorp) | `vybecord-extension-<version>-firefox.zip` | Temporary add-on until it is signed by Mozilla, see below |
| Safari | none | Not applicable: there is no Safari for Windows, and the app runs only on Windows |

Every Chromium browser runs the same package unchanged, because the extension
uses nothing outside the shared WebExtension core: `runtime` messaging,
`storage.sync`, the `action` badge, content scripts and one `fetch` to
127.0.0.1. The app accepts `chrome-extension://` (every Chromium browser, Edge
and Opera included), `moz-extension://` and `safari-web-extension://` origins.

Safari is the one that cannot be covered. Apple stopped making Safari for
Windows in 2012, so a Safari user is on a Mac, where the desktop app does not
run. Shipping a Safari extension would also take a Mac with Xcode to convert it
and a paid Apple Developer account to distribute it. It becomes worth doing the
day the app runs on macOS, not before.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`,
   `opera://extensions`, `vivaldi://extensions`)
2. Turn on **Developer mode**
3. **Load unpacked** → select this `extension/` folder

Firefox 140 or newer needs its own build, because one manifest cannot serve both
engines: Manifest V3 declares the background as a `service_worker`, and Firefox
has no MV3 service workers — it runs the background as an event page declared
with `scripts`. Chromium rejects that key outright and shows the user an error,
so `manifest.json` here is the Chromium one and the Firefox form is generated:

```
node scripts/pack-extension.mjs
```

Then `about:debugging` → **This Firefox** → **Load Temporary Add-on** → pick
`release/vybecord-extension-<version>-firefox.zip`. Firefox drops temporary
add-ons when it closes; only a copy signed by Mozilla stays installed, and
signing goes through addons.mozilla.org (as a public listing, or unlisted for
a self-hosted .xpi). The floor is 140 for two reasons. Before Firefox 127 the
host permissions of a Manifest V3 add-on were not granted at install, so its
content scripts did not run until the user granted them by hand in
about:addons. And 140 is the first version that understands the
`data_collection_permissions` declaration Mozilla now requires, which is also
the current ESR.

The extension icon opens the settings, where each site has its own switch. All are on by default; a site switched off sends nothing at all.

## Age-restricted YouTube videos (optional)

YouTube gives the captions of an age-restricted video only to a signed-in,
age-verified account, and yt-dlp, which the app uses to fetch captions, cannot
sign in. The options page has one switch for that, **Share my YouTube sign-in
for captions**, off by default.

- Turning it on is what grants `cookies` and access to `https://*.youtube.com/*`;
  both are optional in the manifest, so without the switch the extension cannot
  read a cookie at all. Firefox 140+ also asks for consent to share
  authentication data. Turning it off removes the permissions and tells the app
  to forget what it holds.
- The app asks for the session only after a video came back age-restricted
  signed out, by answering the YouTube tab's next push with `wantCookies`. The
  background then reads the youtube.com cookies (nothing else) and posts them to
  `/api/youtube-cookies` on 127.0.0.1, at most once every 30 seconds. No site
  script can reach that path: it is not in the relay's allowlist.
- The app keeps them in memory for ten minutes, writes them only into the temp
  folder of the one yt-dlp call that retries that video, and deletes it after.
  Every other video is still fetched signed out.
- A signed-out browser has nothing to lend: its cookies unlock nothing. And
  yt-dlp warns that an account used with it can be banned, which is why it is
  opt-in and limited to the videos that need it.

## How it reaches the app

The desktop app listens on `127.0.0.1:8888`, and only while **Settings → Integrations → Browser extension → Accept data from the extension** is on. That endpoint:

- binds loopback only, so nothing off the machine can reach it
- answers POST on eight push paths and nothing else — no settings, no reads, nothing that could leak anything about you (the reply to a YouTube push can carry one flag, a request for the YouTube session described below)
- accepts only `chrome-extension://` / `moz-extension://` origins, which the browser sets and a web page cannot forge

Playback never leaves your computer through this extension.

## Layout

```
manifest.json          MV3 manifest, one content script entry per site
src/background.js      the only thing that talks to the app; per-site gate, badge
src/gm-shim.js         Greasemonkey compatibility layer (see below)
src/sites/*.js         the six scrapers
src/options.*          the settings page
```

### About the shim

The six site scripts are the original Tampermonkey userscripts, carried over with their scraping logic **unchanged**. That logic is the valuable part — it knows where SoundCloud hides the real artist, and how to tell a YouTube live edge from a rewind — and rewriting it would have meant re-deriving all of it and reintroducing its bugs.

They use three Greasemonkey APIs, which `gm-shim.js` provides:

- `GM_xmlhttpRequest` → relayed through the service worker, since a content script shares the page's origin and cannot reach `127.0.0.1` itself
- `GM_getValue` / `GM_setValue` → `localStorage`, matching their synchronous signature

The scripts lost the userscript metadata block and the handshake with the old setup page, which the app no longer serves. They also lost every call that went somewhere other than the desktop app — see below.

### What the shim is not

`GM_xmlhttpRequest` here is narrower than Tampermonkey's, in two ways worth knowing before porting more userscript code in:

- **It reaches `127.0.0.1` and nothing else.** Under Tampermonkey the same call was a real cross-origin request, granted per-host by `@connect`, and the scripts used it to reach Spotify and Twitch. Those calls are gone. Anything else now fails loudly, naming the URL and the file.
- **It returns no response body.** The relay reports whether the push landed, not what came back. It used to synthesise `{"ok":true}` for every call, which is how the ported external calls failed without a sound — each one parsed that as its reply.

The same boundary applies to the page's JavaScript. A content script runs in an isolated world: patching `window.fetch` patches its own copy and never sees the page's requests, and there is no `unsafeWindow`. Userscript code that sniffs page traffic or reads page globals runs without error and simply observes nothing — so it has been removed rather than left in place looking functional.

### Maintaining them

These scrape site DOMs, so they break when the sites change — that is what happened to the userscripts. When a site stops reporting, its scraper's selectors are where to look. The desktop app keeps working meanwhile: it simply falls back to what Windows reports.
