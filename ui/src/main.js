/**
 * Renderer entry — boots state, wires the chrome, routes between pages.
 *
 * Pages are plain modules exposing render(root) and optionally returning a
 * cleanup function. The router calls that cleanup before swapping pages, which
 * is what keeps intervals and state subscriptions from piling up as the user
 * navigates back and forth.
 */

import { $, $$, el, toast } from './util.js';
import { state, subscribe, init } from './state.js';
import { setNavigator } from './router.js';
import { mountUpdateBanner } from './update-banner.js';

import * as now from './pages/now.js';
import * as players from './pages/players.js';
import * as stats from './pages/stats.js';
import * as history from './pages/history.js';
import * as library from './pages/library.js';
import * as settings from './pages/settings.js';
import * as account from './pages/account.js';
import * as report from './pages/report.js';

const api = window.vybecord;
const PAGES = { now, players, stats, history, library, settings, account, report };

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

  $$('#sidebar .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
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

  $('#btnQuit').addEventListener('click', () => api.quit());
  $('#btnMin').addEventListener('click', () => api.minimize());
  $('#btnMax').addEventListener('click', () => api.toggleMaximize());
  $('#btnClose').addEventListener('click', () => api.close());

  // Number keys jump between pages; Ctrl+Q quits.
  const order = Object.keys(PAGES);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'q') {
      e.preventDefault();
      api.quit();
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (document.activeElement?.matches('input, textarea, select')) return;
    const index = Number(e.key) - 1;
    if (index >= 0 && index < order.length) navigate(order[index]);
  });
}

/** Connection dots in the title bar. */
function paintStatus() {
  const { discordConnected, mediaSourceReady } = state.status;
  $('#tbStatus').replaceChildren(
    el('span', { class: `dot ${mediaSourceReady ? 'on' : 'off'}`, title: mediaSourceReady ? 'Media detection active' : 'Media detection unavailable' }),
    el('span', { text: mediaSourceReady ? 'Media' : 'No media' }),
    el('span', { class: `dot ${discordConnected ? 'on' : 'off'}`, title: discordConnected ? 'Connected to Discord' : 'Discord not connected' }),
    el('span', { text: discordConnected ? 'Discord' : 'No Discord' }),
  );
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
      style: 'display:grid;place-items:center;height:100vh;padding:40px;text-align:center;color:#a1a1aa',
      text: `Vybecord could not reach its backend: ${e.message}`,
    }));
    return;
  }

  document.documentElement.dataset.theme = state.config.theme === 'light' ? 'light' : 'dark';
  subscribe('config', (cfg) => {
    document.documentElement.dataset.theme = cfg.theme === 'light' ? 'light' : 'dark';
  });

  paintStatus();
  subscribe('status', paintStatus);
  mountUpdateBanner();

  navigate('now');
}

main();
