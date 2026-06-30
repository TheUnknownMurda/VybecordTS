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

export interface HistoryEntry {
  track: string;
  artist: string;
  album: string;
  art: string;
  source: string;
  startedAt: string;   // ISO date
  listenedMs: number;
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

// Current track timing state
let currentTrackStart = 0;              // performance.now() when track started
let currentTrackInfo: { track: string; artist: string; album: string; art: string; source: string } | null = null;

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
export function historyTrackStart(track: string, artist: string, album: string, art: string, source: string): void {
  // Finalise previous track
  finaliseCurrentTrack();

  currentTrackInfo = { track, artist, album, art, source };
  currentTrackStart = performance.now();
}

/** Call when playback stops or app shuts down. */
export function historyTrackEnd(): void {
  finaliseCurrentTrack();
  flushSave();
}

function finaliseCurrentTrack(): void {
  if (!currentTrackInfo || !currentTrackStart) return;

  const listenedMs = Math.round(performance.now() - currentTrackStart);
  // Only record if listened for at least 5 seconds (skip accidental skips)
  if (listenedMs >= 5_000) {
    const entry: HistoryEntry = {
      track: currentTrackInfo.track,
      artist: currentTrackInfo.artist,
      album: currentTrackInfo.album,
      art: currentTrackInfo.art,
      source: currentTrackInfo.source,
      startedAt: new Date(Date.now() - listenedMs).toISOString(),
      listenedMs,
    };
    entries.push(entry);

    // Evict oldest entries
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(-MAX_ENTRIES);
    }

    scheduleSave();
  }

  currentTrackInfo = null;
  currentTrackStart = 0;
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

function saveToDisk(): void {
  if (!historyPath) return;
  try {
    fs.mkdir(path.dirname(historyPath), { recursive: true }, (err) => {
      if (err) return log.warn(`Failed to create history directory: ${err}`);
      fs.writeFile(historyPath, JSON.stringify(entries), 'utf-8', (writeErr) => {
        if (writeErr) log.warn(`Failed to save history: ${writeErr}`);
      });
    });
  } catch (e) {
    log.warn(`Failed to save history: ${e}`);
  }
}

/** Get N most recent history entries. */
export function getRecentHistory(limit = 50, offset = 0): HistoryEntry[] {
  const reversed = [...entries].reverse();
  return reversed.slice(offset, offset + limit);
}

/** Get total entry count. */
export function getHistoryCount(): number {
  return entries.length;
}

/** Compute all-time aggregate stats ("Wrapped"). */
export function getWrappedStats(days?: number): WrappedStats {
  let source = entries;
  if (days && days > 0) {
    const cutoff = Date.now() - days * 86_400_000;
    source = entries.filter(e => new Date(e.startedAt).getTime() >= cutoff);
  }

  const trackMap = new Map<string, { name: string; artist: string; art: string; totalMs: number; plays: number }>();
  const artistMap = new Map<string, { name: string; totalMs: number; plays: number }>();
  const daySet = new Set<string>();

  let totalMs = 0;

  for (const e of source) {
    totalMs += e.listenedMs;
    daySet.add(e.startedAt.slice(0, 10));

    // Track aggregation
    const tKey = `${e.track.toLowerCase()}|${e.artist.toLowerCase().split(/[,&]/)[0].trim()}`;
    const existing = trackMap.get(tKey);
    if (existing) {
      existing.totalMs += e.listenedMs;
      existing.plays++;
      if (e.art) existing.art = e.art;
    } else {
      trackMap.set(tKey, { name: e.track, artist: e.artist, art: e.art, totalMs: e.listenedMs, plays: 1 });
    }

    // Artist aggregation
    const primaryArtist = e.artist.split(/[,&]/)[0].trim();
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
