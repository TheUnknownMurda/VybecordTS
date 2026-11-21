/**
 * My lyrics as a file: what Export writes, what Import reads, and how an
 * import is matched against the songs already in the store.
 *
 * Until this existed, sharing lyrics meant copying custom-lyrics.sqlite3 into
 * someone else's data folder, which replaced their store outright: every song
 * they had timed themselves was gone, and nothing said so. An import here only
 * ever adds. A song both sides have keeps the receiver's version unless they
 * pick the sender's, song by song, after seeing both.
 *
 * The file is JSON rather than a copy of the database. It is what gets sent to
 * a friend over Discord, so it is something that can be opened and read; it
 * holds the lyrics and nothing else (the store also records when an entry went
 * to LRCLIB, which says what *the sender* did and would be false on the other
 * side); and an import can check it field by field before any of it reaches
 * the store. A custom-lyrics.sqlite3 is still read on the way in: it is what a
 * backup of the data folder holds, and what people sent each other before.
 */

import fs from 'node:fs';
import { parseLrc } from './lrc-parser.js';
import { readLyricsStoreFile } from './local-lyrics-db.js';

export const LYRICS_FILE_FORMAT = 'vybecord-lyrics';
/**
 * Raised only for a change an older Vybecord would misread. A new optional
 * field is not one: entries are read key by key, and unknown keys are ignored.
 */
export const LYRICS_FILE_VERSION = 1;

/** Far above any real export: a thousand songs come to a few megabytes. */
const MAX_JSON_BYTES = 64 * 1024 * 1024;
/**
 * A store copied out of a data folder. The ceiling is for the LRCLIB dump, a
 * 100 GB+ file with the same tables, picked by mistake: reading a store copies
 * it to the temp folder first.
 */
const MAX_STORE_BYTES = 512 * 1024 * 1024;
/** Per field. A song's LRC is a few kilobytes; anything past these is not a song. */
const MAX_NAME_CHARS = 500;
const MAX_LYRICS_CHARS = 200_000;
const SQLITE_MAGIC = 'SQLite format 3\0';

const NOT_OURS = 'This file is not lyrics exported from Vybecord. Pick a file made with Export in Lyrics → My lyrics, '
  + 'or a custom-lyrics.sqlite3.';

/** One song as it travels in a file, and as the store hands it out for one. */
export interface SharedLyrics {
  track: string;
  artist: string;
  album: string;
  /** Seconds; null when the entry never had one. */
  duration: number | null;
  /** The text as stored: usually timed LRC, sometimes plain lines copied from a dump. */
  lyrics: string;
  /**
   * When this version of the lyrics was saved. It orders My lyrics, and it is
   * what decides which of two entries for the same song plays.
   */
  created_at: string | null;
  updated_at: string | null;
}

/** An entry already in the store. */
export interface StoredSong extends SharedLyrics {
  trackId: number;
}

/** What a file held, once cleaned: the usable entries, and how many were not. */
export interface LyricsFile {
  entries: SharedLyrics[];
  skipped: number;
}

// ── The file ─────────────────────────────────────────────────────────────────

/** The text of an export file. */
export function buildLyricsFile(entries: readonly SharedLyrics[], appVersion: string, now = new Date()): string {
  return `${JSON.stringify({
    format: LYRICS_FILE_FORMAT,
    version: LYRICS_FILE_VERSION,
    app_version: appVersion,
    exported_at: now.toISOString(),
    count: entries.length,
    // Picked field by field: a StoredSong's trackId means nothing on another machine.
    entries: entries.map((e) => ({
      track: e.track,
      artist: e.artist,
      album: e.album,
      duration: e.duration,
      lyrics: e.lyrics,
      created_at: e.created_at,
      updated_at: e.updated_at,
    })),
  }, null, 2)}\n`;
}

/** Read an export file's text. Throws a sentence the window can show as it is. */
export function parseLyricsFile(text: string): LyricsFile {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error(NOT_OURS);
  }
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object' || d.format !== LYRICS_FILE_FORMAT || !Array.isArray(d.entries)) {
    throw new Error(NOT_OURS);
  }
  if (typeof d.version === 'number' && d.version > LYRICS_FILE_VERSION) {
    throw new Error('This file comes from a newer Vybecord. Update Vybecord, then import it again.');
  }
  return cleanAll(d.entries);
}

/**
 * Write an export file.
 *
 * Straight to the chosen path, without a temp file and a rename: the store is
 * the copy that matters, and an export that fails halfway is made again with
 * one click.
 */
export async function writeLyricsFile(filePath: string, entries: readonly SharedLyrics[], appVersion: string): Promise<void> {
  await fs.promises.writeFile(filePath, buildLyricsFile(entries, appVersion), 'utf-8');
}

/**
 * Read a file picked for an import: an export file, or a custom-lyrics.sqlite3,
 * told apart by their first bytes rather than by name, since a file sent over
 * Discord or renamed keeps its contents and not always its extension.
 */
export async function readLyricsImportFile(filePath: string): Promise<LyricsFile> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error(NOT_OURS);

  const head = Buffer.alloc(SQLITE_MAGIC.length);
  const fd = await fs.promises.open(filePath, 'r');
  try {
    await fd.read(head, 0, head.length, 0);
  } finally {
    await fd.close();
  }

  if (head.toString('latin1') === SQLITE_MAGIC) {
    if (stat.size > MAX_STORE_BYTES) {
      throw new Error('This database is far too big to be someone’s lyrics: it looks like an LRCLIB dump. '
        + 'The LRCLIB dump tab says how to use one.');
    }
    return cleanAll(readLyricsStoreFile(filePath));
  }
  if (stat.size > MAX_JSON_BYTES) throw new Error('This file is too big to be lyrics exported from Vybecord.');
  return parseLyricsFile(await fs.promises.readFile(filePath, 'utf-8'));
}

function cleanAll(raw: readonly unknown[]): LyricsFile {
  const entries: SharedLyrics[] = [];
  let skipped = 0;
  for (const r of raw) {
    const e = cleanEntry(r);
    if (e) entries.push(e);
    else skipped++;
  }
  return { entries, skipped };
}

/**
 * One entry from a file, checked, or null when there is nothing usable in it.
 *
 * A title and some lyrics are all an entry needs, the same as the store: an
 * entry copied out of an LRCLIB dump can lack an artist or an album. Plain,
 * untimed lyrics are kept for the same reason, since the store keeps those too.
 */
export function cleanEntry(raw: unknown): SharedLyrics | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const track = text(r.track);
  const artist = text(r.artist);
  const album = text(r.album);
  // Line endings as the store's own editor saves them; the timings do not care.
  const lyrics = typeof r.lyrics === 'string' ? r.lyrics.replace(/\0/g, '').replace(/\r\n?/g, '\n') : '';
  if (!track || !lyrics.trim()) return null;
  if (track.length > MAX_NAME_CHARS || artist.length > MAX_NAME_CHARS || album.length > MAX_NAME_CHARS) return null;
  if (lyrics.length > MAX_LYRICS_CHARS) return null;
  return {
    track, artist, album,
    duration: seconds(r.duration),
    lyrics,
    created_at: isoDate(r.created_at),
    updated_at: isoDate(r.updated_at),
  };
}

const text = (v: unknown): string => (typeof v === 'string' ? v.replace(/\0/g, '').trim() : '');

function seconds(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 86_400 ? v : null;
}

/**
 * A date as the store writes them, or null. One before 2000 or after tomorrow
 * is a broken clock on the other machine, and it would also pin the entry to
 * one end of My lyrics for good.
 */
function isoDate(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1) || t > Date.now() + 86_400_000) return null;
  return new Date(t).toISOString();
}

// ── Matching an import against the store ────────────────────────────────────

/**
 * Which song an entry answers for: its title and artist, case and outer spaces
 * aside. That is what the lookup goes by (searchCustomLyrics, findCustomLyrics);
 * album and duration play no part in it. Two entries that differ only there
 * would both answer for the same song, and the newer one would quietly win.
 */
export function songKey(track: string, artist: string): string {
  const fold = (s: string) => s.normalize('NFC').trim().toLowerCase();
  return `${fold(track)}\n${fold(artist)}`;
}

/** The same lyrics, once line endings and trailing spaces are set aside. */
export function sameLyrics(a: string, b: string): boolean {
  return normalizeLyrics(a) === normalizeLyrics(b);
}

function normalizeLyrics(s: string): string {
  return s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();
}

/** A song both sides have, with different lyrics. */
export interface ImportConflict {
  key: string;
  mine: StoredSong;
  theirs: SharedLyrics;
}

export interface ImportPlan {
  /** Songs in the file, copies of one song counted once. */
  songs: number;
  /** Songs the store does not have: an import adds them. */
  added: SharedLyrics[];
  /** Songs the store has with these very lyrics: nothing to do. */
  same: number;
  /** Songs the store has with other lyrics: the receiver's stay, unless they pick these. */
  conflicts: ImportConflict[];
}

/** What importing `incoming` into a store holding `existing` would do. */
export function planImport(incoming: readonly SharedLyrics[], existing: readonly StoredSong[]): ImportPlan {
  const theirs = newestBySong(incoming);
  const mine = newestBySong(existing);
  const plan: ImportPlan = { songs: theirs.size, added: [], same: 0, conflicts: [] };
  for (const [key, entry] of theirs) {
    const own = mine.get(key);
    if (!own) plan.added.push(entry);
    else if (sameLyrics(own.lyrics, entry.lyrics)) plan.same++;
    else plan.conflicts.push({ key, mine: own, theirs: entry });
  }
  return plan;
}

/**
 * One entry per song: the one that plays, which is the most recently saved
 * (`ORDER BY l.created_at DESC` in the store's lookup). A library can hold two
 * entries for one song — an import with no duration never matches the one
 * before it — and only one of them is ever heard.
 */
function newestBySong<T extends SharedLyrics>(entries: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const e of entries) {
    const key = songKey(e.track, e.artist);
    const held = out.get(key);
    if (!held || savedAt(e) >= savedAt(held)) out.set(key, e);
  }
  return out;
}

function savedAt(e: SharedLyrics): number {
  const t = Date.parse(e.created_at ?? '');
  return Number.isFinite(t) ? t : -Infinity;
}

// ── What the import window shows ─────────────────────────────────────────────

/** One version of a song, in the few words a row has room for. */
export interface VersionSummary {
  album: string;
  duration: number | null;
  /** Timed lines when the lyrics are timed, text lines otherwise. */
  lines: number;
  timed: boolean;
  /** When this version last changed, or null. */
  changed: string | null;
  lyrics: string;
}

export interface ImportPreview {
  songs: number;
  added: { track: string; artist: string; album: string; lines: number; timed: boolean }[];
  same: number;
  conflicts: { key: string; track: string; artist: string; mine: VersionSummary; theirs: VersionSummary }[];
}

/**
 * Timed means two lines or more that parse, the bar the lookup itself sets
 * (searchCustomLyrics): fewer, and the entry is not used for a playing song.
 */
export function summarizeVersion(e: SharedLyrics): VersionSummary {
  const timed = parseLrc(e.lyrics).length;
  const isTimed = timed >= 2;
  return {
    album: e.album,
    duration: e.duration,
    lines: isTimed ? timed : e.lyrics.split('\n').filter((l) => l.trim()).length,
    timed: isTimed,
    changed: e.updated_at ?? e.created_at,
    lyrics: e.lyrics,
  };
}

export function previewImport(plan: ImportPlan): ImportPreview {
  return {
    songs: plan.songs,
    added: plan.added.map((e) => {
      const v = summarizeVersion(e);
      return { track: e.track, artist: e.artist, album: e.album, lines: v.lines, timed: v.timed };
    }),
    same: plan.same,
    conflicts: plan.conflicts.map((c) => ({
      key: c.key,
      // The receiver's own spelling: their entry is the one that stays, whichever lyrics it ends up with.
      track: c.mine.track,
      artist: c.mine.artist,
      mine: summarizeVersion(c.mine),
      theirs: summarizeVersion(c.theirs),
    })),
  };
}
