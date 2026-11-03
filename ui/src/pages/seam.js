/**
 * The seam of Now playing: the switches that decide what crosses from this
 * window to the Discord card, between the two sides they act on.
 *
 * Settings has pairs that read as one switch said twice — "Translate in this
 * window" and "Translate on Discord too" — and one switch that quietly does
 * both, Lyrics, which takes the words out of the window as well as off the
 * card. Here each one says which way it reaches: an arrow to the right is
 * Discord only, to the left this window only, both ways is both. They write
 * the same keys Settings writes; nothing new is stored.
 */

import { el } from '../util.js';
import { state, subscribe, saveConfig } from '../state.js';
import { lyricsKey } from '../why.js';

const api = window.vybecord;

/** Literal glyphs only — see ICONS in now.js. */
const G = {
  left: '<svg class="br-arrow" viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  right: '<svg class="br-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  latin: '<svg viewBox="0 0 24 24"><path d="M3 19l5-14 5 14M5 14h6"/><path d="M15 9h6M18 6v13"/></svg>',
  translate: '<svg viewBox="0 0 24 24"><path d="M4 5h8M8 3v2M5.5 9c1 2.5 3 4.5 5.5 5.5M10.5 5c-.8 4-3 7-6.5 8.5"/><path d="M12.5 20l3.5-9 3.5 9M13.8 17h4.4"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',
  away: '<svg viewBox="0 0 24 24"><path d="M20.5 13.4A8.6 8.6 0 0110.6 3.5a8.6 8.6 0 109.9 9.9z"/></svg>',
  ad: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 15l2-6 2 6M7.6 13.2h2.8M14 9v6h1.4a3 3 0 000-6z"/></svg>',
};

/*
 * `on` is what an unset key means, as config.ts defaults it. `reach` is the
 * side, or sides, the switch acts on.
 */
const BRIDGES = [
  {
    glyph: 'eye', label: 'Visible', reach: 'out', key: () => 'rpc_enabled', on: true,
    tip: (v) => (v
      ? 'Your activity is on Discord, on every card. Off clears your status right away.'
      : 'Nothing is on your Discord profile. On puts your status back.'),
  },
  {
    glyph: 'note', label: 'Lyrics', reach: 'both', key: () => lyricsKey(state.focus), on: true,
    tip: (v) => {
      const which = multi() ? ` on card ${state.focus + 1}` : '';
      return v
        ? `Lyrics follow the song${which}, here and on Discord. Off hides them in both; the card keeps the title and artist.`
        : `No lyrics${which}, here or on Discord. On shows them again.`;
    },
  },
  // Discord only, though Settings files it under Display: the lyrics engine
  // applies it to the lines it sends to Discord, and the window's lines
  // arrive as written.
  {
    glyph: 'latin', label: 'Romanise', reach: 'out', key: () => 'romanize_lyrics', on: false,
    tip: () => 'Lyrics in Latin letters on your Discord card: Japanese, Korean, Chinese, Cyrillic, Greek, Thai, Arabic and more.',
  },
  {
    glyph: 'translate', label: 'Translate', reach: 'in', key: () => 'translate_lyrics', on: false,
    tip: () => 'A translation under each line, in this window only.',
  },
  {
    glyph: 'translate', label: 'Translate', reach: 'out', key: () => 'rpc_translate_lyrics', on: false,
    tip: () => 'The translated lines on your Discord card, in place of the original.',
  },
];

/** Hide rules: Discord only, each one a situation the card comes down in. */
const RULES = [
  { glyph: 'pause', label: 'Paused', key: () => 'rpc_only_when_playing', on: false, tip: () => 'Take the card down as soon as playback is paused.' },
  {
    glyph: 'away', label: 'Away', key: () => 'rpc_hide_when_away', on: true,
    tip: () => `Hide the card after ${state.config.away_after_minutes ?? 10} minutes without the keyboard or mouse. The delay is in Settings.`,
  },
  { glyph: 'ad', label: 'Spotify ad', key: () => 'filter_spotify_ads', on: true, tip: () => 'Hide the card while a Spotify ad plays.' },
];

const multi = () => (Number(state.status?.presenceCount) || 1) > 1;
const isOn = (b) => (b.on ? state.config[b.key()] !== false : state.config[b.key()] === true);

/**
 * A pill that is a switch. Built once and updated in place: rebuilt, the
 * Lyrics switch — whose key changes with the card on screen — took the
 * keyboard focus with it.
 */
function pill(b, cls = 'br') {
  const node = el('button', {
    type: 'button',
    class: cls,
    role: 'switch',
    onclick: () => { void saveConfig({ [b.key()]: !isOn(b) }); },
  });
  node.innerHTML = (b.reach === 'in' || b.reach === 'both' ? G.left : '') + G[b.glyph];
  node.append(el('span', { class: 'br-label', text: b.label }));
  if (b.reach === 'out' || b.reach === 'both') node.insertAdjacentHTML('beforeend', G.right);
  return node;
}

function paintPill(node, b) {
  const v = isOn(b);
  node.classList.toggle('on', v);
  node.setAttribute('aria-checked', v ? 'true' : 'false');
  const reach = b.reach === 'in' ? ' — this window' : b.reach === 'out' ? ' — on Discord' : b.reach === 'both' ? ' — here and on Discord' : '';
  // Named in full for a screen reader: two pills both read "Translate".
  node.setAttribute('aria-label', `${b.label}${reach}`);
  node.title = b.tip(v);
}

/** The translation languages, asked for once per window — as Settings does. */
let langs = null;

export function seam() {
  const bridges = BRIDGES.map((b) => pill(b));
  const rules = RULES.map((r) => pill(r, 'br br-rule'));
  const lang = el('select', {
    class: 'br-lang',
    'aria-label': 'Translate to',
    title: 'The language of the translation, here and on Discord',
    onchange: (e) => { void saveConfig({ translate_target_lang: e.target.value }); },
  });

  const node = el('div', { class: 'seam', role: 'group', 'aria-label': 'What crosses over to Discord' }, [
    ...bridges.slice(0, 3),
    el('div', { class: 'seam-group' }, [...bridges.slice(3), lang]),
    el('div', { class: 'seam-group' }, [
      el('div', { class: 'seam-cap' }, ['Hide on Discord when']),
      ...rules,
    ]),
  ]);

  function paintLang() {
    const want = state.config.translate_target_lang || 'en';
    const entries = Object.entries(langs || { [want]: want });
    const key = entries.map(([k]) => k).join(',');
    if (lang.dataset.key !== key) {
      lang.dataset.key = key;
      lang.replaceChildren(...entries.map(([code, name]) => el('option', { value: code, text: name })));
    }
    lang.value = want;
  }

  function paint() {
    bridges.forEach((n, i) => paintPill(n, BRIDGES[i]));
    rules.forEach((n, i) => paintPill(n, RULES[i]));
    paintLang();
  }

  paint();
  if (!langs) {
    api.translateLangs()
      .then((got) => { langs = got && Object.keys(got).length ? got : { en: 'English' }; })
      .catch(() => { langs = { en: 'English' }; })
      .then(() => { if (node.isConnected) paintLang(); });
  }

  const unsubs = [subscribe('config', paint), subscribe('focus', paint), subscribe('status', paint)];
  return {
    node,
    dispose() {
      unsubs.forEach((fn) => fn());
    },
  };
}
