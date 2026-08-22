/**
 * The LRCLIB dump, read-only.
 *
 * Everything here is synchronous — better-sqlite3 has no other mode — and the
 * dump is routinely 100 GB+, so this module is written to be hosted on a worker
 * thread (see electron/lrclib-worker.ts) rather than called directly. Nothing in
 * it knows that: it is plain SQLite access, and the thread it runs on is the
 * caller's problem.
 *
 * The custom-lyrics store is deliberately not here. It is small, it is written
 * to, and its writes have to be ordered against reads the UI makes immediately
 * afterwards — it stays in local-lyrics-db.ts on the main thread.
 */

import Database from 'better-sqlite3';
import { createLogger } from './logger.js';
import { parseLrc } from './lrc-parser.js';
import { similarity } from './similarity.js';
import type { LyricLine } from './types.js';

const log = createLogger('LrclibDump');

let db: Database.Database | null = null;
let dbPath = '';
let stmtExact: Database.Statement | null = null;
let stmtFuzzy: Database.Statement | null = null;
let stmtSearch: Database.Statement | null = null;

export interface LrclibSearchResult {
  id: number;
  track: string;
  artist: string;
  album: string;
  duration: number | null;
  hasSynced: boolean;
  hasPlain: boolean;
}

export interface LrclibTrackLyrics {
  track: string;
  artist: string;
  album: string;
  duration: number | null;
  syncedLyrics: string | null;
  plainLyrics: string | null;
}

/** Most results one search can return, however large a limit the caller asks for. */
const MAX_SEARCH_RESULTS = 50;

/**
 * How many FTS hits are pulled before filtering down to the returned page.
 *
 * This is the ceiling on the work one keystroke can cause, so it is deliberately
 * small: the dump is 30M+ tracks, and every candidate costs two random reads in
 * a file that can exceed 100 GB. A few hundred leaves ample room to drop the
 * candidates with no lyrics attached and still fill a page of results.
 */
const CANDIDATE_POOL = 400;

/** Below this artist-name similarity a fuzzy title match is the wrong song. */
const MIN_ARTIST_SIM = 0.50;

/** A duration this far from the playing track means a different recording. */
const MAX_DURATION_DRIFT_SEC = 30;

/** Rows the two lookup statements return. */
interface LookupRow {
  synced_lyrics: string;
  duration: number | null;
  track_name?: string;
  artist_name?: string;
  album_name?: string;
}

export function isOpen(): boolean {
  return db !== null;
}

export function openedPath(): string {
  return dbPath;
}

/**
 * Open a dump and prepare its statements.
 *
 * `nativeBinding` is passed through for hosts where better-sqlite3's `bindings`
 * lookup cannot find the .node file on its own.
 */
export function openDump(path: string, nativeBinding?: string): { ok: boolean; tracks: number; error?: string } {
  closeDump();
  try {
    db = new Database(path, { readonly: true, fileMustExist: true, nativeBinding });
    dbPath = path;
    db.pragma('cache_size = -64000');  // 64MB page cache for fast reads

    stmtExact = db.prepare(`
      SELECT l.synced_lyrics, t.duration
      FROM tracks t
      JOIN lyrics l ON l.id = t.last_lyrics_id
      WHERE t.name_lower = lower(?)
        AND t.artist_name_lower = lower(?)
        AND l.has_synced_lyrics = 1
        AND l.synced_lyrics IS NOT NULL
        AND length(l.synced_lyrics) > 20
      ORDER BY
        CASE WHEN t.duration IS NOT NULL THEN 0 ELSE 1 END,
        t.id DESC
      LIMIT 5
    `);

    stmtFuzzy = db.prepare(`
      SELECT t.name AS track_name, t.artist_name, t.album_name, t.duration, l.synced_lyrics
      FROM tracks_fts fts
      JOIN tracks t ON t.id = fts.rowid
      JOIN lyrics l ON l.id = t.last_lyrics_id
      WHERE tracks_fts MATCH ?
        AND l.has_synced_lyrics = 1
        AND l.synced_lyrics IS NOT NULL
        AND length(l.synced_lyrics) > 20
      LIMIT 20
    `);

    /**
     * The dashboard's free-text search.
     *
     * Shape matters more than it looks. Two things keep it bounded no matter
     * what the user typed:
     *
     *   - The FTS scan is capped in its own subquery, so the cap applies before
     *     anything is joined or sorted. A trailing prefix term ("da*") matches
     *     millions of tracks; joining and sorting every one of them to return
     *     thirty never finished on a 120 GB dump.
     *   - CROSS JOIN pins the join order. Left to itself the planner drives from
     *     `lyrics` through idx_lyrics_has_synced_lyrics — scanning every row with
     *     synced lyrics in the dump — instead of from the handful of FTS hits.
     *
     * The "has lyrics" filter and the synced-first ordering are applied after
     * the fact in dumpSearch: expressing them here reintroduces exactly the two
     * problems above.
     */
    stmtSearch = db.prepare(`
      SELECT t.id AS id, t.name AS track, t.artist_name AS artist, t.album_name AS album,
             t.duration AS duration, l.has_synced_lyrics AS hasSynced, l.has_plain_lyrics AS hasPlain
      FROM (SELECT rowid AS id FROM tracks_fts WHERE tracks_fts MATCH ? LIMIT ?) hits
      CROSS JOIN tracks t ON t.id = hits.id
      LEFT JOIN lyrics l ON l.id = t.last_lyrics_id
    `);

    const tracks = (db.prepare('SELECT COUNT(*) as c FROM tracks').get() as { c: number })?.c ?? 0;
    log.info(`Opened LRCLIB dump: ${path} (${(tracks / 1_000_000).toFixed(1)}M tracks)`);
    return { ok: true, tracks };
  } catch (e) {
    const error = `${(e as Error).message || e}`;
    log.warn(`Failed to open LRCLIB dump ${path}: ${error}`);
    closeDump();
    return { ok: false, tracks: 0, error };
  }
}

export function closeDump(): void {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
  db = null;
  dbPath = '';
  stmtExact = null;
  stmtFuzzy = null;
  stmtSearch = null;
}

/**
 * Build an order-independent, prefix-friendly FTS5 MATCH query from free
 * text: each word becomes its own quoted term (so punctuation like "don't"
 * or "AC/DC" can't break the query), all ANDed together, with the last
 * term prefix-matched so results appear while the user is still typing.
 * Returns null for a query with nothing searchable left in it.
 */
export function buildFtsQuery(userQuery: string): string | null {
  // Strip quotes before dropping empties: a word that was nothing but quote
  // characters would otherwise survive as an empty term FTS5 rejects.
  const words = userQuery.trim().split(/\s+/)
    .map(w => w.replace(/"/g, ''))
    .filter(Boolean);
  // Only the last term is prefix-matched, and a one-letter prefix costs seconds:
  // FTS5 has to open a cursor on every term in the index starting with that
  // letter — hundreds of thousands of them — however selective the rest of the
  // query is. So trailing single letters are dropped rather than paid for.
  // "daft p" searches for "daft", and the second word starts narrowing the
  // moment it reaches two letters; "a b" has no searchable term left at all.
  while (words.length && words[words.length - 1].length < 2) words.pop();
  if (words.length === 0) return null;
  const last = words.length - 1;
  return words.map((w, i) => `"${w}"${i === last ? '*' : ''}`).join(' ');
}

/** Free-text search across the dump (track/artist/album) for the dashboard's search UI. */
export function dumpSearch(query: string, limit = 30): LrclibSearchResult[] {
  if (!db || !stmtSearch) return [];
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];
  const capped = Math.min(Math.max(1, limit), MAX_SEARCH_RESULTS);
  try {
    const rows = stmtSearch.all(ftsQuery, CANDIDATE_POOL) as {
      id: number; track: string; artist: string; album: string;
      duration: number | null; hasSynced: number | null; hasPlain: number | null;
    }[];
    // Both steps are done here rather than in SQL by design — see stmtSearch.
    // Sort is stable, so within "has synced" the FTS order survives.
    return rows
      .filter(r => r.hasSynced || r.hasPlain)
      .sort((a, b) => (b.hasSynced ? 1 : 0) - (a.hasSynced ? 1 : 0))
      .slice(0, capped)
      .map(r => ({
        id: r.id, track: r.track, artist: r.artist, album: r.album, duration: r.duration,
        hasSynced: !!r.hasSynced, hasPlain: !!r.hasPlain,
      }));
  } catch (e) {
    log.debug(`dumpSearch: query failed for "${query}": ${e}`);
    return [];
  }
}

/** Fetch the full lyrics content for one track (to preview or import it). */
export function dumpTrack(trackId: number): LrclibTrackLyrics | null {
  if (!db) return null;
  try {
    const row = db.prepare(`
      SELECT t.name AS track, t.artist_name AS artist, t.album_name AS album, t.duration AS duration,
             l.synced_lyrics AS syncedLyrics, l.plain_lyrics AS plainLyrics
      FROM tracks t
      JOIN lyrics l ON l.id = t.last_lyrics_id
      WHERE t.id = ?
    `).get(trackId) as LrclibTrackLyrics | undefined;
    return row ?? null;
  } catch (e) {
    log.debug(`dumpTrack: query failed for id=${trackId}: ${e}`);
    return null;
  }
}

/**
 * The playback lookup: find synced lyrics for the track that is playing.
 *
 * Phase 1 is an exact name+artist match. Phase 2 falls back to an FTS phrase on
 * the title, then rejects candidates whose artist is too far off — a title match
 * with the wrong artist is the wrong lyrics, so there is deliberately no
 * unfiltered fallback below it.
 */
export function dumpLookup(
  trackName: string,
  artistName: string,
  durationSec: number | undefined,
): LyricLine[] | null {
  if (!db) return null;
  try {
    if (stmtExact) {
      const exactRows = stmtExact.all(trackName, artistName) as LookupRow[];
      log.debug(`Exact query returned ${exactRows.length} rows for "${trackName}" by "${artistName}"`);
      const exactResult = pickBestRow(exactRows, durationSec);
      if (exactResult) {
        log.info(`Exact match for "${trackName}" (${exactResult.length} lines)`);
        return exactResult;
      }
    }

    if (stmtFuzzy) {
      // Escape double quotes in track name and wrap as FTS5 phrase
      const ftsQuery = '"' + trackName.replace(/"/g, '""') + '"';
      const fuzzyRows = stmtFuzzy.all(ftsQuery) as LookupRow[];
      log.debug(`FTS query returned ${fuzzyRows.length} rows for "${trackName}"`);
      if (fuzzyRows.length > 0) {
        const artistLow = artistName.toLowerCase();
        const artistFiltered = fuzzyRows.filter((r) => {
          const candArtist = (r.artist_name ?? '').toLowerCase();
          // Check full similarity + primary artist (before comma/&)
          const primaryCand = candArtist.split(/[,]/)[0].trim();
          const sim = Math.max(
            similarity(artistLow, candArtist),
            similarity(artistLow, primaryCand),
          );
          return sim >= MIN_ARTIST_SIM;
        });

        if (artistFiltered.length > 0) {
          const fuzzyResult = pickBestRow(artistFiltered, durationSec);
          if (fuzzyResult) {
            log.info(`Fuzzy match for "${trackName}" by "${artistName}" (${fuzzyResult.length} lines)`);
            return fuzzyResult;
          }
        } else {
          log.debug(`Fuzzy candidates found for "${trackName}" but no artist match (need ≥${MIN_ARTIST_SIM})`);
        }
      }
    }
  } catch (e) {
    log.warn(`Query error: ${e}`);
  }
  return null;
}

/**
 * Pick the best row from a set of candidates based on duration proximity.
 * Returns parsed lyrics or null.
 */
function pickBestRow(rows: LookupRow[], durationSec: number | undefined): LyricLine[] | null {
  if (!rows.length) return null;

  let best = rows[0];

  if (durationSec != null) {
    let bestDiff = Infinity;
    for (const row of rows) {
      if (row.duration != null) {
        const diff = Math.abs(row.duration - durationSec);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = row;
        }
      }
    }
    if (bestDiff !== Infinity && bestDiff > MAX_DURATION_DRIFT_SEC) {
      log.debug(`Rejected due to duration mismatch (${bestDiff.toFixed(1)}s)`);
      return null;
    }
  }

  const lines = parseLrc(best.synced_lyrics);
  return lines.length >= 2 ? lines : null;
}
