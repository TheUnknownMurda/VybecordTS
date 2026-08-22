/**
 * Last.fm — scrobbling setup.
 *
 * The old web dashboard used Last.fm's callback flow, catching the redirect on
 * the app's own HTTP server. There is no server now, so this is the desktop
 * flow: the app takes a token, opens the approval page, and exchanges the token
 * once you confirm. That confirmation step is why this is a two-button dance
 * rather than one click.
 */

import { el, toast } from '../util.js';
import { state, saveConfig } from '../state.js';

const api = window.vybecord;

export function render(root) {
  const status = el('div', { class: 'muted' });
  const actions = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:14px' });
  let pendingToken = '';

  const apiKey = el('input', { type: 'text', value: state.config.lastfm_api_key || '', placeholder: '32-character API key' });
  const apiSecret = el('input', { type: 'password', placeholder: state.config.lastfm_api_secret ? '•••••••• (saved)' : 'Shared secret' });

  root.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('h1', { text: 'Last.fm' }),
      el('div', { class: 'sub', text: 'Scrobble what you listen to. Entirely optional.' }),
    ]),

    el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: 'Connection' }), status]),
      actions,
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: 'API credentials' }),
      el('div', { class: 'row-desc', style: 'margin-top:6px;max-width:none' },
        'Create an API account at last.fm/api/account/create, then paste the key and secret here. '
        + 'They are stored in your local config and never leave this machine except to talk to Last.fm.'),
      el('div', { style: 'margin-top:14px' }, [
        el('label', { class: 'field' }, [el('span', { text: 'API key' }), apiKey]),
        el('label', { class: 'field' }, [el('span', { text: 'Shared secret' }), apiSecret]),
      ]),
      el('div', { style: 'display:flex;gap:8px' }, [
        el('button', {
          class: 'btn btn-primary', text: 'Save credentials',
          onclick: async () => {
            const patch = { lastfm_api_key: apiKey.value.trim() };
            // An untouched secret field must not blank out the stored value.
            if (apiSecret.value.trim()) patch.lastfm_api_secret = apiSecret.value.trim();
            await saveConfig(patch);
            apiSecret.value = '';
            toast('Saved — restart the app for them to take effect', 'ok');
            refresh();
          },
        }),
        el('button', {
          class: 'btn btn-sm', text: 'Open Last.fm API page',
          onclick: () => api.openExternal('https://www.last.fm/api/account/create'),
        }),
      ]),
    ]),
  );

  async function refresh() {
    let s;
    try {
      s = await api.lastfmStatus();
    } catch (e) {
      status.textContent = `Unavailable: ${e.message}`;
      return;
    }

    actions.replaceChildren();

    if (s.scrobbling) {
      status.replaceChildren(el('span', { class: 'badge accent', text: 'Connected' }));
      actions.append(el('button', {
        class: 'btn btn-danger', text: 'Disconnect',
        onclick: async () => {
          await api.lastfmDisconnect();
          toast('Disconnected', 'ok');
          refresh();
        },
      }));
      return;
    }

    if (!s.canAuth) {
      status.replaceChildren(el('span', { class: 'badge', text: 'Not configured' }));
      actions.append(el('div', { class: 'muted', text: 'Add your API key and secret below, then restart the app.' }));
      return;
    }

    status.replaceChildren(el('span', { class: 'badge', text: 'Not connected' }));

    const step2 = el('button', {
      class: 'btn btn-primary', text: 'I approved it — finish',
      disabled: true,
      onclick: async () => {
        try {
          await api.lastfmComplete(pendingToken);
          toast('Connected to Last.fm ✓', 'ok');
          refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      },
    });

    actions.append(
      el('button', {
        class: 'btn', text: '1. Authorise in browser',
        onclick: async () => {
          try {
            const res = await api.lastfmBeginAuth();
            pendingToken = res.token;
            step2.disabled = false;
            toast('Approve the page in your browser, then come back and finish', 'ok');
          } catch (e) {
            toast(e.message, 'err');
          }
        },
      }),
      step2,
    );
  }

  refresh();
}
