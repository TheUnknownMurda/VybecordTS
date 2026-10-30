/**
 * Options: one switch per site, plus whether the desktop app is reachable.
 *
 * The site list is repeated from background.js rather than imported — the
 * service worker is a classic script, and making it a module to share six
 * strings would cost more than it saves.
 */

const SITES = [
  { key: 'spotify', name: 'Spotify', detail: 'open.spotify.com — album, playlist, shuffle and repeat, plus official lyrics' },
  { key: 'youtube', name: 'YouTube', detail: 'youtube.com and music.youtube.com — video link, live stream start time' },
  { key: 'soundcloud', name: 'SoundCloud', detail: 'the real artist rather than the uploading account, and the track link' },
  { key: 'bandcamp', name: 'Bandcamp', detail: 'album and label metadata' },
  { key: 'twitch', name: 'Twitch', detail: 'stream title, category, uptime' },
  { key: 'kick', name: 'Kick', detail: 'stream title, category, uptime' },
];

const DEFAULTS = Object.fromEntries(SITES.map(s => [s.key, true]));

const list = document.getElementById('sites');
const statusEl = document.getElementById('status');

async function render() {
  const stored = await chrome.storage.sync.get(DEFAULTS);

  list.replaceChildren(...SITES.map(({ key, name, detail }) => {
    const input = Object.assign(document.createElement('input'), {
      type: 'checkbox',
      checked: stored[key] !== false,
      id: `site-${key}`,
    });
    input.addEventListener('change', () => {
      // Written straight through: the service worker watches storage and picks
      // the change up immediately, so a switch takes effect without a reload.
      chrome.storage.sync.set({ [key]: input.checked });
    });

    const label = Object.assign(document.createElement('label'), { className: 'site' });
    label.htmlFor = input.id;

    const text = document.createElement('div');
    text.className = 'site-text';
    text.append(
      Object.assign(document.createElement('div'), { className: 'site-name', textContent: name }),
      Object.assign(document.createElement('div'), { className: 'site-detail', textContent: detail }),
    );

    const sw = document.createElement('span');
    sw.className = 'switch';
    sw.append(input, Object.assign(document.createElement('span'), { className: 'track' }),
      Object.assign(document.createElement('span'), { className: 'thumb' }));

    label.append(text, sw);
    const li = document.createElement('li');
    li.append(label);
    return li;
  }));
}

/**
 * Ask the worker whether the desktop app is reachable.
 *
 * The worker answers by asking the app directly rather than by reporting the
 * result of its last push. It used to do the latter, and a push it has not
 * made yet reads exactly like one that failed -- so opening this page before
 * playing anything said the app was not running, whether or not it was.
 */
function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'vybecord-status' }, (reply) => {
    if (chrome.runtime.lastError || !reply) {
      statusEl.textContent = 'Extension idle';
      statusEl.className = 'status';
      return;
    }
    statusEl.textContent = reply.connected ? 'Connected to Vybecord' : 'Vybecord not running';
    statusEl.className = `status ${reply.connected ? 'ok' : 'off'}`;
  });
}

/**
 * The YouTube sign-in switch.
 *
 * Its state is the permissions themselves rather than a stored flag, so the
 * switch cannot claim to be on after the user revoked access in the browser's
 * own settings. Repeated from background.js for the same reason as SITES.
 */
const YT_COOKIE_PERMISSIONS = { permissions: ['cookies'], origins: ['https://*.youtube.com/*'] };
const ytInput = document.getElementById('yt-cookies');
const ytNote = document.getElementById('yt-cookies-note');

/**
 * What to request, worked out before any click.
 *
 * Firefox 140+ also asks consent per kind of data, and only lists
 * `data_collection` from getAll() when it does. The request itself has to be
 * the first thing the click handler does: Firefox refuses permissions.request
 * once an await has run, because the click no longer counts as the user's.
 */
let ytRequest = YT_COOKIE_PERMISSIONS;

async function renderYouTubeCookies() {
  try {
    const all = await chrome.permissions.getAll();
    const firefoxConsent = Array.isArray(all.data_collection);
    if (firefoxConsent) ytRequest = { ...YT_COOKIE_PERMISSIONS, data_collection: ['authenticationInfo'] };
    const granted = await chrome.permissions.contains(YT_COOKIE_PERMISSIONS)
      && (!firefoxConsent || all.data_collection.includes('authenticationInfo'));
    ytInput.checked = granted;
  } catch {
    ytInput.checked = false;
  }
}

ytInput.addEventListener('change', () => {
  ytNote.hidden = true;
  if (ytInput.checked) {
    chrome.permissions.request(ytRequest).then((ok) => {
      ytInput.checked = ok;
      if (!ok) {
        ytNote.textContent = 'Permission was not given, so nothing is shared.';
        ytNote.hidden = false;
      }
    }).catch((e) => {
      ytInput.checked = false;
      ytNote.textContent = `The browser refused the request: ${e?.message || e}`;
      ytNote.hidden = false;
    });
  } else {
    // Dropping the permissions is what turns it off. The app would forget the
    // cookies it holds on its own within ten minutes; an empty handover makes
    // that immediate.
    chrome.permissions.remove(ytRequest).catch(() => {}).finally(renderYouTubeCookies);
    fetch('http://127.0.0.1:8888/api/youtube-cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"cookies":[]}',
    }).catch(() => {});
  }
});

render();
renderYouTubeCookies();
refreshStatus();
setInterval(refreshStatus, 3000);
