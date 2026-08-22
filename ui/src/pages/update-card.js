/**
 * Update status.
 *
 * The updater works on its own — it checks, downloads and installs on quit
 * without asking. This card exists so that is visible rather than mysterious,
 * and so someone who wants the new version now can restart into it.
 */

import { el, toast } from '../util.js';
import { state } from '../state.js';

const api = window.vybecord;

export function updateCard() {
  const card = el('div', { class: 'card' });
  const body = el('div');

  const check = el('button', {
    class: 'btn btn-sm', text: 'Check now',
    onclick: async () => {
      check.disabled = true;
      check.textContent = 'Checking…';
      try {
        paint(await api.checkForUpdate());
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        check.disabled = false;
        check.textContent = 'Check now';
      }
    },
  });

  function paint(s) {
    const version = state.version ? `v${state.version}` : '';
    const rows = {
      idle: () => [el('div', { class: 'row-desc' }, `Running ${version}. Updates are checked shortly after launch.`)],
      checking: () => [el('div', { class: 'row-desc' }, 'Checking for a newer version…')],
      none: () => [el('div', { class: 'row-desc' }, `${version} is the latest version.`)],
      available: () => [el('div', { class: 'row-desc' }, `Version ${s.version} found — downloading it now.`)],
      downloading: () => [
        el('div', { class: 'row-desc' }, `Downloading${s.version ? ` ${s.version}` : ''} — ${s.percent}%`),
        el('div', { class: 'np-bar', style: 'margin-top:8px' }, [
          el('div', { class: 'np-fill', style: `width:${s.percent}%` }),
        ]),
      ],
      ready: () => [
        el('div', { class: 'notice' }, [
          el('b', { text: `Version ${s.version} is ready. ` }),
          el('span', { text: 'It installs by itself the next time you close Vybecord — or restart into it now.' }),
        ]),
        el('button', {
          class: 'btn btn-primary', text: 'Restart and update',
          onclick: () => api.installUpdate().catch(e => toast(e.message, 'err')),
        }),
      ],
      error: () => [
        el('div', { class: 'row-desc' }, `Could not check for updates: ${s.message}`),
        el('div', { class: 'row-desc', style: 'margin-top:4px' },
          'Not a problem in itself — it will try again later.'),
      ],
    };
    body.replaceChildren(...(rows[s?.status] || rows.idle)());
  }

  card.replaceChildren(
    el('div', { class: 'card-head' }, [el('h2', { text: 'Updates' }), check]),
    body,
  );

  api.updateStatus().then(paint).catch(() => paint({ status: 'idle' }));
  // The updater pushes as it goes, so the card follows a download live.
  const off = api.on('updateStatus', paint);

  return { card, dispose: off };
}
