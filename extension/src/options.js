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
 * Ask the worker whether the last push reached the app.
 *
 * The worker only learns this by pushing, so before anything has played the
 * honest answer is "not known yet" rather than a red light.
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

render();
refreshStatus();
setInterval(refreshStatus, 3000);
