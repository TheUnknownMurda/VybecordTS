/**
 * The card, edited where it stands.
 *
 * Click a part of the Discord preview on Now playing — the verb, the lines,
 * the cover, the buttons — and a bubble opens beside it with the settings
 * that decide that part. Settings → Discord presence lists the same controls
 * by what they are; standing in front of the card the question is "what
 * decides this line?", and the answer is a click on the line.
 *
 * Nothing here is a setting of its own. Every control reads and writes a key
 * Settings already has, through saveConfig(), and the engine rebuilds the card
 * on the change (applyConfig in the lyrics engine), so the preview the bubble
 * points at shows the result a moment later. That is also why the bubble sits
 * beside the card rather than over it whenever there is room.
 *
 * Its tabs reach the other parts, because some have nothing to click: a local
 * file has no buttons, the badge can be switched off, and at the smallest
 * windows the buttons are not drawn at all.
 */

import { el } from './util.js';
import { state, subscribe, saveConfig } from './state.js';
import { goto } from './router.js';
import { lyricsKey } from './why.js';

const api = window.vybecord;

/*
 * The choices behind the card's settings, shared with Settings so the two
 * cannot offer different lists — the icon list once lacked a mode the engine
 * knew, and a second copy is how that happens again.
 */

/** Discord's verbs, as config stores them. Streaming needs a stream link, so it is not offered. */
export const ACTIVITY_TYPES = [[2, 'Listening to'], [0, 'Playing'], [3, 'Watching'], [5, 'Competing in']];
/** The activity type per card; card 1 keeps `rpc_activity_type`, the others may follow it (-1). */
export const ACTIVITY_KEYS = ['rpc_activity_type', 'rpc_activity_type_2', 'rpc_activity_type_3', 'rpc_activity_type_4', 'rpc_activity_type_5'];
export const STATUS_DISPLAY = [
  ['app', 'App name'], ['title', 'Track title'], ['title_artist', 'Title — Artist'],
  ['artist_title', 'Artist — Title'], ['artist', 'Artist'], ['album', 'Album'],
  ['details', 'Details field'], ['state', 'State field'], ['custom', 'Custom template'],
];

/**
 * Small-icon styles. They are stored as separate booleans rather than one enum,
 * but only one can sensibly be on, so the UI presents them as a single choice
 * and clears the rest on change.
 */
export const ICON_MODES = [
  ['', 'Platform default'], ['auto_icon_mode', 'Match the cover'],
  ['dance_mode', 'Dance'], ['radiate_mode', 'Radiate'],
  ['purple_rad_mode', 'Purple'], ['blue_rad_mode', 'Blue'], ['rouge_mode', 'Red'],
  ['bleeding_mode', 'Bleeding'], ['random_icon_mode', 'Random each track'],
  // The engine has always known this mode; the list simply never listed it, so
  // it was the one icon nobody could pick.
  ['lrc_off_mode', 'LRC off'],
  ['hide_small_icon', 'No small icon'],
];
export const ICON_KEYS = ICON_MODES.map(([k]) => k).filter(Boolean);

/** The parts, top to bottom, as the bubble's tabs name them. */
const ZONES = [
  ['verb', 'Activity'],
  ['lines', 'Lines'],
  ['info', 'Third line'],
  ['art', 'Cover'],
  ['buttons', 'Buttons'],
];

const cfg = (key, fallback) => state.config?.[key] ?? fallback;
const put = (key, value) => saveConfig({ [key]: value });
const cardCount = () => Math.max(1, Number(state.status?.presenceCount) || 1);

/** The translation languages, asked for once per window — as Settings and the seam do. */
let langs = null;

async function loadLangs() {
  if (langs) return langs;
  try {
    const got = await api.translateLangs();
    langs = got && Object.keys(got).length ? got : { en: 'English' };
  } catch {
    langs = { en: 'English' };
  }
  return langs;
}

/* ── Controls ──────────────────────────────────────────────────────────────
 *
 * Each is { node, sync }: built once when its part is shown, then re-read from
 * the config by sync() on every change, so a click elsewhere (the seam, the
 * tray) moves it too and nothing the user is typing is rebuilt under them.
 */

/**
 * Which cards a control reaches — said only when there are several. The verb
 * and the lyrics switch belong to one card; everything else to all of them,
 * and changing the badge on card 2 to find card 1's changed too was a
 * surprise worth heading off.
 */
function scopeTag(scope) {
  if (cardCount() < 2) return null;
  return el('span', { class: 'ce-scope', text: scope === 'card' ? `Card ${state.focus + 1}` : 'All cards' });
}

function field(label, scope, control, desc) {
  return el('div', { class: 'ce-field' }, [
    el('div', { class: 'ce-label' }, [label, scopeTag(scope)]),
    control,
    desc ? el('div', { class: 'ce-desc', text: desc }) : null,
  ]);
}

/** One of a few, as a row of pills. Values are compared as strings: config holds numbers and booleans. */
function choices(label, scope, options, get, set, desc) {
  const pills = options.map(([value, text]) => el('button', {
    type: 'button',
    class: 'ce-choice',
    text,
    'aria-pressed': 'false',
    onclick: () => { if (String(get()) !== String(value)) void set(value); },
  }));
  return {
    node: field(label, scope, el('div', { class: 'ce-choices', role: 'group', 'aria-label': label }, pills), desc),
    sync() {
      const now = String(get());
      pills.forEach((p, n) => {
        const on = String(options[n][0]) === now;
        p.classList.toggle('on', on);
        p.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    },
  };
}

function toggle(label, scope, get, set, desc) {
  const input = el('input', { type: 'checkbox', 'aria-label': label, onchange: (e) => { void set(e.target.checked); } });
  return {
    node: el('div', { class: 'ce-toggle' }, [
      el('div', { class: 'ce-toggle-text' }, [
        el('div', { class: 'ce-label' }, [label, scopeTag(scope)]),
        desc ? el('div', { class: 'ce-desc', text: desc }) : null,
      ]),
      el('label', { class: 'switch' }, [input, el('span', { class: 'track' }), el('span', { class: 'thumb' })]),
    ]),
    sync() { input.checked = !!get(); },
  };
}

function select(label, scope, options, get, set, desc) {
  const sel = el('select', { 'aria-label': label, onchange: (e) => { void set(e.target.value); } });
  const fill = (opts) => sel.replaceChildren(...opts.map(([v, t]) => el('option', { value: v, text: t })));
  fill(options);
  return {
    node: field(label, scope, sel, desc),
    fill,
    // Not while it is open: the engine's echo of the change would land on it.
    sync() { if (document.activeElement !== sel) sel.value = String(get()); },
  };
}

/** Saved when the field is left, as in Settings — not on every key. */
function text(label, scope, get, set, opts = {}) {
  const input = el('input', {
    type: 'text',
    'aria-label': label,
    placeholder: opts.placeholder || '',
    maxlength: opts.max,
    onchange: (e) => { void set(e.target.value.trim()); },
    oninput: opts.onInput,
  });
  return {
    node: field(label, scope, input, opts.desc),
    input,
    // Not while it is being typed in: the echo would throw the cursor to the end.
    sync() { if (document.activeElement !== input) input.value = get() || ''; },
  };
}

/* ── The parts ─────────────────────────────────────────────────────────────
 *
 * For card `i`: an intro saying what the part shows now, the controls that
 * decide it, and optionally a note under them. `when` hides a control its
 * neighbour makes pointless — a template nobody uses, a language for a
 * translation that is off.
 */

const PARTS = {
  verb: (i) => ({
    intro: () => 'The word before the app’s name on your profile, and what the member list shows after it.',
    controls: [
      choices('Discord says', 'card',
        i === 0 ? ACTIVITY_TYPES : [[-1, 'Same as card 1'], ...ACTIVITY_TYPES],
        () => cfg(ACTIVITY_KEYS[i], i === 0 ? 2 : -1),
        (v) => put(ACTIVITY_KEYS[i], Number(v))),
      select('Status line', 'all', STATUS_DISPLAY,
        () => cfg('rpc_status_display', 'app'),
        (v) => put('rpc_status_display', v),
        'The one line under your name in the member list.'),
      {
        ...text('Status template', 'all',
          () => cfg('rpc_status_template', ''),
          (v) => put('rpc_status_template', v),
          { placeholder: '{title} - {artist}', max: 128, desc: 'Placeholders: {title} {artist} {album} {platform}' }),
        when: () => cfg('rpc_status_display') === 'custom',
      },
    ],
    // The one place the card does not say what is set here (see buildActivity).
    note: 'A YouTube Short says Watching where this says Listening to.',
  }),

  lines: (i) => ({
    intro: () => (cfg(lyricsKey(i), true) !== false
      ? 'The line being sung, then the next one. A song without lyrics shows its title and artist.'
      : 'The song’s title, then its artist or playlist.'),
    controls: [
      choices('The two lines show', 'card', [[true, 'The lyrics'], [false, 'Title and artist']],
        () => cfg(lyricsKey(i), true) !== false,
        (v) => put(lyricsKey(i), v),
        // The one switch here that reaches the window as well.
        'Lyrics off stops them in this window too.'),
      toggle('Romanise', 'all',
        () => cfg('romanize_lyrics') === true,
        (v) => put('romanize_lyrics', v),
        'Japanese, Korean, Chinese, Cyrillic and more, in Latin letters. On Discord only.'),
      toggle('Translate', 'all',
        () => cfg('rpc_translate_lyrics') === true,
        (v) => put('rpc_translate_lyrics', v),
        'The lines go out translated.'),
      { ...langSelect(), when: () => cfg('rpc_translate_lyrics') === true },
    ],
  }),

  info: (i) => ({
    intro: () => (cfg(lyricsKey(i), true) !== false
      ? 'Under the lyrics, the song named in full: title, artist, album and playlist.'
      : 'The album, under the title and artist.'),
    controls: [
      toggle('Name the playlist', 'all',
        () => cfg('rpc_show_playlist', true) !== false,
        (v) => put('rpc_show_playlist', v),
        'The playlist, radio or Liked Songs it plays from — here and in the status line. Off, the artist takes its place.'),
    ],
  }),

  art: () => ({
    intro: () => 'The cover your player shows, with a badge on its corner.',
    controls: [
      choices('Badge', 'all', ICON_MODES,
        () => ICON_KEYS.find((k) => cfg(k) === true) || '',
        // Exactly one mode may be set, so clear them all and set the chosen one.
        (v) => saveConfig({ ...Object.fromEntries(ICON_KEYS.map((k) => [k, false])), ...(v ? { [v]: true } : {}) }),
        'Match the cover picks the red, blue, purple or green one from the cover’s main colour.'),
      toggle('Publish the player’s cover', 'all',
        () => cfg('art_upload_enabled', true) !== false,
        (v) => put('art_upload_enabled', v),
        'Off, covers come from a public catalogue instead, which may answer with another edition’s artwork.'),
    ],
  }),

  buttons: () => {
    // Said while it is typed rather than found out on the profile: a button
    // only opens a web address, and Settings took anything.
    const warn = el('div', { class: 'ce-warn', hidden: true, text: 'A link starts with https:// — Discord opens nothing else.' });
    const check = (v) => { warn.hidden = !v.trim() || /^https?:\/\//i.test(v.trim()); };
    const link = text('Link', 'all',
      () => cfg('rpc_button1_url', ''),
      (v) => put('rpc_button1_url', v),
      { placeholder: 'https://…', max: 512, onInput: (e) => check(e.target.value) });
    link.node.append(warn);
    return {
      intro: () => 'Friends see them under your card. Discord hides them on your own profile.',
      controls: [
        // 32: the engine cuts a label there, so the field stops where Discord would.
        text('Your button', 'all',
          () => cfg('rpc_button1_label', ''),
          (v) => put('rpc_button1_label', v),
          { placeholder: 'Its label', max: 32 }),
        { ...link, sync() { link.sync(); check(link.input.value); } },
      ],
      note: 'It shows once it has both a label and a link. The other button is fixed: it opens what is playing, on its platform.',
    };
  },
};

function langSelect() {
  const want = () => cfg('translate_target_lang', 'en');
  const s = select('Into', 'all', [[want(), langs?.[want()] || want()]], want,
    (v) => put('translate_target_lang', v),
    'The translation in this window uses the same language.');
  if (langs) s.fill(Object.entries(langs));
  else void loadLangs().then((got) => { s.fill(Object.entries(got)); s.sync(); });
  return s;
}

/* ── The bubble ──────────────────────────────────────────────────────────── */

/**
 * @param {{ host: () => HTMLElement | null }} opts
 *   host — the preview the parts are found in. It moves from card to card,
 *   so it is asked for each time rather than kept.
 * @returns {{ open: (zone: string, from?: HTMLElement) => void, toggle: (zone: string, from?: HTMLElement) => void,
 *   close: (restore?: boolean) => void, painted: () => void, dispose: () => void }}
 *   painted — the preview calls it after every redraw: its parts are new
 *   nodes each time, so the one being edited is marked again and the bubble
 *   follows it.
 */
export function cardEditor(opts) {
  let pop = null;
  let tabs = [];
  let body = null;
  let intro = null;
  let zone = null;
  let part = null;
  let opener = null;
  let offConfig = null;

  const host = () => opts.host?.() || null;
  const zoneNode = (z) => host()?.querySelector(`.dc-zone[data-zone="${z}"]`) || null;
  /** The part itself when it is drawn; the card when it is not — no buttons, or a card that is hidden. */
  const anchorFor = (z) => zoneNode(z) || host()?.querySelector('.dc') || host();

  function build() {
    tabs = ZONES.map(([z, label]) => el('button', {
      type: 'button',
      class: 'ce-tab',
      role: 'tab',
      text: label,
      dataset: { zone: z },
      onclick: () => show(z),
      onkeydown: onTabKey,
    }));
    intro = el('p', { class: 'ce-intro' });
    body = el('div', { class: 'ce-body', role: 'tabpanel' });
    // Closing is at the foot, as Done: beside the five tabs, a close button
    // pushed the last one onto a row of its own.
    pop = el('div', { class: 'ce-pop', role: 'dialog', 'aria-label': 'Edit your card', onkeydown: onPopKey }, [
      el('div', { class: 'ce-tabs', role: 'tablist', 'aria-label': 'Part of the card' }, tabs),
      body,
      el('div', { class: 'ce-foot' }, [
        el('button', {
          type: 'button', class: 'mcard-link', text: 'All card settings',
          title: 'When the card shows, and the cards beside it, in Settings',
          onclick: () => { close(); goto('settings', { cat: 'presence' }); },
        }),
        el('button', { type: 'button', class: 'btn btn-sm', text: 'Done', title: 'Close (Esc)', onclick: () => close(true) }),
      ]),
    ]);
    // Off <body>, fixed: inside the page it was cut off by the columns, and
    // the page's fade-in transform made "fixed" relative to the page.
    document.body.append(pop);
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    offConfig = subscribe('config', sync);
  }

  function show(z) {
    zone = z;
    part = PARTS[z](state.focus);
    for (const t of tabs) {
      const on = t.dataset.zone === z;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      // One stop in the tab order for the row; the arrows move along it.
      t.tabIndex = on ? 0 : -1;
    }
    // replaceChildren() writes a null out as the word "null": filtered here.
    body.replaceChildren(...[intro, ...part.controls.map((c) => c.node), part.note ? el('div', { class: 'ce-note', text: part.note }) : null].filter(Boolean));
    body.scrollTop = 0;
    sync();
    mark();
  }

  function sync() {
    if (!part) return;
    intro.textContent = part.intro();
    for (const c of part.controls) {
      if (c.when) c.node.hidden = !c.when();
      c.sync();
    }
    // A control shown or hidden changes the bubble's height.
    place();
  }

  function mark() {
    host()?.querySelectorAll('.dc-zone').forEach((n) => n.classList.toggle('editing', !!pop && n.dataset.zone === zone));
  }

  /**
   * Beside the card when there is room — on its left, toward the seam — so
   * what changes stays in sight; under or over the part otherwise. The arrow
   * points at the part's middle.
   */
  function place() {
    if (!pop) return;
    const a = anchorFor(zone);
    if (!a) return;
    const r = a.getBoundingClientRect();
    const card = (host()?.querySelector('.dc') || a).getBoundingClientRect();
    const m = 8;
    const gap = 12;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    let left;
    let top;
    let side = false;
    if (card.left - gap - w >= m) {
      side = true;
      left = card.left - gap - w;
      // The arrow sits near the top when it can, level with the part.
      top = clamp(r.top + r.height / 2 - 30, m, vh - m - h);
    } else {
      left = clamp(r.left, m, vw - m - w);
      top = r.bottom + gap;
      if (top + h > vh - m && r.top - gap - h >= m) top = r.top - gap - h;
      top = clamp(top, m, vh - m - h);
    }
    pop.classList.toggle('side', side);
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    if (side) pop.style.setProperty('--ce-arrow', `${Math.round(clamp(r.top + r.height / 2 - top, 18, h - 18))}px`);
  }

  function open(z, from = null) {
    if (!PARTS[z]) return;
    if (!pop) build();
    opener = from;
    show(z);
    pop.querySelector('.ce-tab[aria-selected="true"]')?.focus({ preventScroll: true });
  }

  /** A second click on the part being edited puts the bubble away. */
  function toggle(z, from = null) {
    if (pop && zone === z) close(true);
    else open(z, from);
  }

  function close(restore = false) {
    if (!pop) return;
    // A label typed and not yet confirmed is kept: leaving the field is what
    // saves it, and the field is about to go.
    if (pop.contains(document.activeElement)) document.activeElement.blur();
    const was = zone;
    pop.remove();
    pop = null;
    part = null;
    zone = null;
    offConfig?.();
    offConfig = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    mark();
    if (restore) (opener?.isConnected ? opener : zoneNode(was))?.focus({ preventScroll: true });
    opener = null;
  }

  /** A press anywhere but the bubble, a part of the card or what opened it. */
  function onOutside(e) {
    const t = e.target;
    if (pop?.contains(t) || t.closest?.('.dc-zone, [data-ce-open]')) return;
    close();
  }

  function onPopKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== 'Tab') return;
    // Round and round inside, as in a dialog: the bubble hangs off <body>,
    // and tabbing out of it landed at the end of the page, far from the card.
    const stops = [...pop.querySelectorAll('button, input, select')]
      .filter((n) => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function onTabKey(e) {
    const n = tabs.indexOf(e.currentTarget);
    const to = e.key === 'ArrowRight' ? n + 1
      : e.key === 'ArrowLeft' ? n - 1
      : e.key === 'Home' ? 0
      : e.key === 'End' ? tabs.length - 1
      : null;
    if (to === null) return;
    e.preventDefault();
    const t = tabs[(to + tabs.length) % tabs.length];
    show(t.dataset.zone);
    t.focus();
  }

  function painted() {
    if (!pop) return;
    mark();
    // The intro follows the card, and the part may have moved.
    sync();
  }

  return { open, toggle, close, painted, dispose: () => close() };
}
