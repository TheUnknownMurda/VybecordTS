/**
 * Lyrics already found, kept across songs and across restarts.
 *
 * Measured with the network stubbed at the latencies the real log shows
 * (harness/bench-lookup.ts): a lookup costs 3 requests and ~230 ms when LRCLib
 * has the exact match, 10 requests and ~1.1 s when only its fuzzy search does,
 * and up to 23 requests for a "feat." title credited to three artists. Next to
 * that every CPU step of the pipeline is noise — a whole line's Discord
 * activity is built in ~5 µs (harness/bench-cpu.ts).
 *
 * The cache this replaces was a 50-entry Map that died with the process. On
 * the real listening history (1,106 plays of tracks, July to October 2026),
 * 38% of plays were a track heard before; 50 entries could answer at most 23%
 * of plays, and only for a session that never restarted. 500 entries answer
 * 419 of the 422 repeats; doubling that to catch the last three would double
 * the ~4.4 MB of heap and ~2 MB of file a full cache costs. Every hit is lyrics
 * on screen at once, with no request sent at all.
 *
 * What is cached is unchanged: only something found, under the same key the
 * backend always used. A miss is still asked again next time, so a provider
 * that was down or a lyric set added since is picked up on the next play.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';
import type { LyricLine } from './types.js';

const log = createLogger('LyricsCache');

/** 419 of the 422 repeats in the real history above; ~4 KB of file a track. */
const MAX_ENTRIES = 500;
/**
 * Long enough that a favourite never re-asks, short enough that a provider's
 * corrected timing reaches a track eventually without anyone clearing the cache.
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 10_000;
const FILE_VERSION = 1;

interface Entry {
  lines: LyricLine[];
  savedAt: number;
}

/** On disk: [time, text] or [time, text, source], without the field names on every line. */
type DiskLine = [number, string] | [number, string, 'cc' | 'sub'];
type DiskEntry = [key: string, savedAt: number, lines: DiskLine[]];

export class LyricsCache {
  /** Least recently used first: Map order is insertion order, and get() re-inserts. */
  private entries = new Map<string, Entry>();
  private filePath = '';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(
    private readonly maxEntries = MAX_ENTRIES,
    private readonly maxAgeMs = MAX_AGE_MS,
  ) {}

  /** Load what an earlier run saved. Without this the cache is memory-only. */
  init(dataDir: string): void {
    this.filePath = path.join(dataDir, 'lyrics-cache.json');
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      return; // first run
    }
    try {
      const data = JSON.parse(raw) as { v?: number; entries?: DiskEntry[] };
      if (data.v !== FILE_VERSION || !Array.isArray(data.entries)) return;
      const now = Date.now();
      for (const e of data.entries) {
        if (!Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1] !== 'number' || !Array.isArray(e[2])) continue;
        if (now - e[1] > this.maxAgeMs) continue;
        const lines: LyricLine[] = [];
        for (const l of e[2]) {
          if (!Array.isArray(l) || typeof l[0] !== 'number' || typeof l[1] !== 'string') continue;
          lines.push(l[2] === 'cc' || l[2] === 'sub' ? { time: l[0], text: l[1], source: l[2] } : { time: l[0], text: l[1] });
        }
        if (lines.length) this.entries.set(e[0], { lines, savedAt: e[1] });
      }
      this.trim();
      log.info(`Loaded ${this.entries.size} cached lyric sets`);
    } catch (e) {
      // A damaged cache costs one lookup per track, never the app.
      log.warn(`Ignoring unreadable lyrics cache: ${e}`);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): LyricLine[] | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.savedAt > this.maxAgeMs) {
      this.delete(key);
      return undefined;
    }
    // Most recently used goes last, so a favourite outlives tracks heard once.
    // The old Map evicted by insertion, which dropped a song played every day
    // as readily as one skipped after ten seconds.
    this.entries.delete(key);
    this.entries.set(key, entry);
    // The new order rides along with the next write rather than causing one:
    // a full cache is ~2 MB and takes ~20 ms to write on the thread that
    // times lyric lines (harness/bench-cache-write.ts), and a hit changes no
    // lyrics. Something new being found, or shutdown, writes it.
    this.dirty = true;
    return entry.lines;
  }

  /** Whether a key is held, without counting as a use. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, lines: LyricLine[]): void {
    this.entries.delete(key);
    this.entries.set(key, { lines, savedAt: Date.now() });
    this.trim();
    this.scheduleSave();
  }

  delete(key: string): boolean {
    const had = this.entries.delete(key);
    if (had) this.scheduleSave();
    return had;
  }

  clear(): void {
    this.entries.clear();
    this.scheduleSave();
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  /**
   * Write now if anything changed. Synchronous on purpose: it runs on the way
   * out, where an async write would race the process exiting.
   */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.filePath) return;
    this.dirty = false;
    const entries: DiskEntry[] = [];
    for (const [key, { lines, savedAt }] of this.entries) {
      entries.push([key, savedAt, lines.map(l => (l.source ? [l.time, l.text, l.source] : [l.time, l.text]))]);
    }
    // Temp file and rename: an interrupted write leaves the previous cache
    // standing rather than a truncated file.
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify({ v: FILE_VERSION, entries }), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (e) {
      log.warn(`Failed to save lyrics cache: ${e}`);
      try { fs.unlinkSync(tmpPath); } catch { /* nothing to clean up */ }
    }
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer || !this.filePath) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    // Never what keeps the process alive; shutdown flushes explicitly.
    this.saveTimer.unref?.();
  }
}
