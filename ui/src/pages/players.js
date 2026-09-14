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
 *
 * With two presences on, each card can be pinned to either of them: presence 1
 * to the song, presence 2 to the video, and neither ever swaps with the other.
 */

import { el, fmtTime, platformInfo, toast } from '../util.js';
import { state, subscribe, set } from '../state.js';

const api = window.vybecord;

const dual = () => state.status?.dualPresence === true;

export function render(root) {
  const list = el('div', { class: 'grid', id: 'playerList' });
  const head = el('div', { class: 'card-head', id: 'playerHead' });

  root.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('h1', { text: 'Players' }),
      el('div', { class: 'sub', id: 'playerSub' }),
      el('div', { class: 'sub', id: 'playerSub2' }),
    ]),
    el('div', { class: 'card' }, [head, list]),
    el('div', { class: 'card' }, [
      el('h2', { text: 'How detection works' }),
      el('div', { class: 'row-desc', style: 'margin-top:8px;max-width:none' },
        'Vybecord reads the same Windows media session API that the volume overlay uses. '
        + 'Any app that publishes to it — Spotify, a browser tab, VLC, foobar2000 — is detected with no setup, '
        + 'no extension, and no script. Apps that do not publish to it cannot be seen at all.'),
    ]),
  );

  const paint = () => { paintHead(head); paintList(list); };
  paint();
  const unsubs = [
    subscribe('players', paint),
    subscribe('preferredPlayer', paint),
    subscribe('preferredPlayers', paint),
    subscribe('status', paint),
  ];
  return () => unsubs.forEach((fn) => fn());
}

/** The pin each presence holds, presence 1 falling back to the legacy field. */
function pins() {
  const arr = Array.isArray(state.preferredPlayers) ? state.preferredPlayers : [];
  return [arr[0] ?? state.preferredPlayer ?? null, arr[1] ?? null];
}

function paintHead(head) {
  const [p1, p2] = pins();
  document.querySelector('#playerSub').textContent = dual()
    ? 'Everything Windows currently reports as playing media. Pin a player to presence 1 or presence 2.'
    : 'Everything Windows currently reports as playing media. Click one to pin the presence to it.';
  document.querySelector('#playerSub2').textContent = dual()
    ? 'A pinned presence shows that player and nothing else; the other presence stays automatic unless it is pinned too.'
    : 'A pin is exclusive: while it is set, nothing else is announced — not another player, and not the browser extension.';

  head.replaceChildren(
    el('h2', { text: 'Detected sessions' }),
    el('div', { class: 'item-actions' }, dual()
      ? [
          el('button', {
            class: `btn btn-sm ${p1 ? '' : 'btn-primary'}`.trim(),
            text: 'Presence 1: automatic',
            title: 'Let presence 1 pick its player by priority',
            onclick: () => pin(null, 0),
          }),
          el('button', {
            class: `btn btn-sm ${p2 ? '' : 'btn-primary'}`.trim(),
            text: 'Presence 2: automatic',
            title: 'Let presence 2 take the next thing playing',
            onclick: () => pin(null, 1),
          }),
        ]
      : [
          el('button', {
            class: `btn btn-sm ${p1 ? '' : 'btn-primary'}`.trim(),
            text: 'Automatic',
            title: 'Go back to picking the player automatically',
            onclick: () => pin(null, 0),
          }),
        ]),
  );
}

function paintList(list) {
  const players = state.players || [];
  const [p1, p2] = pins();

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
    const pinnedTo = p.appId === p1 ? 0 : p.appId === p2 ? 1 : -1;
    const pinned = pinnedTo >= 0;
    const twoWay = dual();
    return el('div', {
      class: `player-card ${pinned ? 'pinned' : ''} ${twoWay ? 'has-pins' : ''}`.trim(),
      title: twoWay ? '' : pinned ? 'Pinned — click to unpin' : `Pin the presence to ${label}`,
      onclick: twoWay ? null : () => pin(pinned ? null : p.appId, 0),
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
      twoWay
        ? el('div', { class: 'pin-btns' }, [0, 1].map((i) => el('button', {
            class: `btn btn-sm ${pinnedTo === i ? 'btn-primary' : ''}`.trim(),
            text: pinnedTo === i ? `Pinned · ${i + 1}` : `Pin to ${i + 1}`,
            title: pinnedTo === i
              ? `Pinned to presence ${i + 1} — click to unpin`
              : `Pin presence ${i + 1} to ${label}`,
            onclick: (e) => { e.stopPropagation(); pin(pinnedTo === i ? null : p.appId, i); },
          })))
        : pinned ? el('span', { class: 'badge accent', text: 'Pinned' }) : null,
    ]);
  }));
}

async function pin(appId, slot) {
  const res = await api.preferPlayer(appId, slot);
  set({
    preferredPlayer: res?.preferred ?? null,
    preferredPlayers: Array.isArray(res?.preferredPlayers) ? res.preferredPlayers : [res?.preferred ?? null, null],
  });
  const which = dual() ? ` (presence ${slot + 1})` : '';
  toast(appId ? `Pinned to this player${which}` : `Player selection back to automatic${which}`, 'ok');
}
