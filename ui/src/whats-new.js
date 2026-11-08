/**
 * What's New — shown once, the first time the window opens on a new version.
 *
 * The highlights are written here, in the app, rather than fetched from the
 * GitHub release: the window has no network of its own (connect-src 'none'),
 * the first launch after an update may well be offline, and the release notes
 * are written in French at a length meant for reading on GitHub. A few lines
 * per release in the window's language, and the full notes one click away.
 *
 * What shows is decided by `whats_new_seen`, the version whose notes were last
 * closed: every entry newer than it and not newer than this build, so someone
 * who skipped a release gets both. It is set when the dialog is closed, not
 * when it opens — a window that starts hidden in the tray would otherwise mark
 * the notes read before anyone saw them. A release with nothing worth a dialog
 * (a fix or two) has no entry, and moves the mark on without one.
 */

import { el, modal } from './util.js';
import { state, saveConfig } from './state.js';

const api = window.vybecord;

const RELEASE_URL = 'https://github.com/TheUnknownMurda/VybecordTS/releases/tag/';

/** Literal markup, as everywhere `html` is used: a 24-unit box, stroked in currentColor. */
const ICONS = {
  mirror: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="7" height="14" rx="1.5"/><rect x="14" y="5" width="7" height="14" rx="1.5"/><path d="M12 3v2M12 9v2M12 15v2M12 21v0"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 00-3-3L5 17v3z"/><path d="M14.5 7.5l2 2"/></svg>',
  why: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 014.9.7c0 1.7-2.5 2.2-2.5 4"/><path d="M12 17.2v.1"/></svg>',
  offline: '<svg viewBox="0 0 24 24"><path d="M5 5a10 10 0 000 14M19 5a10 10 0 010 14M8.5 8.5a5 5 0 000 7M15.5 8.5a5 5 0 010 7"/><path d="M3 3l18 18"/></svg>',
  sliders: '<svg viewBox="0 0 24 24"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
  wrench: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 00-5.2 5.2L3.5 17.5a2.1 2.1 0 003 3l6-6a4 4 0 005.2-5.2l-2.5 2.5-2.6-.4-.4-2.6z"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2"/></svg>',
  shorts: '<svg viewBox="0 0 24 24"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 9.5v5l4-2.5z"/></svg>',
  verb: '<svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.5"/></svg>',
};

/**
 * Newest first. Written at release time, in English like the rest of the
 * window — the vybecord-release skill says when. A release no one needs
 * telling about gets no entry.
 */
const ENTRIES = [
  {
    version: '2.13.0',
    headline: 'Spotify’s full details without Spicetify, and YouTube Shorts get a card of their own.',
    items: [
      ['key', 'Spotify without Spicetify',
        'With Spotify Premium and a Spotify app of your own, Vybecord gets the playlist, every artist, shuffle and repeat and the exact position without patching Spotify: Settings → Integrations → Spotify.'],
      ['shorts', 'YouTube Shorts, as Shorts',
        'A Short shows its own title, channel and upright picture, with a timer for your Shorts session instead of a bar that restarts at every loop. It needs the browser extension 2.2.2.'],
      ['verb', 'Watching or Listening to',
        'Pick what a Short says on Discord: Settings → Discord presence → Activity type for Shorts, or click the verb on your card.'],
    ],
  },
  {
    version: '2.12.0',
    headline: 'Now playing is a mirror, and your Discord card changes with a click.',
    items: [
      ['mirror', 'Now playing, mirrored',
        'Your window on the left, your Discord cards on the right, and between them the switches that decide what crosses over, each with an arrow toward the side it changes.'],
      ['pencil', 'Click your card to change it',
        'Every part of your Discord card opens its own settings beside it: the verb, the lines, the badge on the cover, your button.'],
      ['why', 'Why?',
        'When your card is not on Discord, Why? says what is in the way, with a button that fixes it.'],
      ['offline', 'Offline channels',
        'A Twitch or Kick tab on a channel that is not live can now show nothing at all: Settings → Detection → Offline channels.'],
      ['sliders', 'Settings leave the lyrics alone',
        'Changing a setting no longer restarts the lyrics on every card.'],
      ['wrench', 'And a run of fixes',
        'Lyrics offsets, YouTube captions, local covers, updates and the browser extension (2.2.1) all behave better.'],
      ['spark', 'What’s new, after every update',
        'This window opens once after an update. Settings → About shows it again.'],
    ],
  },
];

/** -1, 0 or 1. Dotted numbers; a suffix after a hyphen does not count. */
function cmp(a, b) {
  const pa = String(a).split('-')[0].split('.').map((n) => Number(n) || 0);
  const pb = String(b).split('-')[0].split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * The entries a build owes someone who last closed `seen`, newest first.
 * With no mark at all, nothing says which version they came from: the newest
 * entry this build has is the one to show.
 */
function due(current, seen) {
  const upTo = ENTRIES.filter((e) => cmp(e.version, current) <= 0);
  return seen ? upTo.filter((e) => cmp(e.version, seen) > 0) : upTo.slice(0, 1);
}

const markSeen = (version) => {
  if (state.config.whats_new_seen !== version) void saveConfig({ whats_new_seen: version });
};

/**
 * On startup, after the first page is up: the dialog, when this build has news
 * that has not been closed yet.
 */
export async function maybeShowWhatsNew() {
  const current = state.version;
  if (!current) return;
  const seen = String(state.config.whats_new_seen || '');
  if (seen === current) return;
  // Going back to an older build owes nothing; the mark follows it down.
  if (seen && cmp(seen, current) > 0) return markSeen(current);
  if (!seen) {
    /*
     * No mark: a fresh install, or an update from a version that did not have
     * this dialog. The listening history tells them apart, as it does for
     * Help & setup in main.js — nothing is "new" to someone who never had the
     * old version.
     */
    let total = 0;
    try { total = (await api.getHistory(1, 0))?.total || 0; } catch { /* no history to go by */ }
    if (!total) return markSeen(current);
  }
  const entries = due(current, seen);
  if (!entries.length) return markSeen(current);
  await showWhatsNew(entries);
  markSeen(current);
}

/**
 * The dialog itself; resolves when it is closed. With no entries given, the
 * newest this build has — Settings → About opens it that way.
 */
export function showWhatsNew(entries = due(state.version, '')) {
  if (!entries.length) return Promise.resolve();
  const newest = entries[0];
  const oldest = entries[entries.length - 1];
  let gotIt = null;

  const shown = modal((close) => {
    gotIt = el('button', { type: 'button', class: 'btn btn-primary', text: 'Got it', onclick: () => close() });
    return el('div', { class: 'wn' }, [
      el('div', { class: 'wn-head' }, [
        el('span', { class: 'badge accent', text: entries.length > 1 ? `Versions ${oldest.version} to ${newest.version}` : `Version ${newest.version}` }),
        el('h2', { class: 'wn-title', id: 'wnTitle', text: 'What’s new' }),
        el('p', { class: 'wn-headline', text: newest.headline }),
      ]),
      ...entries.map((e) => el('section', { class: 'wn-release', 'aria-label': `Version ${e.version}` }, [
        entries.length > 1 ? el('div', { class: 'eyebrow', text: `Version ${e.version}` }) : null,
        el('ul', { class: 'wn-list' }, e.items.map(([icon, title, text]) => el('li', { class: 'wn-item' }, [
          el('span', { class: 'wn-ico', html: ICONS[icon] || ICONS.spark }),
          el('div', {}, [
            el('div', { class: 'wn-item-title', text: title }),
            el('div', { class: 'wn-item-text', text }),
          ]),
        ]))),
      ])),
      el('div', { class: 'wn-foot' }, [
        el('button', {
          type: 'button', class: 'btn btn-ghost', text: 'Full release notes',
          title: 'Every change in this version, on GitHub',
          onclick: () => api.openExternal(RELEASE_URL + newest.version),
        }),
        gotIt,
      ]),
    ]);
  });

  // modal() hands the focus to the first button, which here is the link out.
  // Enter should close the dialog, not open a browser. Without preventScroll,
  // a window too short for the list scrolled to the buttons and opened on
  // the last changes, the title out of sight.
  const box = gotIt?.closest('.modal');
  box?.setAttribute('role', 'dialog');
  box?.setAttribute('aria-labelledby', 'wnTitle');
  gotIt?.focus({ preventScroll: true });
  if (box) box.scrollTop = 0;
  return shown;
}
