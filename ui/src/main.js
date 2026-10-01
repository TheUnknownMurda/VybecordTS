/**
 * Renderer entry — boots state, wires the chrome, routes between pages.
 *
 * Pages are plain modules exposing render(root) and optionally returning a
 * cleanup function. The router calls that cleanup before swapping pages, which
 * is what keeps intervals and state subscriptions from piling up as the user
 * navigates back and forth.
 */

import { $, $$, el, toast, platformInfo } from './util.js';
import { state, subscribe, init } from './state.js';
import { setNavigator } from './router.js';
import { mountUpdateBanner } from './update-banner.js';

import * as now from './pages/now.js';
import * as library from './pages/library.js';
import * as activity from './pages/activity.js';
import * as settings from './pages/settings.js';
import * as welcome from './pages/welcome.js';
import * as report from './pages/report.js';

const api = window.vybecord;
const PAGES = { now, library, activity, settings, welcome, report };
/** The pages the number keys reach, in sidebar order. */
const KEYED = ['now', 'library', 'activity', 'settings'];

let currentPage = '';
let cleanup = null;

/**
 * @param params optional handover for the destination page's render(). Pages
 *   that do not expect one ignore it.
 */
function navigate(name, params) {
  if (!PAGES[name]) return;
  // Re-entering the page you are already on is a no-op — unless the caller has
  // something new for it, which is how "flag these lyrics, now open the import
  // form with them" works from anywhere, including from inside that page.
  if (name === currentPage && !params) return;

  if (typeof cleanup === 'function') {
    try {
      cleanup();
    } catch (e) {
      console.error(`cleanup for "${currentPage}" failed`, e);
    }
  }
  cleanup = null;
  currentPage = name;

  $$('#sidebar .nav-item').forEach((b) => {
    const on = b.dataset.page === name;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $$('#content .page').forEach((p) => p.classList.toggle('active', p.dataset.page === name));

  const root = $(`#content .page[data-page="${name}"]`);
  try {
    cleanup = PAGES[name].render(root, params) || null;
  } catch (e) {
    console.error(`render of "${name}" failed`, e);
    root.replaceChildren(el('div', { class: 'empty', text: `This page failed to load: ${e.message}` }));
  }
  // Each page starts at the top rather than inheriting the previous scroll.
  $('#content').scrollTop = 0;
}

function wireChrome() {
  setNavigator(navigate);

  $$('#sidebar .nav-item[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.page));
  });

  $('#btnMin').addEventListener('click', () => api.minimize());
  $('#btnMax').addEventListener('click', () => api.toggleMaximize());
  $('#btnClose').addEventListener('click', () => api.close());

  // Number keys jump between the sidebar's sections; Ctrl+Q quits.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'q') {
      e.preventDefault();
      api.quit();
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (document.activeElement?.matches('input, textarea, select')) return;
    const index = Number(e.key) - 1;
    if (index >= 0 && index < KEYED.length) navigate(KEYED[index]);
  });
}

/**
 * The two things that have to be true for anything to show on Discord, in the
 * sidebar where they are always in view.
 *
 * Repainted from a key rather than on every call: 'slots' fires on each
 * progress tick, and rebuilding the card once a second would make it flicker
 * for a screen reader announcing it.
 */
let statusKey = '';

function paintStatus() {
  const { discordConnected, mediaSourceReady, presenceCount, userAway, hideWhenAway, adPlaying } = state.status;
  const rpcOn = state.config.rpc_enabled !== false;
  const count = Math.max(1, Number(presenceCount) || 1);
  const playing = state.slots.slice(0, count).map((s) => s.track).filter(Boolean);

  const discordSub = !discordConnected ? 'Open the Discord app on this PC'
    : !rpcOn ? 'Rich Presence is off'
    : adPlaying ? 'Hidden during the ad'
    : userAway && hideWhenAway !== false ? 'Hidden while you are away'
    : !playing.length ? 'Waiting for something to play'
    : count > 1 ? `${playing.length} of ${count} presences live`
    : 'Your status is live';

  const sources = [...new Set(playing.map((t) => platformInfo(t.media_source)[0]))];
  const mediaSub = !mediaSourceReady ? 'Detection is unavailable'
    : sources.length ? sources.join(' · ')
    : 'Nothing playing';

  const key = [discordConnected, discordSub, mediaSourceReady, mediaSub].join('|');
  if (key === statusKey) return;
  statusKey = key;

  const row = (on, title, sub) => el('div', { class: 'ss-row', title: `${title} — ${sub}` }, [
    el('span', { class: `dot ${on ? 'on' : 'off'}` }),
    el('div', { class: 'ss-text', style: 'min-width:0' }, [
      el('div', { class: 'ss-title', text: title }),
      el('div', { class: 'ss-sub', text: sub }),
    ]),
  ]);

  $('#sideStatus').replaceChildren(
    row(discordConnected, discordConnected ? 'Discord connected' : 'Discord not found', discordSub),
    row(mediaSourceReady, 'Detecting media', mediaSub),
  );
}

/**
 * Open on the setup page the first time, and never again.
 *
 * "First time" is judged by the history as well as the flag: everyone who
 * updates from a version without this page has no flag yet, and greeting them
 * as newcomers would be the wrong thing to say to someone with months of
 * listening behind them.
 */
async function firstPage() {
  const KEY = 'vybecord.welcomed';
  let seen = false;
  try { seen = localStorage.getItem(KEY) === '1'; } catch { /* storage refused: treat as seen */ seen = true; }
  if (seen) return 'now';
  try { localStorage.setItem(KEY, '1'); } catch { /* nothing to remember it in */ }
  try {
    const res = await api.getHistory(1, 0);
    if ((res?.total || 0) > 0) return 'now';
  } catch {
    return 'now';
  }
  return 'welcome';
}

async function main() {
  wireChrome();

  api.onWindowState(({ maximized }) => {
    $('#btnMax').title = maximized ? 'Restore' : 'Maximise';
  });

  api.on('fatal', (message) => {
    toast(`Startup problem: ${message}`, 'err');
  });

  try {
    await init();
  } catch (e) {
    // Without a snapshot there is no app; say so rather than showing empty pages.
    document.body.replaceChildren(el('div', {
      style: 'display:grid;place-items:center;height:100vh;padding:40px;text-align:center;color:#9d9daa',
      text: `Vybecord could not reach its backend: ${e.message}`,
    }));
    return;
  }

  document.documentElement.dataset.theme = state.config.theme === 'light' ? 'light' : 'dark';
  subscribe('config', (cfg) => {
    document.documentElement.dataset.theme = cfg.theme === 'light' ? 'light' : 'dark';
    paintStatus();
  });

  paintStatus();
  subscribe('status', paintStatus);
  subscribe('slots', paintStatus);
  mountUpdateBanner();

  navigate(await firstPage());
}

main();
