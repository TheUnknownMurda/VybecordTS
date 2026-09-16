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
 * With several presences on, each card can be pinned to any of them: presence
 * 1 to the song, presence 2 to the video, and none ever swaps with another.
 */

import { el, fmtTime, platformInfo, toast } from '../util.js';
import { state, subscribe, set } from '../state.js';

const api = window.vybecord;

const presenceCount = () => Math.max(1, Number(state.status?.presenceCount) || 1);
const multi = () => presenceCount() > 1;

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

/** The pin each presence in play holds, presence 1 falling back to the legacy field. */
function pins() {
  const arr = Array.isArray(state.preferredPlayers) ? state.preferredPlayers : [];
  return Array.from({ length: presenceCount() }, (_, i) => (i === 0 ? arr[0] ?? state.preferredPlayer ?? null : arr[i] ?? null));
}

function paintHead(head) {
  const p = pins();
  document.querySelector('#playerSub').textContent = multi()
    ? `Everything Windows currently reports as playing media. Pin a player to one of the ${p.length} presences.`
    : 'Everything Windows currently reports as playing media. Click one to pin the presence to it.';
  document.querySelector('#playerSub2').textContent = multi()
    ? 'A pinned presence shows that player and nothing else; the others stay automatic unless they are pinned too.'
    : 'A pin is exclusive: while it is set, nothing else is announced — not another player, and not the browser extension.';

  head.replaceChildren(
    el('h2', { text: 'Detected sessions' }),
    el('div', { class: 'item-actions' }, multi()
      ? p.map((pinned, i) => el('button', {
          class: `btn btn-sm ${pinned ? '' : 'btn-primary'}`.trim(),
          text: `Presence ${i + 1}: automatic`,
          title: i === 0
            ? 'Let presence 1 pick its player by priority'
            : `Let presence ${i + 1} take the next thing playing`,
          onclick: () => pin(null, i),
        }))
      : [
          el('button', {
            class: `btn btn-sm ${p[0] ? '' : 'btn-primary'}`.trim(),
            text: 'Automatic',
            title: 'Go back to picking the player automatically',
            onclick: () => pin(null, 0),
          }),
        ]),
  );
}

function paintList(list) {
  const players = state.players || [];
  const p = pins();

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

  list.replaceChildren(...sorted.map((p_) => {
    const [label, glyph] = platformInfo(p_.source);
    const pinnedTo = p.indexOf(p_.appId);
    const pinned = pinnedTo >= 0;
    const twoWay = multi();
    return el('div', {
      class: `player-card ${pinned ? 'pinned' : ''} ${twoWay ? 'has-pins' : ''}`.trim(),
      title: twoWay ? '' : pinned ? 'Pinned — click to unpin' : `Pin the presence to ${label}`,
      onclick: twoWay ? null : () => pin(pinned ? null : p_.appId, 0),
    }, [
      el('div', { class: 'player-icon', text: glyph }),
      el('div', { class: 'item-body' }, [
        el('div', { class: 'item-title', text: p_.title || label }),
        el('div', { class: 'item-sub', text: p_.artist ? `${p_.artist} · ${label}` : label }),
      ]),
      p_.durationMs > 0
        ? el('div', { class: 'item-meta', text: `${fmtTime(p_.positionMs)} / ${fmtTime(p_.durationMs)}` })
        : null,
      p_.isAd ? el('span', { class: 'badge', title: 'Detected as an advertisement and not announced', text: 'Ad' }) : null,
      p_.playing ? el('span', { class: 'pulse', title: 'Playing' }) : null,
      twoWay
        // Past three presences the buttons carry the number alone, under
        // one "Pin to" label — five "Pin to N" in a row crowded the title.
        ? el('div', { class: 'pin-btns' }, [
            p.length > 3 ? el('span', { class: 'pin-label', text: pinned ? 'Pinned to' : 'Pin to' }) : null,
            ...p.map((_, i) => el('button', {
              class: `btn btn-sm ${pinnedTo === i ? 'btn-primary' : ''}`.trim(),
              text: p.length > 3
                ? String(i + 1)
                : pinnedTo === i ? `Pinned · ${i + 1}` : `Pin to ${i + 1}`,
              title: pinnedTo === i
                ? `Pinned to presence ${i + 1} — click to unpin`
                : `Pin presence ${i + 1} to ${label}`,
              onclick: (e) => { e.stopPropagation(); pin(pinnedTo === i ? null : p_.appId, i); },
            })),
          ])
        : pinned ? el('span', { class: 'badge accent', text: 'Pinned' }) : null,
    ]);
  }));
}

async function pin(appId, slot) {
  const res = await api.preferPlayer(appId, slot);
  set({
    preferredPlayer: res?.preferred ?? null,
    preferredPlayers: Array.isArray(res?.preferredPlayers) ? res.preferredPlayers : [res?.preferred ?? null],
  });
  const which = multi() ? ` (presence ${slot + 1})` : '';
  toast(appId ? `Pinned to this player${which}` : `Player selection back to automatic${which}`, 'ok');
}
