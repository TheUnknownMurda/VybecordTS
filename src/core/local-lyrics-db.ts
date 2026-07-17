/**
 * Local LRCLib SQLite database for instant lyrics lookup (~1ms vs ~300ms network).
 * Uses the official LRCLib database dump from https://lrclib.net/db-dumps
 *
 * Schema (from lrclib.net dump):
 *   tracks(id, name, name_lower, artist_name, artist_name_lower, album_name, duration, last_lyrics_id, ...)
 *   lyrics(id, synced_lyrics, has_synced_lyrics, plain_lyrics, track_id, ...)
 *   tracks_fts — FTS5 virtual table on (name_lower, album_name_lower, artist_name_lower)
 *
 * Setup:
 *   1. Download the latest .sqlite3 dump from https://lrclib.net/db-dumps
 *   2. Place it in the project root (any lrclib*.sqlite3 filename is auto-detected)
 *   3. The module auto-detects and opens it on startup
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createLogger } from './logger.js';
import { parseLrc } from './lrc-parser.js';
import { similarity } from './similarity.js';
import type { LyricLine } from './types.js';

const log = createLogger('LocalDB');

const DB_FILENAMES = ['lrclib.db', 'lrclib.sqlite3', 'lrclib-db-dump.sqlite3'];
const GZ_PATTERN = /^lrclib.*\.sqlite3\.gz$/i;

let db: Database.Database | null = null;
let stmtExact: Database.Statement | null = null;
let stmtFuzzy: Database.Statement | null = null;
let stmtCustomExact: Database.Statement | null = null;
let stmtInsertLyrics: Database.Statement | null = null;
let stmtInsertTrack: Database.Statement | null = null;
let stmtUpdateTrack: Database.Statement | null = null;
let stmtInsertFts: Database.Statement | null = null;
let stmtBacklinkLyrics: Database.Statement | null = null;
let stmtFindTrackByUnique: Database.Statement | null = null;

/**
 * Initialize the local lyrics database.
 * Scans for known filenames in `baseDir`.
 * If only a .gz compressed dump is found, decompresses it first.
 * Returns true if a database was found and opened.
 */
export async function initLocalDb(baseDir: string): Promise<boolean> {
  log.debug('initLocalDb: Checking for existing .sqlite3 files...');
  // Check for ready-to-use .sqlite3 files first
  for (const name of DB_FILENAMES) {
    const dbPath = path.join(baseDir, name);
    log.debug(`initLocalDb: Checking ${dbPath}...`);
    if (fs.existsSync(dbPath)) {
      log.debug(`initLocalDb: Found existing DB: ${dbPath}`);
      return openDb(dbPath);
    }
  }

  log.debug('initLocalDb: Scanning for any lrclib*.sqlite3 files...');
  // No exact-name match — scan for any lrclib*.sqlite3 file (e.g. dated dumps)
  try {
    const files = fs.readdirSync(baseDir);
    log.debug(`initLocalDb: Found ${files.length} files in directory`);
    const sqliteFile = files.find(f => /^lrclib.*\.sqlite3$/i.test(f) && !f.endsWith('.gz'));
    if (sqliteFile) {
      log.debug(`initLocalDb: Found lrclib*.sqlite3 file: ${sqliteFile}`);
      return openDb(path.join(baseDir, sqliteFile));
    }
  } catch (e) {
    log.debug(`initLocalDb: Error scanning for sqlite files: ${e}`);
  }

  log.debug('initLocalDb: Looking for .gz dumps to decompress...');
  // Still nothing — look for .gz dumps to decompress
  try {
    const files = fs.readdirSync(baseDir);
    const gzFile = files.find(f => GZ_PATTERN.test(f));
    if (gzFile) {
      log.debug(`initLocalDb: Found .gz file: ${gzFile}`);
      const gzPath = path.join(baseDir, gzFile);
      const outName = gzFile.replace(/\.gz$/i, '');
      const outPath = path.join(baseDir, outName);

      log.info(`Decompressing ${gzFile} → ${outName} (this may take a few minutes on first run)...`);
      await Promise.race([
        pipeline(
          createReadStream(gzPath),
          createGunzip(),
          createWriteStream(outPath),
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Decompression timeout (60s)')), 60000))
      ]);
      log.info(`Decompression complete: ${outName}`);
      return openDb(outPath);
    }
  } catch (e) {
    log.warn(`Failed to decompress .gz dump: ${e}`);
  }

  // No LRCLib dump found — create a minimal empty DB so custom lyrics import still works
  log.info('No LRCLib dump found — creating empty local DB for custom lyrics');
  const emptyPath = path.join(baseDir, 'lrclib-custom.sqlite3');
  return createEmptyDb(emptyPath);
}

/** Create a minimal empty database with the LRCLib-compatible schema. */
function createEmptyDb(dbPath: string): boolean {
  try {
    const newDb = new Database(dbPath);
    newDb.exec(`
      CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        name_lower TEXT NOT NULL,
        artist_name TEXT NOT NULL DEFAULT '',
        artist_name_lower TEXT NOT NULL DEFAULT '',
        album_name TEXT NOT NULL DEFAULT '',
        album_name_lower TEXT NOT NULL DEFAULT '',
        duration REAL,
        last_lyrics_id INTEGER,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS lyrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plain_lyrics TEXT,
        synced_lyrics TEXT,
        track_id INTEGER,
        has_plain_lyrics INTEGER NOT NULL DEFAULT 0,
        has_synced_lyrics INTEGER NOT NULL DEFAULT 0,
        instrumental INTEGER NOT NULL DEFAULT 0,
        source TEXT DEFAULT 'custom',
        created_at TEXT,
        updated_at TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
        name_lower, album_name_lower, artist_name_lower, content=tracks, content_rowid=id
      );
    `);
    newDb.close();
    log.info(`Created empty local DB: ${dbPath}`);
    return openDb(dbPath);
  } catch (e) {
    log.warn(`Failed to create empty DB: ${e}`);
    return false;
  }
}

/** Open and prepare the SQLite database. */
function openDb(dbPath: string): boolean {
  log.debug(`openDb: Opening database at ${dbPath}...`);
  try {
    db = new Database(dbPath, { readonly: false, fileMustExist: true });
    log.debug('openDb: Database opened, setting pragmas...');
    
    // Disable foreign key constraints to allow deletion of custom lyrics
    db.pragma('foreign_keys = OFF');
    
    // Set pragmas with timeout to prevent hanging on large databases
    try {
      db.pragma('journal_mode = WAL', { simple: true });  // Allow concurrent reads + writes (custom lyrics import)
    } catch (e) {
      log.warn(`Failed to set journal_mode to WAL: ${e}. Continuing without WAL mode.`);
    }
    db.pragma('cache_size = -64000'); // 64MB page cache for fast reads

    // Migrate: add source column if the LRCLIB dump predates custom-lyrics support
    try { db.exec(`ALTER TABLE lyrics ADD COLUMN source TEXT DEFAULT 'lrclib'`); } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE lyrics ADD COLUMN created_at TEXT`); } catch { /* already exists */ }
    try { db.exec(`ALTER TABLE lyrics ADD COLUMN updated_at TEXT`); } catch { /* already exists */ }

    // Prepare reusable statements (much faster than ad-hoc queries)
    // Actual schema: tracks(name, name_lower, artist_name, artist_name_lower, duration, last_lyrics_id)
    //                lyrics(id, synced_lyrics, has_synced_lyrics, track_id)
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

    stmtCustomExact = db.prepare(`
      SELECT l.synced_lyrics, t.duration
      FROM tracks t
      JOIN lyrics l ON l.id = t.last_lyrics_id
      WHERE t.name_lower = lower(?)
        AND (
          t.artist_name_lower = lower(?)
          OR t.artist_name_lower LIKE (lower(?) || ',%')
          OR lower(?) LIKE (t.artist_name_lower || ',%')
        )
        AND l.source = 'custom'
        AND l.has_synced_lyrics = 1
        AND l.synced_lyrics IS NOT NULL
        AND length(l.synced_lyrics) > 20
      ORDER BY l.created_at DESC
      LIMIT 1
    `);

    // Prepare write statements for insertCustomLyrics (reusable)
    stmtInsertLyrics = db.prepare(`
      INSERT INTO lyrics (plain_lyrics, synced_lyrics, track_id, has_plain_lyrics, has_synced_lyrics, instrumental, source, created_at, updated_at)
      VALUES (NULL, ?, NULL, 0, 1, 0, 'custom', ?, ?)
    `);
    stmtInsertTrack = db.prepare(`
      INSERT INTO tracks (name, name_lower, artist_name, artist_name_lower, album_name, album_name_lower, duration, last_lyrics_id, created_at, updated_at)
      VALUES (?, lower(?), ?, lower(?), ?, lower(?), ?, ?, ?, ?)
    `);
    stmtUpdateTrack = db.prepare(`
      UPDATE tracks SET last_lyrics_id = ?, updated_at = ?
      WHERE name_lower = lower(?) AND artist_name_lower = lower(?) AND album_name_lower = lower(?) AND duration = ?
    `);
    stmtFindTrackByUnique = db.prepare(`
      SELECT id FROM tracks
      WHERE name_lower = lower(?) AND artist_name_lower = lower(?) AND album_name_lower = lower(?) AND duration = ?
    `);
    stmtInsertFts = db.prepare(`
      INSERT INTO tracks_fts (rowid, name_lower, album_name_lower, artist_name_lower)
      VALUES (?, lower(?), lower(?), lower(?))
    `);
    stmtBacklinkLyrics = db.prepare('UPDATE lyrics SET track_id = ? WHERE id = ?');

    const count = (db.prepare('SELECT COUNT(*) as c FROM tracks').get() as { c: number })?.c ?? 0;
    log.info(`Opened local LRCLib database: ${dbPath} (${(count / 1_000_000).toFixed(1)}M tracks)`);
    return true;
  } catch (e) {
    log.warn(`Failed to open local DB ${dbPath}: ${e}`);
    db = null;
    return false;
  }
}

/** Check if local DB is available. */
export function hasLocalDb(): boolean {
  return db !== null;
}

interface LocalRow {
  synced_lyrics: string;
  duration: number | null;
  track_name?: string;
  artist_name?: string;
  album_name?: string;
}

/**
 * Search the local LRCLib database for synced lyrics.
 * Phase 1: exact match on track_name + artist_name.
 * Phase 2: LIKE fuzzy on track_name if exact fails.
 * Returns parsed LyricLine[] or null.
 */
export function searchLocalDb(
  trackName: string,
  artistName: string,
  durationSec: number | undefined,
): LyricLine[] | null {
  if (!db || !stmtExact || !stmtFuzzy) return null;

  try {
    // Phase 0: Custom-imported lyrics always take priority (no duration filtering)
    if (stmtCustomExact) {
      const customRows = stmtCustomExact.all(trackName, artistName, artistName, artistName) as LocalRow[];
      if (customRows.length > 0) {
        const lines = parseLrc(customRows[0].synced_lyrics);
        if (lines.length >= 2) {
          log.info(`[LOCAL] Custom lyrics hit for "${trackName}" (${lines.length} lines)`);
          return lines;
        }
      }
    }

    // Phase 1: Exact match (artist + track)
    const exactRows = stmtExact.all(trackName, artistName) as LocalRow[];
    log.debug(`[LOCAL] Exact query returned ${exactRows.length} rows for "${trackName}" by "${artistName}"`);
    const exactResult = pickBestRow(exactRows, durationSec);
    if (exactResult) {
      log.info(`[LOCAL] Exact match for "${trackName}" (${exactResult.length} lines)`);
      return exactResult;
    }

    // Phase 2: FTS5 fuzzy on track name (handles slight name differences)
    // Escape double quotes in track name and wrap as FTS5 phrase
    const ftsQuery = '"' + trackName.replace(/"/g, '""') + '"';
    const fuzzyRows = stmtFuzzy.all(ftsQuery) as LocalRow[];
    log.debug(`[LOCAL] FTS query returned ${fuzzyRows.length} rows for "${trackName}"`);
    if (fuzzyRows.length > 0) {
      // Filter by artist similarity using proper string similarity scoring
      const MIN_ARTIST_SIM = 0.50;
      const artistLow = artistName.toLowerCase();
      const artistFiltered = fuzzyRows.filter(r => {
        const candArtist = (r.artist_name ?? '').toLowerCase();
        // Check full similarity + primary artist (before comma/&)
        const primaryCand = candArtist.split(/[,]/)[0].trim();
        const sim = Math.max(
          similarity(artistLow, candArtist),
          similarity(artistLow, primaryCand),
        );
        return sim >= MIN_ARTIST_SIM;
      });

      // Never fall back to unfiltered results — wrong artist = wrong lyrics
      if (artistFiltered.length > 0) {
        const fuzzyResult = pickBestRow(artistFiltered, durationSec);
        if (fuzzyResult) {
          log.info(`[LOCAL] Fuzzy match for "${trackName}" by "${artistName}" (${fuzzyResult.length} lines)`);
          return fuzzyResult;
        }
      } else if (fuzzyRows.length > 0) {
        log.debug(`[LOCAL] Fuzzy candidates found for "${trackName}" but no artist match (need ≥${MIN_ARTIST_SIM})`);
      }
    }
  } catch (e) {
    log.warn(`[LOCAL] Query error: ${e}`);
  }

  return null;
}

/**
 * Pick the best row from a set of candidates based on duration proximity.
 * Returns parsed lyrics or null.
 */
function pickBestRow(rows: LocalRow[], durationSec: number | undefined): LyricLine[] | null {
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
    // Reject if best match is >30s off and we have duration info
    if (bestDiff !== Infinity && bestDiff > 30) {
      log.debug(`[LOCAL] Rejected due to duration mismatch (${bestDiff.toFixed(1)}s)`);
      return null;
    }
  }

  const lines = parseLrc(best.synced_lyrics);
  return lines.length >= 2 ? lines : null;
}

/**
 * Insert custom lyrics into the local database.
 * Creates a track + lyrics row and updates the FTS index.
 * Returns the new track ID, or throws on error.
 */
export interface ExistingLyricsMatch {
  id: number;
  updatedAt: string;
  lineCount: number;
}

/**
 * Check whether an import would overwrite an existing entry — same matching
 * rule as insertCustomLyrics' upsert (name+artist+album+duration, exact,
 * case-insensitive). Note: SQL NULL never equals NULL, so an import with no
 * duration can never match here — it always inserts a new row, exactly like
 * insertCustomLyrics itself does in that case.
 */
export function findExistingCustomLyrics(
  trackName: string, artistName: string, albumName: string, durationSec?: number,
): ExistingLyricsMatch | null {
  if (!db || durationSec === undefined || durationSec === null) return null;
  const row = db.prepare(`
    SELECT t.id as id, t.updated_at as updatedAt, l.synced_lyrics as syncedLyrics
    FROM tracks t
    JOIN lyrics l ON l.id = t.last_lyrics_id
    WHERE t.name_lower = lower(?) AND t.artist_name_lower = lower(?) AND t.album_name_lower = lower(?) AND t.duration = ?
  `).get(trackName, artistName, albumName, durationSec) as { id: number; updatedAt: string; syncedLyrics: string } | undefined;
  if (!row) return null;
  const lineCount = row.syncedLyrics ? row.syncedLyrics.split('\n').filter(l => l.trim()).length : 0;
  return { id: row.id, updatedAt: row.updatedAt, lineCount };
}

export function insertCustomLyrics(
  trackName: string,
  artistName: string,
  albumName: string,
  durationSec: number | undefined,
  syncedLyrics: string,
): number {
  if (!db || !stmtInsertLyrics || !stmtInsertTrack || !stmtUpdateTrack || !stmtFindTrackByUnique || !stmtInsertFts || !stmtBacklinkLyrics) {
    throw new Error('Local DB not initialized');
  }

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    // Check if track already exists
    const existingTrack = stmtFindTrackByUnique!.get(
      trackName, artistName, albumName, durationSec ?? null
    ) as { id: number } | undefined;

    let trackId: number;

    if (existingTrack) {
      // Update existing track with new lyrics
      trackId = existingTrack.id;
      const lyricsResult = stmtInsertLyrics!.run(syncedLyrics, now, now);
      const lyricsId = lyricsResult.lastInsertRowid as number;
      stmtUpdateTrack!.run(lyricsId, now, trackName, artistName, albumName, durationSec ?? null);
      stmtBacklinkLyrics!.run(trackId, lyricsId);
    } else {
      // Insert new track
      const lyricsResult = stmtInsertLyrics!.run(syncedLyrics, now, now);
      const lyricsId = lyricsResult.lastInsertRowid as number;
      const trackResult = stmtInsertTrack!.run(
        trackName, trackName,
        artistName, artistName,
        albumName, albumName,
        durationSec ?? null,
        lyricsId,
        now, now,
      );
      trackId = trackResult.lastInsertRowid as number;
      stmtBacklinkLyrics!.run(trackId, lyricsId);
      stmtInsertFts!.run(trackId, trackName, albumName, artistName);
    }
    return trackId;
  });

  const trackId = tx();
  log.info(`[LOCAL] Inserted custom lyrics: "${trackName}" by "${artistName}" (track #${trackId})`);
  return trackId;
}

// ── Custom lyrics management ──

export interface CustomLyricsEntry {
  track_id: number;
  lyrics_id: number;
  track_name: string;
  artist_name: string;
  album_name: string;
  duration: number | null;
  synced_lyrics: string;
  created_at: string;
}

/**
 * List custom-imported lyrics from the local database.
 * Only returns entries with source = 'custom'.
 */
export function listCustomLyrics(limit = 100, offset = 0, search?: string): { entries: CustomLyricsEntry[]; total: number } {
  if (!db) return { entries: [], total: 0 };

  try {
    let countSql = `SELECT COUNT(*) as c FROM lyrics l JOIN tracks t ON t.last_lyrics_id = l.id WHERE l.source = 'custom'`;
    let querySql = `
      SELECT t.id AS track_id, l.id AS lyrics_id, t.name AS track_name, t.artist_name, t.album_name, t.duration, l.synced_lyrics, l.created_at
      FROM lyrics l
      JOIN tracks t ON t.last_lyrics_id = l.id
      WHERE l.source = 'custom'`;
    const params: unknown[] = [];

    if (search && search.trim()) {
      const like = `%${search.trim()}%`;
      const filter = ` AND (t.name LIKE ? OR t.artist_name LIKE ? OR t.album_name LIKE ?)`;
      countSql += filter;
      querySql += filter;
      params.push(like, like, like);
    }

    querySql += ` ORDER BY l.created_at DESC LIMIT ? OFFSET ?`;

    const total = (db.prepare(countSql).get(...params) as { c: number })?.c ?? 0;
    const rows = db.prepare(querySql).all(...params, limit, offset) as CustomLyricsEntry[];
    return { entries: rows, total };
  } catch (e) {
    log.warn(`[LOCAL] listCustomLyrics error: ${e}`);
    return { entries: [], total: 0 };
  }
}

/**
 * Get a single custom lyrics entry by track ID.
 */
export function getCustomLyrics(trackId: number): CustomLyricsEntry | null {
  if (!db) return null;
  try {
    const row = db.prepare(`
      SELECT t.id AS track_id, l.id AS lyrics_id, t.name AS track_name, t.artist_name, t.album_name, t.duration, l.synced_lyrics, l.created_at
      FROM tracks t
      JOIN lyrics l ON l.id = t.last_lyrics_id
      WHERE t.id = ? AND l.source = 'custom'
    `).get(trackId) as CustomLyricsEntry | undefined;
    return row ?? null;
  } catch (e) {
    log.warn(`[LOCAL] getCustomLyrics error: ${e}`);
    return null;
  }
}

/**
 * Update an existing custom lyrics entry.
 */
export function updateCustomLyrics(trackId: number, data: { track_name?: string; artist_name?: string; album_name?: string; duration?: number | null; synced_lyrics?: string }): boolean {
  if (!db) return false;
  try {
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      // Get current lyrics ID
      const row = db!.prepare('SELECT last_lyrics_id FROM tracks WHERE id = ?').get(trackId) as { last_lyrics_id: number } | undefined;
      if (!row) return false;

      // Update track metadata
      if (data.track_name !== undefined || data.artist_name !== undefined || data.album_name !== undefined || data.duration !== undefined) {
        const sets: string[] = [];
        const vals: unknown[] = [];
        if (data.track_name !== undefined) { sets.push('name = ?', 'name_lower = lower(?)'); vals.push(data.track_name, data.track_name); }
        if (data.artist_name !== undefined) { sets.push('artist_name = ?', 'artist_name_lower = lower(?)'); vals.push(data.artist_name, data.artist_name); }
        if (data.album_name !== undefined) { sets.push('album_name = ?', 'album_name_lower = lower(?)'); vals.push(data.album_name, data.album_name); }
        if (data.duration !== undefined) { sets.push('duration = ?'); vals.push(data.duration); }
        sets.push('updated_at = ?'); vals.push(now);
        vals.push(trackId);
        db!.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

        // Update FTS index
        try {
          db!.prepare('DELETE FROM tracks_fts WHERE rowid = ?').run(trackId);
          const t = db!.prepare('SELECT name, album_name, artist_name FROM tracks WHERE id = ?').get(trackId) as { name: string; album_name: string; artist_name: string };
          if (t) db!.prepare('INSERT INTO tracks_fts (rowid, name_lower, album_name_lower, artist_name_lower) VALUES (?, lower(?), lower(?), lower(?))').run(trackId, t.name, t.album_name, t.artist_name);
        } catch { /* FTS update is best-effort */ }
      }

      // Update lyrics content
      if (data.synced_lyrics !== undefined) {
        db!.prepare('UPDATE lyrics SET synced_lyrics = ?, updated_at = ? WHERE id = ?').run(data.synced_lyrics, now, row.last_lyrics_id);
      }

      return true;
    });
    const ok = tx();
    if (ok) log.info(`[LOCAL] Updated custom lyrics for track #${trackId}`);
    return ok;
  } catch (e) {
    log.warn(`[LOCAL] updateCustomLyrics error: ${e}`);
    return false;
  }
}

/**
 * Delete a custom lyrics entry by track ID.
 */
export function deleteCustomLyrics(trackId: number): boolean {
  if (!db) return false;
  try {
    log.info(`[LOCAL] Attempting to delete custom lyrics track #${trackId}`);
    
    const row = db.prepare(`
      SELECT t.last_lyrics_id, l.source 
      FROM tracks t
      JOIN lyrics l ON l.id = t.last_lyrics_id
      WHERE t.id = ?
    `).get(trackId) as { last_lyrics_id: number; source: string } | undefined;
    
    if (!row) {
      log.warn(`[LOCAL] Track #${trackId} not found`);
      return false;
    }
    
    log.info(`[LOCAL] Found track #${trackId} with lyrics_id=${row.last_lyrics_id}, source=${row.source}`);
    
    // Only delete custom lyrics, not LRCLib official lyrics
    if (row.source !== 'custom') {
      log.warn(`[LOCAL] Cannot delete non-custom lyrics track #${trackId} (source: ${row.source})`);
      return false;
    }
    
    // Step-by-step deletion with logging
    log.info(`[LOCAL] Step 1: Clearing last_lyrics_id reference`);
    db.prepare('UPDATE tracks SET last_lyrics_id = NULL WHERE id = ?').run(trackId);
    
    log.info(`[LOCAL] Step 2: Clearing track_id in lyrics`);
    db.prepare('UPDATE lyrics SET track_id = NULL WHERE id = ?').run(row.last_lyrics_id);
    
    log.info(`[LOCAL] Step 3: Deleting FTS entry`);
    try { db.prepare('DELETE FROM tracks_fts WHERE rowid = ?').run(trackId); } catch (e) { 
      log.debug(`[LOCAL] FTS deletion failed (non-critical): ${e}`); 
    }
    
    log.info(`[LOCAL] Step 4: Deleting lyrics`);
    db.prepare('DELETE FROM lyrics WHERE id = ?').run(row.last_lyrics_id);
    
    log.info(`[LOCAL] Step 5: Deleting track`);
    db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId);
    
    log.info(`[LOCAL] Successfully deleted custom lyrics track #${trackId}`);
    return true;
  } catch (e) {
    log.warn(`[LOCAL] deleteCustomLyrics error: ${e}`);
    return false;
  }
}

/** Close the database connection. */
export function closeLocalDb(): void {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
    stmtExact = null;
    stmtFuzzy = null;
    stmtCustomExact = null;
    stmtInsertLyrics = null;
    stmtInsertTrack = null;
    stmtUpdateTrack = null;
    stmtInsertFts = null;
    stmtBacklinkLyrics = null;
    stmtFindTrackByUnique = null;
    log.info('Local LRCLib database closed');
  }
}
