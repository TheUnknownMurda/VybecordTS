/**
 * Last.fm — scrobbling setup, as a card for Settings → Integrations.
 *
 * The old web dashboard used Last.fm's callback flow, catching the redirect on
 * the app's own HTTP server. There is no server now, so this is the desktop
 * flow: the app takes a token, opens the approval page, and exchanges the token
 * once you confirm. That confirmation step is why this is a two-button dance
 * rather than one click.
 *
 * It was a page of its own; it is one optional add-on among several, so it
 * now sits with the others.
 */

import { el, toast } from '../util.js';
import { state, saveConfig } from '../state.js';

const api = window.vybecord;

export function lastfmCard() {
  const status = el('span', { class: 'badge', text: 'Checking…' });
  const actions = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px' });
  let pendingToken = '';

  const apiKey = el('input', { type: 'text', value: state.config.lastfm_api_key || '', placeholder: '32-character API key' });
  const apiSecret = el('input', { type: 'password', placeholder: state.config.lastfm_api_secret ? '•••••••• (saved)' : 'Shared secret' });

  /**
   * Clearing the credentials is its own button, because the form cannot tell
   * "remove these" from "this field never got filled in" — and guessing wrong
   * silently switches scrobbling off, with the saved session still sitting on
   * disk looking connected.
   */
  const forget = el('button', {
    type: 'button', class: 'btn btn-sm btn-danger', text: 'Remove credentials',
    onclick: async () => {
      await saveConfig({ lastfm_api_key: '', lastfm_api_secret: '' });
      apiKey.value = '';
      apiSecret.value = '';
      apiSecret.placeholder = 'Shared secret';
      toast('Credentials removed', 'ok');
      refresh();
    },
  });

  // Folded away once they are saved: they are filled in once, and after that
  // they are only clutter between the user and the connect button.
  const creds = el('details', { style: 'margin-top:16px' }, [
    el('summary', { class: 'row-label', style: 'cursor:pointer', text: 'API credentials' }),
    el('div', { class: 'row-desc', style: 'margin:8px 0 12px;max-width:none' },
      'Create an API account at last.fm/api/account/create, then paste the key and secret here. '
      + 'They are stored in your local config and never leave this machine except to talk to Last.fm.'),
    el('label', { class: 'field' }, [el('span', { text: 'API key' }), apiKey]),
    el('label', { class: 'field' }, [el('span', { text: 'Shared secret' }), apiSecret]),
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
      el('button', {
        type: 'button', class: 'btn btn-primary btn-sm', text: 'Save credentials',
        onclick: async () => {
          // Neither field blanks what is stored. The secret is never rendered
          // back, so an empty one means untouched; the key is rendered back,
          // but an empty one is far more often a form that opened without the
          // config than a deliberate wipe — and a wiped key takes scrobbling
          // down with it. "Remove credentials" says so out loud.
          const patch = {};
          if (apiKey.value.trim()) patch.lastfm_api_key = apiKey.value.trim();
          if (apiSecret.value.trim()) patch.lastfm_api_secret = apiSecret.value.trim();
          if (!Object.keys(patch).length) {
            toast('Nothing to save — paste your key and secret first', 'err');
            return;
          }
          await saveConfig(patch);
          apiSecret.value = '';
          apiSecret.placeholder = '•••••••• (saved)';
          // Picked up live by the backend, so the connect buttons are usable
          // straight away — no restart.
          toast('Saved — you can connect now', 'ok');
          refresh();
        },
      }),
      el('button', {
        type: 'button', class: 'btn btn-sm', text: 'Open Last.fm API page',
        onclick: () => api.openExternal('https://www.last.fm/api/account/create'),
      }),
      forget,
    ]),
  ]);

  const card = el('div', { class: 'card' }, [
    el('div', { class: 'card-head', style: 'margin-bottom:0' }, [
      el('div', {}, [
        el('div', { class: 'row-label', text: 'Scrobbling' }),
        el('div', { class: 'row-desc', text: 'Log what you listen to on your Last.fm profile. Entirely optional.' }),
      ]),
      status,
    ]),
    actions,
    creds,
  ]);

  async function refresh() {
    // Nothing stored, nothing to remove.
    forget.hidden = !(state.config.lastfm_api_key || state.config.lastfm_api_secret);

    let s;
    try {
      s = await api.lastfmStatus();
    } catch (e) {
      status.textContent = 'Unavailable';
      actions.replaceChildren(el('div', { class: 'muted', text: e.message }));
      return;
    }

    actions.replaceChildren();

    if (s.scrobbling) {
      status.className = 'badge accent';
      status.textContent = s.user ? `Connected as ${s.user}` : 'Connected';
      creds.open = false;
      // Scrobbles Last.fm has not taken yet are held on disk rather than lost,
      // so say so: an unreachable Last.fm otherwise looks like a silent failure.
      if (s.pending > 0) {
        actions.append(el('div', {
          class: 'muted',
          text: `${s.pending} scrobble${s.pending > 1 ? 's' : ''} waiting to be sent — they go out with the next track.`,
        }));
      }
      actions.append(el('button', {
        type: 'button', class: 'btn btn-sm btn-danger', text: 'Disconnect',
        onclick: async () => {
          await api.lastfmDisconnect();
          toast('Disconnected', 'ok');
          refresh();
        },
      }));
      return;
    }

    status.className = 'badge';
    if (!s.canAuth) {
      status.textContent = 'Not set up';
      creds.open = true;
      actions.append(el('div', { class: 'muted', text: 'Add your API key and secret below, then connect.' }));
      return;
    }

    status.textContent = 'Not connected';

    const step2 = el('button', {
      type: 'button', class: 'btn btn-primary btn-sm', text: '2. I approved it — finish',
      disabled: true,
      onclick: async () => {
        try {
          await api.lastfmComplete(pendingToken);
          toast('Connected to Last.fm', 'ok');
          refresh();
        } catch (e) {
          toast(e.message, 'err');
        }
      },
    });

    actions.append(
      el('button', {
        type: 'button', class: 'btn btn-sm', text: '1. Authorise in browser',
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
  return card;
}
