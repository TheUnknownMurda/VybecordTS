/**
 * The app's two lyrics databases, behind one entry point.
 *
 * They are very different things:
 *
 *   - The LRCLIB dump is read-only, optional, and routinely 100 GB+. It lives on
 *     a worker thread (electron/lrclib-worker.ts) because better-sqlite3 is
 *     synchronous: a query here would stop the window, the tray and the Discord
 *     presence for as long as it ran, and the search box issues one per
 *     keystroke. Everything dump-related on this side is therefore async.
 *   - The custom store holds lyrics the user imported. It is small, it is
 *     written to, and its writes must be visible to the very next read, so it
 *     stays in-process and synchronous.
 *
 * Schema (from lrclib.net dump, mirrored by the custom store):
 *   tracks(id, name, name_lower, artist_name, artist_name_lower, album_name, duration, last_lyrics_id, ...)
 *   lyrics(id, synced_lyrics, has_synced_lyrics, plain_lyrics, track_id, ...)
 *   tracks_fts — FTS5 virtual table on (name_lower, album_name_lower, artist_name_lower)
 *
 * Setup:
 *   1. Download the latest .sqlite3 dump from https://lrclib.net/db-dumps
 *   2. Put it in the "LRCLIB Dump" folder, or point lrclib_dump_path at it
 *   3. The module auto-detects and opens it on startup
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

// ── Native binding resolution for pkg-packaged exe ──
// When packaged with pkg, better-sqlite3's `bindings` module cannot locate
// the .node file inside the virtual snapshot. We resolve it manually: the build
// script places `better_sqlite3.node` in `<exe_dir>/build/Release/`.
const IS_PKG = !!(process as unknown as { pkg?: unknown }).pkg;
let nativeBinding: string | undefined;
if (IS_PKG) {
  const candidate = path.join(path.dirname(process.execPath), 'build', 'Release', 'better_sqlite3.node');
  if (fs.existsSync(candidate)) {
    nativeBinding = candidate;
  }
}
import { createLogger, type LogLevel } from './logger.js';
import { normalizeUserPath } from './config.js';
import { parseLrc } from './lrc-parser.js';
import type { LrclibSearchResult, LrclibTrackLyrics } from './lrclib-dump.js';
import type { LyricLine } from './types.js';

export type { LrclibSearchResult, LrclibTrackLyrics };

const log = createLogger('LocalDB');

const DB_FILENAMES = ['lrclib.db', 'lrclib.sqlite3', 'lrclib-db-dump.sqlite3'];
const LRCLIB_DUMP_FOLDER = 'LRCLIB Dump';

/*
 * The two databases used to be a coin toss to tell apart: the dump could end up
 * called `db.sqlite3`, which says nothing, and the custom store was
 * `lrclib-custom.sqlite3`, near-identical to the `lrclib-*.sqlite3` names a
 * downloaded dump arrives under. Someone renaming a 100 GB dump by hand into
 * the wrong one of those is not a mistake worth leaving available, so the
 * canonical names now state which is which, and the old ones are still read.
 */

/** The read-only LRCLIB dump, inside the drop folder. */
const LRCLIB_DUMP_FILE = 'lrclib-dump.sqlite3';
/** Names an existing install may have the dump under, tried in this order. */
const LEGACY_DUMP_FILES = ['db.sqlite3'];

/** The app's own store of user-imported lyrics — never a dump, however it sorts. */
const CUSTOM_DB_FILE = 'custom-lyrics.sqlite3';
/** Renamed to CUSTOM_DB_FILE on first run; see migrateCustomDbName(). */
const LEGACY_CUSTOM_DB_FILE = 'lrclib-custom.sqlite3';

/**
 * How long a dump request may go unanswered before the caller is told it failed.
 *
 * Generous on purpose: it is a backstop against a query that will never come
 * back, not a performance budget. Nothing is cancelled when it fires — the
 * worker is wedged in a synchronous native call and cannot be interrupted — but
 * the caller stops waiting, and the window says so instead of spinning forever.
 */
const DUMP_REQUEST_TIMEOUT_MS = 60_000;

// ── LRCLIB dump (read-only, on its own thread) ──
let dumpWorker: Worker | null = null;
/** Which file the dump was opened from; '' when none was found. */
let lrclibDbPath = '';
let dumpOpen = false;
/**
 * The configured dump path, when startup could not use it; '' otherwise.
 *
 * Falling back to auto-detection keeps lyrics working when a path goes stale,
 * but silently: the window would say a dump is loaded while quietly searching a
 * different file from the one in Settings. Remembering the rejected path lets
 * the Lyrics library say which file it actually opened, and why.
 */
let ignoredDumpOverride = '';
/** Set while we are the ones stopping the worker, so its exit is not reported as a fault. */
let dumpClosing = false;
let nextRequestId = 0;
const pendingRequests = new Map<number, {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// Custom lyrics database (read-write, user-imported lyrics)
let customDb: Database.Database | null = null;
let stmtCustomExact: Database.Statement | null = null;
let stmtInsertLyrics: Database.Statement | null = null;
let stmtInsertTrack: Database.Statement | null = null;
let stmtUpdateTrack: Database.Statement | null = null;
let stmtInsertFts: Database.Statement | null = null;
let stmtBacklinkLyrics: Database.Statement | null = null;
let stmtFindTrackByUnique: Database.Statement | null = null;

// ── Worker plumbing ──────────────────────────────────────────────────────────

/** Mirrors DumpWorkerOut in electron/lrclib-worker.ts. */
type DumpWorkerOut =
  | { t: 'ok'; id: number; value: unknown }
  | { t: 'err'; id: number; message: string }
  | { t: 'log'; level: LogLevel; name: string; message: string };

/**
 * Start the dump worker, or return the running one.
 *
 * Returns null when the thread cannot be started at all. That is not fatal: the
 * dump is optional, so the app carries on with the custom store and the online
 * providers, having said plainly in the log why offline lookup is unavailable.
 */
function ensureDumpWorker(workerPath: string): Worker | null {
  if (dumpWorker) return dumpWorker;
  let worker: Worker;
  try {
    worker = new Worker(workerPath);
  } catch (e) {
    log.warn(`Could not start the LRCLIB dump worker (${workerPath}): ${e}`);
    return null;
  }

  worker.on('message', (msg: DumpWorkerOut) => {
    if (msg.t === 'log') {
      // The worker has no log file of its own — re-emit its lines here so they
      // land beside everything else.
      createLogger(msg.name)[msg.level](msg.message);
      return;
    }
    const pending = pendingRequests.get(msg.id);
    if (!pending) return;  // already timed out
    pendingRequests.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.t === 'ok') pending.resolve(msg.value);
    else pending.reject(new Error(msg.message));
  });

  worker.on('error', (e) => {
    log.error(`LRCLIB dump worker crashed: ${e.message}`);
    dumpWorker = null;
    dumpOpen = false;
    failAllPending(`dump worker crashed: ${e.message}`);
  });

  worker.on('exit', (code) => {
    // terminate() reports a non-zero code by design; only an exit we did not
    // ask for says something went wrong.
    if (code !== 0 && !dumpClosing) log.warn(`LRCLIB dump worker exited with code ${code}`);
    dumpWorker = null;
    dumpOpen = false;
    failAllPending('dump worker stopped');
  });

  dumpWorker = worker;
  return worker;
}

/** Reject every in-flight request — the thread that owed them answers is gone. */
function failAllPending(reason: string): void {
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  pendingRequests.clear();
}

/** One request, one reply, matched by id. Rejects rather than hanging forever. */
function askWorker<T>(msg: Record<string, unknown>): Promise<T> {
  const worker = dumpWorker;
  if (!worker) return Promise.reject(new Error('no LRCLIB dump loaded'));
  const id = ++nextRequestId;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`LRCLIB dump did not answer within ${DUMP_REQUEST_TIMEOUT_MS / 1000}s`));
    }, DUMP_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    pendingRequests.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    worker.postMessage({ ...msg, id });
  });
}

/**
 * Ask the dump for something, and treat any failure as "no result".
 *
 * Every caller has a working answer for "not found" — the online providers, or
 * an empty result list — so a worker that is missing, busy or broken should look
 * the same as a dump with no match rather than propagate an error the UI has no
 * better response to.
 */
async function askDump<T>(msg: Record<string, unknown>, fallback: T): Promise<T> {
  if (!dumpOpen || !dumpWorker) return fallback;
  try {
    return await askWorker<T>(msg);
  } catch (e) {
    log.debug(`Dump request "${msg.t}" failed: ${e}`);
    return fallback;
  }
}

// ── Dump discovery ───────────────────────────────────────────────────────────

/**
 * Every place a dump might be, best first.
 *
 * Only paths that exist are returned, so the caller can try them in turn — a
 * file that is present but unopenable (truncated download, wrong format) falls
 * through to the next candidate instead of ending the search.
 */
function dumpCandidates(baseDir: string, dumpPathOverride?: string): string[] {
  const found: string[] = [];
  const add = (p: string | null) => {
    if (p && fs.existsSync(p) && !found.includes(p)) found.push(p);
  };

  // A configured absolute path wins — that is the whole point of setting it.
  // Normalised first: a path pasted from Explorer arrives wrapped in quotes,
  // which no filesystem call resolves, and the fallback below would then look
  // like the setting being ignored outright.
  const override = normalizeUserPath(dumpPathOverride ?? '');
  if (override) {
    if (fs.existsSync(override)) add(override);
    else log.warn(`Configured LRCLIB dump path not found: ${override} — falling back to auto-detection`);
  }

  // The documented spot, then anything else in that folder: the folder is the
  // instruction, so a dump left with the name it was downloaded under, or
  // renamed, is still plainly the one that was put there to be used. Renaming a
  // 100 GB file is not something to make someone do twice.
  const dumpFolder = path.join(baseDir, LRCLIB_DUMP_FOLDER);
  add(path.join(dumpFolder, LRCLIB_DUMP_FILE));
  for (const legacy of LEGACY_DUMP_FILES) add(path.join(dumpFolder, legacy));
  add(findDumpInFolder(dumpFolder));

  // Legacy layouts: loose files in the config directory.
  for (const name of DB_FILENAMES) add(path.join(baseDir, name));
  try {
    // Any lrclib*.sqlite3 — except our own custom-lyrics store, under either
    // name, which the pattern would otherwise match. Opening that as the dump
    // makes the app report a dump is loaded while every search comes back empty.
    const ours = new Set([CUSTOM_DB_FILE, LEGACY_CUSTOM_DB_FILE]);
    const stray = fs.readdirSync(baseDir).find(f =>
      /^lrclib.*\.sqlite3$/i.test(f)
      && !f.endsWith('.gz')
      && !ours.has(f.toLowerCase()));
    if (stray) add(path.join(baseDir, stray));
  } catch (e) {
    log.debug(`dumpCandidates: could not scan ${baseDir}: ${e}`);
  }

  return found;
}

/**
 * Open both databases.
 *
 * The dump is handed to a worker thread; candidates are tried in order until
 * one opens, so a stale path or a half-downloaded file falls through to the
 * next rather than leaving the feature off. The custom store is opened here, in
 * process, and is created empty if it does not exist yet.
 *
 * Returns true if at least one database is usable.
 *
 * @param workerPath  absolute path to the built lrclib-worker.cjs. Without it
 *   the dump is skipped entirely — this module cannot derive the path, since
 *   the worker is bundled by the Electron build, not by its own module layout.
 */
export async function initLocalDb(
  baseDir: string,
  dumpPathOverride?: string,
  workerPath?: string,
): Promise<boolean> {
  let lrclibLoaded = false;

  const override = normalizeUserPath(dumpPathOverride ?? '');
  const candidates = dumpCandidates(baseDir, dumpPathOverride);
  if (candidates.length === 0) {
    log.debug(`initLocalDb: no LRCLIB dump found under ${baseDir}`);
  } else if (!workerPath) {
    log.warn('LRCLIB dump found but no worker path was supplied — offline lookup is off');
  } else if (ensureDumpWorker(workerPath)) {
    for (const candidate of candidates) {
      try {
        const res = await askWorker<{ ok: boolean; approxTracks: number; error?: string }>({
          t: 'open', path: candidate, nativeBinding,
        });
        if (res.ok) {
          if (candidate !== path.join(baseDir, LRCLIB_DUMP_FOLDER, LRCLIB_DUMP_FILE)) {
            log.info(`Using ${path.basename(candidate)} as the LRCLIB dump`);
          }
          lrclibDbPath = candidate;
          dumpOpen = true;
          lrclibLoaded = true;
          break;
        }
        log.warn(`Not a usable LRCLIB dump, trying the next candidate: ${candidate} (${res.error})`);
      } catch (e) {
        log.warn(`Could not open ${candidate}: ${e}`);
      }
    }
  }

  // A path was set, and it is not the file we ended up on: either it is gone or
  // it would not open. Kept so the window can say so rather than report a dump
  // loaded and leave the mismatch to be discovered through missing lyrics.
  ignoredDumpOverride = override && lrclibDbPath !== override ? override : '';

  // Always create/load custom lyrics database
  migrateCustomDbName(baseDir);
  const customDbPath = path.join(baseDir, CUSTOM_DB_FILE);
  let customLoaded: boolean;
  if (fs.existsSync(customDbPath)) {
    log.debug(`initLocalDb: Found existing custom DB: ${customDbPath}`);
    customLoaded = openCustomDb(customDbPath);
  } else {
    log.info('Creating new custom lyrics database for user imports');
    customLoaded = createEmptyCustomDb(customDbPath);
  }

  log.info(`Database initialization complete: LRCLIB dump (${lrclibLoaded ? 'loaded' : 'not found'}), Custom DB (${customLoaded ? 'loaded' : 'failed'})`);

  return lrclibLoaded || customLoaded;
}

/**
 * Move an existing custom-lyrics store onto its clearer name.
 *
 * Renaming rather than reading both: two accepted names is two things to keep
 * straight forever, and the lyrics people imported are the one thing here that
 * cannot be re-downloaded, so they should live under a name that says what they
 * are. Runs once — after the rename the legacy name is gone.
 *
 * The -wal and -shm sidecars are removed rather than renamed: a clean shutdown
 * checkpoints the WAL into the database, and SQLite rebuilds both on next open.
 * A non-empty WAL is carried across instead, since it holds writes the database
 * file does not have yet.
 */
function migrateCustomDbName(baseDir: string): void {
  const legacy = path.join(baseDir, LEGACY_CUSTOM_DB_FILE);
  const target = path.join(baseDir, CUSTOM_DB_FILE);
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return;

  try {
    fs.renameSync(legacy, target);
    for (const suffix of ['-wal', '-shm']) {
      const from = legacy + suffix;
      if (!fs.existsSync(from)) continue;
      try {
        if (suffix === '-wal' && fs.statSync(from).size > 0) fs.renameSync(from, target + suffix);
        else fs.rmSync(from, { force: true });
      } catch (e) {
        log.debug(`migrateCustomDbName: could not deal with ${from}: ${e}`);
      }
    }
    log.info(`Renamed ${LEGACY_CUSTOM_DB_FILE} to ${CUSTOM_DB_FILE}`);
  } catch (e) {
    // Not fatal: the store stays where it is and opens under the old name on
    // the next line, because that path is what createEmptyCustomDb would
    // otherwise recreate empty. Better a stale name than lost imports.
    log.warn(`Could not rename ${LEGACY_CUSTOM_DB_FILE}: ${e}`);
  }
}

/**
 * The largest SQLite file in the drop folder, or null if there is none.
 *
 * Largest wins because a dump dwarfs anything else that could plausibly end up
 * beside it, and because SQLite's own sidecars (-wal, -shm) do not end in a
 * database extension and never match in the first place. A .gz is the download
 * before it was unpacked, not a database, so it is skipped too.
 */
function findDumpInFolder(folder: string): string | null {
  try {
    const candidates = fs.readdirSync(folder)
      .filter(f => /\.(sqlite3?|db)$/i.test(f))
      .map((f) => {
        const full = path.join(folder, f);
        try {
          const st = fs.statSync(full);
          return st.isFile() ? { full, size: st.size } : null;
        } catch {
          return null;
        }
      })
      .filter((c): c is { full: string; size: number } => c !== null)
      .sort((a, b) => b.size - a.size);
    return candidates[0]?.full ?? null;
  } catch {
    return null;  // no folder yet, or unreadable
  }
}

/** Create a minimal empty database for custom lyrics with the LRCLib-compatible schema. */
function createEmptyCustomDb(dbPath: string): boolean {
  try {
    const newDb = new Database(dbPath, { nativeBinding });
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
    log.info(`Created empty custom DB: ${dbPath}`);
    return openCustomDb(dbPath);
  } catch (e) {
    log.warn(`Failed to create empty custom DB: ${e}`);
    return false;
  }
}

/** Open and prepare the custom lyrics database (read-write). */
function openCustomDb(dbPath: string): boolean {
  log.debug(`openCustomDb: Opening custom DB at ${dbPath}...`);
  try {
    customDb = new Database(dbPath, { readonly: false, fileMustExist: true, nativeBinding });
    log.debug('openCustomDb: Custom DB opened, setting pragmas...');

    // Disable foreign key constraints to allow deletion of custom lyrics
    customDb.pragma('foreign_keys = OFF');

    // Set pragmas with timeout to prevent hanging on large databases
    try {
      customDb.pragma('journal_mode = WAL', { simple: true });  // Allow concurrent reads + writes (custom lyrics import)
    } catch (e) {
      log.warn(`Failed to set journal_mode to WAL: ${e}. Continuing without WAL mode.`);
    }
    customDb.pragma('cache_size = -64000'); // 64MB page cache for fast reads

    // Migrate: add source column if the database predates custom-lyrics support
    try { customDb.exec(`ALTER TABLE lyrics ADD COLUMN source TEXT DEFAULT 'custom'`); } catch { /* already exists */ }
    try { customDb.exec(`ALTER TABLE lyrics ADD COLUMN created_at TEXT`); } catch { /* already exists */ }
    try { customDb.exec(`ALTER TABLE lyrics ADD COLUMN updated_at TEXT`); } catch { /* already exists */ }

    // Prepare reusable statements for custom lyrics queries
    stmtCustomExact = customDb.prepare(`
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
    stmtInsertLyrics = customDb.prepare(`
      INSERT INTO lyrics (plain_lyrics, synced_lyrics, track_id, has_plain_lyrics, has_synced_lyrics, instrumental, source, created_at, updated_at)
      VALUES (NULL, ?, NULL, 0, 1, 0, 'custom', ?, ?)
    `);
    stmtInsertTrack = customDb.prepare(`
      INSERT INTO tracks (name, name_lower, artist_name, artist_name_lower, album_name, album_name_lower, duration, last_lyrics_id, created_at, updated_at)
      VALUES (?, lower(?), ?, lower(?), ?, lower(?), ?, ?, ?, ?)
    `);
    stmtUpdateTrack = customDb.prepare(`
      UPDATE tracks SET last_lyrics_id = ?, updated_at = ?
      WHERE name_lower = lower(?) AND artist_name_lower = lower(?) AND album_name_lower = lower(?) AND duration = ?
    `);
    stmtFindTrackByUnique = customDb.prepare(`
      SELECT id FROM tracks
      WHERE name_lower = lower(?) AND artist_name_lower = lower(?) AND album_name_lower = lower(?) AND duration = ?
    `);
    stmtInsertFts = customDb.prepare(`
      INSERT INTO tracks_fts (rowid, name_lower, album_name_lower, artist_name_lower)
      VALUES (?, lower(?), lower(?), lower(?))
    `);
    stmtBacklinkLyrics = customDb.prepare('UPDATE lyrics SET track_id = ? WHERE id = ?');

    const count = (customDb.prepare('SELECT COUNT(*) as c FROM tracks').get() as { c: number })?.c ?? 0;
    log.info(`Opened custom lyrics DB: ${dbPath} (${count} custom tracks)`);
    return true;
  } catch (e) {
    log.warn(`Failed to open custom DB ${dbPath}: ${e}`);
    customDb = null;
    return false;
  }
}

/** Check if local DB is available (either LRCLIB dump or custom DB). */
export function hasLocalDb(): boolean {
  return dumpOpen || customDb !== null;
}

/**
 * Where the dump was loaded from, and where one would be picked up automatically.
 *
 * The window needs both: with no dump every search comes back empty, which is
 * indistinguishable from "no match" unless it can say the dump is missing and
 * point at the folder to drop one into.
 */
export function lrclibDumpStatus(baseDir: string): {
  loaded: boolean; path: string; folder: string; ignoredConfigured: string;
} {
  return {
    loaded: dumpOpen,
    path: lrclibDbPath,
    folder: path.join(baseDir, LRCLIB_DUMP_FOLDER),
    ignoredConfigured: ignoredDumpOverride,
  };
}

/** Free-text search across the LRCLIB dump (track/artist/album) for the dashboard's search UI. */
export function searchLrclibDump(query: string, limit = 30): Promise<LrclibSearchResult[]> {
  return askDump<LrclibSearchResult[]>({ t: 'search', query, limit }, []);
}

/** Fetch full lyrics for one LRCLIB search result, to preview or import it. */
export function getLrclibTrackLyrics(trackId: number): Promise<LrclibTrackLyrics | null> {
  return askDump<LrclibTrackLyrics | null>({ t: 'track', trackId }, null);
}

/** A row of the custom store's exact-match lookup. */
interface CustomRow {
  synced_lyrics: string;
  duration: number | null;
}

/**
 * Find synced lyrics for the track that is playing.
 *
 * Phase 0 is the custom store, in process: lyrics the user imported themselves
 * outrank anything the dump has to say, and the store is small enough that
 * querying it costs nothing.
 * Phases 1 and 2 are the dump, on its worker thread — an exact name+artist
 * match, then an FTS fallback on the title filtered by artist similarity.
 */
export async function searchLocalDb(
  trackName: string,
  artistName: string,
  durationSec: number | undefined,
): Promise<LyricLine[] | null> {
  try {
    if (customDb && stmtCustomExact) {
      const customRows = stmtCustomExact.all(trackName, artistName, artistName, artistName) as CustomRow[];
      if (customRows.length > 0) {
        const lines = parseLrc(customRows[0].synced_lyrics);
        if (lines.length >= 2) {
          log.info(`[LOCAL] Custom lyrics hit for "${trackName}" (${lines.length} lines)`);
          return lines;
        }
      }
    }
  } catch (e) {
    log.warn(`[LOCAL] Custom store query error: ${e}`);
  }

  return askDump<LyricLine[] | null>(
    { t: 'lookup', track: trackName, artist: artistName, duration: durationSec },
    null,
  );
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
  if (!customDb || durationSec === undefined || durationSec === null) return null;
  const row = customDb.prepare(`
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
  if (!customDb || !stmtInsertLyrics || !stmtInsertTrack || !stmtUpdateTrack || !stmtFindTrackByUnique || !stmtInsertFts || !stmtBacklinkLyrics) {
    throw new Error('Custom DB not initialized');
  }

  const now = new Date().toISOString();

  const tx = customDb.transaction(() => {
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
  if (!customDb) return { entries: [], total: 0 };

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

    const total = (customDb.prepare(countSql).get(...params) as { c: number })?.c ?? 0;
    const rows = customDb.prepare(querySql).all(...params, limit, offset) as CustomLyricsEntry[];
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
  if (!customDb) return null;
  try {
    const row = customDb.prepare(`
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
  if (!customDb) return false;
  try {
    const now = new Date().toISOString();
    const tx = customDb.transaction(() => {
      // Get current lyrics ID
      const row = customDb!.prepare('SELECT last_lyrics_id FROM tracks WHERE id = ?').get(trackId) as { last_lyrics_id: number } | undefined;
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
        customDb!.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

        // Update FTS index
        try {
          customDb!.prepare('DELETE FROM tracks_fts WHERE rowid = ?').run(trackId);
          const t = customDb!.prepare('SELECT name, album_name, artist_name FROM tracks WHERE id = ?').get(trackId) as { name: string; album_name: string; artist_name: string };
          if (t) customDb!.prepare('INSERT INTO tracks_fts (rowid, name_lower, album_name_lower, artist_name_lower) VALUES (?, lower(?), lower(?), lower(?))').run(trackId, t.name, t.album_name, t.artist_name);
        } catch { /* FTS update is best-effort */ }
      }

      // Update lyrics content
      if (data.synced_lyrics !== undefined) {
        customDb!.prepare('UPDATE lyrics SET synced_lyrics = ?, updated_at = ? WHERE id = ?').run(data.synced_lyrics, now, row.last_lyrics_id);
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
  if (!customDb) return false;
  try {
    log.info(`[LOCAL] Attempting to delete custom lyrics track #${trackId}`);

    const row = customDb.prepare(`
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
    customDb.prepare('UPDATE tracks SET last_lyrics_id = NULL WHERE id = ?').run(trackId);

    log.info(`[LOCAL] Step 2: Clearing track_id in lyrics`);
    customDb.prepare('UPDATE lyrics SET track_id = NULL WHERE id = ?').run(row.last_lyrics_id);

    log.info(`[LOCAL] Step 3: Deleting FTS entry`);
    try { customDb.prepare('DELETE FROM tracks_fts WHERE rowid = ?').run(trackId); } catch (e) {
      log.debug(`[LOCAL] FTS deletion failed (non-critical): ${e}`);
    }

    log.info(`[LOCAL] Step 4: Deleting lyrics`);
    customDb.prepare('DELETE FROM lyrics WHERE id = ?').run(row.last_lyrics_id);

    log.info(`[LOCAL] Step 5: Deleting track`);
    customDb.prepare('DELETE FROM tracks WHERE id = ?').run(trackId);

    log.info(`[LOCAL] Successfully deleted custom lyrics track #${trackId}`);
    return true;
  } catch (e) {
    log.warn(`[LOCAL] deleteCustomLyrics error: ${e}`);
    return false;
  }
}

/** Close the database connections. */
export function closeLocalDb(): void {
  if (dumpWorker) {
    // Ask first, then stop waiting: a query in flight is native code that
    // terminate() cannot interrupt, and shutdown must not stall behind it. The
    // dump is read-only, so an abandoned connection loses nothing.
    dumpClosing = true;
    try { dumpWorker.postMessage({ t: 'close' }); } catch { /* ignore */ }
    void dumpWorker.terminate().catch(() => { /* already gone */ });
    dumpWorker = null;
    dumpOpen = false;
    lrclibDbPath = '';
    failAllPending('shutting down');
    log.info('LRCLIB dump worker stopped');
  }

  if (customDb) {
    // Fold the -wal file back into the main DB before closing, so a copy or
    // backup of custom-lyrics.sqlite3 taken after shutdown is never missing
    // the latest writes still sitting in the WAL.
    try { customDb.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    try { customDb.close(); } catch { /* ignore */ }
    customDb = null;
    log.info('Custom lyrics database closed');
  }

  // Clear all prepared statements
  stmtCustomExact = null;
  stmtInsertLyrics = null;
  stmtInsertTrack = null;
  stmtUpdateTrack = null;
  stmtInsertFts = null;
  stmtBacklinkLyrics = null;
  stmtFindTrackByUnique = null;

  log.info('All local database connections closed');
}
