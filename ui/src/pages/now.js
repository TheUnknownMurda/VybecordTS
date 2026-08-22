/** Now playing — cover, metadata, progress and the live lyric line. */

import { el, $, fmtTime, setArt, platformInfo, toast, modal, BLANK_ART } from '../util.js';
import { state, subscribe, saveConfig } from '../state.js';
import { goto } from '../router.js';

const api = window.vybecord;

export function render(root) {
  root.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('h1', { text: 'Now playing' }),
      el('div', { class: 'sub', id: 'npSource', text: 'Waiting for a player…' }),
    ]),

    el('div', { class: 'card' }, [
      el('div', { class: 'np' }, [
        el('img', { class: 'np-art', id: 'npArt', alt: '', src: BLANK_ART }),
        el('div', { class: 'np-meta' }, [
          el('div', { class: 'np-title', id: 'npTitle', text: 'Nothing playing' }),
          el('div', { class: 'np-artist', id: 'npArtist' }),
          el('div', { class: 'np-album', id: 'npAlbum' }),
          el('div', { class: 'np-badges', id: 'npBadges' }),
          el('div', { class: 'np-cover-src', id: 'npCoverSrc' }),
          el('div', { class: 'np-progress' }, [
            el('div', { class: 'np-bar' }, [el('div', { class: 'np-fill', id: 'npFill' })]),
            el('div', { class: 'np-times' }, [
              el('span', { id: 'npElapsed', text: '0:00' }),
              el('span', { id: 'npTotal', text: '0:00' }),
            ]),
          ]),
        ]),
      ]),
    ]),

    el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Lyrics' }),
        el('div', { class: 'item-actions' }, [
          el('button', {
            class: 'btn btn-sm', text: 'Copy .lrc', title: 'Copy the synced lyrics to the clipboard',
            onclick: copyLrc,
          }),
        ]),
      ]),
      el('div', { class: 'lyr' }, [
        el('div', { class: 'lyr-prev', id: 'lyrPrev' }),
        el('div', { class: 'lyr-cur', id: 'lyrCur', text: '—' }),
        el('div', { class: 'lyr-tr', id: 'lyrTr' }),
        el('div', { class: 'lyr-next', id: 'lyrNext' }),
      ]),
      el('div', { class: 'lyr-report' }, [
        el('button', {
          class: 'btn btn-danger btn-lg', id: 'npReport',
          text: '⚑  These lyrics aren’t matching?',
          onclick: reportLyrics,
        }),
        el('div', { class: 'lyr-report-hint' },
          'Not matching what you hear? Say so — the app stops using them for this track, '
          + 'and if it is only the timing that drifts you can re-time them yourself.'),
      ]),

      el('div', { class: 'row' }, [
        el('div', {}, [
          el('div', { class: 'row-label', text: 'Timing offset' }),
          el('div', { class: 'row-desc', text: 'Negative shows lines earlier, positive later. Applies to the current track and every track after it.' }),
        ]),
        el('div', { class: 'row-control', style: 'display:flex;gap:6px;align-items:center' }, [
          el('button', { class: 'btn btn-sm', text: '−250', onclick: () => nudgeOffset(-250) }),
          el('span', { id: 'npOffset', style: 'min-width:70px;text-align:center;font-variant-numeric:tabular-nums', text: '0 ms' }),
          el('button', { class: 'btn btn-sm', text: '+250', onclick: () => nudgeOffset(250) }),
          el('button', { class: 'btn btn-sm', text: 'Reset', onclick: () => setOffset(0) }),
        ]),
      ]),
    ]),
  );

  // Initial paint from whatever state we already hold.
  paintTrack(state.track);
  paintProgress(state.progress);
  paintLyrics(state.lyrics);
  paintOffset();

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

  const onProgress = (p) => {
    base = p?.progress_ms || 0;
    baseAt = performance.now();
    paintProgress(p);
  };

  const unsubs = [
    subscribe('track', paintTrack),
    subscribe('progress', onProgress),
    subscribe('lyrics', paintLyrics),
    subscribe('config', paintOffset),
    // An ad produces no track, so the idle state has to be redrawn to explain
    // itself rather than sit there reading "Nothing playing".
    subscribe('status', () => { if (!state.track) paintTrack(null); }),
  ];

  const ticker = setInterval(() => {
    if (!state.track?.is_playing) return;
    const duration = state.progress.duration_ms;
    const elapsed = base + (performance.now() - baseAt);
    paintProgress({
      progress_ms: duration > 0 ? Math.min(elapsed, duration) : elapsed,
      duration_ms: duration,
    });
  }, 250);

  return () => {
    clearInterval(ticker);
    unsubs.forEach((fn) => fn());
  };
}

/** What the source line says while nothing is playing. */
function waitingText() {
  const pinnedId = state.preferredPlayer;
  if (!pinnedId) return 'Waiting for a player…';
  const pinned = (state.players || []).find((p) => p.appId === pinnedId);
  return pinned
    ? `Pinned to ${platformInfo(pinned.source)[0]} — waiting for it to play`
    : 'Pinned to a player that is not running';
}

function paintTrack(track) {
  const art = $('#npArt');
  const source = $('#npSource');

  if (!track) {
    const ad = state.status?.adPlaying === true;
    $('#npTitle').textContent = ad ? 'Advertisement' : 'Nothing playing';
    $('#npArtist').textContent = ad ? 'Your Discord status is hidden until the ad is over.' : '';
    $('#npAlbum').textContent = '';
    // Spread a list rather than passing a conditional: replaceChildren() has no
    // filtering of its own, so a bare null lands on screen as the text "null".
    $('#npBadges').replaceChildren(
      ...(ad ? [el('span', { class: 'badge', text: 'Spotify ad' })] : []),
    );
    art.src = BLANK_ART;
    $('#npCoverSrc').replaceChildren();
    // A pin is exclusive, so nothing playing may simply mean the pinned player
    // is paused or closed. Saying which one avoids the app looking broken when
    // it is doing exactly what it was told.
    source.textContent = ad ? '🟢 Spotify' : waitingText();
    paintProgress({ progress_ms: 0, duration_ms: 0 });
    setAmbient(null);
    return;
  }

  const [label, glyph] = platformInfo(track.media_source);
  source.textContent = `${glyph} ${label}`;
  $('#npTitle').textContent = track.track_name || 'Unknown track';
  $('#npArtist').textContent = track.artist_name || '';
  $('#npAlbum').textContent = track.album_name || '';

  // Resolving local art needs a round trip, so the tint follows the image.
  setArt(art, track.album_art_url, track.track_id).then(setAmbient, () => setAmbient(null));

  /*
   * The exact URL handed to Discord.
   *
   * Discord will happily accept an activity and then quietly fail to load its
   * image — the profile shows a "?" and nothing anywhere says why. Surfacing the
   * URL turns that into something checkable in one click: if it opens in a
   * browser but Discord still shows "?", the host is the problem, not the app.
   */
  const srcLine = $('#npCoverSrc');
  const artUrlSent = track.album_art_url || '';
  if (/^https?:\/\//.test(artUrlSent)) {
    let host = '?';
    try { host = new URL(artUrlSent).host; } catch { /* keep the placeholder */ }
    srcLine.replaceChildren(
      el('span', { text: `Cover sent to Discord via ${host} — ` }),
      el('a', {
        href: '#', text: 'open it',
        onclick: (e) => { e.preventDefault(); api.openExternal(artUrlSent); },
      }),
    );
  } else {
    srcLine.replaceChildren(el('span', {
      text: artUrlSent === '/api/thumbnail'
        ? 'Cover is local only — not uploaded yet, so Discord has none'
        : '',
    }));
  }

  const badges = [];
  if (track.is_live) badges.push(['LIVE', true]);
  if (track.is_local) badges.push(['Local file', false]);
  if (track.is_shuffle) badges.push(['Shuffle', false]);
  if (track.repeat_mode && track.repeat_mode !== 'off') badges.push([`Repeat ${track.repeat_mode}`, false]);
  if (!track.is_playing) badges.push(['Paused', false]);
  $('#npBadges').replaceChildren(
    ...badges.map(([text, accent]) => el('span', { class: `badge ${accent ? 'accent' : ''}`.trim(), text })),
  );
}

function paintProgress(p) {
  const total = p?.duration_ms || 0;
  const elapsed = Math.min(p?.progress_ms || 0, total || Infinity);
  $('#npFill').style.width = total > 0 ? `${Math.min(100, (elapsed / total) * 100)}%` : '0%';
  $('#npElapsed').textContent = fmtTime(elapsed);
  $('#npTotal').textContent = total > 0 ? fmtTime(total) : '—';
}

function paintLyrics(l) {
  $('#lyrPrev').textContent = l?.prev || '';
  $('#lyrCur').textContent = l?.current || (state.track ? '♪' : '—');
  $('#lyrNext').textContent = l?.next || '';
  $('#lyrTr').textContent = l?.translation || '';
}

function paintOffset() {
  const ms = Number(state.config.lyrics_offset_ms) || 0;
  $('#npOffset').textContent = `${ms > 0 ? '+' : ''}${ms} ms`;
}

async function setOffset(ms) {
  const clamped = Math.max(-60000, Math.min(60000, ms));
  await api.setLyricsOffset(clamped);
  await saveConfig({ lyrics_offset_ms: clamped });
}

function nudgeOffset(delta) {
  return setOffset((Number(state.config.lyrics_offset_ms) || 0) + delta);
}

async function copyLrc() {
  const lrc = await api.getLrc();
  if (!lrc) return toast('No synced lyrics loaded for this track', 'err');
  await navigator.clipboard.writeText(lrc);
  toast('Copied to clipboard', 'ok');
}

/**
 * Ask what is actually wrong, then act on the answer.
 *
 * The two cases want opposite things. Wrong words: drop them and never fetch
 * them again, done. Wrong timing: the words are worth keeping, so they are
 * carried into the import form where the sync studio can re-tap the lines that
 * drift. Both flag the version currently loaded, which is what stops the app
 * from fetching it back.
 */
async function reportLyrics() {
  const track = state.track;
  if (!track) return toast('Nothing is playing', 'err');

  const choice = await modal((close) => el('div', {}, [
    el('h2', { text: 'What is wrong with these lyrics?' }),
    el('div', { class: 'muted', style: 'margin:10px 0 18px' },
      `${track.track_name || 'Unknown track'} — ${track.artist_name || ''}`),

    choice_(
      'The timing is off',
      'The words are right, they just land early or late. They are carried over to the import '
      + 'page, where you can re-time them line by line against the song and save your own copy.',
      () => close('timing'),
    ),
    choice_(
      'The words are wrong',
      'A different song, nonsense — or this track has no lyrics at all. '
      + 'This version is dropped and never fetched for this track again.',
      () => close('wrong'),
    ),

    el('div', { style: 'display:flex;justify-content:flex-end;margin-top:16px' }, [
      el('button', { class: 'btn', text: 'Cancel', onclick: () => close() }),
    ]),
  ]));

  if (!choice) return;

  // Read the lines out first: flagging drops them from the cache, so asking
  // afterwards would hand the import form an empty box.
  const lrc = choice === 'timing' ? await api.getLrc().catch(() => null) : null;

  const flagged = (await api.flagLyrics())?.ok === true;

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

/** A big clickable answer in the report dialog. */
function choice_(title, desc, onclick) {
  return el('button', { class: 'choice', onclick }, [
    el('div', { class: 'choice-title', text: title }),
    el('div', { class: 'choice-desc', text: desc }),
  ]);
}

/**
 * Tint the background orbs from the cover.
 *
 * The image is drawn to a 1x1 canvas to get its average colour. It comes from
 * the local vybecord: scheme or an https CDN; either way it must not taint the
 * canvas, so a failed read is swallowed rather than allowed to throw.
 */
function setAmbient(url) {
  const orbs = document.querySelectorAll('.orb');
  if (!url) {
    orbs.forEach((o) => o.style.removeProperty('--orb'));
    return;
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      orbs.forEach((o) => o.style.setProperty('--orb', `rgb(${r},${g},${b})`));
    } catch {
      /* cross-origin cover — keep the default tint */
    }
  };
  img.src = url;
}
