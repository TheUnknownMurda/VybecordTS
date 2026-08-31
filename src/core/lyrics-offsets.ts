/**
 * Per-track lyric offsets.
 *
 * The sync error is not a property of the app, it is a property of the
 * recording: a live take, a remaster, a YouTube upload with ten seconds of
 * intro and a Spotify single do not drift by the same amount. One global
 * number therefore cannot be right for two of them at once -- correcting one
 * track pulled every other one off, and the correction had to be made again
 * the next time the song came round.
 *
 * So an offset set while something is playing belongs to that something. The
 * setting in Settings stays as the default for tracks that have never been
 * corrected, which is almost all of them.
 *
 * Stored next to the listening history, in the same shape: a JSON file written
 * atomically, and bounded, because this grows one entry per corrected track and
 * a file nobody prunes is a file that eventually has to be.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('Offsets');

/**
 * How many corrected tracks are remembered.
 *
 * Generous: an entry is a key and a number, so a thousand of them is a few tens
 * of kilobytes, and someone who corrects that many tracks has earned the space.
 */
const MAX_ENTRIES = 1000;

/** Matches the clamp the window and the IPC handler already apply. */
const LIMIT_MS = 60_000;

let offsetsPath = '';
/** key -> offset in milliseconds. Insertion order is the eviction order. */
let offsets = new Map<string, number>();

/**
 * The same shape the blacklist keys on, for the same reason: a track is
 * identified by what the player calls it, and only the first artist is stable
 * across sources -- a feature credit that one source lists and another does not
 * must not make the same song a different one.
 */
function keyFor(track: string, artist: string): string {
  const primary = artist.split(',')[0].trim();
  return `${track.trim().toLowerCase()}|${primary.toLowerCase()}`;
}

export function initLyricsOffsets(configDir: string): void {
  offsetsPath = path.join(configDir, 'lyrics-offsets.json');
  try {
    const raw = fs.readFileSync(offsetsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        // A hand-edited file is a supported way in here as much as anywhere
        // else, so what it holds is checked rather than trusted.
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        offsets.set(k, Math.max(-LIMIT_MS, Math.min(LIMIT_MS, Math.round(v))));
      }
      if (offsets.size) log.info(`Loaded ${offsets.size} per-track lyric offset(s)`);
    }
  } catch {
    /* never corrected a track, or the file went away -- either way, none yet */
  }
}

/** The offset this track was last corrected to, or null if it never was. */
export function getTrackOffset(track: string, artist: string): number | null {
  if (!track) return null;
  const found = offsets.get(keyFor(track, artist));
  return found === undefined ? null : found;
}

/**
 * Remember a correction for this track.
 *
 * An offset of zero is a deletion rather than a stored zero: it means "this
 * track needs nothing special", which is what having no entry already says, and
 * storing it would keep a row alive that the global default covers.
 */
export function setTrackOffset(track: string, artist: string, ms: number): void {
  if (!track) return;
  const key = keyFor(track, artist);
  const clamped = Math.max(-LIMIT_MS, Math.min(LIMIT_MS, Math.round(ms)));

  if (clamped === 0) {
    if (!offsets.delete(key)) return;   // nothing was stored, nothing changed
    save();
    return;
  }

  // Re-insert so a track corrected again is the newest key, and never the one
  // evicted below.
  offsets.delete(key);
  offsets.set(key, clamped);
  while (offsets.size > MAX_ENTRIES) {
    const oldest = offsets.keys().next().value;
    if (oldest === undefined) break;
    offsets.delete(oldest);
  }
  save();
}

/** Everything remembered, for the window to list and for tests. */
export function listTrackOffsets(): { key: string; offsetMs: number }[] {
  return [...offsets.entries()].map(([key, offsetMs]) => ({ key, offsetMs }));
}

/** Forget every correction. */
export function clearTrackOffsets(): void {
  if (!offsets.size) return;
  offsets = new Map();
  save();
}

/**
 * Write the file out, atomically.
 *
 * Same reasoning as the listening history next door: the whole file is
 * rewritten on every correction, so an interrupted write would leave JSON that
 * cannot be parsed -- and this loader starts empty by design, which would throw
 * away every correction the user has ever made.
 */
function save(): void {
  if (!offsetsPath) return;
  const tmpPath = `${offsetsPath}.${process.pid}.tmp`;
  try {
    if (!offsets.size) {
      fs.rmSync(offsetsPath, { force: true });
      return;
    }
    fs.writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(offsets)), 'utf-8');
    fs.renameSync(tmpPath, offsetsPath);
  } catch (e) {
    log.warn(`Could not write the per-track offsets: ${(e as Error).message}`);
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* nothing to clean up */ }
  }
}
