/** Stats — this session's top tracks/artists, plus snapshots of past sessions. */

import { el, artUrl, fmtDate, BLANK_ART } from '../util.js';
import { state, subscribe } from '../state.js';

const api = window.vybecord;

export function render(root) {
  const session = el('div', { class: 'card' });
  const past = el('div', { class: 'card' }, [el('div', { class: 'empty', text: 'Loading…' })]);

  root.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('h1', { text: 'Stats' }),
      el('div', { class: 'sub', text: 'Session stats reset when the app restarts. Past sessions are kept below.' }),
    ]),
    session,
    past,
  );

  const paint = () => paintSession(session);
  paint();
  const unsub = subscribe('stats', paint);
  loadHistory(past);
  return unsub;
}

function paintSession(card) {
  const { topTracks = [], topArtists = [] } = state.stats || {};

  card.replaceChildren(
    el('div', { class: 'card-head' }, [el('h2', { text: 'This session' })]),
    el('div', { class: 'grid grid-2' }, [
      el('div', {}, [
        el('div', { class: 'muted', style: 'margin-bottom:8px', text: 'Top tracks' }),
        topTracks.length
          ? el('div', { class: 'list' }, topTracks.map((t, i) => el('div', { class: 'item' }, [
              el('div', { class: 'item-rank', text: String(i + 1) }),
              artImg(t.art, t.name),
              el('div', { class: 'item-body' }, [
                el('div', { class: 'item-title', text: t.name }),
                el('div', { class: 'item-sub', text: t.artist }),
              ]),
              el('div', { class: 'item-meta', text: `${t.plays}×` }),
            ])))
          : el('div', { class: 'empty', text: 'Nothing played yet' }),
      ]),
      el('div', {}, [
        el('div', { class: 'muted', style: 'margin-bottom:8px', text: 'Top artists' }),
        topArtists.length
          ? el('div', { class: 'list' }, topArtists.map((a, i) => el('div', { class: 'item' }, [
              el('div', { class: 'item-rank', text: String(i + 1) }),
              artImg(a.artist_art || a.art, a.name),
              el('div', { class: 'item-body' }, [el('div', { class: 'item-title', text: a.name })]),
              el('div', { class: 'item-meta', text: `${a.plays}×` }),
            ])))
          : el('div', { class: 'empty', text: 'Nothing played yet' }),
      ]),
    ]),
  );
}

async function loadHistory(card) {
  let sessions = [];
  try {
    sessions = (await api.getStatsHistory()) || [];
  } catch (e) {
    card.replaceChildren(el('div', { class: 'empty', text: `Could not load past sessions: ${e.message}` }));
    return;
  }

  if (!sessions.length) {
    card.replaceChildren(
      el('div', { class: 'card-head' }, [el('h2', { text: 'Past sessions' })]),
      el('div', { class: 'empty', text: 'No past sessions yet — this is the first one. It is saved as you listen, so closing the app is not what keeps it.' }),
    );
    return;
  }

  // The backend already hands these back newest-first, which is the order to
  // show them in: the session that just ended is the one being looked for.
  card.replaceChildren(
    el('div', { class: 'card-head' }, [el('h2', { text: 'Past sessions' })]),
    ...sessions.map((s) => el('div', { style: 'margin-bottom:18px' }, [
      el('div', { class: 'muted', style: 'margin-bottom:6px', text: fmtDate(s.date) }),
      el('div', { class: 'list' }, (s.topTracks || []).slice(0, 3).map((t, i) => el('div', { class: 'item' }, [
        el('div', { class: 'item-rank', text: String(i + 1) }),
        artImg(t.art, t.name),
        el('div', { class: 'item-body' }, [
          el('div', { class: 'item-title', text: t.name }),
          el('div', { class: 'item-sub', text: t.artist }),
        ]),
        el('div', { class: 'item-meta', text: `${t.plays}×` }),
      ]))),
    ])),
  );
}

function artImg(url, alt) {
  const src = artUrl(url);
  return el('img', { class: 'item-art', src: src || BLANK_ART, alt: '' });
}
