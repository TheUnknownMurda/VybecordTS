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
function setBadge(ok) {
  if (ok === lastBadge) return;
  lastBadge = ok;
  chrome.action.setBadgeText({ text: ok ? '' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#10b981' : '#71717a' });
  chrome.action.setTitle({ title: ok ? 'Vybecord — connected' : 'Vybecord — desktop app not running' });
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
  ready.then(() => sendResponse({ connected, enabled }));
  return true;
});
