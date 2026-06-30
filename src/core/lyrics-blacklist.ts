/**
 * Persistent lyrics blacklist.
 *
 * Stores hashes of wrong lyrics matched to a track, so the same
 * bad match is never used again. Data is persisted to `flagged-lyrics.json`.
 *
 * Key:   normalised "track|artist" (lowercase, trimmed)
 * Value: Set of SHA-256 hex hashes of bad LyricLine[] content
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from './logger.js';
import type { LyricLine } from './types.js';

const log = createLogger('Blacklist');

/** Map<normalised track key, Set<lyrics hash>> */
let blacklist = new Map<string, Set<string>>();
let filePath = '';

/** Initialise the blacklist, loading any previously flagged entries from disk.
 * Returns true if initialization succeeded, false otherwise. */
export function initBlacklist(configDir: string): boolean {
  filePath = path.join(configDir, 'flagged-lyrics.json');
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, string[]>;
      for (const [key, hashes] of Object.entries(raw)) {
        blacklist.set(key, new Set(hashes));
      }
      const total = [...blacklist.values()].reduce((s, v) => s + v.size, 0);
      log.info(`Loaded ${total} flagged lyrics entries`);
      return true;
    }
    log.info('No flagged-lyrics.json found, starting with empty blacklist');
    return true;
  } catch (e) {
    log.error(`Failed to load flagged-lyrics.json: ${e}`);
    log.error('Flagged lyrics will not be available in this session');
    return false;
  }
}

/** Compute a stable hash of a lyrics array. */
export function hashLyrics(lyrics: LyricLine[]): string {
  const content = lyrics.map(l => `${l.time}|${l.text}`).join('\n');
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** Build a normalised key for blacklist lookups. */
function normaliseKey(trackName: string, artistName: string): string {
  return `${trackName.toLowerCase().trim()}|${artistName.toLowerCase().trim().split(/[,&]/)[0].trim()}`;
}

/** Flag a set of lyrics as wrong for a given track. */
export function flagLyrics(trackName: string, artistName: string, lyrics: LyricLine[]): void {
  if (!lyrics.length) return;
  const key = normaliseKey(trackName, artistName);
  const hash = hashLyrics(lyrics);

  let hashes = blacklist.get(key);
  if (!hashes) {
    hashes = new Set();
    blacklist.set(key, hashes);
  }
  hashes.add(hash);
  log.info(`Flagged lyrics for "${trackName}" — ${artistName} (hash ${hash})`);
  persist();
}

/** Check if a lyrics result is blacklisted for a track. */
export function isLyricsFlagged(trackName: string, artistName: string, lyrics: LyricLine[]): boolean {
  if (!lyrics.length) return false;
  const key = normaliseKey(trackName, artistName);
  const hashes = blacklist.get(key);
  if (!hashes || hashes.size === 0) return false;
  return hashes.has(hashLyrics(lyrics));
}

/** Remove all flags for a track (e.g. when user imports custom lyrics). */
export function clearFlags(trackName: string, artistName: string): void {
  const key = normaliseKey(trackName, artistName);
  if (blacklist.delete(key)) {
    log.info(`Cleared flags for "${trackName}" — ${artistName}`);
    persist();
  }
}

/** Total number of flagged entries (for stats/debug). */
export function flagCount(): number {
  return [...blacklist.values()].reduce((s, v) => s + v.size, 0);
}

/** List all flagged tracks with their key and hash count. */
export function listFlaggedTracks(): { key: string; track: string; artist: string; count: number }[] {
  const entries: { key: string; track: string; artist: string; count: number }[] = [];
  for (const [key, hashes] of blacklist) {
    const [track, artist] = key.split('|');
    entries.push({ key, track: track || '', artist: artist || '', count: hashes.size });
  }
  return entries;
}

/** Clear flags by the raw normalised key (e.g. "track|artist"). */
export function clearFlagsByKey(key: string): boolean {
  if (blacklist.delete(key)) {
    log.info(`Cleared flags by key: "${key}"`);
    persist();
    return true;
  }
  return false;
}

function persist(): void {
  try {
    const obj: Record<string, string[]> = {};
    for (const [key, hashes] of blacklist) {
      obj[key] = [...hashes];
    }
    // Use async write to avoid blocking event loop
    fs.writeFile(filePath, JSON.stringify(obj, null, 2), 'utf-8', (err) => {
      if (err) log.error(`Failed to save flagged-lyrics.json: ${err}`);
    });
  } catch (e) {
    log.error(`Failed to save flagged-lyrics.json: ${e}`);
  }
}
