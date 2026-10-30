/**
 * Background worker: the only thing that talks to the desktop app.
 *
 * Content scripts run in the page's origin and cannot reach 127.0.0.1, so every
 * push comes through here. Keeping it central also puts the per-site switches in
 * one place: a disabled site is dropped at this boundary, which means toggling
 * one takes effect immediately instead of on the next page reload.
 *
 * Chrome runs this as a service worker, Firefox as an event page — manifest.json
 * declares both. What matters here is what they share: this file is evaluated
 * again from scratch every time the browser wakes it, which is often, so nothing
 * below may assume state survives between pushes. See `ready` for the one place
 * that bites.
 */

const APP_BASE = 'http://127.0.0.1:8888';

/**
 * Endpoint → site key, so a push can be matched to its switch.
 *
 * `/api/spotify-lyrics` is not here. The app still serves it — the Tampermonkey
 * userscripts posted to it — but no site script in this extension does: see the
 * header of sites/spotify.js for why the lyrics path did not survive the port.
 *
 * Nor is `/api/youtube-cookies`: only this worker posts there (see
 * sendYouTubeCookies), and leaving it out is what stops a site script from
 * relaying anything to it.
 */
const ENDPOINT_SITE = {
  '/api/spicetify': 'spotify',
  '/api/youtube': 'youtube',
  '/api/soundcloud': 'soundcloud',
  '/api/bandcamp': 'bandcamp',
  '/api/twitch': 'twitch',
  '/api/kick': 'kick',
};

const SITES = ['spotify', 'youtube', 'soundcloud', 'bandcamp', 'twitch', 'kick'];

/** Every site on by default: an extension that does nothing until configured is a bug report. */
const DEFAULTS = Object.fromEntries(SITES.map(s => [s, true]));

/**
 * Cached switches.
 *
 * A push arrives every couple of seconds per open tab; reading storage on each
 * one would be wasteful. The cache is refreshed by the change listener below, so
 * it cannot go stale.
 */
let enabled = { ...DEFAULTS };

/** Whether the last push reached the app, for the badge. */
let connected = false;
let lastBadge = null;

/**
 * Resolves once `enabled` holds the user's real settings.
 *
 * The push that wakes this worker is delivered as soon as the file finishes
 * evaluating, which is well before an async storage read can answer. Reading
 * `enabled` directly in the handler therefore saw the all-on defaults, and every
 * wake-up relayed one push from a site the user had switched off — the one thing
 * a per-site switch exists to prevent. So the handler awaits this instead.
 *
 * It costs a wait on the first push after a wake and nothing afterwards: an
 * already-resolved promise, and the listener below keeps the cache current.
 */
const ready = chrome.storage.sync.get(DEFAULTS).then((stored) => {
  enabled = { ...DEFAULTS, ...stored };
}).catch(() => {
  // Storage unreadable: keep the defaults rather than dropping every push.
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    // `newValue === undefined` means the key was removed, which is a reset to
    // the default rather than a switch-off — hence `!== false` and not truthiness.
    if (key in enabled) enabled[key] = newValue === undefined ? DEFAULTS[key] : newValue !== false;
  }
});

/**
 * Badge: green when the app is receiving, grey when it is not running.
 *
 * Without it, "nothing shows on Discord" gives the user no way to tell whether
 * the extension is scraping, whether the app is running, or whether they are
 * simply on a site they switched off.
 */
/**
 * Is the desktop app there?
 *
 * Any HTTP answer means yes, whatever its status: the app refuses a request
 * with no Origin, and a 403 is still proof that something is listening on the
 * port. Only a network failure means no. Measured at 2ms either way, both for
 * an app that is running and for a port with nothing behind it.
 */
async function probeApp() {
  try {
    await fetch(APP_BASE + '/api/kick', { method: 'OPTIONS' });
    return true;
  } catch {
    return false;
  }
}
function setBadge(ok) {
  if (ok === lastBadge) return;
  lastBadge = ok;
  chrome.action.setBadgeText({ text: ok ? '' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#10b981' : '#71717a' });
  chrome.action.setTitle({ title: ok ? 'Vybecord — connected' : 'Vybecord — desktop app not running' });
}

/**
 * Lending the app the browser's YouTube session, for age-restricted captions.
 *
 * Off unless the user turns it on in the options page, which is what grants
 * the `cookies` permission and access to youtube.com in the first place: both
 * are optional in the manifest, so an install that never flips the switch
 * cannot read a single cookie. Firefox 140+ additionally asks for consent to
 * share authentication data, which the options page requests with the rest.
 *
 * Even when on, cookies are sent only when the app asks, and the app asks only
 * after a video has come back age-restricted signed out. They go to
 * 127.0.0.1 and nowhere else, and only the youtube.com ones.
 */
const YT_COOKIE_PERMISSIONS = { permissions: ['cookies'], origins: ['https://*.youtube.com/*'] };

/**
 * Whether the switch is on: the permissions are the setting, so the two can
 * never disagree. Firefox's data consent is checked too where it exists; its
 * getAll() lists `data_collection` only on a browser that has the feature.
 */
async function youtubeCookiesAllowed() {
  try {
    if (!(await chrome.permissions.contains(YT_COOKIE_PERMISSIONS))) return false;
    const all = await chrome.permissions.getAll();
    return !all.data_collection || all.data_collection.includes('authenticationInfo');
  } catch {
    return false;
  }
}

/**
 * At most one handover per half minute. The app asks on every reply until
 * the cookies land, and a reply comes every couple of seconds; this file is
 * re-evaluated on every wake, so the worst case after a restart is one extra.
 */
const COOKIE_EXPORT_GAP_MS = 30_000;
let lastCookieExport = 0;

async function sendYouTubeCookies() {
  if (Date.now() - lastCookieExport < COOKIE_EXPORT_GAP_MS) return;
  lastCookieExport = Date.now();
  if (!(await youtubeCookiesAllowed()) || !chrome.cookies) return;

  let jar;
  try {
    jar = await chrome.cookies.getAll({ domain: 'youtube.com' });
  } catch {
    // Firefox with first-party isolation (LibreWolf, resistFingerprinting
    // setups) refuses a query that does not name a first-party domain.
    try { jar = await chrome.cookies.getAll({ domain: 'youtube.com', firstPartyDomain: null }); }
    catch { return; }
  }
  if (!jar?.length) return;

  const cookies = jar.map(c => ({
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    expires: c.session ? 0 : Math.floor(c.expirationDate || 0),
    name: c.name,
    value: c.value,
  }));
  try {
    await fetch(APP_BASE + '/api/youtube-cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies }),
    });
  } catch {
    // The app closed between the reply and this; it will ask again.
  }
}

/** Match a push to its switch, check the switch, and forward it to the app. */
async function relay(msg) {
  const path = (() => {
    try { return new URL(msg.url).pathname; } catch { return ''; }
  })();

  const site = ENDPOINT_SITE[path];
  if (!site) {
    // Second line of defence; gm-shim.js rejects a non-app URL before it gets
    // here, and reports it against the calling site script. This catches the
    // other case — a real app path that was added to a site script but never
    // to ENDPOINT_SITE above — which would otherwise look like the app being
    // closed and be absorbed by the caller's backoff.
    console.error(
      `[Vybecord] Refusing to relay "${msg.url}": path "${path}" is not one of the ` +
      `app's push endpoints (${Object.keys(ENDPOINT_SITE).join(', ')}). ` +
      `A new endpoint has to be added to ENDPOINT_SITE so it can be matched to a site switch.`,
    );
    return { ok: false, error: `unknown endpoint: ${path || msg.url}` };
  }

  // Never read `enabled` before this: see the comment on `ready`.
  await ready;
  if (!enabled[site]) return { ok: false, error: 'site disabled' };

  try {
    const res = await fetch(APP_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: msg.body,
    });
    connected = res.ok;
    setBadge(res.ok);
    // The one reply worth reading: the app asking for the YouTube session.
    // Anything unreadable is simply no request.
    if (res.ok && site === 'youtube') {
      const reply = await res.json().catch(() => null);
      if (reply?.wantCookies) void sendYouTubeCookies();
    }
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    // The app being closed is the normal case here, not an error worth
    // shouting about. The site script backs off on its own.
    connected = false;
    setBadge(false);
    return { ok: false, error: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'vybecord-push') return false;
  // The listener itself stays synchronous and returns true: an `async` listener
  // returns a promise, which Chrome reads as "not handling this message".
  relay(msg).then(sendResponse);
  return true;  // response is async — `ready` has to be awaited first
});

/** The options page asks for this to show live status. */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'vybecord-status') return false;
  // Awaited for the same reason as in relay(): asking right after a wake would
  // otherwise report the defaults as though they were the user's settings.
  //
  // `connected` only means anything once a push has been made, and this file is
  // evaluated from scratch on every wake -- so a worker woken by this very
  // message has it false regardless of the app. Reporting that told anyone who
  // opened the options page before playing anything that the app was not
  // running, which is the exact wrong signal this status exists to give. Ask
  // the app instead.
  ready
    .then(probeApp)
    .then((up) => sendResponse({ connected: up, enabled }));
  return true;
});
