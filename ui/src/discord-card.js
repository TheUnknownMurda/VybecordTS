/**
 * "What your friends see" — the focused presence as Discord draws it.
 *
 * Built from the activity the engine last handed to Discord (the
 * activityUpdate event), not re-derived here: the engine decides what goes on
 * which line, and a second copy of those rules in the window would drift from
 * it the first time either changed. How Discord lays those fields out is
 * discord-model.js, which the harness checks against real activities.
 *
 * Whether the card is up at all is read off the status and the config, since
 * the engine keeps building cards while publishing is held back.
 */

import { el, platformInfo, setArt, BLANK_ART } from './util.js';
import { state, subscribe } from './state.js';
import { presenceModel } from './discord-model.js';

/** Why nothing is on the profile right now, or '' when the card is up. */
function hiddenReason() {
  const s = state.status || {};
  const c = state.config || {};
  const t = state.track;
  if (!s.discordConnected) return 'Discord is not open, so nothing is on your profile right now.';
  if (c.rpc_enabled === false) return 'Rich Presence is off — nothing is on your profile.';
  if (s.adPlaying) return 'Hidden while the ad plays. It comes back with the music.';
  if (s.userAway && s.hideWhenAway !== false) return 'Hidden while you are away. It comes back the moment you are.';
  if (t && !t.is_playing && c.rpc_only_when_playing === true) return 'Hidden while paused.';
  return '';
}

/** Discord's note glyph beside a running clock. Literal markup, nothing from a track. */
const NOTE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

/**
 * @param {{ onCustomize?: () => void, title?: string }} opts
 * @returns {{ node: HTMLElement, dispose: () => void }}
 */
export function discordPreview(opts = {}) {
  const body = el('div', { class: 'dc' });
  const note = el('div', { class: 'dc-note' });
  const node = el('section', { class: 'card dc-card', 'aria-label': 'Preview of your Discord card' }, [
    el('div', { class: 'dc-head' }, [
      el('span', { class: 'eyebrow', text: opts.title || 'What your friends see' }),
      opts.onCustomize ? el('button', { type: 'button', text: 'Customize', onclick: opts.onCustomize }) : null,
    ]),
    body,
    note,
  ]);

  /** What the 1s tick repaints: the clock and nothing else. */
  let timeSlot = null;
  let activity = null;
  let appName = '';

  function paint() {
    timeSlot = null;
    activity = null;
    note.textContent = '';

    const reason = hiddenReason();
    if (reason) {
      body.replaceChildren(el('div', { class: 'dc-hidden', text: reason }));
      return;
    }

    const t = state.track;
    if (!t) {
      // The idle card only ever goes on presence 1, and only while nothing at
      // all is playing — see setIdlePresence() in the backend.
      const anyPlaying = state.slots.some((s) => s.track);
      if (state.focus === 0 && !anyPlaying && state.config.rpc_only_when_playing !== true) {
        activity = { type: state.config.rpc_activity_type ?? 2, details: '⏸ Nothing playing', state: '  ' };
        appName = 'Vybecord';
        draw(BLANK_ART);
      } else {
        body.replaceChildren(el('div', { class: 'dc-hidden', text: 'Nothing on this card right now.' }));
      }
      return;
    }

    // Until the engine has built the first card for a new track, show what it
    // is about to say rather than the previous track's lines.
    activity = state.activity || { type: 2, details: t.track_name, state: t.artist_name };
    appName = platformInfo(t.media_source)[0];
    draw(null, t);

    // The one thing about the lyric layout nobody would guess.
    if (state.lyrics?.current && activity.details && activity.details.trim() !== (t.track_name || '').trim()) {
      note.textContent = 'The first two lines follow the song, line by line. The one under them names the track.';
    }
  }

  function draw(blankArt, track) {
    const m = presenceModel(activity, { appName });

    const art = el('img', { class: 'dc-art', alt: '', src: blankArt || BLANK_ART, title: m.largeText });
    if (m.largeImage) art.src = m.largeImage;
    else if (track) setArt(art, track.album_art_url, track.track_id).catch(() => {});

    timeSlot = el('div', { class: 'dc-time-slot' });

    body.replaceChildren(...[
      el('div', { class: 'dc-verb', text: m.header, title: m.header }),
      el('div', { class: 'dc-body' }, [
        el('div', { class: 'dc-art-wrap' }, [
          art,
          m.smallImage ? el('img', { class: 'dc-small', alt: '', src: m.smallImage, title: m.smallText }) : null,
        ]),
        el('div', { class: 'dc-lines' }, [
          ...m.lines.map((line, i) => el('div', { class: i === 0 ? 'dc-l1' : 'dc-l', text: line })),
          timeSlot,
        ]),
      ]),
      m.buttons.length
        ? el('div', { class: 'dc-buttons' }, [
            ...m.buttons.map((label) => el('div', { class: 'dc-button', text: label })),
            el('div', { class: 'dc-buttons-note', text: 'Friends see these buttons. Discord hides them on your own profile.' }),
          ])
        : null,
    ].filter(Boolean));
    paintTime();
  }

  /** Discord counts from the timestamps, every second, and so does this. */
  function paintTime() {
    if (!timeSlot || !activity) return;
    const { time } = presenceModel(activity, { appName });
    if (!time) {
      timeSlot.replaceChildren();
      return;
    }
    if (time.kind === 'bar') {
      timeSlot.replaceChildren(el('div', { class: 'dc-time' }, [
        el('span', { text: time.elapsed }),
        el('div', { class: 'dc-bar' }, [el('div', { class: 'dc-fill', style: `width:${time.pct}%` })]),
        el('span', { text: time.total }),
      ]));
    } else {
      const run = el('div', { class: 'dc-elapsed', title: 'Time since it started' });
      run.innerHTML = NOTE;
      run.append(time.text);
      timeSlot.replaceChildren(run);
    }
  }

  paint();
  const unsubs = [
    subscribe('activity', paint),
    subscribe('track', paint),
    subscribe('status', paint),
    subscribe('config', paint),
    subscribe('focus', paint),
  ];
  const ticker = setInterval(paintTime, 1000);

  return {
    node,
    dispose() {
      clearInterval(ticker);
      unsubs.forEach((fn) => fn());
    },
  };
}
