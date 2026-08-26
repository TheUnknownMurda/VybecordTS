/**
 * The offer to install an update that is already downloaded.
 *
 * The updater checks, downloads and installs on quit without ever asking (see
 * electron/updater.ts), and the card in Settings -> App is where the detail
 * lives. But someone who never opens Settings had no way of knowing a new
 * version was sitting there, and a tray app can go weeks without the quit that
 * would install it. So this is the one place the app speaks up.
 *
 * It waits for 'ready' rather than 'available': until the download has
 * finished there is nothing to offer that clicking could make happen sooner.
 *
 * The state is read on mount as well as subscribed to, because the window can
 * open long after the update was ready -- with "start minimised" the app may
 * have been in the tray for hours before anyone looked at it, and the event
 * that announced the download fired into a window that did not exist.
 */

import { el, toast } from './util.js';

const api = window.vybecord;

export function mountUpdateBanner() {
  const bar = document.getElementById('updateBar');
  if (!bar) return;

  /** Version the user has waved off. A newer one is entitled to ask again. */
  let dismissed = '';

  function paint(s) {
    if (s?.status !== 'ready' || !s.version || s.version === dismissed) {
      bar.hidden = true;
      bar.replaceChildren();
      return;
    }
    bar.replaceChildren(
      el('span', { class: 'ub-text' }, [
        el('b', { text: `Vybecord ${s.version} is ready to install.` }),
        el('span', { text: ' It installs by itself the next time you quit — or restart into it now.' }),
      ]),
      el('button', {
        class: 'btn btn-sm btn-primary',
        text: 'Restart and update',
        onclick: () => api.installUpdate().catch((e) => toast(e.message, 'err')),
      }),
      el('button', {
        class: 'btn btn-sm',
        text: 'Later',
        // Only for this session, and it costs nothing: the update installs on
        // quit regardless, which is what the sentence above promises.
        onclick: () => { dismissed = s.version; bar.hidden = true; },
      }),
    );
    bar.hidden = false;
  }

  api.updateStatus().then(paint).catch(() => { /* the event will bring it */ });
  api.on('updateStatus', paint);
}
