/**
 * Players — every media session Windows reports, and which one to follow.
 *
 * By default the backend picks by priority (a dedicated music app beats a
 * browser tab). Pinning overrides that, which matters when two things play at
 * once and the automatic choice is not the one you want announced.
 *
 * The pin binds a player, not a transport: the browser extension reporting the
 * same service as the pinned session still counts as that player, so pinning a
 * tab keeps the extension's better data rather than throwing it away.
 */

import { el, fmtTime, platformInfo, toast } from '../util.js';
import { state, subscribe, set } from '../state.js';

const api = window.vybecord;

export function render(root) {
  const list = el('div', { class: 'grid', id: 'playerList' });

  root.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('h1', { text: 'Players' }),
      el('div', { class: 'sub', text: 'Everything Windows currently reports as playing media. Click one to pin the presence to it.' }),
      el('div', { class: 'sub', text: 'A pin is exclusive: while it is set, nothing else is announced — not another player, and not the browser extension.' }),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Detected sessions' }),
        el('button', {
          class: 'btn btn-sm', id: 'btnAuto', text: 'Automatic',
          title: 'Go back to picking the player automatically',
          onclick: () => pin(null),
        }),
      ]),
      list,
    ]),
    el('div', { class: 'card' }, [
      el('h2', { text: 'How detection works' }),
      el('div', { class: 'row-desc', style: 'margin-top:8px;max-width:none' },
        'Vybecord reads the same Windows media session API that the volume overlay uses. '
        + 'Any app that publishes to it — Spotify, a browser tab, VLC, foobar2000 — is detected with no setup, '
        + 'no extension, and no script. Apps that do not publish to it cannot be seen at all.'),
    ]),
  );

  const paint = () => paintList(list);
  paint();
  const unsubs = [subscribe('players', paint), subscribe('preferredPlayer', paint)];
  return () => unsubs.forEach((fn) => fn());
}

function paintList(list) {
  const players = state.players || [];
  document.querySelector('#btnAuto')?.classList.toggle('btn-primary', !state.preferredPlayer);

  if (!players.length) {
    list.replaceChildren(el('div', {
      class: 'empty',
      text: 'No media session detected. Start playing something and it will appear here.',
    }));
    return;
  }

  // Playing first, then alphabetically — a stable order stops cards from
  // reshuffling under the cursor on every 2s refresh.
  const sorted = [...players].sort((a, b) => (
    (b.playing ? 1 : 0) - (a.playing ? 1 : 0) || a.source.localeCompare(b.source)
  ));

  list.replaceChildren(...sorted.map((p) => {
    const [label, glyph] = platformInfo(p.source);
    const pinned = state.preferredPlayer === p.appId;
    return el('div', {
      class: `player-card ${pinned ? 'pinned' : ''}`.trim(),
      title: pinned ? 'Pinned — click to unpin' : `Pin the presence to ${label}`,
      onclick: () => pin(pinned ? null : p.appId),
    }, [
      el('div', { class: 'player-icon', text: glyph }),
      el('div', { class: 'item-body' }, [
        el('div', { class: 'item-title', text: p.title || label }),
        el('div', { class: 'item-sub', text: p.artist ? `${p.artist} · ${label}` : label }),
      ]),
      p.durationMs > 0
        ? el('div', { class: 'item-meta', text: `${fmtTime(p.positionMs)} / ${fmtTime(p.durationMs)}` })
        : null,
      p.isAd ? el('span', { class: 'badge', title: 'Detected as an advertisement and not announced', text: 'Ad' }) : null,
      p.playing ? el('span', { class: 'pulse', title: 'Playing' }) : null,
      pinned ? el('span', { class: 'badge accent', text: 'Pinned' }) : null,
    ]);
  }));
}

async function pin(appId) {
  const res = await api.preferPlayer(appId);
  set({ preferredPlayer: res?.preferred ?? null });
  toast(appId ? 'Pinned to this player' : 'Player selection back to automatic', 'ok');
}
