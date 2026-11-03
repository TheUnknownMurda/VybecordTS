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
import { evictOldest } from './utils.js';

const log = createLogger('LocalArt');

const THUMB_PATH = path.join(process.env.TEMP || os.tmpdir(), 'vybecord_local_art.jpg');
const SMTC_THUMB_PATH = path.join(process.env.TEMP || os.tmpdir(), 'vybecord_thumb.jpg');
const AUDIO_EXTS = new Set(['.m4a', '.mp3', '.flac', '.aac', '.alac', '.wav', '.ogg', '.wma', '.aiff']);

// Cache: trackKey → true (art found) / false (no art) / 'pending'
const artCache = new Map<string, boolean | 'pending'>();
/** One entry per track played, and nothing ever cleared it. */
const ART_CACHE_MAX = 500;

// File index: normalized filename → full path (built once, refreshed on miss)
let fileIndex: Map<string, string[]> | null = null;
/** Date.now() of the last walk of the Music folders. */
let fileIndexAt = 0;
/** The walk under way, shared by every track that asks for one meanwhile. */
let indexBuild: Promise<void> | null = null;
/** How stale the index may be before a miss is allowed to walk the folders again. */
const INDEX_REFRESH_MS = 10 * 60_000;

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
 * Write the cover embedded in one audio file to the thumbnail files.
 *
 * Not once `signal` has aborted: the thumbnail is shared by every track, and a
 * track skipped while its file was being parsed used to land its cover on the
 * one playing after it. Throws when the file cannot be parsed, so each caller
 * decides whether that is worth a word in the log.
 */
async function writeCoverFrom(filePath: string, signal?: AbortSignal): Promise<boolean> {
  const parser = await getParseFile();
  const metadata = await parser(filePath, { skipCovers: false });
  // The first picture is the front cover in every tagger that writes more than one.
  const pic = metadata.common.picture?.[0];
  if (!pic || signal?.aborted) return false;
  await fs.writeFile(THUMB_PATH, pic.data);
  await fs.writeFile(SMTC_THUMB_PATH, pic.data);
  log.info(`Extracted art from: ${path.basename(filePath)} (${pic.data.length} bytes)`);
  return true;
}

/**
 * Extract album art directly from a specific file path.
 * Used when we already know the file path (e.g., from spotify:localfileimage: URL).
 */
export async function extractArtFromPath(filePath: string, signal?: AbortSignal): Promise<boolean> {
  try {
    return await writeCoverFrom(filePath, signal);
  } catch (e) {
    log.debug(`Failed to extract art from ${filePath}: ${e}`);
    return false;
  }
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
  signal?: AbortSignal,
): Promise<boolean> {
  log.info(`[ART] Searching for art: track="${trackName}", artist="${artistName}", album="${albumName}"`);

  // Check cache for negative results (no art found)
  const cached = artCache.get(trackKey);
  if (cached === false) {
    log.debug(`[ART] Cache miss (no art): ${trackKey}`);
    return false;
  }
  if (cached === 'pending') {
    log.debug(`[ART] Cache pending: ${trackKey}`);
    return false;
  }

  // Always re-extract art (no positive cache) since temp file is shared across tracks
  // This ensures the temp file always contains the correct art for the current track
  artCache.set(trackKey, 'pending');

  try {
    const musicDirs = getMusicDirs();
    log.debug(`[ART] Music directories: ${musicDirs.join(', ')}`);

    if (!fileIndex) await buildFileIndex(musicDirs);

    /** The first candidate with a cover in it, written out; false with none. */
    const tryCandidates = async (candidates: string[]): Promise<boolean> => {
      for (const filePath of candidates) {
        if (signal?.aborted) return false;
        try {
          log.debug(`[ART] Trying to extract from: ${path.basename(filePath)}`);
          if (await writeCoverFrom(filePath, signal)) return true;
        } catch (e) {
          // File might be locked or corrupt — skip
          log.debug(`[ART] Failed to extract from ${path.basename(filePath)}: ${e}`);
        }
      }
      return false;
    };

    // Search strategy:
    // 1. Exact match on filename containing track name
    // 2. Fuzzy match using artist + track name
    const candidates = findCandidates(trackName, artistName, albumName);
    log.info(`[ART] Found ${candidates.length} candidate files: ${candidates.map(p => path.basename(p)).join(', ')}`);
    let found = await tryCandidates(candidates);

    /*
     * A miss rebuilds the index — at most once per INDEX_REFRESH_MS.
     *
     * It used to rebuild on every miss, and a miss is the normal answer for a
     * song streamed from the catalogue, which has no file anywhere: every
     * Apple Music track that was not a local file walked the whole Music
     * folder again, and the card waited on the walk before it showed the
     * track at all. A file added since the last walk is still found, within
     * the refresh period.
     */
    if (!found && candidates.length === 0 && Date.now() - fileIndexAt > INDEX_REFRESH_MS && !signal?.aborted) {
      log.debug('No candidates found, rebuilding file index...');
      await buildFileIndex(musicDirs);
      found = await tryCandidates(findCandidates(trackName, artistName, albumName));
    }

    if (found) {
      artCache.set(trackKey, true);
      evictOldest(artCache, ART_CACHE_MAX);
      return true;
    }
    // A skip is not a verdict on the track: drop the pending mark rather than
    // remember "no art" for a lookup that never finished.
    if (signal?.aborted) {
      artCache.delete(trackKey);
      return false;
    }

    artCache.set(trackKey, false);
    log.debug(`No embedded art found for: ${trackName} — ${artistName}`);
    evictOldest(artCache, ART_CACHE_MAX);
    return false;
  } catch (e) {
    artCache.set(trackKey, false);
    log.warn(`Art extraction error: ${e}`);
    evictOldest(artCache, ART_CACHE_MAX);
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

/** Build a file index: normalized name → [full paths]. Two tracks asking at once share one walk. */
function buildFileIndex(dirs: string[]): Promise<void> {
  indexBuild ??= (async () => {
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
    fileIndexAt = Date.now();
    log.info(`File index built: ${index.size} audio files`);
  })().finally(() => { indexBuild = null; });
  return indexBuild;
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
  const normAlbum = normalize(album);

  // Nothing left to match on — a title of pure punctuation, say. Every test
  // below would succeed against every file, and the caller would publish some
  // unrelated album's cover with full confidence. No candidates is the answer.
  if (!normTrack) return [];

  // Strategy 1: Exact match on track name (highest priority)
  for (const [key, paths] of fileIndex) {
    if (key === normTrack) {
      results.push(...paths);
    }
  }

  // Strategy 2: If no exact match, try contains match on track name.
  // Both sides must be substantial: a one-character filename is a substring of
  // everything, which is the same failure as an empty needle in miniature.
  if (results.length === 0) {
    for (const [key, paths] of fileIndex) {
      if (key.length < 2) continue;
      if (key.includes(normTrack) || normTrack.includes(key)) {
        results.push(...paths);
      }
    }
  }

  // Strategy 3: Filter by artist in path (if we have results)
  if (results.length > 0 && normArtist) {
    const filtered = results.filter(p => {
      const normPath = normalize(p);
      return normPath.includes(normArtist);
    });
    if (filtered.length > 0) {
      // If filtering by artist gives results, use them
      return filtered.slice(0, 5);
    }
  }

  // Strategy 4: Filter by album in path (if we have results and album name)
  if (results.length > 0 && normAlbum && normAlbum.length > 3) {
    const filtered = results.filter(p => {
      const normPath = normalize(p);
      return normPath.includes(normAlbum);
    });
    if (filtered.length > 0) {
      return filtered.slice(0, 5);
    }
  }

  // Strategy 5: If too many results without artist/album filter, limit to 5
  if (results.length > 5) {
    return results.slice(0, 5);
  }

  // Strategy 6: If still no results, try matching artist + track combination
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

/**
 * Normalize a string for matching: lowercase, accents stripped, punctuation out.
 *
 * Letters and digits are kept in *every* script. This used to reduce to
 * `[a-z0-9\s]`, which does not mean "strip special characters" — it means
 * delete every writing system that is not Latin. A Japanese, Korean, Chinese,
 * Cyrillic, Greek, Arabic or Hebrew title normalised to the empty string, and
 * an empty needle matches every file in the library (see findCandidates), so
 * the first five arbitrary tracks were opened and whichever had embedded art
 * became the cover published to Discord.
 *
 * Keeping those characters also makes the match work rather than merely fail
 * safely: a file named 夜に駆ける.mp3 now matches the track called 夜に駆ける.
 *
 * NFD then stripping combining marks folds é to e; it leaves Han, Kana and
 * Hangul alone, which is what we want — they are letters, not decorated ones.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clear the art cache. */
export function clearLocalArtCache(): void {
  artCache.clear();
}
