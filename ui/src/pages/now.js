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

    // The card that takes the leftover height — see .lyr-card in the stylesheet.
    el('div', { class: 'card lyr-card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Lyrics' }),
        el('div', { class: 'item-actions' }, [
          el('button', {
            class: 'btn btn-sm', text: 'Full lyrics', title: 'Show every line of this song',
            onclick: openFullLyrics,
          }),
          el('button', {
            class: 'btn btn-sm', text: 'Copy .lrc', title: 'Copy the synced lyrics to the clipboard',
            onclick: copyLrc,
          }),
        ]),
      ]),
      // The block itself is the affordance: three lines is a keyhole view of the
      // song, and clicking anywhere on them opens the rest of it.
      el('div', {
        class: 'lyr lyr-clickable',
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

  const onProgress = (p) => {
    base = p?.progress_ms || 0;
    baseAt = performance.now();
    paintProgress(p);
  };

  const unsubs = [
    subscribe('track', paintTrack),
    subscribe('progress', onProgress),
    subscribe('lyrics', paintLyrics),
    subscribe('config', () => { paintOffset(); paintTrSlot(); }),
    // An ad produces no track, so the idle state has to be redrawn to explain
    // itself rather than sit there reading "Nothing playing".
    // Being away hides the presence without the song changing at all, so the
    // chip that says so cannot wait for the next trackUpdate to appear.
    subscribe('status', () => (state.track ? paintBadges(state.track) : paintTrack(null))),
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

/*
 * The glyphs behind the status chips.
 *
 * Drawn in the same language as the sidebar icons: a 24-unit box, stroked in
 * currentColor, round joins. They are literal markup and never touch anything
 * a track can name, which is what makes `html` safe to use here.
 */
const ICONS = {
  live: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.2"/><path d="M8.2 8.2a5.4 5.4 0 000 7.6"/>'
    + '<path d="M15.8 15.8a5.4 5.4 0 000-7.6"/><path d="M5.4 5.4a9.3 9.3 0 000 13.2"/>'
    + '<path d="M18.6 18.6a9.3 9.3 0 000-13.2"/></svg>',
  local: '<svg viewBox="0 0 24 24"><rect x="3" y="13" width="18" height="7" rx="2"/>'
    + '<path d="M6 13l1.8-6.2A2 2 0 019.7 5.4h4.6a2 2 0 011.9 1.4L18 13"/><circle cx="17" cy="16.5" r="1"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M3 6h3.5c1.3 0 2.5.6 3.2 1.7l4.6 6.6c.7 1.1 1.9 1.7 3.2 1.7H21"/>'
    + '<path d="M3 18h3.5c1.3 0 2.5-.6 3.2-1.7l.8-1.2"/><path d="M14.5 9.2l.8-1.2c.7-1.1 1.9-1.7 3.2-1.7H21"/>'
    + '<path d="M18 3.6L21 6l-3 2.4"/><path d="M18 13.6L21 16l-3 2.4"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M7 7h10a3 3 0 013 3v1"/><path d="M17 17H7a3 3 0 01-3-3v-1"/>'
    + '<path d="M15 4l3 3-3 3"/><path d="M9 20l-3-3 3-3"/></svg>',
  repeatOne: '<svg viewBox="0 0 24 24"><path d="M7 7h10a3 3 0 013 3v1"/><path d="M17 17H7a3 3 0 01-3-3v-1"/>'
    + '<path d="M15 4l3 3-3 3"/><path d="M9 20l-3-3 3-3"/><path d="M11.3 10.6l1.4-1V15"/></svg>',
  paused: '<svg viewBox="0 0 24 24"><rect x="7" y="5" width="3.4" height="14" rx="1.2"/>'
    + '<rect x="13.6" y="5" width="3.4" height="14" rx="1.2"/></svg>',
  ad: '<svg viewBox="0 0 24 24"><path d="M4 10.5v3a1 1 0 001 1h2.2l6.8 4V5.5l-6.8 4H5a1 1 0 00-1 1z"/>'
    + '<path d="M17.5 9.2a4 4 0 010 5.6"/><path d="M20 6.6a7.6 7.6 0 010 10.8"/></svg>',
  away: '<svg viewBox="0 0 24 24"><path d="M20.5 13.4A8.6 8.6 0 0110.6 3.5a8.6 8.6 0 109.9 9.9z"/></svg>',
};

/** True while the presence is being withheld because the user is idle. */
function hiddenForAway() {
  return state.status?.userAway === true && state.status?.hideWhenAway !== false;
}

/**
 * A status chip: the glyph on screen, the words in the tooltip.
 *
 * Four of these spelled out in words ran wider than the track title and read
 * like a sentence the page was not making. The label is still there for anyone
 * hovering, and for a screen reader.
 */
function statusChip(icon, label, accent = false) {
  return el('span', {
    class: `badge badge-icon${accent ? ' accent' : ''}`,
    title: label,
    role: 'img',
    'aria-label': label,
    html: ICONS[icon],
  });
}

function paintTrack(track) {
  const art = $('#npArt');
  const source = $('#npSource');

  if (!track) {
    const ad = state.status?.adPlaying === true;
    const away = !ad && hiddenForAway();
    $('#npTitle').textContent = ad ? 'Advertisement' : 'Nothing playing';
    $('#npArtist').textContent = ad
      ? 'Your Discord status is hidden until the ad is over.'
      : away ? 'You are away — your Discord status is hidden until you come back.' : '';
    $('#npAlbum').textContent = '';
    // Spread a list rather than passing a conditional: replaceChildren() has no
    // filtering of its own, so a bare null lands on screen as the text "null".
    $('#npBadges').replaceChildren(
      ...(ad ? [statusChip('ad', 'Spotify ad')] : []),
      ...(away ? [statusChip('away', 'Away — Discord status hidden')] : []),
    );
    art.src = BLANK_ART;
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

  paintBadges(track);
}

/**
 * The chips under the title.
 *
 * Split out of paintTrack because the first of them answers to the status
 * rather than to the track — see the 'status' subscription above.
 */
function paintBadges(track) {
  const badges = [];
  if (hiddenForAway()) badges.push(['away', 'Away — Discord status hidden until you come back', true]);
  if (track.is_live) badges.push(['live', 'Live broadcast', true]);
  if (track.is_local) badges.push(['local', 'Local file', false]);
  if (track.is_shuffle) badges.push(['shuffle', 'Shuffle is on', false]);
  if (track.repeat_mode === 'track') badges.push(['repeatOne', 'Repeating this track', false]);
  else if (track.repeat_mode && track.repeat_mode !== 'off') badges.push(['repeat', 'Repeating the queue', false]);
  if (!track.is_playing) badges.push(['paused', 'Paused', false]);
  $('#npBadges').replaceChildren(...badges.map((b) => statusChip(...b)));
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

/**
 * Whether the translation line holds its place.
 *
 * With translations on it stays in the layout even while a line is untranslated,
 * so the lines do not jump every time one arrives. With them off it goes away
 * entirely — an empty slot there spaces the three lines unevenly, leaving a hole
 * under the current one.
 */
function paintTrSlot() {
  $('.lyr')?.classList.toggle('with-tr', state.config.translate_lyrics === true);
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

/* ── Full lyrics ───────────────────────────────────────────────────────────
 *
 * The card shows three lines because that is what fits beside a cover; the rest
 * of the song lives in a panel one click away. Nothing extra is fetched to fill
 * it: every lyric tick already carries the whole line array and the index the
 * engine is on, so the panel follows the song off the same events the card does.
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

/** Set while the panel is up. */
let panelOpen = false;

/**
 * Open the panel, once.
 *
 * The lyric block keeps the focus while the panel is up — modal() hands the
 * focus to its first button, which is the follow button, and that one is
 * disabled — so a second Enter would otherwise mount an identical panel over
 * the first, subscriptions and all.
 */
function openFullLyrics() {
  if (panelOpen) return Promise.resolve();
  panelOpen = true;
  return showFullLyrics().finally(() => { panelOpen = false; });
}

async function showFullLyrics() {
  /*
   * The engine only emits on a line change, so a track paused before its first
   * line has lyrics cached but no state to read them from. Asking for the LRC
   * covers that: it comes off the same cache the engine was injected with, so
   * the indexes line up with the ones the ticks report.
   */
  let data = readLines();
  if (!data) {
    const lrc = await api.getLrc().catch(() => null);
    const lines = lrc ? parseLrc(lrc) : [];
    if (lines.length) data = { lines, synced: true };
  }
  if (!data) {
    return toast(state.track ? 'No lyrics loaded for this track' : 'Nothing is playing', 'err');
  }

  const list = el('div', { class: 'lyr-full' });
  const trackLine = el('div', { class: 'lyr-full-track' });
  const meta = el('div', { class: 'lyr-full-meta' });
  const followBtn = el('button', { class: 'btn btn-sm lyr-full-follow', onclick: () => setFollow(true) });

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

  // modal() builds and mounts synchronously, and only resolves once the panel
  // is closed — so this is the promise to wait on, not the panel being up.
  const closed = modal((close) => el('div', {}, [
    el('div', { class: 'lyr-full-head' }, [el('h2', { text: 'Lyrics' }), meta]),
    trackLine,
    list,
    el('div', { class: 'lyr-full-foot' }, [
      followBtn,
      el('button', { class: 'btn', text: 'Close', onclick: () => close() }),
    ]),
  ]));

  // The list has no size until it is in the document, so it opens on the line
  // the song is on only if the first centring waits for that. Anything measured
  // before the mount is zero, and the panel would open at the top of the song.
  if (rows[cur]) centre(rows[cur], 'auto');

  await closed;

  clearTimeout(waitTimer);
  unsubs.forEach((fn) => fn());

  function paintTrack_() {
    const t = state.track;
    trackLine.textContent = t
      ? [t.track_name || 'Unknown track', t.artist_name].filter(Boolean).join(' — ')
      : 'Nothing playing';
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
      const lrc = await api.getLrc().catch(() => null);
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
        next.synced ? el('span', { class: 'lyr-full-time', text: fmtTime(line.time) }) : null,
        el('span', { class: 'lyr-full-text', text: line.text || '♪' }),
      ]));
      list.replaceChildren(...rows);
      meta.textContent = next.synced
        ? `${next.lines.length} lines · follows the song`
        : `${next.lines.length} lines · no timings, so it cannot follow along`;
      followBtn.hidden = !next.synced;
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
    if (!node) return;
    node.classList.add('is-current');
    if (follow) centre(node, behavior);
  }

  function setFollow(on) {
    follow = on;
    followBtn.textContent = on ? 'Following the song' : 'Back to the current line';
    followBtn.disabled = on;
    followBtn.classList.toggle('btn-primary', !on);
    if (on && rows[cur]) centre(rows[cur], 'smooth');
  }

  /**
   * Put a line in the middle of the list.
   *
   * The scroll is aimed at the list rather than the row — scrollIntoView() moves
   * every scrollable ancestor, which would drag the modal and the page behind it
   * around as well. The measurement goes through rects rather than offsetTop,
   * which is relative to whichever ancestor happens to be positioned.
   */
  function centre(node, behavior) {
    const rect = node.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    const top = Math.max(0, list.scrollTop + (rect.top - box.top) - (list.clientHeight - rect.height) / 2);
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
   * so this is usually a cache read that lands in one round trip. A miss just
   * leaves the lines untranslated — there is nothing to report.
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
