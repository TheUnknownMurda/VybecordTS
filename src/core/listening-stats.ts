/**
 * The numbers behind the Activity page, crunched from the listening history.
 *
 * Kept apart from listening-history.ts, which owns the log on disk: this file
 * reads and writes nothing and takes the clock as an argument, so the whole
 * page can be computed from a sample log outside Electron — which is how the
 * page is previewed without Windows.
 *
 * Everything is worked out in one pass over the log per call. At the log's
 * ceiling (10,000 plays) that is a few milliseconds, cheaper than keeping
 * running totals in step with plays that are written late, merged on resume
 * and evicted from the front.
 */

import type { HistoryEntry } from './listening-history.js';

const DAY_MS = 86_400_000;

/**
 * Sources that are not music.
 *
 * A Twitch or Kick stream has no track identity — its "title" is the channel,
 * its "artist" the stream's banner — and one sitting runs for hours, so a
 * single afternoon outweighs a year of songs in every aggregate. They stay in
 * the log, which promises everything the app saw, and out of the music
 * totals; picked on their own, they get channels and categories instead.
 */
export const STREAM_SOURCES: ReadonlySet<string> = new Set(['twitch', 'kick']);

/** True for an entry that is a live stream rather than a track. Older entries have no `kind`. */
export function isStreamEntry(e: Pick<HistoryEntry, 'kind' | 'source'>): boolean {
  return e.kind === 'stream' || STREAM_SOURCES.has(e.source);
}

/**
 * A longer gap than this between two plays ends a session (for a stream, a
 * sitting). Ten minutes covers a skipped ad, a paused song while the kettle
 * boils, a stream that drops and comes back; it does not join lunch to dinner.
 */
const SESSION_GAP_MS = 10 * 60_000;

/**
 * How far the history must reach back before a range for "new" to mean new.
 * In the first days of the log every artist is one never heard before, and a
 * page saying "48 new artists" on day two would be counting the app's age.
 */
const BASELINE_MS = 7 * DAY_MS;

const TOP_N = 50;
const DISCOVERIES_N = 12;

/**
 * The most one play can count for: the ceiling listening-history.ts puts on a
 * play with no known length (MAX_UNKNOWN_LISTEN_MS). Rows written before that
 * ceiling existed can run far past it — a real log holds a 16-hour "Polaris"
 * from a night the app never saw the song stop — and one of them made its
 * artist the most listened of all time. Read through the same ceiling, an old
 * row counts no more than a new one could.
 */
const MAX_PLAY_MS = 4 * 60 * 60_000;

/**
 * Names the sources write when they have none. Kept out of the artist lists
 * and counts — "Unknown" is not anybody's most played artist — but the time
 * still counts toward the totals and the platform.
 */
const PLACEHOLDER_ARTISTS = new Set(['', 'unknown']);

export interface TopTrack { name: string; artist: string; art: string; totalMs: number; plays: number; /** The platform it was played on most. */ source: string }
export interface TopArtist { name: string; /** The cover of their most played track: there is no artist picture in the log. */ art: string; totalMs: number; plays: number; tracks: number }
export interface TopAlbum { name: string; artist: string; art: string; totalMs: number; plays: number }
export interface TopChannel { name: string; art: string; source: string; totalMs: number; sittings: number }
export interface TopCategory { name: string; totalMs: number; sittings: number }
export interface Discovery { name: string; art: string; totalMs: number; plays: number; firstAt: string }
export interface PlatformShare {
  source: string;
  stream: boolean;
  ms: number;
  plays: number;
  /** The same span just before this range; null when there is no comparison (see `previous`). */
  prevMs: number | null;
}
export interface DayTotal { day: string; ms: number; /** Split by platform, for the chart's tooltip. */ bySource: Record<string, number> }
export interface Session { ms: number; startedAt: string; endedAt: string; plays: number }

export interface WrappedStats {
  /** The range asked for, 0 for all time. */
  days: number;
  /** The platform asked for; '' is every music platform together. */
  source: string;
  /** True when `source` is a live-stream platform: the lists are channels and categories. */
  streams: boolean;
  /** Where the range starts (ISO); null for all time. */
  from: string | null;
  /** The oldest play in the log, or null when it is empty. */
  historyStart: string | null;
  /** Every platform in the whole log, most time first: the page's filter, the same whatever the range. */
  historyPlatforms: { source: string; stream: boolean }[];
  /** Every platform in the range, music and streams, whatever `source` is: the breakdown. */
  platforms: PlatformShare[];

  totalListenedMs: number;
  /** Plays. For streams, rows in the log — see `sittings` for the number a person would give. */
  totalTracks: number;
  uniqueTracks: number;
  /** Different artists; for streams, different channels. */
  uniqueArtists: number;
  /** Streams only: unbroken stretches on one channel. */
  sittings: number;
  activeDays: number;
  avgDailyMs: number;
  /** Time per local day (YYYY-MM-DD), oldest first; days with nothing are absent. */
  byDay: DayTotal[];
  /** Time per weekday and clock hour, Monday first: index weekday * 24 + hour. */
  byHour: number[];
  topTracks: TopTrack[];
  topArtists: TopArtist[];
  topAlbums: TopAlbum[];
  topChannels: TopChannel[];
  topCategories: TopCategory[];
  /** Artists (for streams, channels) first heard in this range; null when the log is too young to say. */
  newArtists: number | null;
  discoveries: Discovery[];
  /** The same span just before this one, for the trend; null for all time, or when the log does not reach back that far. */
  previous: { totalListenedMs: number; totalTracks: number; uniqueArtists: number; activeDays: number } | null;
  longestSession: Session | null;
  busiestDay: { day: string; ms: number } | null;
  longestStreak: { days: number; from: string; to: string } | null;
  /** Days in a row, up to today, with something played. Today not over yet does not break it. */
  currentStreak: number;
}

export interface StatsQuery {
  days?: number;
  source?: string;
  /** Epoch ms; the system clock when omitted. */
  now?: number;
}

/** YYYY-MM-DD in the calendar the user actually lives in, not UTC. */
function localDay(d: Date): string {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? '0' : ''}${m}-${day < 10 ? '0' : ''}${day}`;
}

/**
 * Where a range starts, on the same calendar the chart draws: "7 days" is
 * today and the six before it, "12 months" this month and the eleven before.
 * A rolling 7 × 24 hours counted part of a day the chart had no column for,
 * so the bars never added up to the total above them.
 */
function rangeStart(days: number, now: number): number {
  if (days <= 0) return 0;
  const d = new Date(now);
  if (days === 365) return new Date(d.getFullYear(), d.getMonth() - 11, 1).getTime();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime();
}

/** The same wall-clock moment one range earlier (by the calendar, so a DST change does not shift it). */
function shiftBack(t: number, days: number): number {
  const d = new Date(t);
  const months = days === 365 ? 12 : 0;
  const back = days === 365 ? 0 : days;
  return new Date(d.getFullYear(), d.getMonth() - months, d.getDate() - back,
    d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime();
}

/**
 * Hand `fn` each local clock hour a play touches, with the part of it that
 * falls there. A song sits in one hour; a four-hour stream started at 22:00
 * belongs to two days and five hours, not all to 22:00 on the first.
 */
function eachHour(start: number, ms: number, fn: (d: Date, part: number) => void): void {
  const end = start + ms;
  let t = start;
  while (t < end) {
    const d = new Date(t);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
    // `next` can fail to move forward across a DST change; an hour on is always safe.
    const stop = Math.min(end, next > t ? next : t + 3_600_000);
    fn(d, stop - t);
    t = stop;
  }
}

/**
 * A cover the window can show. The log also holds '/api/thumbnail', the
 * placeholder for art the OS handed over as bytes, which only ever meant the
 * track playing at that moment; kept as a list's picture it drew a blank
 * where another play of the same track had a real cover.
 */
function coverOf(art: string): string {
  return /^https?:\/\//.test(art) ? art : '';
}

function primaryArtist(artist: string): string {
  return artist.split(',')[0].trim();
}

/** A stream's channel: the title line is "📺 Channel". */
function channelOf(e: HistoryEntry): string {
  return e.track.replace(/^📺\s*/u, '').trim();
}

/** A stream's category: the album line is "🎮 Category", with " · Past broadcast" after it on a video. */
function categoryOf(e: HistoryEntry): string {
  return e.album.replace(/^🎮\s*/u, '').split(' · ')[0].trim();
}

/** A row of the log in range, with its start parsed and its time read through the ceiling. */
interface Play { t: number; ms: number; e: HistoryEntry }

/**
 * Plays strung together: a new run starts when one begins more than the gap
 * after everything before it has ended. Works on any list sorted by start.
 */
function* runs(sorted: readonly Play[]): Generator<{ start: number; end: number; ms: number; plays: number }> {
  let cur: { start: number; end: number; ms: number; plays: number } | null = null;
  for (const { t, ms } of sorted) {
    if (cur && t - cur.end <= SESSION_GAP_MS) {
      cur.end = Math.max(cur.end, t + ms);
      cur.ms += ms;
      cur.plays++;
      continue;
    }
    if (cur) yield cur;
    cur = { start: t, end: t + ms, ms, plays: 1 };
  }
  if (cur) yield cur;
}

function byMsDesc<T extends { totalMs: number }>(a: T, b: T): number {
  return b.totalMs - a.totalMs;
}

export function computeStats(log: readonly HistoryEntry[], q: StatsQuery = {}): WrappedStats {
  const now = q.now ?? Date.now();
  const days = q.days && q.days > 0 ? Math.floor(q.days) : 0;
  const source = q.source || '';
  const streams = STREAM_SOURCES.has(source);
  const from = rangeStart(days, now);
  const prevFrom = days ? shiftBack(from, days) : 0;
  const prevTo = days ? shiftBack(now, days) : 0;

  // Which plays this view is about, at any date: one platform, or all music.
  const inScope = (e: HistoryEntry) => (source ? e.source === source : !isStreamEntry(e));

  let historyStart = Infinity;
  const everPlatforms = new Map<string, number>();
  const platforms = new Map<string, { ms: number; plays: number; prevMs: number }>();
  const cur: Play[] = [];
  const scopeDays = new Set<string>();
  /** First play ever per artist (channel) key, for "new". */
  const firstSeen = new Map<string, number>();
  const prevArtists = new Set<string>();
  const prevDays = new Set<string>();
  let prevMs = 0;
  let prevPlays = 0;

  const artistKeyOf = (e: HistoryEntry) => (streams ? channelOf(e) : primaryArtist(e.artist)).toLowerCase();

  for (const e of log) {
    const t = Date.parse(e.startedAt);
    if (!Number.isFinite(t)) continue;
    const ms = Math.min(e.listenedMs, MAX_PLAY_MS);
    if (t < historyStart) historyStart = t;
    everPlatforms.set(e.source, (everPlatforms.get(e.source) ?? 0) + ms);

    const inRange = t >= from;
    const inPrev = days > 0 && t >= prevFrom && t < prevTo;
    if (inRange || inPrev) {
      let p = platforms.get(e.source);
      if (!p) platforms.set(e.source, p = { ms: 0, plays: 0, prevMs: 0 });
      if (inRange) { p.ms += ms; p.plays++; }
      else p.prevMs += ms;
    }

    if (!inScope(e)) continue;
    scopeDays.add(localDay(new Date(t)));
    const aKey = artistKeyOf(e);
    if (!PLACEHOLDER_ARTISTS.has(aKey)) {
      const seen = firstSeen.get(aKey);
      if (seen === undefined || t < seen) firstSeen.set(aKey, t);
    }
    if (inRange) cur.push({ t, ms, e });
    else if (inPrev) {
      prevMs += ms;
      prevPlays++;
      prevDays.add(localDay(new Date(t)));
      if (!PLACEHOLDER_ARTISTS.has(aKey)) prevArtists.add(aKey);
    }
  }

  const hasHistory = Number.isFinite(historyStart);
  // A comparison is only fair when the log covers the whole span before:
  // half a week on record is not "down 50% on last week".
  const comparable = days > 0 && hasHistory && historyStart <= prevFrom;
  const canSayNew = days > 0 && hasHistory && historyStart <= from - BASELINE_MS;

  cur.sort((a, b) => a.t - b.t);

  // ── Totals, days and hours ──
  let total = 0;
  const dayMap = new Map<string, DayTotal>();
  const byHour = new Array<number>(168).fill(0);
  for (const { t, ms, e } of cur) {
    total += ms;
    eachHour(t, ms, (d, part) => {
      const key = localDay(d);
      let day = dayMap.get(key);
      if (!day) dayMap.set(key, day = { day: key, ms: 0, bySource: {} });
      day.ms += part;
      day.bySource[e.source] = (day.bySource[e.source] ?? 0) + part;
      byHour[((d.getDay() + 6) % 7) * 24 + d.getHours()] += part;
    });
  }
  // The keys are zero-padded, so a string sort is a date sort.
  const byDay = [...dayMap.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  const activeDays = byDay.length;

  // ── Lists ──
  type TrackAcc = TopTrack & { aKey: string; bySrc: Map<string, number> };
  type ArtistAcc = TopArtist & { bestMs: number; trackKeys: Set<string> };
  const trackMap = new Map<string, TrackAcc>();
  const artistMap = new Map<string, ArtistAcc>();
  const albumMap = new Map<string, TopAlbum>();
  const channelMap = new Map<string, TopChannel & { lastEnd: number }>();
  const categoryMap = new Map<string, TopCategory & { lastEnd: number }>();
  let sittings = 0;

  for (const { t, ms, e } of cur) {
    if (streams) {
      const name = channelOf(e);
      const key = name.toLowerCase();
      let c = channelMap.get(key);
      if (!c) channelMap.set(key, c = { name, art: '', source: e.source, totalMs: 0, sittings: 0, lastEnd: -Infinity });
      c.totalMs += ms;
      if (coverOf(e.art)) c.art = e.art;
      // The same channel again within the gap is the same sitting: a stream
      // that dropped and came back, or the app restarting under it.
      if (t - c.lastEnd > SESSION_GAP_MS) { c.sittings++; sittings++; }
      c.lastEnd = Math.max(c.lastEnd, t + ms);

      const cat = categoryOf(e);
      if (cat) {
        const ck = cat.toLowerCase();
        let g = categoryMap.get(ck);
        if (!g) categoryMap.set(ck, g = { name: cat, totalMs: 0, sittings: 0, lastEnd: -Infinity });
        g.totalMs += ms;
        if (t - g.lastEnd > SESSION_GAP_MS) g.sittings++;
        g.lastEnd = Math.max(g.lastEnd, t + ms);
      }
      continue;
    }

    const artist = primaryArtist(e.artist);
    const aKey = artist.toLowerCase();
    const tKey = `${e.track.toLowerCase()}|${aKey}`;
    let tr = trackMap.get(tKey);
    if (!tr) {
      trackMap.set(tKey, tr = { name: e.track, artist: e.artist, art: coverOf(e.art), totalMs: 0, plays: 0, source: e.source, aKey, bySrc: new Map() });
    }
    tr.totalMs += ms;
    tr.plays++;
    if (coverOf(e.art)) tr.art = e.art;
    tr.bySrc.set(e.source, (tr.bySrc.get(e.source) ?? 0) + ms);

    if (!PLACEHOLDER_ARTISTS.has(aKey)) {
      let a = artistMap.get(aKey);
      if (!a) artistMap.set(aKey, a = { name: artist, art: '', totalMs: 0, plays: 0, tracks: 0, bestMs: -1, trackKeys: new Set() });
      a.totalMs += ms;
      a.plays++;
      a.trackKeys.add(tKey);
      // The longest spelling wins: "Tyler, The Creator" is cut at its comma
      // on some plays and not others.
      if (artist.length > a.name.length) a.name = artist;
    }

    if (e.album) {
      const alKey = `${e.album.toLowerCase()}|${aKey}`;
      let al = albumMap.get(alKey);
      if (!al) albumMap.set(alKey, al = { name: e.album, artist, art: coverOf(e.art), totalMs: 0, plays: 0 });
      al.totalMs += ms;
      al.plays++;
      if (coverOf(e.art)) al.art = e.art;
    }
  }

  for (const tr of trackMap.values()) {
    let best = 0;
    for (const [src, ms] of tr.bySrc) if (ms > best) { best = ms; tr.source = src; }
    const a = artistMap.get(tr.aKey);
    if (a && tr.art && tr.totalMs > a.bestMs) { a.bestMs = tr.totalMs; a.art = tr.art; }
  }

  const topTracks = [...trackMap.values()].sort(byMsDesc).slice(0, TOP_N)
    .map(({ name, artist, art, totalMs, plays, source: src }) => ({ name, artist, art, totalMs, plays, source: src }));
  const topArtists = [...artistMap.values()].sort(byMsDesc).slice(0, TOP_N)
    .map(({ name, art, totalMs, plays, trackKeys }) => ({ name, art, totalMs, plays, tracks: trackKeys.size }));
  const topAlbums = [...albumMap.values()].sort(byMsDesc).slice(0, TOP_N);
  const topChannels = [...channelMap.values()].sort(byMsDesc).slice(0, TOP_N)
    .map(({ name, art, source: src, totalMs, sittings: s }) => ({ name, art, source: src, totalMs, sittings: s }));
  const topCategories = [...categoryMap.values()].sort(byMsDesc).slice(0, TOP_N)
    .map(({ name, totalMs, sittings: s }) => ({ name, totalMs, sittings: s }));

  // ── New this range ──
  let newArtists: number | null = null;
  const discoveries: Discovery[] = [];
  if (canSayNew) {
    const pool = streams
      ? [...channelMap.entries()].map(([k, c]) => ({ k, name: c.name, art: c.art, totalMs: c.totalMs, plays: c.sittings }))
      : [...artistMap.entries()].map(([k, a]) => ({ k, name: a.name, art: a.art, totalMs: a.totalMs, plays: a.plays }));
    const fresh = pool.filter((p) => (firstSeen.get(p.k) ?? -Infinity) >= from);
    newArtists = fresh.length;
    for (const p of fresh.sort(byMsDesc).slice(0, DISCOVERIES_N)) {
      discoveries.push({ name: p.name, art: p.art, totalMs: p.totalMs, plays: p.plays, firstAt: new Date(firstSeen.get(p.k)!).toISOString() });
    }
  }

  // ── Habits ──
  let longestSession: Session | null = null;
  for (const r of runs(cur)) {
    if (!longestSession || r.ms > longestSession.ms) {
      longestSession = { ms: r.ms, startedAt: new Date(r.start).toISOString(), endedAt: new Date(r.end).toISOString(), plays: r.plays };
    }
  }

  let busiestDay: { day: string; ms: number } | null = null;
  for (const d of byDay) if (!busiestDay || d.ms > busiestDay.ms) busiestDay = { day: d.day, ms: d.ms };

  // Walked day by day on the calendar rather than by adding 24 h, which lands
  // on 23:00 the day before after the clocks go back in the fall.
  let longestStreak: WrappedStats['longestStreak'] = null;
  if (byDay.length) {
    const last = byDay[byDay.length - 1].day;
    let run = 0;
    let runFrom = '';
    for (let d = new Date(`${byDay[0].day}T12:00:00`); localDay(d) <= last; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12)) {
      const key = localDay(d);
      if (dayMap.has(key)) {
        if (!run) runFrom = key;
        run++;
        if (!longestStreak || run > longestStreak.days) longestStreak = { days: run, from: runFrom, to: key };
      } else {
        run = 0;
      }
    }
  }

  let currentStreak = 0;
  {
    const today = new Date(now);
    let back = scopeDays.has(localDay(today)) ? 0 : 1;
    while (scopeDays.has(localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, 12)))) {
      currentStreak++;
      back++;
    }
  }

  const sortedEver = [...everPlatforms.entries()].sort((a, b) => b[1] - a[1]);

  return {
    days,
    source,
    streams,
    from: days ? new Date(from).toISOString() : null,
    historyStart: hasHistory ? new Date(historyStart).toISOString() : null,
    historyPlatforms: sortedEver.map(([src]) => ({ source: src, stream: STREAM_SOURCES.has(src) })),
    platforms: [...platforms.entries()]
      .filter(([, p]) => p.ms > 0)
      .sort((a, b) => b[1].ms - a[1].ms)
      .map(([src, p]) => ({ source: src, stream: STREAM_SOURCES.has(src), ms: p.ms, plays: p.plays, prevMs: comparable ? p.prevMs : null })),

    totalListenedMs: total,
    totalTracks: cur.length,
    uniqueTracks: streams ? 0 : trackMap.size,
    uniqueArtists: streams ? channelMap.size : artistMap.size,
    sittings,
    activeDays,
    avgDailyMs: activeDays ? Math.round(total / activeDays) : 0,
    byDay,
    byHour,
    topTracks,
    topArtists,
    topAlbums,
    topChannels,
    topCategories,
    newArtists,
    discoveries,
    previous: comparable
      ? { totalListenedMs: prevMs, totalTracks: prevPlays, uniqueArtists: prevArtists.size, activeDays: prevDays.size }
      : null,
    longestSession,
    busiestDay,
    longestStreak,
    currentStreak,
  };
}
