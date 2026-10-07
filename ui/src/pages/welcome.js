/**
 * Help & setup — the first screen of a fresh install, and a checklist after.
 *
 * Two things have to be true for anything to reach Discord: the Discord app is
 * running, and something is playing that Vybecord can see. Both are read live,
 * so this page ticks itself off as the user goes. Everything after that is
 * optional, and says so.
 */

import { el, platformInfo, toggleRow } from '../util.js';
import { state, subscribe, saveConfig } from '../state.js';
import { goto } from '../router.js';

const api = window.vybecord;

const TICK = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>';
const MARK = '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const ARROW = '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

export function render(root) {
  const mark = el('span', { class: 'wel-mark', 'aria-hidden': 'true' });
  mark.innerHTML = MARK;

  const discordStep = el('li', { class: 'wel-step' });
  const mediaStep = el('li', { class: 'wel-step' });
  const extraStep = el('li', { class: 'wel-step' });

  const open = el('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: () => goto('now') }, ['Open Vybecord']);
  open.insertAdjacentHTML('beforeend', ARROW);

  root.replaceChildren(el('div', { class: 'welcome' }, [
    el('div', { class: 'wel-head' }, [
      mark,
      el('h1', { text: 'Welcome to Vybecord' }),
      el('p', { text: 'Your music, your streams and synced lyrics on your Discord profile. Two things to check, then it runs on its own.' }),
    ]),
    el('ol', { class: 'card wel-steps' }, [discordStep, mediaStep, extraStep]),
    el('div', { class: 'wel-foot' }, [
      el('button', { type: 'button', class: 'btn btn-ghost', text: 'Report a problem', onclick: () => goto('report') }),
      open,
    ]),
  ]));

  /*
   * Repainted from a key: 'slots' fires on every progress tick, and rebuilding
   * the steps once a second would swallow clicks on their buttons.
   */
  let key = '';
  /** Asks the add-ons where they stand again; set once the extras are drawn. */
  let recheck = null;
  function paintLive() {
    const s = state.status || {};
    const playing = state.slots.map((x) => x.track).find(Boolean) || null;
    const k = [s.discordConnected, s.mediaSourceReady, playing?.track_name, playing?.media_source].join('|');
    if (k === key) return;
    key = k;
    // An add-on connects by reporting what plays, so this is when it changes.
    recheck?.();

    step(discordStep, s.discordConnected, 1, 'Discord is open',
      s.discordConnected
        ? 'Connected to the Discord app on this PC.'
        : 'Start the Discord desktop app on this PC — the browser version cannot show a status from other apps. This ticks itself once it is up.');

    const desc = el('div', { class: 'wel-desc' });
    if (playing) {
      desc.append('Found ', el('b', { text: playing.track_name || 'a track', style: 'color:var(--text-primary);font-weight:600' }),
        ` on ${platformInfo(playing.media_source)[0]} — it is on your profile now.`);
    } else {
      desc.textContent = s.mediaSourceReady
        ? 'Press play in Spotify, a browser tab, VLC or any app that shows up in the Windows volume overlay.'
        : 'Windows media detection is not available yet — it usually starts within a few seconds.';
    }
    step(mediaStep, !!playing, 2, 'Play something', desc);
  }

  /** The optional extras, each with what it is for and where it stands. Returns a re-check. */
  function paintExtras() {
    const ext = el('span', { class: 'badge', text: 'Checking…' });
    const spot = el('span', { class: 'badge', text: 'Checking…' });
    const fm = el('span', { class: 'badge', text: 'Checking…' });

    const opt = (title, desc, badge, action) => el('div', { class: 'wel-opt' }, [
      el('div', { style: 'flex:1 1 260px;min-width:0' }, [
        el('div', { class: 'row-label', text: title }),
        el('div', { class: 'row-desc', text: desc }),
      ]),
      el('div', { style: 'display:flex;align-items:center;gap:10px' }, [badge, action]),
    ]);
    const toIntegrations = (label) => el('button', {
      type: 'button', class: 'btn btn-sm', text: label, onclick: () => goto('settings', { cat: 'integrations' }),
    });
    const extBtn = toIntegrations('Set up');
    const spotBtn = toIntegrations('Set up');
    const fmBtn = toIntegrations('Connect');

    const body = el('div', { class: 'wel-body' }, [
      el('div', {}, [
        el('div', { class: 'wel-title' }, ['Make it better ', el('span', { style: 'font-weight:500;color:var(--text-muted)', text: '— optional' })]),
        el('div', { class: 'wel-desc', text: 'Any time from Settings → Integrations.' }),
      ]),
      opt('Browser extension', 'Recognises YouTube, SoundCloud, Twitch and Kick tabs by name, with the exact position.', ext, extBtn),
      opt('Spotify, through Spicetify', 'Spotify’s own synced lyrics, every artist, the playlist you are in.', spot, spotBtn),
      opt('Last.fm', 'Scrobble everything you play.', fm, fmBtn),
      el('div', { class: 'wel-opt', style: 'padding:0 14px' }, [
        el('div', { style: 'flex:1' }, [
          toggleRow('Start with Windows', 'Runs in the background, without opening this window.',
            state.config.launch_on_startup === true, (v) => saveConfig({ launch_on_startup: v })),
        ]),
      ]),
    ]);
    const n = el('span', { class: 'wel-n', text: '3' });
    extraStep.className = 'wel-step';
    extraStep.replaceChildren(n, body);

    // A connected add-on has nothing left to set up, so its button goes: "Connected"
    // beside "Set up" read as a contradiction. Hidden rather than removed, since
    // the answer can change while the page is open.
    const done = (badge, button, on, text) => {
      badge.className = `badge${on ? ' accent' : ''}`;
      badge.textContent = text;
      button.hidden = !!on;
    };
    api.lastfmStatus().then((s) => done(fm, fmBtn, s?.scrobbling, s?.scrobbling ? 'Connected' : 'Not connected'))
      .catch(() => done(fm, fmBtn, false, 'Unknown'));

    /*
     * The two add-ons are asked more than once. On a first launch this page
     * opens before Spotify's extension has said hello — 0.8s after start on a
     * real PC — and the single answer it got left "Installed" and "Set up" on
     * screen for an add-on that was connected by the time anyone read them.
     * The newest question is the one that paints: the extension's answer
     * looks for browsers on disk and can come back after a later one.
     */
    let asked = 0;
    return function check() {
      const mine = ++asked;
      api.extensionInfo()
        .then((i) => { if (mine === asked) done(ext, extBtn, i?.connected, i?.connected ? 'Connected' : 'Not set up'); })
        .catch(() => { if (mine === asked) done(ext, extBtn, false, 'Unknown'); });
      api.spicetifyInfo()
        .then((i) => { if (mine === asked) done(spot, spotBtn, i?.connected, i?.connected ? 'Connected' : i?.installed && i?.extensionEnabled ? 'Installed' : 'Not set up'); })
        .catch(() => { if (mine === asked) done(spot, spotBtn, false, 'Unknown'); });
    };
  }

  paintLive();
  recheck = paintExtras();
  recheck();
  // A few times over the first seconds, for the add-ons still starting up.
  const retries = [1500, 4000, 10000].map((ms) => setTimeout(() => recheck(), ms));
  const unsubs = [subscribe('status', paintLive), subscribe('slots', paintLive)];
  return () => {
    retries.forEach(clearTimeout);
    unsubs.forEach((fn) => fn());
  };
}

/** Fill one of the two required steps: a tick when it is done, its number when not. */
function step(li, done, n, title, desc) {
  const mark = el('span', { class: 'wel-n' });
  if (done) mark.innerHTML = TICK;
  else mark.textContent = String(n);
  li.className = `wel-step${done ? ' done' : ''}`;
  li.replaceChildren(mark, el('div', { class: 'wel-body' }, [
    el('div', {}, [
      el('div', { class: 'wel-title', text: title }),
      typeof desc === 'string' ? el('div', { class: 'wel-desc', text: desc }) : desc,
    ]),
  ]));
}
