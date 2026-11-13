/**
 * "Why?" — everything that stands between what is playing and the Discord
 * card, checked in the order it goes wrong, each with the click that fixes it
 * when there is one.
 *
 * The answers were already in the window, spread over four places: the
 * sidebar said Discord was not found, the preview said the card was hidden
 * while you were away, the Lyrics card said they were off for this presence,
 * Settings held the switch behind each. Nothing said which one mattered, so a
 * status that did not show read as the app being broken. This lists them for
 * the card on screen, and the first one that fails is the answer.
 *
 * Read off the same status and config the preview paints from — no backend
 * call of its own — so it cannot disagree with the card beside it.
 */

import { el, platformInfo } from './util.js';
import { state, subscribe, saveConfig } from './state.js';
import { goto } from './router.js';

/** The lyrics switch of a card; `show_lyrics` is the first one's. */
export const lyricsKey = (i) => (i > 0 ? `show_lyrics_${i + 1}` : 'show_lyrics');

/** How many of the cards on air carry lyrics. */
export function lyricCardCount(cfg) {
  const count = Math.max(1, Math.min(5, Number(cfg.presence_count) || 1));
  let n = 0;
  for (let i = 0; i < count; i++) if (cfg[lyricsKey(i)] !== false) n++;
  return n;
}

/**
 * Said when lyrics go on a second card, as a toast (main.js) and under the
 * switches in Settings.
 *
 * Discord puts the card that changed last on top of the others of its type,
 * and a lyric line is a change, so two cards with lyrics trade places line
 * after line. Nothing the app sends holds them: a fixed created_at per card
 * (Discord stamps its own) and re-sending the upper card after each change of
 * the lower one (unchanged, start moved by 1 ms, hover text changed) were each
 * tried on 2026-11-13 and watched from another account; none kept the order.
 * So the user is told rather than surprised.
 */
export const CARD_ORDER_NOTE = 'With lyrics on more than one card, your cards can swap places on your Discord profile at each new line: '
  + 'Discord puts the card that changed last on top, and Vybecord cannot hold the order.';

/** Literal glyphs only, never anything a track can name — see ICONS in pages/now.js. */
const GLYPH = {
  ok: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>',
  fail: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 7v6"/><path d="M12 17v.01"/></svg>',
  info: '<svg viewBox="0 0 24 24"><path d="M12 11v6"/><path d="M12 7v.01"/></svg>',
};
/** What the glyph says, for a screen reader. */
const KIND_WORD = { ok: 'OK:', fail: 'Problem:', warn: 'Note:', info: 'Info:' };

const CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const playerName = (t) => platformInfo(t.media_source)[0];

/** The player a card is pinned to, the first card falling back to the legacy field. */
function pinOf(i) {
  const arr = Array.isArray(state.preferredPlayers) ? state.preferredPlayers : [];
  return i === 0 ? arr[0] ?? state.preferredPlayer ?? null : arr[i] ?? null;
}

/** Into the lyrics editor with the song's details filled in, and any words already found. */
function writeLyrics(t, text) {
  goto('library', {
    tab: 'import',
    prefill: {
      track: t.track_name || '',
      artist: t.artist_name || '',
      album: t.album_name || '',
      duration: t.duration_ms > 0 ? String(Math.round(t.duration_ms / 1000)) : '',
      lrc: text,
    },
  });
}

/**
 * What this card has to show, or why it shows nothing.
 *
 * Paused songs follow the preview's rules (discord-card.js): the first card
 * says "Nothing playing" while nothing at all plays, the others go blank,
 * and with Hide when paused on, neither shows.
 */
function sourceCheck(actions) {
  const i = state.focus;
  const c = state.config || {};
  const t = state.track;
  const hidePaused = c.rpc_only_when_playing === true;
  const hiddenPaused = (name) => ({
    kind: 'fail',
    short: 'Hidden',
    title: 'Hidden while paused',
    detail: `${name} is paused, and Paused is on under Hide on Discord when.`,
    fixes: [{ label: 'Keep it while paused', run: () => saveConfig({ rpc_only_when_playing: false }) }],
  });

  if (state.status?.adPlaying === true) {
    return {
      kind: 'fail',
      short: 'Hidden',
      title: 'A Spotify ad is playing',
      detail: 'The card is held back until the music comes back.',
      fixes: [{ label: 'Show during ads', run: () => saveConfig({ filter_spotify_ads: false }) }],
    };
  }
  if (t && !t.is_playing && hidePaused) return hiddenPaused(playerName(t));
  if (t) return { kind: 'ok', title: `${t.is_playing ? 'Playing' : 'Paused'} on ${playerName(t)}` };

  const idleCard = i === 0 && !state.slots.some((s) => s.track) && !hidePaused;
  const paused = state.lastTrack;
  if (paused) {
    if (hidePaused) return hiddenPaused(playerName(paused));
    return {
      kind: 'warn',
      short: 'Paused',
      title: `Paused on ${playerName(paused)}`,
      detail: idleCard
        ? 'Your card says “Nothing playing” until the song goes on again.'
        : 'This card stays empty until the song goes on again.',
    };
  }

  const pinned = pinOf(i);
  if (pinned) {
    const player = (state.players || []).find((p) => p.appId === pinned);
    return {
      kind: 'fail',
      short: 'Idle',
      title: player ? `Pinned to ${platformInfo(player.source)[0]}, which isn’t playing` : 'Pinned to a player that isn’t running',
      detail: 'A pinned card follows that one player and nothing else.',
      fixes: actions.unpin ? [{ label: 'Follow anything', run: actions.unpin }] : [],
    };
  }
  return {
    kind: 'warn',
    short: 'Idle',
    title: 'Nothing is playing',
    detail: (idleCard ? 'Your card says “Nothing playing”. ' : '')
      + 'Play something in Spotify, a browser tab or any media app. If it still does not show, its player may be switched off under Detection.',
    fixes: [{ label: 'Open Detection', run: () => goto('settings', { cat: 'detection' }) }],
  };
}

/** What the card does with lyrics, once there is a song on it. */
function lyricsCheck() {
  const t = state.track;
  if (!t) return null;
  const key = lyricsKey(state.focus);
  const l = state.lyrics;
  const synced = Array.isArray(l?.lyrics) && l.lyrics.length > 0;
  const plain = !synced && Array.isArray(l?.lines) && l.lines.length > 0;
  // Kick's captions arrive as lines, the way lyrics do — see kickCaptions() in pages/now.js.
  const kick = t.media_source === 'kick' && (!!t.is_live || t.context_type === 'vod');

  if (state.config?.[key] === false) {
    return {
      kind: 'warn',
      title: 'Lyrics are off for this card',
      detail: 'The card shows the title and artist instead, and so does this window.',
      fixes: [{ label: 'Turn them on', run: () => saveConfig({ [key]: true }) }],
    };
  }
  if (kick) {
    return synced
      ? { kind: 'ok', title: 'Kick’s captions are on the card' }
      : { kind: 'info', title: 'No captions yet', detail: 'Turn on captions (CC) in Kick’s player: what is said shows on the card, as lyrics.' };
  }
  if (t.is_live || t.media_source === 'twitch' || t.media_source === 'kick') {
    return { kind: 'info', title: 'Streams show their title, not lyrics' };
  }
  // A Short is never looked up as a song (see onNewTrack): only its captions.
  if (t.is_short) {
    return synced
      ? { kind: 'ok', title: 'The Short’s captions are on the card' }
      : { kind: 'info', title: 'Shorts show their captions, not lyrics', detail: 'When the Short has captions on YouTube, what is said shows on the card. Without them, the card shows its title.' };
  }
  if (synced) return { kind: 'ok', title: 'Synced lyrics are on the card' };
  if (plain) {
    return {
      kind: 'warn',
      title: 'Only words without timings were found',
      detail: 'The card cannot follow the song with them. Time them once and they are kept for this song.',
      fixes: [{ label: 'Time them', run: () => writeLyrics(t, l.lines.join('\n')) }],
    };
  }
  // The engine sends nothing until it has lines, so "still looking" and
  // "found none" look the same from here; the words cover both.
  return {
    kind: 'warn',
    title: 'No lyrics for this song yet',
    detail: 'None found so far. Write them and tap along to time them, or look in the LRCLIB dump.',
    fixes: [
      { label: 'Write them', run: () => writeLyrics(t, '') },
      { label: 'Search the dump', run: () => goto('library', { tab: 'dump' }) },
    ],
  };
}

/**
 * Every check for the card on screen, and the verdict: the first one that
 * keeps the card off Discord, or "live".
 *
 * @param {{ unpin?: () => void }} actions  fixes that belong to the page,
 *   offered only when the page passes them in
 */
export function diagnose(actions = {}) {
  const s = state.status || {};
  const c = state.config || {};
  const gates = [
    s.discordConnected
      ? { kind: 'ok', title: 'Discord is open' }
      : {
          kind: 'fail',
          short: 'Not connected',
          title: 'Discord isn’t open on this PC',
          detail: 'Your status goes through the Discord desktop app. Start it, and the card shows up within a few seconds.',
        },
    c.rpc_enabled !== false
      ? { kind: 'ok', title: 'Visible is on' }
      : {
          kind: 'fail',
          short: 'Off',
          title: 'Visible is off',
          detail: 'Nothing goes to your profile, on any card, until it is back on.',
          fixes: [{ label: 'Turn it on', run: () => saveConfig({ rpc_enabled: true }) }],
        },
    s.mediaSourceReady
      ? { kind: 'ok', title: 'Media detection is running' }
      : {
          kind: 'fail',
          short: 'No detection',
          title: 'Media detection isn’t running',
          detail: 'Windows did not hand over its media sessions. Quitting and reopening Vybecord usually brings them back.',
        },
    sourceCheck(actions),
  ];
  // Read off the config rather than the status: the switch for it is right
  // here, and the config moves the moment it is flipped.
  if (s.userAway === true && c.rpc_hide_when_away !== false) {
    gates.push({
      kind: 'fail',
      short: 'Hidden',
      title: 'Hidden while you’re away',
      detail: `Nothing touched the keyboard or mouse for ${c.away_after_minutes ?? 10} minutes. It comes back the moment you do.`,
      fixes: [{ label: 'Show while away', run: () => saveConfig({ rpc_hide_when_away: false }) }],
    });
  }

  const blocker = gates.find((g) => g.kind !== 'ok');
  const card = (Number(s.presenceCount) || 1) > 1 ? `Card ${state.focus + 1}` : 'Your card';
  return {
    live: !blocker,
    short: blocker?.short || 'Live',
    headline: blocker ? blocker.title : `${card} is live on Discord`,
    checks: [...gates, lyricsCheck()].filter(Boolean),
  };
}

function row(c) {
  return el('li', { class: `why-row ${c.kind}` }, [
    el('span', { class: 'why-ico', 'aria-hidden': 'true', html: GLYPH[c.kind] }),
    el('div', { class: 'why-text' }, [
      el('div', { class: 'why-title' }, [el('span', { class: 'sr-only', text: `${KIND_WORD[c.kind]} ` }), c.title]),
      c.detail ? el('div', { class: 'why-detail', text: c.detail }) : null,
      c.fixes?.length
        ? el('div', { class: 'why-fixes' }, c.fixes.map((f, n) => el('button', {
            type: 'button',
            class: `btn btn-sm${n === 0 ? ' btn-primary' : ''}`,
            text: f.label,
            onclick: f.run,
          })))
        : null,
    ]),
  ]);
}

/**
 * The panel the Why? button opens.
 *
 * Rebuilt from a key, never on every event: 'lyrics' and 'slots' fire on each
 * tick, and a list rebuilt under the cursor swallowed the click on a fix.
 *
 * @param {{ unpin?: () => void, onToggle?: (open: boolean) => void }} opts
 */
export function whyPanel(opts = {}) {
  const headline = el('div', { class: 'why-headline' });
  const list = el('ul', { class: 'why-list' });
  const node = el('section', { class: 'card why', id: 'whyPanel', hidden: true, 'aria-label': 'Why your card looks like this' }, [
    el('div', { class: 'why-head' }, [
      headline,
      el('button', {
        type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': 'Close', title: 'Close',
        html: CLOSE, onclick: () => toggle(false),
      }),
    ]),
    list,
  ]);

  let key = '';
  function paint() {
    if (node.hidden) return;
    const d = diagnose(opts);
    const next = JSON.stringify([state.focus, d.live, d.headline, d.checks.map((c) => [c.kind, c.title, c.detail, (c.fixes || []).map((f) => f.label)])]);
    if (next === key) return;
    key = next;
    headline.className = `why-headline ${d.live ? 'ok' : 'fail'}`;
    headline.textContent = d.headline;
    list.replaceChildren(...d.checks.map(row));
  }

  function toggle(open) {
    const show = open ?? node.hidden;
    node.hidden = !show;
    key = '';
    paint();
    opts.onToggle?.(show);
  }

  const unsubs = ['status', 'config', 'track', 'lastTrack', 'lyrics', 'focus', 'slots', 'players', 'preferredPlayers']
    .map((k) => subscribe(k, paint));

  return {
    node,
    toggle,
    dispose() {
      unsubs.forEach((fn) => fn());
    },
  };
}
