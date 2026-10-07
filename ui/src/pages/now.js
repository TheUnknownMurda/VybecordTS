/**
 * Now playing — the track, what Discord shows for it, and the live lyrics.
 *
 * Two cards, top to bottom: the song together with its Discord card, then the
 * words. The player picker that used to be a page of its own is the Source
 * menu in the header — pinning is a decision about the presence on screen, so
 * it lives next to it.
 */

import { el, $, fmtTime, setArt, platformInfo, toast, modal, BLANK_ART } from '../util.js';
import { state, subscribe, setFocus, set } from '../state.js';
import { goto } from '../router.js';
import { discordPreview } from '../discord-card.js';

const api = window.vybecord;

/** How many presence cards are in play. */
const presenceCount = () => Math.max(1, Number(state.status?.presenceCount) || 1);
const multi = () => presenceCount() > 1;

/*
 * The glyphs behind the status chips.
 *
 * Drawn in the same language as the sidebar icons: a 24-unit box, stroked in
 * currentColor, round joins. They are literal markup and never touch anything
 * a track can name, which is what makes `html` safe to use here.
 */
const ICONS = {
  local: '<svg viewBox="0 0 24 24"><rect x="3" y="13" width="18" height="7" rx="2"/>'
    + '<path d="M6 13l1.8-6.2A2 2 0 019.7 5.4h4.6a2 2 0 011.9 1.4L18 13"/><circle cx="17" cy="16.5" r="1"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M3 6h3.5c1.3 0 2.5.6 3.2 1.7l4.6 6.6c.7 1.1 1.9 1.7 3.2 1.7H21"/>'
    + '<path d="M3 18h3.5c1.3 0 2.5-.6 3.2-1.7l.8-1.2"/><path d="M14.5 9.2l.8-1.2c.7-1.1 1.9-1.7 3.2-1.7H21"/>'
    + '<path d="M18 3.6L21 6l-3 2.4"/><path d="M18 13.6L21 16l-3 2.4"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M7 7h10a3 3 0 013 3v1"/><path d="M17 17H7a3 3 0 01-3-3v-1"/>'
    + '<path d="M15 4l3 3-3 3"/><path d="M9 20l-3-3 3-3"/></svg>',
  repeatOne: '<svg viewBox="0 0 24 24"><path d="M7 7h10a3 3 0 013 3v1"/><path d="M17 17H7a3 3 0 01-3-3v-1"/>'
    + '<path d="M15 4l3 3-3 3"/><path d="M9 20l-3-3 3-3"/><path d="M11.3 10.6l1.4-1V15"/></svg>',
  away: '<svg viewBox="0 0 24 24"><path d="M20.5 13.4A8.6 8.6 0 0110.6 3.5a8.6 8.6 0 109.9 9.9z"/></svg>',
  // In place of the pulse while paused: the dot going grey alone was too
  // small a change to read from across the room.
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>',
  // Behind the cover, so a track with no art, or no track, is not a blank tile.
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/>'
    + '<circle cx="18" cy="16" r="3"/></svg>',
};

/** A few literal glyphs for the buttons; same rule as ICONS. */
const BTN = {
  lines: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  check: '<svg class="src-check" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

/** A button whose face is a glyph plus words. */
function iconBtn(cls, glyph, label, props = {}) {
  const b = el('button', { type: 'button', class: cls, ...props });
  b.innerHTML = glyph;
  if (label) b.append(document.createTextNode(label));
  return b;
}

export function render(root) {
  const preview = discordPreview({ onCustomize: () => goto('settings', { cat: 'presence' }) });

  const cover = el('div', { class: 'np-cover' });
  cover.innerHTML = ICONS.note;
  cover.append(el('img', { class: 'np-art', id: 'npArt', alt: '', src: BLANK_ART }));

  root.replaceChildren(
    el('div', { class: 'np-head' }, [
      el('div', { id: 'npHeadLeft' }),
      sourcePicker(),
    ]),

    /*
     * The song and its Discord card are one card, split by a hairline: what
     * is playing, then how it shows on a profile. The preview alone could not
     * name the song — while lyrics run its big line is the lyric, and the title
     * sits small in the header — and as two cards, the second one read as a
     * repeat of the first. Stacked, never side by side: beside the track the
     * preview's text got about 190px and wrapped six or seven times.
     */
    el('section', { class: 'card np-card', id: 'npCard', 'aria-label': 'Now playing' }, [
      el('div', { class: 'np-track' }, [
        cover,
        el('div', { class: 'np-meta' }, [
          // Polite, as the status line it replaced was: play, pause and going
          // away are announced. Not the title, which changes with every track.
          el('div', { class: 'np-state', id: 'npState', 'aria-live': 'polite' }),
          el('div', { class: 'np-title', id: 'npTitle' }),
          el('div', { class: 'np-sub' }, [
            el('div', { class: 'np-artist', id: 'npArtist' }),
            el('div', { class: 'np-album', id: 'npAlbum' }),
          ]),
          el('div', { class: 'np-progress', id: 'npProgress', hidden: true }, [
            el('span', { class: 'np-time', id: 'npElapsed', text: '0:00' }),
            el('div', { class: 'np-bar' }, [el('div', { class: 'np-fill', id: 'npFill' })]),
            el('span', { class: 'np-time', id: 'npTotal', text: '0:00' }),
          ]),
        ]),
      ]),
      preview.node,
    ]),

    // The card that takes the leftover height — see .lyr-card in the stylesheet.
    el('section', { class: 'card lyr-card', id: 'lyrCard', 'aria-label': 'Lyrics' }, [
      el('div', { class: 'lyr-bar' }, [
        el('div', { class: 'lyr-bar-title' }, [
          el('h2', { text: 'Lyrics' }),
          el('span', { class: 'badge', id: 'lyrKind', hidden: true }),
        ]),
        el('div', { class: 'lyr-actions', id: 'lyrActions' }, [
          iconBtn('btn btn-ghost btn-sm', BTN.expand, 'Big lyrics', { title: 'Fill the window with the lyrics, one big line at a time', onclick: openBigLyrics }),
          iconBtn('btn btn-ghost btn-sm', BTN.lines, 'Full lyrics', { title: 'Show every line of this song', onclick: openFullLyrics }),
          iconBtn('btn btn-ghost btn-sm', BTN.copy, 'Copy .lrc', { id: 'lyrCopy', title: 'Copy the synced lyrics to the clipboard', onclick: copyLrc }),
        ]),
      ]),
      // The block itself is the affordance: a few lines is a keyhole view of
      // the song, and clicking anywhere on them opens the rest of it.
      el('div', {
        class: 'lyr lyr-clickable',
        id: 'lyrStage',
        role: 'button',
        tabindex: '0',
        title: 'Show every line of this song',
        onclick: openFullLyrics,
        onkeydown: (e) => {
          // A held key repeats; only the first press means anything here.
          if (e.repeat) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFullLyrics(); }
        },
      }, [
        el('div', { class: 'lyr-far', id: 'lyrPrev2' }),
        el('div', { class: 'lyr-near', id: 'lyrPrev' }),
        el('div', { class: 'lyr-cur', id: 'lyrCur', text: '—' }),
        el('div', { class: 'lyr-tr', id: 'lyrTr' }),
        el('div', { class: 'lyr-near', id: 'lyrNext' }),
        el('div', { class: 'lyr-far', id: 'lyrNext2' }),
        el('div', { class: 'lyr-plain', id: 'lyrPlain' }),
      ]),
      el('div', { class: 'lyr-empty', id: 'lyrEmpty', hidden: true }, [
        el('div', { class: 'lyr-empty-title', id: 'lyrEmptyTitle' }),
        el('div', { class: 'lyr-empty-desc', id: 'lyrEmptyDesc' }),
      ]),
      el('div', { class: 'lyr-ask', id: 'lyrAsk', hidden: true, role: 'group', 'aria-label': 'What is wrong with these lyrics?' }, [
        el('div', { class: 'lyr-ask-title', text: 'What’s wrong with these lyrics?' }),
        choice_('The timing is off',
          'The words are right, they just land early or late. They go to the lyrics editor, where you re-time the lines that drift.',
          () => reportLyrics('timing')),
        choice_('The words are wrong',
          'A different song, nonsense, or this track has none. This version is dropped and never fetched for it again.',
          () => reportLyrics('wrong')),
        el('button', { type: 'button', class: 'btn btn-ghost', text: 'Cancel', style: 'align-self:center', onclick: () => toggleAsk(false) }),
      ]),
      el('div', { class: 'lyr-foot', id: 'lyrFoot' }, [
        el('div', { class: 'lyr-offset', id: 'lyrOffset' }, [
          el('span', { class: 'lyr-offset-label', text: 'Timing' }),
          iconBtn('btn btn-sm btn-icon', BTN.minus, '', { 'aria-label': 'Show lines 250 ms earlier', title: 'Earlier', onclick: () => nudgeOffset(-250) }),
          el('output', { id: 'npOffset', text: '0 ms' }),
          iconBtn('btn btn-sm btn-icon', BTN.plus, '', { 'aria-label': 'Show lines 250 ms later', title: 'Later', onclick: () => nudgeOffset(250) }),
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'npOffsetReset', text: 'Reset', onclick: () => setOffset(0) }),
          el('span', { class: 'lyr-offset-hint', id: 'npOffsetHint' }),
        ]),
        iconBtn('btn btn-ghost btn-sm', BTN.flag, 'Wrong lyrics?', { id: 'npReport', 'aria-expanded': 'false', onclick: () => toggleAsk() }),
      ]),
    ]),
  );

  // Initial paint from whatever state we already hold.
  paintHead();
  paintTrack(state.track);
  paintLyrics(state.lyrics);
  void refreshOffset();
  paintTrSlot();

  /*
   * Local clock for the progress bar.
   *
   * The backend reports progress once per poll (1s); this fills the gap so the
   * bar and the elapsed time move smoothly. It reads the elapsed time from a
   * timestamp rather than adding a fixed step per tick — setInterval fires late
   * under load, and a fixed step would quietly lose that time on every tick and
   * drift away from the player over the length of a track.
   */
  let base = state.progress.progress_ms || 0;
  let baseAt = performance.now();
  let running = !!state.track?.is_playing;

  /** Where the song is now: the last report, moved on by the time since while it plays. */
  const position = () => {
    const duration = state.progress.duration_ms;
    const elapsed = running ? base + (performance.now() - baseAt) : base;
    return { progress_ms: duration > 0 ? Math.min(elapsed, duration) : elapsed, duration_ms: duration };
  };

  const onProgress = (p) => {
    base = p?.progress_ms || 0;
    baseAt = performance.now();
    paintProgress(p);
  };

  /*
   * Play and pause restart the clock from where it stands. Progress is only
   * reported while something plays, so without this a resumed song had its
   * whole pause added on, and the bar leapt ahead until the next report.
   */
  const onPlayState = (t) => {
    const playing = !!t?.is_playing;
    if (playing !== running) {
      base = position().progress_ms;
      baseAt = performance.now();
      running = playing;
    }
    paintProgress(position());
  };
  onPlayState(state.track);

  const unsubs = [
    subscribe('track', (t) => { paintTrack(t); onPlayState(t); paintLyrics(state.lyrics); }),
    subscribe('progress', onProgress),
    subscribe('lyrics', paintLyrics),
    subscribe('config', () => { void refreshOffset(); paintTrSlot(); paintLyrics(state.lyrics); }),
    // A new track may carry its own correction, or none.
    subscribe('track', () => { void refreshOffset(); }),
    // An ad produces no track, so both cards have to be redrawn to explain it
    // rather than sit there reading "Waiting for a player". Being away hides
    // the presence without the song changing at all, so the chip that says so
    // cannot wait for the next trackUpdate to appear.
    subscribe('status', () => { paintHead(); paintTrack(state.track); paintLyrics(state.lyrics); }),
    // The other cards come and go with what is playing; the tabs read them.
    subscribe('slots', paintHead),
    subscribe('players', () => { paintHead(); if (menuOpen) paintSourceMenu(); }),
    subscribe('preferredPlayers', () => { paintHead(); if (!state.track) paintTrack(null); }),
    // A different presence picked: everything below the header is its now.
    subscribe('focus', () => { toggleAsk(false); paintHead(); paintTrack(state.track); paintLyrics(state.lyrics); void refreshOffset(); }),
  ];

  const ticker = setInterval(() => { if (running) paintProgress(position()); }, 250);

  // The row's room changes with the window and with the cover beside it.
  const chipsRoom = new ResizeObserver(fitChips);
  chipsRoom.observe($('#npState'));
  // Only the width: what fitHead() changes is the height, and watching that
  // too would run it again for its own work.
  let headWidth = 0;
  const headRoom = new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (w !== headWidth) { headWidth = w; fitHead(); }
  });
  headRoom.observe($('.np-head'));

  return () => {
    clearInterval(ticker);
    chipsRoom.disconnect();
    headRoom.disconnect();
    unsubs.forEach((fn) => fn());
    preview.dispose();
    closeSourceMenu();
    // It hangs off <body>, so leaving the page would otherwise leave it up.
    closeBig?.();
  };
}

/** The pin each presence in play holds, presence 1 falling back to the legacy field. */
function pins() {
  const arr = Array.isArray(state.preferredPlayers) ? state.preferredPlayers : [];
  return Array.from({ length: presenceCount() }, (_, i) => (i === 0 ? arr[0] ?? state.preferredPlayer ?? null : arr[i] ?? null));
}

/** What the source line says while nothing is playing. */
function waitingText() {
  const pinnedId = pins()[state.focus] ?? null;
  if (!pinnedId) return 'Waiting for a player…';
  const pinned = (state.players || []).find((p) => p.appId === pinnedId);
  return pinned
    ? `Pinned to ${platformInfo(pinned.source)[0]} — waiting for it to play`
    : 'Pinned to a player that is not running';
}

/* ── Header: presence tabs and the source picker ─────────────────────────── */

/*
 * Rebuilt from a key rather than on every call: 'slots' fires on each progress
 * tick, and replacing the tabs once a second would swallow the click that
 * happened to land on one.
 */
let headKey = '';

function paintHead() {
  const left = $('#npHeadLeft');
  if (!left) return;
  paintSourceButton();

  const count = presenceCount();
  const tabs = count > 1 ? state.slots.slice(0, count).map((s, i) => {
    const t = s.track;
    return { i, sub: t ? platformInfo(t.media_source)[0] : s.lastTrack ? 'Paused' : 'Idle', playing: !!t?.is_playing };
  }) : [];
  const key = `${state.focus}|${tabs.map((t) => `${t.sub}:${t.playing}`).join(',')}`;
  if (key === headKey && left.childElementCount) return;
  headKey = key;

  if (!tabs.length) {
    left.replaceChildren(el('h1', { text: 'Now playing' }));
    fitHead();
    return;
  }
  left.replaceChildren(el('div', { class: 'seg', role: 'tablist', 'aria-label': 'Presences on your profile' },
    tabs.map((t) => el('button', {
      type: 'button',
      class: `seg-btn${t.i === state.focus ? ' active' : ''}`,
      role: 'tab',
      'aria-selected': t.i === state.focus ? 'true' : 'false',
      // Its words can be cut down to the number — see fitHead() — so the
      // name it is read out by is set whole.
      'aria-label': `Presence ${t.i + 1}, ${t.sub}`,
      title: `Show presence ${t.i + 1} (${t.sub})`,
      onclick: () => setFocus(t.i),
    }, [
      el('span', { class: `dot${t.playing ? ' on' : ''}` }),
      el('span', {}, [el('span', { class: 'seg-word', text: 'Presence ' }), String(t.i + 1)]),
      el('span', { class: 'seg-sub', text: t.sub }),
    ]))));
  fitHead();
}

/*
 * Tabs and the source picker on one row, at any number of presences. Three
 * or more tabs beside "Presence 1 source" did not fit the smallest window:
 * the picker wrapped under them, and the 50px row that added made the page
 * scroll by 43px with four. Short of room, the row sheds words in order —
 * the picker's "Presence 1" (the selected tab already says it), then the
 * tabs' "Presence", then the player under each number — and keeps them all
 * whenever they fit. Measured, like fitChips(): the room depends on the
 * window, the number of tabs and the players' names.
 */
const TIGHT = ['tight-src', 'tight-word', 'tight-sub'];

function fitHead() {
  const head = $('.np-head');
  const left = $('#npHeadLeft');
  const picker = $('.src-wrap');
  if (!head || !left || !picker) return;
  const wrapped = () => picker.getBoundingClientRect().top >= left.getBoundingClientRect().bottom - 1;
  head.classList.remove(...TIGHT);
  for (const step of TIGHT) {
    if (!wrapped()) break;
    head.classList.add(step);
  }
}

let menuOpen = false;
let onDocClick = null;
let onDocKey = null;

function sourcePicker() {
  const btn = el('button', {
    type: 'button', class: 'btn src-btn', id: 'srcBtn', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onclick: (e) => { e.stopPropagation(); menuOpen ? closeSourceMenu() : openSourceMenu(); },
  });
  return el('div', { class: 'src-wrap' }, [btn, el('div', { class: 'src-menu', id: 'srcMenu', role: 'menu', hidden: true })]);
}

function paintSourceButton() {
  const btn = $('#srcBtn');
  if (!btn) return;
  const pinnedId = pins()[state.focus] ?? null;
  const pinned = pinnedId ? (state.players || []).find((p) => p.appId === pinnedId) : null;
  const label = !pinnedId ? 'Automatic' : pinned ? platformInfo(pinned.source)[0] : 'Pinned player';
  const key = `${multi() ? state.focus : '-'}|${label}`;
  if (btn.dataset.key === key) return;
  btn.dataset.key = key;
  btn.replaceChildren(
    el('span', { class: 'src-label' }, multi()
      ? [el('span', { class: 'src-long', text: `Presence ${state.focus + 1} source` }), el('span', { class: 'src-short', text: 'Source' })]
      : ['Source']),
    label,
  );
  btn.insertAdjacentHTML('beforeend', BTN.chevron);
  btn.title = 'Choose which player this presence follows';
  if (menuOpen) paintSourceMenu();
  fitHead();
}

function openSourceMenu() {
  const menu = $('#srcMenu');
  if (!menu) return;
  menuOpen = true;
  menu.hidden = false;
  $('#srcBtn')?.setAttribute('aria-expanded', 'true');
  paintSourceMenu(true);
  menu.querySelector('.src-opt')?.focus();
  onDocClick = (e) => { if (!e.target.closest?.('.src-wrap')) closeSourceMenu(); };
  onDocKey = (e) => { if (e.key === 'Escape') { closeSourceMenu(); $('#srcBtn')?.focus(); } };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);
}

function closeSourceMenu() {
  menuOpen = false;
  const menu = $('#srcMenu');
  if (menu) menu.hidden = true;
  $('#srcBtn')?.setAttribute('aria-expanded', 'false');
  if (onDocClick) document.removeEventListener('click', onDocClick);
  if (onDocKey) document.removeEventListener('keydown', onDocKey);
  onDocClick = null;
  onDocKey = null;
}

/*
 * Rebuilt only when what it lists changes. The player list is polled every
 * two seconds, and replacing the rows each time would take the keyboard focus
 * off whichever one it was on.
 */
let menuKey = '';

function paintSourceMenu(force = false) {
  const menu = $('#srcMenu');
  if (!menu) return;
  const p = pins();
  const mine = p[state.focus] ?? null;
  // Playing first, then alphabetically — a stable order stops rows from
  // reshuffling under the cursor on every 2s refresh.
  const players = [...(state.players || [])].sort((a, b) => (
    (b.playing ? 1 : 0) - (a.playing ? 1 : 0) || a.source.localeCompare(b.source)
  ));
  const key = [state.focus, p.join(','), ...players.map((pl) => [pl.appId, pl.playing, pl.title, pl.artist, pl.isAd].join(':'))].join('|');
  if (!force && key === menuKey) return;
  menuKey = key;

  const opt = (active, title, sub, onclick, extra = []) => {
    const b = el('button', { type: 'button', class: `src-opt${active ? ' active' : ''}`, role: 'menuitemradio', 'aria-checked': active ? 'true' : 'false', onclick }, [
      el('div', { class: 'item-body' }, [
        el('div', { class: 'item-title', text: title }),
        sub ? el('div', { class: 'item-sub', text: sub }) : null,
      ]),
      ...extra,
    ]);
    b.insertAdjacentHTML('afterbegin', BTN.check);
    return b;
  };

  menu.replaceChildren(
    opt(!mine, 'Automatic', multi()
      ? `Presence ${state.focus + 1} takes the next thing playing`
      : 'Follows whatever ranks highest — a music app beats a browser tab', () => pin(null)),
    ...(players.length ? players.map((pl) => {
      const [label] = platformInfo(pl.source);
      const elsewhere = p.indexOf(pl.appId);
      const sub = [pl.artist, label, elsewhere >= 0 && elsewhere !== state.focus ? `on presence ${elsewhere + 1}` : '', pl.isAd ? 'ad' : '']
        .filter(Boolean).join(' · ');
      return opt(mine === pl.appId, pl.title || label, sub,
        () => pin(mine === pl.appId ? null : pl.appId),
        [pl.playing ? el('span', { class: 'pulse', title: 'Playing' }) : null]);
    }) : [el('div', { class: 'empty', style: 'padding:16px', text: 'No media session detected. Start playing something and it appears here.' })]),
    el('div', { class: 'src-note', text: 'A pinned presence shows that player and nothing else — not another player, and not the browser extension.' }),
  );
}

async function pin(appId) {
  const slot = state.focus;
  closeSourceMenu();
  const res = await api.preferPlayer(appId, slot);
  set({
    preferredPlayer: res?.preferred ?? null,
    preferredPlayers: Array.isArray(res?.preferredPlayers) ? res.preferredPlayers : [res?.preferred ?? null],
  });
  const which = multi() ? ` (presence ${slot + 1})` : '';
  toast(appId ? `Pinned to this player${which}` : `Back to automatic${which}`, 'ok');
}

/* ── Track ───────────────────────────────────────────────────────────────── */

/**
 * The song the card shows paused when the presence has none: the one that
 * was playing when it stopped. Not during an ad, which has its own words.
 */
function pausedTrack() {
  return !state.track && state.status?.adPlaying !== true ? state.lastTrack : null;
}

/** True while the presence is being withheld because the user is idle. */
function hiddenForAway() {
  return state.status?.userAway === true && state.status?.hideWhenAway !== false;
}

/** A status chip: a glyph and a word, the word in a node of its own — see fitChips(). */
function statusChip(icon, label, accent = false, tip = label) {
  const chip = el('span', { class: `badge${accent ? ' accent' : ''}`, title: tip });
  chip.innerHTML = ICONS[icon];
  chip.append(el('span', { class: 'np-chip-label', text: label }));
  return chip;
}

/**
 * Chips with their words while the row has room for them, glyphs alone when
 * it does not — the last chip first, so "Away" is the one that keeps its word
 * longest. The tooltip still names each one. Measured rather than set at a
 * width: the room left depends on the player's name and on how many chips
 * there are, as well as on the window.
 */
function fitChips() {
  const row = $('#npState');
  if (!row) return;
  const labels = [...row.querySelectorAll('.np-chip-label')];
  for (const l of labels) l.hidden = false;
  for (let i = labels.length - 1; i >= 0 && row.scrollWidth > row.clientWidth; i--) labels[i].hidden = true;
}

/** The heading and the hint the card shows while this presence has no track. */
function idleText() {
  // The ad gets a heading and nothing else: the preview under it already says
  // the status comes back with the music, and a second "comes back" here and a
  // third in the Lyrics card read as the app repeating itself.
  if (state.status?.adPlaying === true) {
    return ['A Spotify ad is playing', ''];
  }
  // A pin is exclusive, so nothing playing may simply mean the pinned player
  // is paused or closed. Saying which one, and how to undo it, avoids the app
  // looking broken when it is doing exactly what it was told.
  return [waitingText(), pins()[state.focus]
    ? 'This presence follows that player only. Set Source to Automatic to follow anything.'
    : 'Play something in Spotify, a browser tab or any media app.'];
}

/**
 * The top of the card: the cover, the song, and the states the Discord card
 * does not show — which player, paused, shuffle, a local file.
 */
function paintTrack(playing) {
  const card = $('#npCard');
  if (!card) return;
  const art = $('#npArt');
  const title = $('#npTitle');
  const artist = $('#npArtist');
  const album = $('#npAlbum');
  // Paused, the backend sends no track at all; the card keeps the song, as
  // any player does, while the preview under it shows what Discord shows.
  const track = playing || pausedTrack();
  card.classList.toggle('is-idle', !track);
  card.classList.toggle('is-paused', !!track && !track.is_playing);
  // A stream's "artist" is its title, so it keeps a second line — see .np-artist.
  card.classList.toggle('is-live', !!track?.is_live);

  if (!track) {
    const [head, hint] = idleText();
    const away = state.status?.adPlaying !== true && hiddenForAway();
    $('#npState').replaceChildren(...(away ? [statusChip('away', 'Away', true, AWAY_TIP)] : []));
    fitChips();
    title.textContent = head;
    artist.textContent = hint;
    album.textContent = '';
    for (const n of [title, artist, album]) n.removeAttribute('title');
    art.src = BLANK_ART;
    delete art.dataset.track;
    setAmbient(null);
    return;
  }

  const [label] = platformInfo(track.media_source);
  /*
   * What leads the line says what the player is doing: the pulse while it
   * plays, a pause glyph when it stops, and for a stream the red LIVE tag
   * everyone reads at a glance — paused too, since the stream goes on without
   * the viewer. A stream is watched, not played — and "Live on" after a LIVE
   * tag said it twice. The tag goes first so a paused stream's glyph sits
   * next to its verb.
   */
  const lead = [];
  if (track.is_live) lead.push(el('span', { class: 'live-tag', text: 'Live' }));
  if (!track.is_playing) {
    const glyph = el('span', { class: 'np-glyph' });
    glyph.innerHTML = ICONS.pause;
    lead.push(glyph);
  }
  if (!lead.length) lead.push(el('span', { class: 'pulse' }));
  const verb = !track.is_playing ? 'Paused on' : track.is_live ? 'Watching on' : 'Playing on';
  $('#npState').replaceChildren(
    el('span', { class: 'eyebrow np-source' }, [...lead, `${verb} ${label}`]),
    ...badges(track).map((b) => statusChip(...b)),
  );
  fitChips();

  // Clamped in the stylesheet — a stream's "artist" is its title, and
  // streamers write paragraphs there — so the whole of each is the tooltip.
  title.textContent = track.track_name || 'Unknown track';
  artist.textContent = track.artist_name || '';
  album.textContent = track.album_name || '';
  title.title = track.track_name || '';
  artist.title = track.artist_name || '';
  album.title = track.album_name || '';

  // Resolving local art needs a round trip, and the card may have moved on
  // meanwhile: switching tabs repaints with the old track first, and its
  // answer arrives after the new one's. The cover and the tint wait for it.
  const current = () => (state.track || pausedTrack()) === track;
  // A different track blanks the cover while its own resolves; the previous
  // one beside the new title read as the wrong song. The tint is left alone so
  // the background does not flash on every skip.
  if (art.dataset.track !== (track.track_id || '')) {
    art.dataset.track = track.track_id || '';
    art.src = BLANK_ART;
  }
  coverFor(track).then(
    (url) => { if (current()) { art.src = url || BLANK_ART; setAmbient(url); } },
    () => { if (current()) { art.src = BLANK_ART; setAmbient(null); } },
  );
}

/**
 * The cover's URL, resolved into an image nobody sees. setArt() writes the
 * image it is handed the moment it has an answer, and aimed at the one on
 * screen, a slow local cover painted the previous track over the next one, or
 * over the idle card. The caller decides whether the answer still applies.
 */
function coverFor(track) {
  return setArt(new Image(), track?.album_art_url, track?.track_id);
}

/** The bar under the song: how far in, and how long it is. */
function paintProgress(p) {
  const box = $('#npProgress');
  if (!box) return;
  const paused = pausedTrack();
  const t = state.track || paused;
  if (paused) p = { progress_ms: paused.progress_ms, duration_ms: paused.duration_ms };
  // No length, no bar. A stream has none, and the preview under it already
  // counts how long it has been live. Nor do many browser tabs and media apps
  // over SMTC: there the bar sat empty beside a "—" while the elapsed time
  // counted up, which looked like a stalled player. The next progress report
  // that carries a length brings the row back.
  box.hidden = !t || !!t.is_live || !(p?.duration_ms > 0);
  if (box.hidden) return;
  const total = p.duration_ms;
  const elapsed = Math.min(p.progress_ms || 0, total);
  $('#npFill').style.width = `${(elapsed / total) * 100}%`;
  $('#npElapsed').textContent = fmtTime(elapsed);
  $('#npTotal').textContent = fmtTime(total);
}

/*
 * One word on the chip: the preview right under it already explains that the
 * status is hidden, and the long label cost the other chips their words at the
 * default window.
 */
const AWAY_TIP = 'Away — your Discord status is hidden until you come back';

/** The chips after the player: what the track is doing that its title does not say. */
function badges(track) {
  const out = [];
  if (hiddenForAway()) out.push(['away', 'Away', true, AWAY_TIP]);
  if (track.is_local) out.push(['local', 'Local file', false]);
  if (track.is_shuffle) out.push(['shuffle', 'Shuffle', false]);
  if (track.repeat_mode === 'track') out.push(['repeatOne', 'Repeat one', false]);
  else if (track.repeat_mode && track.repeat_mode !== 'off') out.push(['repeat', 'Repeat', false]);
  return out;
}

/* ── Lyrics ──────────────────────────────────────────────────────────────── */

/** The text of line `i` of a synced array, '' outside it. */
const lineAt = (arr, i) => (i >= 0 && i < arr.length ? arr[i]?.text || '' : '');

function paintLyrics(l) {
  const stage = $('#lyrStage');
  if (!stage) return;
  const t = state.track;
  const kind = $('#lyrKind');

  const synced = Array.isArray(l?.lyrics) && l.lyrics.length > 0;
  const plain = !synced && Array.isArray(l?.lines) && l.lines.length > 0;
  kind.hidden = !(synced || plain);
  kind.textContent = synced ? 'Synced' : plain ? 'Words only' : '';
  kind.title = plain ? 'Found without timings, so they cannot follow the song' : '';

  // What to say instead of lines, when there are none to show.
  let empty = null;
  // Not "Nothing playing": the card above already says so, and so does the
  // Discord preview inside it — three times in one window read as an error.
  if (!t && state.status?.adPlaying === true) empty = ['Back after the ad', ''];
  else if (!t && pausedTrack()) empty = ['Paused', 'The lyrics come back with the song.'];
  else if (!t) empty = ['No lyrics yet', 'They show here, in time with the song, as soon as something plays.'];
  else if (t.is_live) empty = ['Live streams have no lyrics', 'This presence shows the stream title and how long it has been live instead.'];
  else if (state.config[state.focus === 0 ? 'show_lyrics' : `show_lyrics_${state.focus + 1}`] === false) {
    empty = ['Lyrics are switched off for this presence', 'Turn them back on in Settings → Discord presence.'];
  }

  stage.hidden = !!empty;
  $('#lyrCard').classList.toggle('is-empty', !!empty);
  $('#lyrEmpty').hidden = !empty;
  $('#lyrFoot').hidden = !!empty;
  $('#lyrActions').hidden = !!empty;
  if (empty) {
    toggleAsk(false);
    $('#lyrEmptyTitle').textContent = empty[0];
    $('#lyrEmptyDesc').textContent = empty[1];
    return;
  }

  // Words with no times have no line to follow and nothing to re-time.
  stage.classList.toggle('is-plain', plain);
  $('#lyrOffset').hidden = plain;
  $('#lyrCopy').hidden = plain;
  if (plain) {
    paintPlain(l.lines);
    return;
  }

  // The whole song rides along with every tick, so the lines either side of
  // the three the engine names come straight off it.
  const idx = Number.isInteger(l?.currentIndex) ? l.currentIndex : -1;
  const arr = synced ? l.lyrics : [];
  $('#lyrPrev2').textContent = idx >= 0 ? lineAt(arr, idx - 2) : '';
  $('#lyrPrev').textContent = l?.prev || '';
  $('#lyrCur').textContent = l?.current || (t ? '♪' : '—');
  $('#lyrNext').textContent = l?.next || '';
  $('#lyrNext2').textContent = idx >= 0 ? lineAt(arr, idx + 2) : '';
  $('#lyrTr').textContent = l?.translation || '';
}

/**
 * Words found without timings: the song from the top as a block of text you
 * can scroll, as a lyrics site shows it, instead of the moving lines, which
 * would have no current line to centre on. Clicking still opens all of it.
 * Rebuilt only when the words change: the engine keeps ticking regardless,
 * and a rebuild would throw the reader back to the first line.
 */
function paintPlain(lines) {
  const box = $('#lyrPlain');
  const key = lines.join('\n');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(...lines.map((text) => el('div', { class: text.trim() ? 'lyr-plain-line' : 'lyr-plain-gap', text })));
  box.scrollTop = 0;
}

/**
 * Whether the translation line holds its place.
 *
 * With translations on it stays in the layout even while a line is untranslated,
 * so the lines do not jump every time one arrives. With them off it goes away
 * entirely — an empty slot there spaces the lines unevenly.
 */
function paintTrSlot() {
  $('#lyrStage')?.classList.toggle('with-tr', state.config.translate_lyrics === true);
}

function toggleAsk(open) {
  const ask = $('#lyrAsk');
  if (!ask) return;
  const show = open ?? ask.hidden;
  if (show && !state.track) return toast('Nothing is playing', 'err');
  // The panel stands in for the timing row while it is open, button and all,
  // so closing it from inside hands the focus back to that button.
  const hadFocus = ask.contains(document.activeElement);
  ask.hidden = !show;
  $('#npReport')?.setAttribute('aria-expanded', show ? 'true' : 'false');
  if (show) ask.querySelector('.choice')?.focus();
  else if (hadFocus) $('#npReport')?.focus();
}

/* ── Timing offset ───────────────────────────────────────────────────────── */

/**
 * The offset in force, and whether it belongs to this track or is the default.
 *
 * Not read from config: a correction made here is stored against the playing
 * track, because the drift belongs to the recording. The Settings control still
 * moves the default, which is what tracks nobody has corrected run under.
 */
let offsetState = { offsetMs: 0, perTrack: false };

function paintOffset() {
  const out = $('#npOffset');
  if (!out) return;
  const ms = offsetState.offsetMs;
  out.textContent = `${ms > 0 ? '+' : ''}${ms} ms`;
  // A corrected track is worth marking: otherwise the number looks like a
  // global setting that has mysteriously changed on its own.
  out.classList.toggle('per-track', offsetState.perTrack && ms !== 0);
  $('#npOffsetReset').hidden = ms === 0;
  $('#npOffsetHint').textContent = offsetState.perTrack && ms !== 0
    ? 'Saved for this track'
    : 'Default from Settings';
}

/** Ask what is in force. Called on load and whenever the track changes. */
async function refreshOffset() {
  try {
    const got = await api.lyricsOffsetCurrent(state.focus);
    if (got && typeof got.offsetMs === 'number') offsetState = got;
  } catch {
    /* the backend will answer on the next track; the last value stands */
  }
  paintOffset();
}

async function setOffset(ms) {
  const clamped = Math.max(-60000, Math.min(60000, ms));
  const applied = await api.setLyricsOffset(clamped, state.focus);
  // Trust what came back rather than what was asked for: the backend clamps,
  // and it is the side that knows whether this landed on a track or on the
  // default.
  if (applied && typeof applied.offsetMs === 'number') {
    offsetState = { offsetMs: applied.offsetMs, perTrack: !!applied.perTrack };
  }
  paintOffset();
}

function nudgeOffset(delta) {
  return setOffset(offsetState.offsetMs + delta);
}

async function copyLrc() {
  const lrc = await api.getLrc(state.focus);
  if (!lrc) return toast('No synced lyrics loaded for this track', 'err');
  await navigator.clipboard.writeText(lrc);
  toast('Copied to clipboard', 'ok');
}

/* ── Full lyrics ───────────────────────────────────────────────────────────
 *
 * The card shows a few lines; the rest of the song lives in a panel one click
 * away. Nothing extra is fetched to fill it: every lyric tick already carries
 * the whole line array and the index the engine is on, so the panel follows
 * the song off the same events the card does.
 */

/**
 * The lines to show, read from whatever the backend last pushed.
 *
 * Returns null rather than an empty list when the state holds nothing usable,
 * so a repaint mid-song leaves what is on screen alone instead of blanking it.
 */
function readLines() {
  const l = state.lyrics;

  if (Array.isArray(l?.lyrics) && l.lyrics.length) {
    /*
     * A lyric payload carries the duration of the track it was built for, and a
     * mismatch means it predates what is playing now. A skip alone no longer
     * gets here — state.js drops the lyrics with the track — but a translation
     * landing late re-emits the previous song's state, and painting that would
     * put its words under the new title.
     */
    const dur = state.track?.duration_ms;
    if (dur > 0 && l.duration_ms > 0 && Math.abs(dur - l.duration_ms) > 1500) return null;
    return { lines: l.lyrics.map((x) => ({ time: x.time, text: x.text })), synced: true };
  }

  // The unsynced fallback the backend fetches for display only: words, no times.
  if (Array.isArray(l?.lines) && l.lines.length) {
    return { lines: l.lines.map((text) => ({ time: null, text })), synced: false };
  }

  return null;
}

/** `[mm:ss.xx] text` → `{ time, text }`. Lines without a stamp are skipped. */
function parseLrc(lrc) {
  const out = [];
  for (const raw of String(lrc).split('\n')) {
    const m = /^\s*\[(\d+):(\d+(?:\.\d+)?)\]\s?(.*)$/.exec(raw);
    if (!m) continue;
    out.push({ time: (Number(m[1]) * 60 + Number(m[2])) * 1000, text: m[3].trim() });
  }
  return out;
}

/** Set while the panel or the big view is up. */
let panelOpen = false;
/** Closes the big view; null while it is not up. */
let closeBig = null;

/**
 * Open the panel, once.
 *
 * The lyric block keeps the focus while the panel is up — modal() hands the
 * focus to its first button, which is the follow button, and that one is
 * disabled — so a second Enter would otherwise mount an identical panel over
 * the first, subscriptions and all.
 */
function openFullLyrics() {
  return openLyrics('panel');
}

/** The Spotify-style view: the window turns into the lyrics, a few big lines at a time. */
function openBigLyrics() {
  return openLyrics('big');
}

function openLyrics(mode) {
  if (panelOpen) return Promise.resolve();
  panelOpen = true;
  return showFullLyrics(mode).finally(() => { panelOpen = false; });
}

/**
 * Every line of the song, following along.
 *
 * Both views are this one function: the list, the highlight, following the
 * song and the wait after a skip are the hard part, and two copies of them
 * would drift apart. 'panel' is the dialog with timestamps; 'big' takes the
 * whole window below the title bar, tinted from the cover.
 */
async function showFullLyrics(mode = 'panel') {
  const big = mode === 'big';
  /*
   * The engine only emits on a line change, so a track paused before its first
   * line has lyrics cached but no state to read them from. Asking for the LRC
   * covers that: it comes off the same cache the engine was injected with, so
   * the indexes line up with the ones the ticks report.
   */
  let data = readLines();
  if (!data) {
    const lrc = await api.getLrc(state.focus).catch(() => null);
    const lines = lrc ? parseLrc(lrc) : [];
    if (lines.length) data = { lines, synced: true };
  }
  if (!data) {
    return toast(state.track ? 'No lyrics loaded for this track' : 'Nothing is playing', 'err');
  }

  const list = el('div', { class: big ? 'lyr-big-list' : 'lyr-full' });
  const trackLine = el('div', { class: 'lyr-full-track' });
  const meta = el('div', { class: 'lyr-full-meta' });
  const followBtn = el('button', {
    class: big ? 'btn lyr-big-follow' : 'btn btn-sm lyr-full-follow',
    onclick: () => setFollow(true),
  });
  const bigArt = big ? el('img', { class: 'lyr-big-art', alt: '', src: BLANK_ART }) : null;
  const bigTitle = big ? el('div', { class: 'lyr-big-title' }) : null;
  const bigArtist = big ? el('div', { class: 'lyr-big-artist' }) : null;

  // One node per line, kept and mutated: the highlight moves several times a
  // minute and rebuilding the list would throw away the scroll position each time.
  let rows = [];
  let cur = -1;
  let follow = true;
  let signature = '';                            // what the rendered list is of
  let trackId = state.track?.track_id || '';
  let waitTimer = 0;

  paintTrack_();
  paint(data);
  setFollow(true);

  const unsubs = [
    subscribe('lyrics', () => paint()),
    subscribe('track', onTrack),
  ];

  /*
   * Only the user's own scrolling stops the panel from following. The scroll
   * event cannot tell the two apart — following the song fires it too, so the
   * panel would switch itself off every time the line changed. A gesture can.
   */
  for (const ev of ['wheel', 'touchmove', 'pointerdown']) {
    list.addEventListener(ev, () => setFollow(false), { passive: true });
  }

  // Both build and mount synchronously, and only resolve once closed — so this
  // is the promise to wait on, not the view being up.
  const closed = big
    ? fullWindow((close) => [
      el('div', { class: 'lyr-big-head' }, [
        bigArt,
        el('div', { class: 'lyr-big-id' }, [bigTitle, bigArtist]),
        iconBtn('btn btn-ghost btn-icon lyr-big-close', BTN.close, '', {
          'aria-label': 'Close the big lyrics', title: 'Close (Esc)', onclick: () => close(),
        }),
      ]),
      list,
      el('div', { class: 'lyr-big-foot' }, [followBtn]),
    ])
    : modal((close) => el('div', {}, [
      el('div', { class: 'lyr-full-head' }, [el('h2', { text: 'Lyrics' }), meta]),
      trackLine,
      list,
      el('div', { class: 'lyr-full-foot' }, [
        followBtn,
        el('button', { class: 'btn', text: 'Close', onclick: () => close() }),
      ]),
    ]));

  // The list has no size until it is in the document, so it opens on the line
  // the song is on only if the first centring waits for that.
  if (rows[cur]) centre(rows[cur], 'auto');

  await closed;

  clearTimeout(waitTimer);
  unsubs.forEach((fn) => fn());

  function paintTrack_() {
    const t = state.track;
    trackLine.textContent = t
      ? [t.track_name || 'Unknown track', t.artist_name].filter(Boolean).join(' — ')
      : 'Nothing playing';
    if (!big) return;
    bigTitle.textContent = t ? t.track_name || 'Unknown track' : 'Nothing playing';
    bigArtist.textContent = t?.artist_name || '';
    // Resolved art is cached by track, so this is the image Now already shows.
    // By id, not by object: this view is not repainted when the same track
    // comes round again with more metadata.
    const id = trackId;
    coverFor(t).then(
      (url) => { if (trackId === id) bigArt.src = url || BLANK_ART; },
      () => { if (trackId === id) bigArt.src = BLANK_ART; },
    );
  }

  /** A skip empties the panel until the new song's lines arrive. */
  function onTrack(t) {
    const id = t?.track_id || '';
    if (id === trackId) return;
    trackId = id;
    signature = '';
    rows = [];
    cur = -1;
    meta.textContent = '';
    paintTrack_();
    list.replaceChildren(el('div', { class: 'lyr-full-empty', text: 'Looking up the lyrics for this track…' }));
    // A track with no lyrics at all produces no further event, so the wait has
    // to time itself out rather than sit on "looking up" for the whole song.
    clearTimeout(waitTimer);
    waitTimer = setTimeout(async () => {
      if (rows.length) return;
      /*
       * Ask the cache before giving up. The engine speaks only on a line
       * change, so a long instrumental intro outlasts this wait with the whole
       * song already loaded — and saying "no lyrics" there is simply wrong.
       */
      const lrc = await api.getLrc(state.focus).catch(() => null);
      const lines = lrc ? parseLrc(lrc) : [];
      // A tick may have landed, or the panel closed, while that was in flight.
      if (rows.length || !list.isConnected) return;
      if (lines.length) { paint({ lines, synced: true }); return; }
      list.replaceChildren(el('div', { class: 'lyr-full-empty', text: 'No lyrics found for this track.' }));
    }, 10000);
  }

  function paint(resolved) {
    const next = resolved || readLines();
    if (!next) return;

    const sig = `${trackId}|${next.synced}|${next.lines.length}`;
    const rebuilt = sig !== signature;

    if (rebuilt) {
      clearTimeout(waitTimer);
      signature = sig;
      cur = -1;
      rows = next.lines.map((line) => el('div', { class: `lyr-full-line${line.text ? '' : ' is-blank'}` }, [
        next.synced && !big ? el('span', { class: 'lyr-full-time', text: fmtTime(line.time) }) : null,
        el('span', { class: 'lyr-full-text', text: line.text || '♪' }),
      ]));
      list.replaceChildren(...rows);
      meta.textContent = next.synced
        ? `${next.lines.length} lines · follows the song`
        : `${next.lines.length} lines · no timings, so it cannot follow along`;
      followBtn.hidden = !next.synced;
      list.classList.toggle('is-plain', !next.synced);
      setFollow(true);
      translateAll(next.lines);
    }

    const idx = next.synced && Number.isInteger(state.lyrics?.currentIndex)
      ? state.lyrics.currentIndex
      : -1;
    highlight(idx, rebuilt ? 'auto' : 'smooth');
  }

  function highlight(idx, behavior) {
    if (idx === cur) return;
    rows[cur]?.classList.remove('is-current');
    cur = idx;
    const node = rows[idx];
    // The big view greys what is still to come with a sibling selector off the
    // current line; before the first line there is none, and it needs telling.
    list.classList.toggle('has-current', !!node);
    if (!node) return;
    node.classList.add('is-current');
    if (follow) centre(node, behavior);
  }

  function setFollow(on) {
    follow = on;
    followBtn.textContent = on ? 'Following the song' : 'Back to the current line';
    followBtn.disabled = on;
    // A disabled "Following the song" is noise over big type; it shows only
    // when there is somewhere to go back to.
    if (big) followBtn.classList.toggle('is-idle', on);
    followBtn.classList.toggle('btn-primary', !on && !big);
    if (on && rows[cur]) centre(rows[cur], 'smooth');
  }

  /**
   * Put a line in the middle of the list — or, in the big view, a third of the
   * way down, as Spotify does, so more of what is coming is on screen.
   *
   * The scroll is aimed at the list rather than the row — scrollIntoView() moves
   * every scrollable ancestor, which would drag the modal and the page behind it
   * around as well.
   */
  function centre(node, behavior) {
    const rect = node.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    const anchor = big ? 0.36 : 0.5;
    const top = Math.max(0, list.scrollTop + (rect.top - box.top) - (list.clientHeight - rect.height) * anchor);
    const from = list.scrollTop;
    list.scrollTo({ top, behavior });
    if (behavior !== 'smooth') return;

    // Smooth scrolling is a no-op in some embedded Chromium builds, and there
    // the panel would quietly stop following the song. A real animation has
    // moved by now, so no movement at all means the runtime ignored it — jump.
    setTimeout(() => {
      if (follow && list.scrollTop === from && Math.round(from) !== Math.round(top)) {
        list.scrollTop = top;
      }
    }, 120);
  }

  /**
   * Fill in the translations, when the user has them switched on.
   *
   * The backend warms the whole song's translations as soon as a track loads,
   * so this is usually a cache read that lands in one round trip.
   */
  async function translateAll(lines) {
    if (state.config.translate_lyrics !== true) return;
    const texts = lines.map((l) => l.text).filter((t) => t && t.trim().length >= 2);
    if (!texts.length) return;

    const sig = signature;
    const res = await api.translateBatch(texts, state.config.translate_target_lang || 'en')
      .catch(() => null);
    // The song may have moved on while this was in flight.
    if (!res?.translations || sig !== signature) return;

    lines.forEach((line, i) => {
      // Own properties only: a line reading "constructor" would otherwise pick
      // up what Object.prototype answers and print it as its translation.
      if (!Object.hasOwn(res.translations, line.text)) return;
      const tr = res.translations[line.text];
      if (!tr || tr === line.text) return;
      rows[i]?.querySelector('.lyr-full-text')?.append(el('span', { class: 'lyr-full-tr', text: tr }));
    });
  }
}

/* ── Wrong lyrics ──────────────────────────────────────────────────────────
 *
 * The two answers want opposite things. Wrong words: drop them and never fetch
 * them again, done. Wrong timing: the words are worth keeping, so they are
 * carried into the editor where the sync studio can re-tap the lines that
 * drift. Both flag the version currently loaded, which is what stops the app
 * from fetching it back.
 */
async function reportLyrics(choice) {
  const track = state.track;
  toggleAsk(false);
  if (!track) return toast('Nothing is playing', 'err');

  // Read the lines out first: flagging drops them from the cache, so asking
  // afterwards would hand the editor an empty box.
  const lrc = choice === 'timing' ? await api.getLrc(state.focus).catch(() => null) : null;

  const flagged = (await api.flagLyrics(state.focus))?.ok === true;

  if (choice === 'wrong') {
    toast(flagged
      ? 'Flagged — these lyrics will not be used for this track again'
      : 'Nothing to flag: no lyrics are loaded for this track', flagged ? 'ok' : 'err');
    return;
  }

  goto('library', {
    tab: 'import',
    prefill: {
      track: track.track_name || '',
      artist: track.artist_name || '',
      album: track.album_name || '',
      duration: track.duration_ms > 0 ? String(Math.round(track.duration_ms / 1000)) : '',
      lrc: lrc || '',
    },
  });
  toast(lrc
    ? 'Carried over — re-time the lines, then save to your library'
    : 'No synced lyrics to carry over — the track details are filled in', lrc ? 'ok' : 'err');
}

/** A big clickable answer. */
function choice_(title, desc, onclick) {
  return el('button', { type: 'button', class: 'choice', onclick }, [
    el('div', { class: 'choice-title', text: title }),
    el('div', { class: 'choice-desc', text: desc }),
  ]);
}

/*
 * The cover setAmbient() was last asked for. Only that one may paint: a cover
 * still loading when the presence went idle, or when the other tab was
 * picked, landed afterwards and washed the card in the colour of a song no
 * longer on it.
 */
let ambientUrl = null;

/**
 * Tint the background orbs, and the top of the card, from the cover.
 *
 * The image is drawn to a 1x1 canvas to get its average colour. It comes from
 * the local vybecord: scheme or an https CDN; either way it must not taint the
 * canvas, so a failed read is swallowed rather than allowed to throw.
 */
function setAmbient(url) {
  ambientUrl = url || null;
  const orbs = document.querySelectorAll('.orb');
  const card = $('#npCard');
  if (!url) {
    orbs.forEach((o) => o.style.removeProperty('--orb'));
    card?.style.removeProperty('--np-tint');
    setTint(null);
    return;
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (url !== ambientUrl) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      orbs.forEach((o) => o.style.setProperty('--orb', `rgb(${r},${g},${b})`));
      // The same colour washes the top of the card, so the cover and the
      // song beside it read as one thing.
      card?.style.setProperty('--np-tint', `rgb(${r},${g},${b})`);
      setTint(`rgb(${r},${g},${b})`);
    } catch {
      /* cross-origin cover — keep the default tint */
    }
  };
  img.src = url;
}

/** The cover's average colour, for the big lyrics' background; null for the default. */
let tint = null;

function setTint(colour) {
  tint = colour;
  const view = document.querySelector('.lyr-big');
  if (!view) return;
  if (tint) view.style.setProperty('--big-tint', tint);
  else view.style.removeProperty('--big-tint');
}

/**
 * Mount a view over the whole window below the title bar.
 *
 * Not modal(): that one is a box in the middle of a dimmed page, and the point
 * here is the opposite — nothing else on screen. It sits on <body> because the
 * page container animates with a transform, which would turn `position: fixed`
 * into "fixed to the page". The title bar stays reachable so the window can
 * still be moved, minimised and closed.
 */
function fullWindow(render) {
  return new Promise((resolve) => {
    const before = document.activeElement;
    const view = el('div', { class: 'lyr-big', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Lyrics' });
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
    };
    const close = () => {
      if (!view.isConnected) return;
      view.remove();
      document.removeEventListener('keydown', onKey);
      closeBig = null;
      if (before?.isConnected) before.focus();
      resolve(undefined);
    };

    view.append(...render(close));
    if (tint) view.style.setProperty('--big-tint', tint);
    document.body.append(view);
    document.addEventListener('keydown', onKey);
    closeBig = close;
    view.querySelector('.lyr-big-close')?.focus();
  });
}
