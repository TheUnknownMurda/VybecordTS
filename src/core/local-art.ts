/**
 * Extract embedded album art from local audio files (Apple Music, etc.).
 *
 * When SMTC doesn't provide a thumbnail (common for Apple Music local files),
 * this module searches the user's Music directory for the matching audio file
 * and extracts the embedded cover art using music-metadata.
 *
 * Results are cached per track key. The extracted art is saved to
 * %TEMP%/vybecord_thumb.jpg for serving via /api/thumbnail.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from './logger.js';

const log = createLogger('LocalArt');

const THUMB_PATH = path.join(process.env.TEMP || os.tmpdir(), 'vybecord_thumb.jpg');
const AUDIO_EXTS = new Set(['.m4a', '.mp3', '.flac', '.aac', '.alac', '.wav', '.ogg', '.wma', '.aiff']);

// Cache: trackKey → true (art found) / false (no art) / 'pending'
const artCache = new Map<string, boolean | 'pending'>();

// File index: normalized filename → full path (built once, refreshed on miss)
let fileIndex: Map<string, string[]> | null = null;
let indexedDirs: string[] = [];

// Dynamic import for music-metadata (ES module compatibility with pkg)
let parseFile: any = null;
async function getParseFile() {
  if (!parseFile) {
    const musicMetadata = await import('music-metadata');
    parseFile = musicMetadata.parseFile;
  }
  return parseFile;
}

/**
 * Extract album art directly from a specific file path.
 * Used when we already know the file path (e.g., from spotify:localfileimage: URL).
 */
export async function extractArtFromPath(filePath: string): Promise<boolean> {
  try {
    const parser = await getParseFile();
    const metadata = await parser(filePath, { skipCovers: false });
    const pictures = metadata.common.picture;
    if (pictures && pictures.length > 0) {
      const pic = pictures[0];
      await fs.writeFile(THUMB_PATH, pic.data);
      log.info(`Extracted art from path: ${path.basename(filePath)} (${pic.data.length} bytes)`);
      return true;
    }
  } catch (e) {
    log.debug(`Failed to extract art from ${filePath}: ${e}`);
  }
  return false;
}

/**
 * Try to extract embedded album art for the given track.
 * Searches common Music directories for a matching audio file.
 * Returns true if art was extracted and saved to THUMB_PATH.
 */
export async function extractLocalArt(
  trackName: string,
  artistName: string,
  albumName: string,
  trackKey: string,
): Promise<boolean> {
  // Check cache
  const cached = artCache.get(trackKey);
  if (cached === true) return true;
  if (cached === false) return false;
  if (cached === 'pending') return false;

  artCache.set(trackKey, 'pending');

  try {
    const musicDirs = getMusicDirs();
    if (!fileIndex) {
      await buildFileIndex(musicDirs);
    }

    // Search strategy:
    // 1. Exact match on filename containing track name
    // 2. Fuzzy match using artist + track name
    const candidates = findCandidates(trackName, artistName, albumName);

    for (const filePath of candidates) {
      try {
        const parser = await getParseFile();
        const metadata = await parser(filePath, { skipCovers: false });
        const pictures = metadata.common.picture;
        if (pictures && pictures.length > 0) {
          // Use the first (usually front cover) picture
          const pic = pictures[0];
          await fs.writeFile(THUMB_PATH, pic.data);
          artCache.set(trackKey, true);
          log.info(`Extracted art from: ${path.basename(filePath)} (${pic.data.length} bytes)`);
          return true;
        }
      } catch {
        // File might be locked or corrupt — skip
        continue;
      }
    }

    // If index miss, rebuild and retry once
    if (candidates.length === 0 && fileIndex) {
      log.debug('No candidates found, rebuilding file index...');
      fileIndex = null;
      await buildFileIndex(musicDirs);
      const retry = findCandidates(trackName, artistName, albumName);
      for (const filePath of retry) {
        try {
          const parser = await getParseFile();
          const metadata = await parser(filePath, { skipCovers: false });
          const pictures = metadata.common.picture;
          if (pictures && pictures.length > 0) {
            await fs.writeFile(THUMB_PATH, pictures[0].data);
            artCache.set(trackKey, true);
            log.info(`Extracted art (retry) from: ${path.basename(filePath)}`);
            return true;
          }
        } catch { continue; }
      }
    }

    artCache.set(trackKey, false);
    log.debug(`No embedded art found for: ${trackName} — ${artistName}`);
    return false;
  } catch (e) {
    artCache.set(trackKey, false);
    log.warn(`Art extraction error: ${e}`);
    return false;
  }
}

/** Get common music directories to search. */
function getMusicDirs(): string[] {
  const dirs: string[] = [];

  // Standard Music folder
  const musicDir = path.join(os.homedir(), 'Music');
  dirs.push(musicDir);

  // Apple Music subfolder (common on Windows)
  dirs.push(path.join(musicDir, 'Music'));
  dirs.push(path.join(musicDir, 'Music', 'Media'));
  dirs.push(path.join(musicDir, 'Media'));
  dirs.push(path.join(musicDir, 'iTunes', 'iTunes Media', 'Music'));

  return dirs;
}

/** Build a file index: normalized name → [full paths]. */
async function buildFileIndex(dirs: string[]): Promise<void> {
  const index = new Map<string, string[]>();
  const visited = new Set<string>();

  for (const dir of dirs) {
    try {
      await indexDir(dir, index, visited, 0);
    } catch {
      // Directory might not exist
    }
  }

  fileIndex = index;
  indexedDirs = dirs;
  log.info(`File index built: ${index.size} audio files`);
}

async function indexDir(
  dir: string,
  index: Map<string, string[]>,
  visited: Set<string>,
  depth: number,
): Promise<void> {
  if (depth > 6) return; // Don't go too deep
  const realDir = await fs.realpath(dir).catch(() => dir);
  if (visited.has(realDir)) return;
  visited.add(realDir);

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch { return; }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await indexDir(fullPath, index, visited, depth + 1);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXTS.has(ext)) {
        const key = normalize(path.basename(entry.name, ext));
        const existing = index.get(key);
        if (existing) existing.push(fullPath);
        else index.set(key, [fullPath]);
      }
    }
  }
}

/** Find candidate files matching the track. */
function findCandidates(track: string, artist: string, album: string): string[] {
  if (!fileIndex) return [];
  const results: string[] = [];

  const normTrack = normalize(track);
  const normArtist = normalize(artist);

  // Strategy 1: Direct match on track name
  for (const [key, paths] of fileIndex) {
    if (key.includes(normTrack) || normTrack.includes(key)) {
      results.push(...paths);
    }
  }

  // Strategy 2: If too many results, filter by artist in path
  if (results.length > 5 && normArtist) {
    const filtered = results.filter(p => {
      const normPath = normalize(p);
      return normPath.includes(normArtist);
    });
    if (filtered.length > 0) return filtered.slice(0, 5);
  }

  // Strategy 3: If no results, try matching artist + track combination
  if (results.length === 0) {
    for (const [key, paths] of fileIndex) {
      // Check if key contains significant parts of the track name
      const words = normTrack.split(/\s+/).filter(w => w.length > 2);
      const matchCount = words.filter(w => key.includes(w)).length;
      if (matchCount >= Math.max(1, words.length * 0.6)) {
        // Also check if artist is in the path
        for (const p of paths) {
          if (normalize(p).includes(normArtist)) {
            results.push(p);
          }
        }
      }
    }
  }

  return results.slice(0, 5);
}

/** Normalize a string for matching (lowercase, strip accents, remove special chars). */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clear the art cache. */
export function clearLocalArtCache(): void {
  artCache.clear();
}
