/**
 * Activity — what you listened to, over a range and on a platform you pick.
 *
 * Two filters sit above everything and scope everything below them: the range
 * (top right) and the platform (the row of chips). "All music" is every music
 * platform together, live streams left out as they always were; picking
 * Twitch or Kick turns the page into watch time, channels and categories.
 * The breakdown by platform ignores the platform filter on purpose: it is
 * the map of where the time went, and each of its rows is a way in.
 *
 * Every number comes from one call (getWrapped, worked out in
 * src/core/listening-stats.ts); the page only lays it out. The colour of the
 * charts is the accent on "All music" and the platform's own once one is
 * picked (--act-c), so the page says at a glance what it is showing.
 */

import { el, artUrl, fmtDate, fmtDay, fmtDuration, fmtHour, fmtTime, platformInfo, plural, toast, modal, BLANK_ART } from '../util.js';
import { state, subscribe } from '../state.js';

const api = window.vybecord;
const PAGE_SIZE = 50;

const RANGES = [[7, '7 days'], [30, '30 days'], [365, '12 months'], [0, 'All time']];
const BEFORE = { 7: 'the week before', 30: 'the month before', 365: 'the year before' };
const IN_RANGE = { 7: 'in the last 7 days', 30: 'in the last 30 days', 365: 'in the last 12 months', 0: 'yet' };

/** The range and platform picked last, kept for the life of the window. '' is all music. */
let range = 7;
let platform = '';

/**
 * Platforms with a colour of their own (the --pf-* tokens in styles.css);
 * browsers, desktop players and anything new share the neutral one. A colour
 * belongs to the platform, never to its rank, so Spotify is the same green on
 * every range and every filter.
 */
const COLOURED = new Set(['spotify', 'youtube', 'youtube_music', 'soundcloud', 'apple_music', 'bandcamp', 'deezer', 'tidal', 'amazon_music', 'twitch', 'kick']);
const pfColor = (src) => `var(--pf-${COLOURED.has(src) ? src.replace('_', '-') : 'other'})`;
const pfName = (src) => platformInfo(src)[0];

const fmtCount = (n) => Number(n || 0).toLocaleString('en-US');
/** A duration, where a few seconds is "<1m" rather than a "0m" beside something that was played. */
const dur = (ms) => (ms > 0 && ms < 30_000 ? '<1m' : fmtDuration(ms));
const dayDate = (key) => new Date(`${key}T12:00:00`);
const shortDay = (key) => fmtDay(dayDate(key), { month: 'short', day: 'numeric' });

export function render(root) {
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' });
  const chips = el('div', { class: 'act-chips', role: 'group', 'aria-label': 'Platform', hidden: true });
  const body = el('div', { class: 'act-body' }, [el('div', { class: 'empty', text: 'Crunching…' })]);
  const tips = hoverTips();

  root.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Activity' }),
        el('div', { class: 'sub', text: 'What you listened to and watched — kept on this PC only.' }),
      ]),
      seg,
    ]),
    chips,
    body,
  );

  // Ranges differ by an order of magnitude in how long they take to crunch, so
  // clicking two in a row can land the slower answer last. The token makes the
  // pick made last the one that paints, not the one that finishes last.
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

  function pick(src) {
    if (platform === src) return;
    platform = src;
    load();
  }

  /**
   * `quiet` keeps what is on screen until the new numbers are in. A pick the
   * user made dims the page meanwhile instead of blanking it, so nothing
   * jumps while the next answer is worked out.
   */
  async function load(quiet = false) {
    const mine = ++token;
    if (!quiet) body.classList.add('busy');
    let w;
    try {
      w = await api.getWrapped(range || undefined, platform || undefined);
    } catch (e) {
      if (mine !== token || quiet) return;
      body.classList.remove('busy');
      body.replaceChildren(el('div', { class: 'card empty', text: `Could not compute: ${e.message}` }));
      return;
    }
    if (mine !== token) return;
    // A platform that left the log (evicted from the front) cannot stay picked.
    if (platform && !(w.historyPlatforms || []).some((p) => p.source === platform)) {
      platform = '';
      load(quiet);
      return;
    }
    tips.hide();
    paintChips(chips, w, pick);
    paint(body, w, tips, pick);
    body.classList.remove('busy');
  }

  paintSeg();
  load();

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
    timer = setTimeout(() => load(true), 1500);
  });
  return () => {
    unsub();
    clearTimeout(timer);
    tips.destroy();
  };
}

/* ── Platform filter ───────────────────────────────────────────────────────── */

/**
 * One chip per platform the log has ever seen, in the order of all-time
 * listening, so the row does not reshuffle when the range changes. Hidden
 * when there is only one platform: nothing to pick between.
 */
function paintChips(row, w, pick) {
  const all = w.historyPlatforms || [];
  row.hidden = all.length < 2;
  if (row.hidden) return;
  const chip = (src, label) => el('button', {
    type: 'button',
    class: `chip${platform === src ? ' active' : ''}`,
    'aria-pressed': platform === src ? 'true' : 'false',
    onclick: () => pick(src),
  }, [
    src ? el('span', { class: 'chip-dot', style: `--c:${pfColor(src)}`, 'aria-hidden': 'true' }) : null,
    el('span', { text: label }),
  ]);
  const music = all.filter((p) => !p.stream);
  const live = all.filter((p) => p.stream);
  // The streams go on the line together with their label, never split from it.
  row.replaceChildren(...[
    chip('', 'All music'),
    ...music.map((p) => chip(p.source, pfName(p.source))),
    live.length ? el('span', { class: 'chip-group' }, [el('span', { class: 'chip-sep', text: 'Live' }), ...live.map((p) => chip(p.source, pfName(p.source)))]) : null,
  ].filter(Boolean));
}

/* ── The page ──────────────────────────────────────────────────────────────── */

/** Lay the whole answer out. Recently played fills itself in when its own call returns. */
function paint(body, w, tips, pick) {
  body.style.setProperty('--act-c', platform ? pfColor(platform) : 'var(--accent-hex)');
  const streams = !!w.streams;
  const has = w.totalTracks > 0;
  const where = platform ? ` on ${pfName(platform)}` : '';
  const showPlatforms = (w.historyPlatforms || []).length > 1;

  const recentCard = el('section', { class: 'card act-flex', 'aria-label': streams ? 'Recently watched' : 'Recently played' });
  paintRecent(recentCard, streams);

  if (!has) {
    body.replaceChildren(
      tilesRow(w),
      el('div', { class: 'act-row' }, [
        el('section', { class: 'card act-wide' }, [
          el('h2', { text: streams ? 'Watch time' : 'Listening time' }),
          el('div', { class: 'empty', text: `Nothing ${streams ? 'watched' : 'played'}${where} ${IN_RANGE[range] ?? 'in this range'}.` }),
        ]),
        showPlatforms ? platformsCard(w, tips, pick) : null,
      ]),
      el('div', { class: 'act-row' }, [recentCard]),
    );
    return;
  }

  const albums = !streams && w.topAlbums?.length ? albumsCard(w) : null;
  // replaceChildren() would write a missing card out as the word "null".
  body.replaceChildren(...[
    tilesRow(w),
    el('div', { class: 'act-row' }, [chartCard(w, tips), showPlatforms ? platformsCard(w, tips, pick) : null]),
    el('div', { class: 'act-row' }, [hoursCard(w, tips), highlightsCard(w)]),
    el('div', { class: 'act-row' }, streams
      ? [rankCard('Top channels', w.topChannels, channelRow, w), rankCard('Top categories', w.topCategories, categoryRow, w)]
      : [rankCard('Top artists', w.topArtists, artistRow, w), tracksCard(w)]),
    albums,
    el('div', { class: 'act-row' }, [discoveriesCard(w), recentCard]),
  ].filter(Boolean));
}

/* ── Tiles ─────────────────────────────────────────────────────────────────── */

function tile(value, label, foot) {
  return el('div', { class: 'tile' }, [
    el('div', { class: 'tile-value', text: value }),
    el('div', { class: 'tile-label', text: label }),
    foot ? el('div', { class: 'tile-foot' }, [foot]) : null,
  ]);
}

/**
 * "▲ 18% on the 7 days before". Up is not good and down is not bad here — it
 * is listening, not a score — so the line stays in text colours either way.
 * Nothing at all when there is no fair comparison (all time, or a log that
 * does not reach back far enough).
 */
function trendLine(cur, prev) {
  if (prev === null || prev === undefined || !BEFORE[range]) return null;
  if (!prev) return cur ? el('span', { text: `Nothing in ${BEFORE[range]}` }) : null;
  const pct = Math.max(cur > 0 ? -99 : -100, Math.round(((cur - prev) / prev) * 100));
  if (Math.abs(pct) < 1) return el('span', { text: `Same as ${BEFORE[range]}` });
  return el('span', {}, [
    el('b', { text: `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%` }),
    ` vs ${BEFORE[range]}`,
  ]);
}

/**
 * Under the total: the trend when there is one. Without one, when the log
 * starts — on all time, or when it is younger than the range, which the total
 * would otherwise seem to cover — or a monthly rate on a year that has no year
 * before it on record.
 */
function totalFoot(w) {
  const trend = trendLine(w.totalListenedMs, w.previous?.totalListenedMs);
  if (trend) return trend;
  const start = w.historyStart ? new Date(w.historyStart) : null;
  if (start && (range === 0 || (w.from && start > new Date(w.from)))) {
    return `Since ${fmtDay(start, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  if (range === 365) {
    const month = w.totalListenedMs / 12;
    return `About ${month >= 36_000_000 ? `${Math.round(month / 3_600_000)}h` : dur(month)} a month`;
  }
  return null;
}

function tilesRow(w) {
  const has = w.totalTracks > 0;
  const dash = '—';
  const daysFoot = has
    ? (range === 7 || range === 30 ? `${w.activeDays} of ${range} days` : plural(w.activeDays, 'active day'))
    : null;
  // How many are new when that can be said; otherwise who came first.
  const lead = w.streams ? w.topChannels?.[0] : w.topArtists?.[0];
  const newFoot = w.newArtists ? `${fmtCount(w.newArtists)} new` : lead ? `Top: ${lead.name}` : null;

  if (w.streams) {
    return el('div', { class: 'grid grid-3 act-tiles' }, [
      tile(has ? dur(w.totalListenedMs) : dash, 'Time watched', has ? totalFoot(w) : null),
      tile(has ? fmtCount(w.uniqueArtists) : dash, w.uniqueArtists === 1 ? 'Channel' : 'Channels', newFoot),
      tile(has ? fmtCount(w.sittings) : dash, w.sittings === 1 ? 'Sitting' : 'Sittings',
        has && w.longestSession ? `Longest ${dur(w.longestSession.ms)}` : null),
      tile(has ? dur(w.avgDailyMs) : dash, 'Daily average', daysFoot),
    ]);
  }
  return el('div', { class: 'grid grid-3 act-tiles' }, [
    tile(has ? dur(w.totalListenedMs) : dash, 'Time listened', has ? totalFoot(w) : null),
    tile(has ? fmtCount(w.totalTracks) : dash, 'Tracks played', has ? `${fmtCount(w.uniqueTracks)} different` : null),
    tile(has ? fmtCount(w.uniqueArtists) : dash, w.uniqueArtists === 1 ? 'Artist' : 'Artists', newFoot),
    tile(has ? dur(w.avgDailyMs) : dash, 'Daily average', daysFoot),
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

function addSplit(into, from) {
  for (const [src, ms] of Object.entries(from || {})) into[src] = (into[src] || 0) + ms;
  return into;
}

/** Days the chart draws one column each for: the range's, or all time's while the log is under a month old. */
function dailySpan(w) {
  if (range === 7 || range === 30) return range;
  if (range !== 0 || !w.byDay?.length) return 0;
  const days = Math.round((Date.now() - dayDate(w.byDay[0].day).getTime()) / 86_400_000) + 1;
  return days <= 31 ? Math.max(days, 7) : 0;
}

/**
 * The buckets to draw: one per day for a week or a month, one per month
 * beyond that. Days nothing was played on are zero rather than missing, so the
 * gaps read as gaps. All time starts where the log does — padded out to a
 * year, a log of three months was nine empty columns and three bars.
 */
function buckets(w) {
  const byDay = new Map((w.byDay || []).map((d) => [d.day, d]));
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  const span = dailySpan(w);
  if (span) {
    return Array.from({ length: span }, (_, i) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (span - 1 - i), 12);
      const hit = byDay.get(dayKey(d));
      return {
        ms: hit?.ms || 0,
        split: hit?.bySource || {},
        label: span <= 7
          ? fmtDay(d, { weekday: 'short' })
          : (i % 5 === 4 || i === span - 1 ? String(d.getDate()) : ''),
        tip: fmtDay(d, { weekday: 'long', month: 'short', day: 'numeric' }),
      };
    });
  }

  const months = new Map();
  for (const d of byDay.values()) {
    const k = d.day.slice(0, 7);
    const m = months.get(k) || { ms: 0, split: {} };
    m.ms += d.ms;
    addSplit(m.split, d.bySource);
    months.set(k, m);
  }
  let first = new Date(today.getFullYear(), today.getMonth() - 11, 1);
  if (range === 0 && w.byDay?.length) {
    const [y, m] = w.byDay[0].day.split('-').map(Number);
    first = new Date(y, m - 1, 1);
  }
  const out = [];
  for (let d = new Date(first); d <= today; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const hit = months.get(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    out.push({
      ms: hit?.ms || 0,
      split: hit?.split || {},
      label: fmtDay(d, { month: 'short' }),
      tip: fmtDay(d, { month: 'long', year: 'numeric' }),
    });
  }
  // Past two years a label per month no longer fits; keep every third.
  if (out.length > 24) out.forEach((b, i) => { if (i % 3) b.label = ''; });
  return out;
}

/** Tooltip rows: one per platform, keyed with a short stroke of its colour. */
function splitRows(split) {
  const rows = Object.entries(split || {}).filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]);
  if (rows.length < 2) return [];
  return rows.map(([src, ms]) => el('div', { class: 'tip-row' }, [
    el('span', { class: 'tip-key', style: `--c:${pfColor(src)}` }),
    el('span', { text: pfName(src) }),
    el('span', { class: 'tip-n', text: dur(ms) }),
  ]));
}

function chartCard(w, tips) {
  const perMonth = !dailySpan(w);
  const noun = w.streams ? 'Watch time' : 'Listening time';
  const bs = buckets(w);
  const max = Math.max(...bs.map((b) => b.ms), 1);
  const peak = bs.findIndex((b) => b.ms === max);
  const card = el('section', { class: 'card act-wide act-chart', 'aria-label': noun });

  // Hours when there are hours to show, minutes otherwise — "0.3 h" reads worse than "18 m".
  const unitMs = max >= 3_600_000 ? 3_600_000 : 60_000;
  const unit = unitMs === 3_600_000 ? 'h' : 'm';
  const top = niceCeil(max / unitMs);

  // Heights are shares of the plot rather than pixels: the chart grows with
  // its card, which the breakdown beside it can make tall.
  const plot = el('div', { class: 'chart-plot' }, bs.map((b, i) => {
    const h = `${((b.ms / unitMs / top) * 100).toFixed(2)}%`;
    const col = el('div', { class: `chart-col${i === peak ? ' peak' : ''}`, style: `--h:${h}` }, [
      // The tallest bar wears its value: the one number worth reading off
      // the chart without hovering. The rest are in the tooltip.
      i === peak ? el('span', { class: 'chart-peak', text: dur(b.ms) }) : null,
      el('div', { class: 'chart-bar' }),
    ]);
    return tips.set(col, () => [
      el('div', { class: 'tip-v', text: b.ms ? dur(b.ms) : 'Nothing' }),
      el('div', { class: 'tip-l', text: b.tip }),
      ...(platform ? [] : splitRows(b.split)),
    ]);
  }));

  const tick = (v) => {
    const y = `--y:${(1 - v / top).toFixed(4)}`;
    return [
      el('div', { class: 'chart-grid', style: y }),
      el('div', { class: 'chart-tick', style: y, text: `${v}${unit}` }),
    ];
  };

  card.append(
    el('div', { class: 'card-head', style: 'margin-bottom:0' }, [el('h2', { text: `${noun} per ${perMonth ? 'month' : 'day'}` })]),
    el('div', { class: 'chart', role: 'img', 'aria-label': `${perMonth ? 'Monthly' : 'Daily'} ${noun.toLowerCase()}, peak ${dur(max)}` }, [
      ...tick(top / 2),
      ...tick(top),
      plot,
      el('div', { class: 'chart-x', 'aria-hidden': 'true' }, bs.map((b) => el('span', { text: b.label }))),
    ]),
  );
  return card;
}

/* ── By platform ───────────────────────────────────────────────────────────── */

/** A share as a whole percentage; a sliver is "<1%", never a "0%" beside time that was played. */
const shareOf = (part, whole) => (part / whole < 0.005 ? '<1%' : `${Math.round((part / whole) * 100)}%`);

/** "▲ 12%", "new", or nothing when there is no fair comparison. */
function platformTrend(p) {
  if (p.prevMs === null || p.prevMs === undefined) return '';
  if (!p.prevMs) return 'new';
  // Rounded, a fall to a few seconds read "▼ 100%" beside time still played.
  const pct = Math.max(-99, Math.round(((p.ms - p.prevMs) / p.prevMs) * 100));
  if (Math.abs(pct) < 1) return '=';
  return `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%`;
}

/**
 * Where the time went. A thin bar splits the music time at a glance; the rows
 * under it carry the names and figures, each with its colour as the legend.
 * Streams get rows of their own: they are not part of the music total, so a
 * share of it would mean nothing. A row is also a way in: it picks that
 * platform, as its chip does.
 */
function platformsCard(w, tips, pick) {
  const all = w.platforms || [];
  const music = all.filter((p) => !p.stream);
  const live = all.filter((p) => p.stream);
  const musicMs = music.reduce((s, p) => s + p.ms, 0);
  const card = el('section', { class: 'card act-side', 'aria-label': 'By platform' });
  card.append(
    el('h2', { text: 'By platform' }),
    el('div', { class: 'pf-caption', text: all.some((p) => p.prevMs !== null && p.prevMs !== undefined) ? `Share of the music time, and the change vs ${BEFORE[range]}` : 'Share of the music time' }),
  );

  if (!all.length) {
    card.append(el('div', { class: 'empty', text: 'Nothing in this range.' }));
    return card;
  }

  const row = (p, share) => el('button', {
    type: 'button',
    class: `pf-row${platform === p.source ? ' on' : ''}`,
    'aria-pressed': platform === p.source ? 'true' : 'false',
    title: platform === p.source ? 'Showing only this platform' : `Show only ${pfName(p.source)}`,
    onclick: () => pick(platform === p.source ? '' : p.source),
  }, [
    el('span', { class: 'pf-dot', style: `--c:${pfColor(p.source)}`, 'aria-hidden': 'true' }),
    el('span', { class: 'pf-name', text: pfName(p.source) }),
    el('span', { class: 'pf-time', text: dur(p.ms) }),
    el('span', { class: 'pf-share', text: share }),
    el('span', { class: 'pf-trend', text: platformTrend(p) }),
  ]);

  if (music.length) {
    const bar = el('div', { class: 'pf-bar', role: 'img', 'aria-label': music.map((p) => `${pfName(p.source)} ${shareOf(p.ms, musicMs)}`).join(', ') },
      music.map((p) => tips.set(el('span', { style: `--c:${pfColor(p.source)};flex-grow:${p.ms}` }), () => [
        el('div', { class: 'tip-v', text: shareOf(p.ms, musicMs) }),
        el('div', { class: 'tip-l', text: `${pfName(p.source)} · ${dur(p.ms)}` }),
      ])));
    card.append(bar, el('div', { class: 'pf-list' }, music.map((p) => row(p, shareOf(p.ms, musicMs)))));
  }
  if (live.length) {
    card.append(
      el('div', { class: 'pf-group', text: 'Live streams · not in the music totals' }),
      el('div', { class: 'pf-list' }, live.map((p) => row(p, ''))),
    );
  }
  return card;
}

/* ── When you listen ───────────────────────────────────────────────────────── */

const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i)); // 1 Jan 2024 was a Monday
const PARTS = [['Night', 0, 6], ['Morning', 6, 12], ['Afternoon', 12, 18], ['Evening', 18, 24]];

/** The hour of the day and the weekday with the most time, from the weekday × hour grid. */
function peaks(byHour) {
  const hours = Array.from({ length: 24 }, (_, h) => WEEKDAYS.reduce((s, _d, wd) => s + (byHour[wd * 24 + h] || 0), 0));
  const days = WEEKDAYS.map((_d, wd) => byHour.slice(wd * 24, wd * 24 + 24).reduce((s, v) => s + v, 0));
  const total = hours.reduce((s, v) => s + v, 0);
  const hour = hours.indexOf(Math.max(...hours));
  const day = days.indexOf(Math.max(...days));
  const parts = PARTS.map(([name, a, b]) => ({ name, span: `${fmtHour(a)} to ${fmtHour(b % 24)}`, ms: hours.slice(a, b).reduce((s, v) => s + v, 0) }));
  const part = parts.reduce((m, p) => (p.ms > m.ms ? p : m), parts[0]);
  return { hours, total, hour, day, part };
}

/**
 * A week folded onto itself: one row per weekday, one cell per hour, darker
 * where more time went. One hue, four steps and empty, square-root spaced so
 * a single long evening does not leave every other cell at the faintest step.
 */
function hoursCard(w, tips) {
  const byHour = w.byHour || [];
  const max = Math.max(...byHour, 0);
  const { total, hour, day, part } = peaks(byHour);
  const verb = w.streams ? 'watch' : 'listen';
  const level = (v) => (v > 0 && max ? Math.max(1, Math.ceil(4 * Math.sqrt(v / max))) : 0);

  const grid = el('div', {
    class: 'heat',
    role: 'img',
    'aria-label': total ? `Most of it on ${fmtDay(WEEKDAYS[day], { weekday: 'long' })}s, peak hour ${fmtHour(hour)}` : 'Nothing yet',
  });
  grid.append(el('span'), ...Array.from({ length: 8 }, (_, i) => el('span', { class: 'heat-hour', text: fmtHour(i * 3, true) })));
  WEEKDAYS.forEach((d, wd) => {
    grid.append(el('span', { class: 'heat-day', text: fmtDay(d, { weekday: 'short' }) }));
    for (let h = 0; h < 24; h++) {
      const v = byHour[wd * 24 + h] || 0;
      grid.append(tips.set(el('span', { class: 'heat-cell', 'data-l': String(level(v)) }), () => [
        el('div', { class: 'tip-v', text: v ? dur(v) : 'Nothing' }),
        el('div', { class: 'tip-l', text: `${fmtDay(d, { weekday: 'long' })}s, ${fmtHour(h)} – ${fmtHour((h + 1) % 24)}` }),
      ]));
    }
  });

  return el('section', { class: 'card act-wide', 'aria-label': `When you ${verb}` }, [
    el('div', { class: 'card-head', style: 'margin-bottom:12px' }, [
      el('h2', { text: `When you ${verb}` }),
      total ? el('span', { class: 'muted', text: `Mostly ${fmtDay(WEEKDAYS[day], { weekday: 'long' })}s · ${part.name.toLowerCase()}s` }) : null,
    ]),
    grid,
    el('div', { class: 'heat-foot' }, [
      el('span', { class: 'muted', text: range === 7 ? 'Each cell is one hour of one day.' : 'All the weeks in this range, added up.' }),
      el('span', { class: 'heat-legend', 'aria-hidden': 'true' }, [
        el('span', { text: 'Less' }),
        ...[0, 1, 2, 3, 4].map((l) => el('span', { class: 'heat-cell', 'data-l': String(l) })),
        el('span', { text: 'More' }),
      ]),
    ]),
  ]);
}

/* ── Highlights ────────────────────────────────────────────────────────────── */

function hlRow(label, value, sub) {
  return el('div', { class: 'hl-fact' }, [
    el('div', { class: 'hl-label', text: label }),
    el('div', { class: 'hl-val', text: value }),
    sub ? el('div', { class: 'hl-sub', text: sub }) : null,
  ]);
}

/** The facts a chart does not show: records, streaks, the shape of a day. */
function highlightsCard(w) {
  const { total, hour, hours, part } = peaks(w.byHour || []);
  const rows = [];
  if (w.busiestDay) {
    rows.push(hlRow('Busiest day', dur(w.busiestDay.ms), fmtDay(dayDate(w.busiestDay.day), { weekday: 'short', month: 'short', day: 'numeric' })));
  }
  if (w.longestSession) {
    const s = w.longestSession;
    rows.push(hlRow(w.streams ? 'Longest sitting' : 'Longest session', dur(s.ms),
      w.streams ? fmtDate(s.startedAt) : `${plural(s.plays, 'track')}, ${fmtDate(s.startedAt)}`));
  }
  if (w.longestStreak && w.longestStreak.days > 1) {
    const st = w.longestStreak;
    rows.push(hlRow('Longest streak', plural(st.days, 'day'), `${shortDay(st.from)} – ${shortDay(st.to)}`));
  }
  if (w.currentStreak > 1) rows.push(hlRow('Current streak', plural(w.currentStreak, 'day'), 'Every day up to today'));
  if (total) {
    rows.push(hlRow('Peak hour', fmtHour(hour), `${Math.round((hours[hour] / total) * 100)}% of the time`));
    rows.push(hlRow('Time of day', part.name, `${Math.round((part.ms / total) * 100)}%, ${part.span}`));
  }
  if (w.streams) {
    if (w.topCategories?.[0]) rows.push(hlRow('Top category', w.topCategories[0].name, dur(w.topCategories[0].totalMs)));
  } else if (w.totalTracks) {
    rows.push(hlRow('Average play', fmtTime(w.totalListenedMs / w.totalTracks), `Over ${fmtCount(w.totalTracks)} ${w.totalTracks === 1 ? 'play' : 'plays'}`));
  }
  return el('section', { class: 'card act-side', 'aria-label': 'Highlights' }, [
    el('h2', { text: 'Highlights', style: 'margin-bottom:14px' }),
    rows.length ? el('div', { class: 'hl' }, rows) : el('div', { class: 'empty', text: 'Nothing yet.' }),
  ]);
}

/* ── Top lists ─────────────────────────────────────────────────────────────── */

const SHOWN = 8;

function rankLine(i, art, round, name, sub, value, frac) {
  return el('div', { class: 'rank-row' }, [
    el('span', { class: 'rank-n', text: String(i + 1) }),
    art === null
      ? el('span', { class: 'rank-art rank-glyph', 'aria-hidden': 'true', text: name.slice(0, 1).toUpperCase() })
      : el('img', { class: `rank-art${round ? ' round' : ''}`, src: artUrl(art) || BLANK_ART, alt: '' }),
    el('div', { class: 'rank-main' }, [
      el('div', { class: 'rank-top' }, [
        el('span', { class: 'rank-name', text: name }),
        el('span', { class: 'rank-val', text: value }),
      ]),
      sub ? el('div', { class: 'rank-sub', text: sub }) : null,
      el('div', { class: 'rank-meter', 'aria-hidden': 'true' }, [el('div', { style: `width:${Math.max(2, Math.round(frac * 100))}%` })]),
    ]),
  ]);
}

const artistRow = (a, i, max) => rankLine(i, a.art, true, a.name, null, `${dur(a.totalMs)} · ${plural(a.plays, 'play')}`, a.totalMs / max);
const channelRow = (c, i, max) => rankLine(i, c.art, true, c.name, null, `${dur(c.totalMs)} · ${plural(c.sittings, 'sitting')}`, c.totalMs / max);
const categoryRow = (c, i, max) => rankLine(i, null, false, c.name, null, dur(c.totalMs), c.totalMs / max);

/** A ranked list with a bar per row, the first eight here and up to fifty behind "See all". */
function rankCard(title, list, rowFn, w) {
  const items = list || [];
  const max = items[0]?.totalMs || 1;
  return el('section', { class: 'card act-half', 'aria-label': title }, [
    el('div', { class: 'card-head', style: 'margin-bottom:6px' }, [
      el('h2', { text: title }),
      items.length > SHOWN ? el('button', { type: 'button', class: 'btn btn-sm', text: 'See all', onclick: () => openTop(title, items, rowFn, max) }) : null,
    ]),
    items.length
      ? el('div', {}, items.slice(0, SHOWN).map((x, i) => rowFn(x, i, max)))
      : el('div', { class: 'empty', text: w.streams ? 'No categories yet.' : 'Nobody yet.' }),
  ]);
}

function trackRow(t, i, several) {
  return el('div', { class: 'item' }, [
    el('div', { class: 'item-rank', text: String(i + 1) }),
    el('img', { class: 'item-art', src: artUrl(t.art) || BLANK_ART, alt: '' }),
    el('div', { class: 'item-body' }, [
      el('div', { class: 'item-title', text: t.name }),
      // The platform is only news when there is more than one in the list.
      el('div', { class: 'item-sub', text: several ? `${t.artist} · ${pfName(t.source)}` : t.artist }),
    ]),
    el('div', { class: 'item-meta', text: `${t.plays}× · ${dur(t.totalMs)}` }),
  ]);
}

function tracksCard(w) {
  const list = w.topTracks || [];
  const several = !platform && new Set(list.map((t) => t.source)).size > 1;
  return el('section', { class: 'card act-half act-list', 'aria-label': 'Top tracks' }, [
    el('div', { class: 'card-head', style: 'margin:0 10px 6px' }, [
      el('h2', { text: 'Top tracks' }),
      list.length > SHOWN
        ? el('button', { type: 'button', class: 'btn btn-sm', text: 'See all', onclick: () => openTop('Top tracks', list, (t, i) => trackRow(t, i, several)) })
        : null,
    ]),
    list.length
      ? el('div', { class: 'list' }, list.slice(0, SHOWN).map((t, i) => trackRow(t, i, several)))
      : el('div', { class: 'empty', text: 'Nothing yet.' }),
  ]);
}

/** The albums, cover first: the one place on the page that looks like the music. */
function albumsCard(w) {
  return el('section', { class: 'card act-albums', 'aria-label': 'Top albums' }, [
    el('div', { class: 'card-head', style: 'margin-bottom:12px' }, [
      el('h2', { text: 'Top albums' }),
      w.topAlbums.length > 6
        ? el('button', {
            type: 'button', class: 'btn btn-sm', text: 'See all',
            onclick: () => openTop('Top albums', w.topAlbums, (a, i, max) => rankLine(i, a.art, false, a.name, a.artist, dur(a.totalMs), a.totalMs / max), w.topAlbums[0].totalMs),
          })
        : null,
    ]),
    el('div', { class: 'albums' }, w.topAlbums.slice(0, 6).map((a) => el('div', { class: 'album' }, [
      el('img', { class: 'album-art', src: artUrl(a.art) || BLANK_ART, alt: '' }),
      el('div', { class: 'album-name', text: a.name, title: a.name }),
      el('div', { class: 'album-sub', text: `${a.artist} · ${dur(a.totalMs)}` }),
    ]))),
  ]);
}

/** A top list in full, up to fifty, for the range and platform on screen. */
function openTop(title, items, rowFn, max = items[0]?.totalMs || 1) {
  const scope = [RANGES.find(([d]) => d === range)?.[1], platform ? pfName(platform) : ''].filter(Boolean).join(' · ');
  modal((close) => el('div', {}, [
    el('div', { class: 'card-head', style: 'margin-bottom:0' }, [el('h2', { text: title }), el('span', { class: 'muted', text: scope })]),
    el('div', { class: 'act-modal-list' }, items.map((x, i) => rowFn(x, i, max))),
    el('div', { style: 'display:flex;justify-content:flex-end;margin-top:14px' }, [
      el('button', { type: 'button', class: 'btn', text: 'Close', onclick: () => close() }),
    ]),
  ]));
}

/* ── New this range ────────────────────────────────────────────────────────── */

/**
 * Artists (channels) heard for the first time in this range. Absent when the
 * log is too young for "first time" to mean anything, and on all time.
 */
function discoveriesCard(w) {
  // Nothing new is said by the Artists tile; a card saying it would be a box of nothing.
  if (!w.newArtists) return null;
  const noun = w.streams ? 'channel' : 'artist';
  const title = w.streams ? 'New channels' : platform ? `New on ${pfName(platform)}` : 'New to you';
  const list = w.discoveries || [];
  return el('section', { class: 'card act-flex', 'aria-label': title }, [
    el('div', { class: 'card-head', style: 'margin-bottom:6px' }, [
      el('h2', { text: title }),
      el('span', { class: 'muted', text: plural(w.newArtists, `new ${noun}`) }),
    ]),
    el('div', {}, list.slice(0, 6).map((d) => el('div', { class: 'rank-row' }, [
          el('img', { class: 'rank-art round', src: artUrl(d.art) || BLANK_ART, alt: '' }),
          el('div', { class: 'rank-main' }, [
            el('div', { class: 'rank-top' }, [
              el('span', { class: 'rank-name', text: d.name }),
              el('span', { class: 'rank-val', text: dur(d.totalMs) }),
            ]),
            el('div', { class: 'rank-sub', text: `First ${w.streams ? 'watched' : 'played'} ${fmtDay(new Date(d.firstAt), { month: 'short', day: 'numeric' })}` }),
          ]),
        ]))),
  ]);
}

/* ── The log ───────────────────────────────────────────────────────────────── */

/** What the log is narrowed to: the picked platform, or all music. */
const logFilter = () => platform || 'music';

function logRow(e) {
  const src = artUrl(e.art);
  return el('div', { class: 'item' }, [
    el('img', { class: 'item-art', src: src || BLANK_ART, alt: '' }),
    el('div', { class: 'item-body' }, [
      el('div', { class: 'item-title', text: e.track }),
      el('div', { class: 'item-sub', text: `${e.artist}${e.album ? ` · ${e.album}` : ''} · ${pfName(e.source)}` }),
    ]),
    el('div', { class: 'item-meta', title: `Listened ${dur(e.listenedMs)}`, text: fmtDate(e.startedAt) }),
  ]);
}

/** The last few plays on what the page shows. Returns `reload`, which refills the list in place. */
function paintRecent(card, streams) {
  const list = el('div', { class: 'list' }, [el('div', { class: 'empty', text: 'Loading…' })]);
  card.classList.add('act-list');
  card.replaceChildren(
    el('div', { class: 'card-head', style: 'margin:0 10px 6px' }, [
      el('h2', { text: streams ? 'Recently watched' : 'Recently played' }),
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
      const res = await api.getHistory(6, 0, undefined, logFilter());
      if (mine !== token) return;
      const entries = res?.entries || [];
      list.replaceChildren(...(entries.length
        ? entries.map(logRow)
        : [el('div', { class: 'empty', text: streams ? 'Nothing watched yet.' : 'Nothing listened to yet.' })]));
    } catch (e) {
      if (mine !== token) return;
      list.replaceChildren(el('div', { class: 'empty', text: `Could not load history: ${e.message}` }));
    }
  }
  void reload();
  return { reload };
}

/** Every play the app has seen on what the page shows, newest first, a page at a time. */
function openLog() {
  const filter = logFilter();
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
      const res = await api.getHistory(PAGE_SIZE, offset, anchor, filter);
      const entries = res?.entries || [];
      anchor = res?.anchor ?? anchor;
      total = res?.total ?? total;
      offset += entries.length;
      if (!entries.length && offset === 0) {
        list.replaceChildren(el('div', { class: 'empty', text: 'Nothing here yet.' }));
      } else {
        list.append(...entries.map(logRow));
      }
      counter.textContent = total ? `${fmtCount(offset)} of ${fmtCount(total)}` : '';
      more.hidden = offset >= total;
    } catch (e) {
      toast(`Could not load history: ${e.message}`, 'err');
    } finally {
      more.disabled = false;
      more.textContent = 'Load more';
    }
  }

  modal((close) => el('div', {}, [
    el('div', { class: 'card-head', style: 'margin-bottom:0' }, [
      el('h2', { text: filter === 'music' ? 'Listening history' : `${pfName(filter)} history` }),
      counter,
    ]),
    list,
    el('div', { style: 'display:flex;justify-content:space-between;gap:8px;margin-top:14px' }, [
      more,
      el('button', { type: 'button', class: 'btn', text: 'Close', onclick: () => close() }),
    ]),
  ]));
  load();
}

/* ── Tooltips ──────────────────────────────────────────────────────────────── */

/**
 * One tooltip for the whole page, on the bars, the platform split and the
 * hour cells. `set(node, build)` marks a node and says how to fill the tip;
 * the content is built on hover, so a page of 168 cells builds nothing up
 * front. The tip lives on <body> with fixed positioning: inside a card it
 * would be clipped at the card's edge for the first and last bars.
 */
function hoverTips() {
  const tip = el('div', { class: 'act-tip', role: 'tooltip', hidden: true });
  const builders = new WeakMap();
  document.body.append(tip);
  let current = null;

  function show(node) {
    const build = builders.get(node);
    if (!build) return;
    current = node;
    tip.replaceChildren(...build());
    tip.hidden = false;
    const r = node.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const x = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8);
    const above = r.top - t.height - 8;
    const y = above >= 8 ? above : r.bottom + 8;
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
  function hide() {
    current = null;
    tip.hidden = true;
  }
  const over = (e) => {
    const node = e.target.closest?.('[data-tip]');
    if (node && node !== current) show(node);
    else if (!node && current) hide();
  };
  const content = document.getElementById('content');
  document.addEventListener('pointerover', over);
  content?.addEventListener('scroll', hide, { passive: true });

  return {
    set(node, build) {
      node.dataset.tip = '';
      builders.set(node, build);
      return node;
    },
    hide,
    destroy() {
      document.removeEventListener('pointerover', over);
      content?.removeEventListener('scroll', hide);
      tip.remove();
    },
  };
}
