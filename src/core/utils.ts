/**
 * Shared micro-utilities — zero dependencies, pure functions only.
 * Keeps repetitive patterns DRY across the codebase.
 */

import fs from 'node:fs';

/**
 * Evict the oldest entry from a Map if it exceeds `maxSize`.
 * Maps iterate in insertion order, so the first key is the oldest.
 * Call **after** inserting to ensure the map never exceeds maxSize + 1.
 */
export function evictOldest<K, V>(map: Map<K, V>, maxSize: number): void {
  if (map.size <= maxSize) return;
  const first = map.keys().next().value;
  if (first !== undefined) map.delete(first);
}

/**
 * Evict entries from the front of a Map until its size is at most `maxSize`.
 * Use for bulk eviction (e.g. cache trim after batch inserts).
 */
export function evictUntil<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
    else break;
  }
}

/**
 * Atomic write: write to a temp file then rename over the target.
 * Prevents corruption if the process crashes mid-write (partial writes,
 * which would leave the target file truncated or with invalid JSON).
 *
 * Used for: config.json, .cache.json (Spotify tokens), lastfm-session.txt,
 * flagged-lyrics.json, translate-cache.json, stats-history.json.
 *
 * On Windows/POSIX, rename is atomic for files on the same volume.
 * Throws on failure (caller logs); the temp file is cleaned up either way.
 */
export function atomicWriteFileSync(filePath: string, data: string | Buffer): void {
  // PID + monotonic timestamp avoids collisions when multiple writes race
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* tmp may already be gone */ }
    throw e;
  }
}
