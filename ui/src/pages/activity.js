/**
 * Activity — what you listened to, over a range you pick.
 *
 * Stats and History used to be two pages that answered the same question from
 * two ends: totals for a period on one, the raw log on the other. Here the
 * range drives everything on screen, and the log is the "recently played" list
 * with the full history one click away.
 */

import { el, artUrl, fmtDate, fmtDay, fmtDuration, platformInfo, plural, toast, modal, BLANK_ART } from '../util.js';
import { state, subscribe } from '../state.js';

const api = window.vybecord;
const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;

const RANGES = [[7, '7 days'], [30, '30 days'], [365, '12 months'], [0, 'All time']];

/** The range picked last, kept for the life of the window. */
let range = 7;

export function render(root) {
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' });
  const tiles = el('div', { class: 'grid grid-3', style: 'margin-bottom:16px' });
  const chartCard = el('section', { class: 'card', style: 'flex:3 1 420px', 'aria-label': 'Listening time' });
  const artistsCard = el('section', { class: 'card', style: 'flex:2 1 280px', 'aria-label': 'Top artists' });
  const tracksCard = el('section', { class: 'card', style: 'flex:1 1 340px;padding:16px 10px 10px', 'aria-label': 'Top tracks' });
  const recentCard = el('section', { class: 'card', style: 'flex:1 1 340px;padding:16px 10px 10px', 'aria-label': 'Recently played' });

  root.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Activity' }),
        el('div', { class: 'sub', text: 'What you listened to — kept on this PC only. Live streams are left out of the totals.' }),
      ]),
      seg,
    ]),
    tiles,
    el('div', { class: 'act-row' }, [chartCard, artistsCard]),
    el('div', { class: 'act-row' }, [tracksCard, recentCard]),
  );

  // Ranges differ by an order of magnitude in how long they take to crunch, so
  // clicking two in a row can land the slower answer last. The token makes the
  // range that was picked last the one that paints, not the one that finishes last.
  let token = 0;

  function paintSeg() {
    seg.replaceChildren(...RANGES.map(([days, label]) => el('button', {
      type: 'button',
      class: `seg-btn${days === range ? ' active' : ''}`,
      'aria-pressed': days === range ? 'true' : 'false',
      text: label,
      onclick: () => { if (range !== days) { range = days; paintSeg(); load(); } },
    })));
  }

  /** `quiet` keeps what is on screen until the new numbers are in — see below. */
  async function load(quiet = false) {
    const mine = ++token;
    if (!quiet) tiles.replaceChildren(el('div', { class: 'empty', text: 'Crunching…' }));
    let w;
    try {
      w = await api.getWrapped(range || undefined);
    } catch (e) {
      if (mine !== token || quiet) return;
      tiles.replaceChildren(el('div', { class: 'empty', text: `Could not compute: ${e.message}` }));
      return;
    }
    if (mine !== token) return;

    const has = !!w?.totalTracks;
    tiles.replaceChildren(
      tile(has ? fmtDuration(w.totalListenedMs) : '—', 'Time listened'),
      tile(has ? String(w.totalTracks) : '—', 'Tracks played'),
      tile(has ? String(w.uniqueArtists) : '—', 'Different artists'),
      tile(has ? fmtDuration(w.avgDailyMs) : '—', `Daily average · ${plural(has ? w.activeDays : 0, 'active day')}`),
    );
    paintChart(chartCard, has ? w : null);
    paintArtists(artistsCard, has ? w : null);
    paintTracks(tracksCard, has ? w : null);
  }

  paintSeg();
  load();
  const recent = paintRecent(recentCard);

  /*
   * A play is written to the history as the next track starts, so a change of
   * track on any presence is when these numbers move. With the page open the
   * song that just ended stayed out of every tile and list ("2 tracks") while
   * See all already counted it ("3 of 3"). Reloaded a moment after the change,
   * since nothing promises the play is written before the track is announced,
   * and quietly: "Crunching…" on every song change would blink the page under
   * whoever is reading it.
   */
  const playingKey = () => state.slots.map((s) => s.track?.track_id || '').join('|');
  let key = playingKey();
  let timer = 0;
  const unsub = subscribe('slots', () => {
    const k = playingKey();
    if (k === key) return;
    key = k;
    clearTimeout(timer);
    timer = setTimeout(() => { load(true); recent.reload(); }, 1500);
  });
  return () => {
    unsub();
    clearTimeout(timer);
  };
}

function tile(value, label) {
  return el('div', { class: 'tile' }, [
    el('div', { class: 'tile-value', text: value }),
    el('div', { class: 'tile-label', text: label }),
  ]);
}

/* ── Listening time chart ──────────────────────────────────────────────────── */

/** YYYY-MM-DD for a local date — the same key the backend groups by. */
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 1, 2, 2.5, 5 × 10^k — the smallest of those at or above `v`. */
function niceCeil(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * The buckets to draw: one per day for a week or a month, one per month
 * beyond that. Days nothing was played on are zero rather than missing, so the
 * gaps read as gaps.
 */
function buckets(w) {
  const byDay = new Map((w.byDay || []).map((d) => [d.day, d.ms]));
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  if (range === 7 || range === 30) {
    return Array.from({ length: range }, (_, i) => {
      const d = new Date(today.getTime() - (range - 1 - i) * DAY_MS);
      const ms = byDay.get(dayKey(d)) || 0;
      return {
        ms,
        label: range === 7
          ? fmtDay(d, { weekday: 'short' })
          : (i % 5 === 4 || i === range - 1 ? String(d.getDate()) : ''),
        tip: fmtDay(d, { weekday: 'long', month: 'short', day: 'numeric' }),
      };
    });
  }

  const months = new Map();
  for (const [day, ms] of byDay) months.set(day.slice(0, 7), (months.get(day.slice(0, 7)) || 0) + ms);
  let first = new Date(today.getFullYear(), today.getMonth() - 11, 1);
  if (range === 0 && w.byDay?.length) {
    const [y, m] = w.byDay[0].day.split('-').map(Number);
    const earliest = new Date(y, m - 1, 1);
    if (earliest < first) first = earliest;
  }
  const out = [];
  for (let d = new Date(first); d <= today; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push({
      ms: months.get(key) || 0,
      label: fmtDay(d, { month: 'short' }),
      tip: fmtDay(d, { month: 'long', year: 'numeric' }),
    });
  }
  // Past two years a label per month no longer fits; keep every third.
  if (out.length > 24) out.forEach((b, i) => { if (i % 3) b.label = ''; });
  return out;
}

function paintChart(card, w) {
  const perMonth = !(range === 7 || range === 30);
  const head = el('div', { class: 'card-head', style: 'margin-bottom:0' }, [
    el('h2', { text: perMonth ? 'Listening time per month' : 'Listening time per day' }),
  ]);
  if (!w) {
    card.replaceChildren(head, el('div', { class: 'empty', text: 'Nothing listened to in this range yet.' }));
    return;
  }

  const bs = buckets(w);
  const max = Math.max(...bs.map((b) => b.ms), 1);
  // Hours when there are hours to show, minutes otherwise — "0.3 h" reads worse than "18 m".
  const unitMs = max >= 3_600_000 ? 3_600_000 : 60_000;
  const unit = unitMs === 3_600_000 ? 'h' : 'm';
  const top = niceCeil(max / unitMs);
  const PLOT_H = 196;
  const peak = bs.findIndex((b) => b.ms === max);

  const plot = el('div', { class: 'chart-plot' }, bs.map((b, i) => {
    const h = Math.round((b.ms / unitMs / top) * PLOT_H);
    const col = el('div', {
      class: `chart-col${i === peak ? ' peak' : ''}`,
      title: `${b.tip} · ${b.ms ? fmtDuration(b.ms) : 'nothing'}`,
      style: `--h:${h}px`,
    }, [
      el('span', { class: 'chart-tip', text: b.ms ? fmtDuration(b.ms) : '0m' }),
      el('div', { class: 'chart-bar', style: `height:${h}px` }),
    ]);
    return col;
  }));

  const tick = (v) => {
    const y = PLOT_H - (v / top) * PLOT_H;
    return [
      el('div', { class: 'chart-grid', style: `top:${y}px` }),
      el('div', { class: 'chart-tick', style: `top:${y}px`, text: `${v}${unit}` }),
    ];
  };

  card.replaceChildren(
    head,
    el('div', { class: 'chart', role: 'img', 'aria-label': `${perMonth ? 'Monthly' : 'Daily'} listening time, peak ${fmtDuration(max)}` }, [
      ...tick(top / 2),
      ...tick(top),
      plot,
      el('div', { class: 'chart-x', 'aria-hidden': 'true' }, bs.map((b) => el('span', { text: b.label }))),
    ]),
  );
}

/* ── Top lists ─────────────────────────────────────────────────────────────── */

function paintArtists(card, w) {
  const head = el('h2', { text: 'Top artists', style: 'margin-bottom:8px' });
  const list = (w?.topArtists || []).slice(0, 6);
  if (!list.length) {
    card.replaceChildren(head, el('div', { class: 'empty', text: 'Nobody yet.' }));
    return;
  }
  const max = list[0].totalMs || 1;
  card.replaceChildren(head, ...list.map((a) => el('div', { class: 'meter-row' }, [
    el('div', { class: 'meter-top' }, [
      el('span', { class: 'meter-name', text: a.name }),
      el('span', { class: 'meter-val', text: `${fmtDuration(a.totalMs)} · ${plural(a.plays, 'play')}` }),
    ]),
    el('div', { class: 'meter', 'aria-hidden': 'true' }, [el('div', { style: `width:${Math.max(2, Math.round((a.totalMs / max) * 100))}%` })]),
  ])));
}

function paintTracks(card, w) {
  const head = el('h2', { text: 'Top tracks', style: 'margin:0 10px 6px' });
  const list = (w?.topTracks || []).slice(0, 6);
  card.replaceChildren(head, list.length
    ? el('div', { class: 'list' }, list.map((t, i) => el('div', { class: 'item' }, [
        el('div', { class: 'item-rank', text: String(i + 1) }),
        el('img', { class: 'item-art', src: artUrl(t.art) || BLANK_ART, alt: '' }),
        el('div', { class: 'item-body' }, [
          el('div', { class: 'item-title', text: t.name }),
          el('div', { class: 'item-sub', text: t.artist }),
        ]),
        el('div', { class: 'item-meta', text: `${t.plays}× · ${fmtDuration(t.totalMs)}` }),
      ])))
    : el('div', { class: 'empty', text: 'Nothing yet.' }));
}

/* ── The log ───────────────────────────────────────────────────────────────── */

function logRow(e) {
  const [label] = platformInfo(e.source);
  const src = artUrl(e.art);
  return el('div', { class: 'item' }, [
    el('img', { class: 'item-art', src: src || BLANK_ART, alt: '' }),
    el('div', { class: 'item-body' }, [
      el('div', { class: 'item-title', text: e.track }),
      el('div', { class: 'item-sub', text: `${e.artist}${e.album ? ` · ${e.album}` : ''} · ${label}` }),
    ]),
    el('div', { class: 'item-meta', title: `Listened ${fmtDuration(e.listenedMs)}`, text: fmtDate(e.startedAt) }),
  ]);
}

/** The last few plays. Returns `reload`, which refills the list in place. */
function paintRecent(card) {
  const list = el('div', { class: 'list' }, [el('div', { class: 'empty', text: 'Loading…' })]);
  card.replaceChildren(
    el('div', { class: 'card-head', style: 'margin:0 0 6px 10px' }, [
      el('h2', { text: 'Recently played' }),
      el('button', { type: 'button', class: 'btn btn-sm', text: 'See all', onclick: openLog }),
    ]),
    list,
  );
  // Same guard as the range token: two reloads close together must not let
  // the older answer paint last.
  let token = 0;
  async function reload() {
    const mine = ++token;
    try {
      const res = await api.getHistory(6, 0);
      if (mine !== token) return;
      const entries = res?.entries || [];
      list.replaceChildren(...(entries.length
        ? entries.map(logRow)
        : [el('div', { class: 'empty', text: 'Nothing listened to yet.' })]));
    } catch (e) {
      if (mine !== token) return;
      list.replaceChildren(el('div', { class: 'empty', text: `Could not load history: ${e.message}` }));
    }
  }
  void reload();
  return { reload };
}

/** Every track the app has seen, newest first, a page at a time. */
function openLog() {
  let offset = 0;
  let total = 0;
  // Pins every page to the log as it stood on the first call. Without it, a
  // track finishing mid-scroll shifts the whole log down by one and the next
  // page repeats the row already on screen.
  let anchor;
  const list = el('div', { class: 'list', style: 'max-height:56vh;overflow-y:auto;margin-top:12px' });
  const counter = el('div', { class: 'muted' });
  const more = el('button', { type: 'button', class: 'btn', text: 'Load more', onclick: () => load() });

  async function load() {
    more.disabled = true;
    more.textContent = 'Loading…';
    try {
      const res = await api.getHistory(PAGE_SIZE, offset, anchor);
      const entries = res?.entries || [];
      anchor = res?.anchor ?? anchor;
      total = res?.total ?? total;
      offset += entries.length;
      if (!entries.length && offset === 0) {
        list.replaceChildren(el('div', { class: 'empty', text: 'Nothing listened to yet.' }));
      } else {
        list.append(...entries.map(logRow));
      }
      counter.textContent = total ? `${offset} of ${total}` : '';
      more.hidden = offset >= total;
    } catch (e) {
      toast(`Could not load history: ${e.message}`, 'err');
    } finally {
      more.disabled = false;
      more.textContent = 'Load more';
    }
  }

  modal((close) => el('div', {}, [
    el('div', { class: 'card-head', style: 'margin-bottom:0' }, [el('h2', { text: 'Listening history' }), counter]),
    list,
    el('div', { style: 'display:flex;justify-content:space-between;gap:8px;margin-top:14px' }, [
      more,
      el('button', { type: 'button', class: 'btn', text: 'Close', onclick: () => close() }),
    ]),
  ]));
  load();
}
