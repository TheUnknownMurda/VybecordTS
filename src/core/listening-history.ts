/**
 * Persistent listening history — records every track play with timing data.
 * Provides all-time aggregate stats ("Wrapped") and a recent timeline.
 * Stored in listening-history.json (max MAX_ENTRIES entries, FIFO eviction).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('History');
const MAX_ENTRIES = 10_000;
const SAVE_DEBOUNCE_MS = 5_000;

/** Below this, a play was a skip rather than something the user listened to. */
const MIN_LISTEN_MS = 5_000;

/**
 * Slack allowed on top of a track's own length before the time is capped.
 *
 * The clock runs from the moment a track becomes current to the moment the next
 * one does, so it also covers the seconds either side of the song itself.
 */
const LISTEN_GRACE_MS = 30_000;

/**
 * Ceiling for a track whose source reports no duration.
 *
 * There is no song length to cap against there, so this is the backstop against
 * a play that was never closed properly — a machine that slept mid-song, a
 * player that died without reporting a stop. Generous enough for a long set or
 * a podcast, short enough that an overnight gap cannot become the user's
 * most-listened anything.
 */
const MAX_UNKNOWN_LISTEN_MS = 4 * 60 * 60_000;

/**
 * How long a pause may last before resuming counts as a new listen.
 *
 * Coming back to a paused song minutes later is the same listen continued.
 * Coming back the next morning is not — and treating it as one would date the
 * entry from whenever it finally ended rather than when it was played.
 */
const MAX_PAUSE_RESUME_MS = 30 * 60_000;

/**
 * Sources that are not music.
 *
 * A Twitch or Kick stream has no track identity — its "title" is the stream's
 * banner and its "artist" is the streamer — and one sitting runs for hours, so
 * a single afternoon outweighs a year of songs in every aggregate. They stay in
 * the log, which promises everything the app saw, and stay out of the stats.
 */
const STREAM_SOURCES = new Set(['twitch', 'kick']);

export interface HistoryEntry {
  track: string;
  artist: string;
  album: string;
  art: string;
  source: string;
  startedAt: string;   // ISO date
  listenedMs: number;
  /** Set for live streams. Absent on entries written before the field — see isStream(). */
  kind?: 'stream';
}

/** What historyTrackStart() needs to know about a play. */
export interface TrackStart {
  track: string;
  artist: string;
  album: string;
  art: string;
  source: string;
  /** 0 when the source reports none. */
  durationMs: number;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** How many entries this page's anchor can reach. */
  total: number;
  /** Pass back on the next call to keep paging the same listing. */
  anchor: number;
}

export interface WrappedStats {
  totalListenedMs: number;
  totalTracks: number;
  uniqueTracks: number;
  uniqueArtists: number;
  topTracks: { name: string; artist: string; art: string; totalMs: number; plays: number }[];
  topArtists: { name: string; totalMs: number; plays: number }[];
  activeDays: number;
  avgDailyMs: number;
}

let historyPath = '';
let entries: HistoryEntry[] = [];
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Entries dropped off the front since load.
 *
 * Lets a position be expressed absolutely — `entries[i]` sits at `i + evicted` —
 * which is what makes a page anchor survive both new plays and eviction.
 */
let evicted = 0;

// Current track timing state
let currentTrackStart = 0;              // performance.now() when the clock last started; 0 while paused
let currentTrackInfo: TrackStart | null = null;
let currentTrackBankedMs = 0;           // listening already banked across earlier pauses of this same track
let pausedAt = 0;                       // Date.now() when the clock stopped; 0 while running
/**
 * Date.now() when this listen began.
 *
 * Kept because an entry is written when the *next* track starts, which can be
 * hours after a paused one was actually played. Counting backwards from the
 * write by the time listened filed that play at the wrong end of the gap.
 * A resume continues the same listen, so this is not touched there.
 */
let currentTrackStartedAt = 0;

export function initHistory(configDir: string): void {
  historyPath = path.join(configDir, 'listening-history.json');
  try {
    if (fs.existsSync(historyPath)) {
      const raw = fs.readFileSync(historyPath, 'utf-8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        entries = arr.slice(-MAX_ENTRIES);
        log.info(`Loaded ${entries.length} history entries`);
      }
    }
  } catch (e) {
    log.warn(`Failed to load history: ${e}`);
    entries = [];
  }
}

/** Call when a new track starts playing. Finalises the previous track. */
export function historyTrackStart(info: TrackStart): void {
  // Finalise previous track
  finaliseCurrentTrack();

  currentTrackInfo = { ...info };
  currentTrackBankedMs = 0;
  currentTrackStart = performance.now();
  currentTrackStartedAt = Date.now();
  pausedAt = 0;
}

/**
 * Replace the in-progress track's cover URL.
 *
 * The entry is only materialised in finaliseCurrentTrack(), so this still lands
 * in the saved history. It exists because the art known when a track *starts* is
 * usually the local-file placeholder — the public URL is resolved a second or so
 * later, by which point historyTrackStart() has long returned.
 */
export function historyUpdateArt(art: string): void {
  if (currentTrackInfo && art) currentTrackInfo.art = art;
}

/**
 * Call when playback stops — a pause, a player closing, an ad taking over.
 *
 * Banks what was listened to so far and stops the clock, but leaves the entry
 * open. Without this the clock keeps running against the paused track until the
 * next one starts, which is how a song left paused overnight ends up as the
 * most-listened track of the year.
 *
 * The entry stays open rather than being written out because the same track
 * resuming is one listen, not two — see historyTrackResume().
 */
export function historyTrackPause(): void {
  if (!currentTrackInfo || !currentTrackStart) return;
  currentTrackBankedMs += Math.round(performance.now() - currentTrackStart);
  currentTrackStart = 0;
  pausedAt = Date.now();
}

/**
 * Call when playback resumes. True when it continued the paused track, in which
 * case the caller must NOT record a new play: the entry it belongs to is still
 * open and the clock is running again.
 *
 * False means there is nothing to resume — a different track, a pause long
 * enough to count as over, or playback that was never paused (a song looping
 * back to its start is a second play, not a resume). The caller then records a
 * fresh play as usual, which closes whatever was left open.
 */
export function historyTrackResume(track: string, artist: string, source: string): boolean {
  if (!currentTrackInfo || currentTrackStart) return false;
  if (currentTrackInfo.track !== track
    || currentTrackInfo.artist !== artist
    || currentTrackInfo.source !== source) return false;
  if (Date.now() - pausedAt > MAX_PAUSE_RESUME_MS) return false;

  currentTrackStart = performance.now();
  pausedAt = 0;
  return true;
}

/** Call when the app shuts down: bank the current track and write immediately. */
export function historyTrackEnd(): void {
  finaliseCurrentTrack();
  flushSave();
}

function finaliseCurrentTrack(): void {
  if (!currentTrackInfo) return;

  const info = currentTrackInfo;
  // Time on the clock right now, plus whatever earlier stretches of this same
  // listen already banked. Zero while paused — that is the point.
  const running = currentTrackStart ? Math.round(performance.now() - currentTrackStart) : 0;
  const banked = currentTrackBankedMs;
  const startedAt = currentTrackStartedAt;
  currentTrackInfo = null;
  currentTrackStart = 0;
  currentTrackBankedMs = 0;
  currentTrackStartedAt = 0;
  pausedAt = 0;

  // A track cannot be listened to for longer than it lasts, so its own length is
  // the ceiling. Anything past it is time the app failed to notice was not
  // playing, and banking that would poison every total downstream.
  const elapsed = banked + running;
  const ceiling = info.durationMs > 0 ? info.durationMs + LISTEN_GRACE_MS : MAX_UNKNOWN_LISTEN_MS;
  const listenedMs = Math.min(elapsed, ceiling);

  // Only record if listened for at least 5 seconds (skip accidental skips)
  if (listenedMs < MIN_LISTEN_MS) return;

  const entry: HistoryEntry = {
    track: info.track,
    artist: info.artist,
    album: info.album,
    art: info.art,
    source: info.source,
    startedAt: new Date(startedAt || Date.now() - listenedMs).toISOString(),
    listenedMs,
  };
  if (STREAM_SOURCES.has(info.source)) entry.kind = 'stream';
  entries.push(entry);

  // Evict oldest entries
  if (entries.length > MAX_ENTRIES) {
    const drop = entries.length - MAX_ENTRIES;
    entries = entries.slice(drop);
    evicted += drop;
  }

  scheduleSave();
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveToDisk();
  }, SAVE_DEBOUNCE_MS);
}

function flushSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveToDisk();
}

/**
 * Write the log out, atomically and synchronously.
 *
 * Both properties are load-bearing, and neither held before.
 *
 * Atomic: the whole file is rewritten on every save, so an interrupted write
 * left a truncated JSON array — which the loader cannot parse, so it starts
 * from empty and the user's entire listening history is gone. A temp file plus
 * a rename means the old file stands until a complete new one exists. This is
 * the same shape saveStatsHistory() already uses next door.
 *
 * Synchronous: the shutdown path is `historyTrackEnd()` → here → `app.exit(0)`
 * a moment later. An async write racing process exit is exactly the write worth
 * not losing — it is the one holding the track that just finished. It also
 * means two saves can never be in flight at once and interleave.
 *
 * The cost is a write of a few hundred KB at most once per five seconds, and in
 * practice once a song, since only a finished track schedules one.
 */
function saveToDisk(): void {
  if (!historyPath) return;
  const tmpPath = `${historyPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(entries), 'utf-8');
    fs.renameSync(tmpPath, historyPath);
  } catch (e) {
    log.warn(`Failed to save history: ${e}`);
    try { fs.unlinkSync(tmpPath); } catch { /* nothing to clean up */ }
  }
}

/** True for an entry that is a live stream rather than a track. */
function isStream(e: HistoryEntry): boolean {
  return e.kind === 'stream' || STREAM_SOURCES.has(e.source);
}

/**
 * A page of the log, newest first.
 *
 * `anchor` pins the listing to the log as it stood when paging began. Positions
 * are absolute, so a track finishing while the user pages down neither shifts
 * the rows already on screen nor repeats one at the seam between two pages.
 * Omit it on the first call and pass the returned value back afterwards.
 */
export function getHistoryPage(limit = 50, offset = 0, anchor?: number): HistoryPage {
  const newest = evicted + entries.length;
  const from = anchor !== undefined && anchor >= 0 ? Math.min(anchor, newest) : newest;

  // Walk backwards by position instead of copying + reversing all 10k entries
  // just to slice 50 off the front.
  const out: HistoryEntry[] = [];
  for (let pos = from - 1 - Math.max(0, offset); pos >= evicted && out.length < limit; pos--) {
    out.push(entries[pos - evicted]);
  }
  return { entries: out, total: Math.max(0, from - evicted), anchor: from };
}

/** Compute all-time aggregate stats ("Wrapped"). */
export function getWrappedStats(days?: number): WrappedStats {
  const cutoff = days && days > 0 ? Date.now() - days * 86_400_000 : 0;
  const source = entries.filter(e =>
    !isStream(e) && (!cutoff || Date.parse(e.startedAt) >= cutoff));

  const trackMap = new Map<string, { name: string; artist: string; art: string; totalMs: number; plays: number }>();
  const artistMap = new Map<string, { name: string; totalMs: number; plays: number }>();
  const daySet = new Set<string>();

  let totalMs = 0;

  for (const e of source) {
    totalMs += e.listenedMs;
    daySet.add(e.startedAt.slice(0, 10));

    // Track aggregation
    const tKey = `${e.track.toLowerCase()}|${e.artist.toLowerCase().split(/[,]/)[0].trim()}`;
    const existing = trackMap.get(tKey);
    if (existing) {
      existing.totalMs += e.listenedMs;
      existing.plays++;
      if (e.art) existing.art = e.art;
    } else {
      trackMap.set(tKey, { name: e.track, artist: e.artist, art: e.art, totalMs: e.listenedMs, plays: 1 });
    }

    // Artist aggregation
    const primaryArtist = e.artist.split(/[,]/)[0].trim();
    const aKey = primaryArtist.toLowerCase();
    const existingA = artistMap.get(aKey);
    if (existingA) {
      existingA.totalMs += e.listenedMs;
      existingA.plays++;
      if (primaryArtist.length > existingA.name.length) existingA.name = primaryArtist;
    } else {
      artistMap.set(aKey, { name: primaryArtist, totalMs: e.listenedMs, plays: 1 });
    }
  }

  const topTracks = [...trackMap.values()]
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 10);

  const topArtists = [...artistMap.values()]
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 10);

  const activeDays = daySet.size;

  return {
    totalListenedMs: totalMs,
    totalTracks: source.length,
    uniqueTracks: trackMap.size,
    uniqueArtists: artistMap.size,
    topTracks,
    topArtists,
    activeDays,
    avgDailyMs: activeDays > 0 ? Math.round(totalMs / activeDays) : 0,
  };
}
