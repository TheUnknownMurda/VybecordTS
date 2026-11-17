/**
 * Publishing an imported entry to LRCLIB — the public lyrics database LRCGET,
 * and a long list of players, fetch their lyrics from.
 *
 * The protocol, as LRCLIB's server implements it (tranxuanthang/lrclib:
 * server/src/routes/request_challenge.rs, publish_lyrics.rs and utils.rs — read
 * rather than taken from lrclib.net/docs, which leaves the hashing unstated):
 *
 *   1. POST /api/request-challenge → { prefix, target }. The prefix is 32
 *      alphanumerics, and the server keeps the challenge for five minutes.
 *   2. Find a nonce — any string — such that SHA-256(prefix + nonce) is at most
 *      `target`, compared byte by byte. The base target is 000000FF00…, about
 *      16.8 million tries on average, and the server makes it harder when more
 *      than a hundred lyrics were published in the last ten minutes.
 *   3. POST /api/publish with `X-Publish-Token: <prefix>:<nonce>` and a JSON
 *      body. The token is spent on first use. 201, with no body, on success.
 *
 * There is no way back. LRCLIB has no delete or edit endpoint, and a second
 * publish for the same track adds a revision that becomes the one everybody is
 * served. So this leans towards not sending: every blocking problem is found
 * before the network is touched, nothing is retried once a request may have
 * reached the server, and a publish that times out is reported as "may have gone
 * through" rather than as a failure worth repeating.
 *
 * The server itself checks very little — no range on the duration, nothing on
 * an empty album — so the checks below are the only ones the entry gets.
 */

import { createHash } from 'node:crypto';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { createLogger } from './logger.js';
import { LRCLIB_BASE, lrclibFetch } from './lrclib-api.js';

const log = createLogger('LrclibPublish');

/** LRCLIB's docs ask every client for a name, a version and a link back. */
const PROJECT_URL = 'https://github.com/TheUnknownMurda/VybecordTS';

const CHALLENGE_TIMEOUT_MS = 10_000;
/** Generous: a publish that times out leaves the user not knowing whether it landed. */
const PUBLISH_TIMEOUT_MS = 20_000;
const CHECK_TIMEOUT_MS = 8_000;
/** The server forgets a challenge after five minutes; this leaves one to send the answer. */
const SOLVE_DEADLINE_MS = 4 * 60_000;
/** One try plus two retries, each on a fresh challenge — LRCGET's count. */
const MAX_ATTEMPTS = 3;
/**
 * The longest `Retry-After` worth waiting out with the dialog open, in seconds.
 * LRCGET's figure. Longer than that, and the error says when to come back.
 */
const MAX_RETRY_WAIT_S = 5;
/**
 * Each worker's share of the nonce space. Worker k starts at k × this, so the
 * shares never overlap; none gets anywhere near the end of its share before the
 * deadline (~36 000 s at 3.6M tries/s, against a 240 s deadline).
 */
const NONCE_RANGE = 10_000_000_000;
const MAX_WORKERS = 4;
/** /api/get refuses durations outside this range, so a track published outside it could never be fetched. */
const MIN_DURATION_S = 1;
const MAX_DURATION_S = 3600;
/** LRCLIB matches a track's duration to within this many seconds. */
const DURATION_SLACK_S = 2;

// ── Types ─────────────────────────────────────────────────────────────────────

/** What the publish dialog may change first: the two fields the store most often lacks. */
export interface PublishEdits {
  album?: string;
  duration?: number | null;
}

/** The body of POST /api/publish. */
export interface PublishPayload {
  trackName: string;
  artistName: string;
  albumName: string;
  /** Whole seconds — the server rounds anyway, and matches to within two. */
  duration: number;
  plainLyrics: string;
  syncedLyrics: string;
}

/** An entry as the custom store holds it; see CustomLyricsEntry in local-lyrics-db.ts. */
export interface PublishSource {
  track_name: string;
  artist_name: string;
  album_name: string;
  duration: number | null;
  synced_lyrics: string;
  lrclib_published_at?: string | null;
  lrclib_published_hash?: string | null;
}

export type ProblemField = 'title' | 'artist' | 'album' | 'duration' | 'lyrics' | 'published' | 'remote';

/** Something that stops the entry from being published, said so the user can fix it. */
export interface PublishProblem {
  field: ProblemField;
  message: string;
}

/** What LRCLIB serves for the track today, as /api/get answers. */
export type RemoteState =
  | { status: 'none' }
  | {
      status: 'synced' | 'plain' | 'instrumental';
      id: number;
      /** LRCLIB's synced lyrics are these very lines, timings included. */
      same: boolean;
      album: string;
      duration: number;
    }
  | { status: 'unknown'; error: string };

export interface PublishPreview {
  trackId: number;
  title: string;
  artist: string;
  album: string;
  duration: number | null;
  /** Lines carrying at least one timing — what "N timed lines" counts. */
  timedLines: number;
  /** No problems: the dialog may offer the button. */
  ready: boolean;
  problems: PublishProblem[];
  /** Worth reading, not worth refusing over. */
  warnings: string[];
  /** Exactly what would be sent, or null while a problem stands. */
  payload: PublishPayload | null;
  /** This entry was published from here before, and whether it has changed since. */
  published: { at: string; unchanged: boolean } | null;
  /** Only when asked for: it costs a round trip to LRCLIB. */
  remote: RemoteState | null;
}

export interface PublishResult {
  ok: true;
  publishedAt: string;
  attempts: number;
  solveMs: number;
  /** The album or duration typed into the dialog went into the store first. */
  savedEdits: boolean;
}

/** The custom store, as far as publishing needs it — injected so tests need no SQLite. */
export interface PublishStore {
  get(trackId: number): PublishSource | null;
  save(trackId: number, data: { album_name?: string; duration?: number | null }): boolean;
  markPublished(trackId: number, hash: string, at: string): boolean;
}

export interface PublishOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  /** Replaces the worker pool. Tests use it to skip the CPU work. */
  solve?: (prefix: string, target: string) => Promise<string>;
  /** Replaces the Retry-After wait. Tests use it to skip the clock. */
  sleep?: (ms: number) => Promise<void>;
}

type FailureCode =
  | 'network' | 'unknown_outcome' | 'busy' | 'rejected' | 'token' | 'server'
  | 'bad_challenge' | 'solve_failed' | 'invalid' | 'in_progress';

export class LrclibPublishError extends Error {
  constructor(
    message: string,
    readonly code: FailureCode,
    readonly status?: number,
    readonly apiName?: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = 'LrclibPublishError';
  }
}

export function publishUserAgent(appVersion: string): string {
  return `Vybecord v${appVersion || '0.0.0'} (${PROJECT_URL})`;
}

/**
 * The dialog's edits, from whatever the window sent.
 *
 * The window is ours, but the object still crosses IPC as `unknown`, and a NaN
 * or a megabyte of album name has no business reaching the store or LRCLIB.
 */
export function sanitizeEdits(raw: unknown): PublishEdits {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: PublishEdits = {};
  if (typeof r.album === 'string') out.album = r.album.trim().slice(0, 300);
  if (r.duration === null) out.duration = null;
  else if (typeof r.duration === 'number' && Number.isFinite(r.duration) && r.duration >= 0) out.duration = r.duration;
  return out;
}

// ── The lyrics ────────────────────────────────────────────────────────────────

/**
 * A leading timing, in every form Vybecord itself plays: `[m:ss]`,
 * `[mm:ss.x]` to `[mm:ss.xxxx]`, and `[mm:ss:xx]`.
 *
 * Read leniently because these are the timings the user checked against the
 * song in this app, and written back strictly (stampText) because LRCLIB's own
 * parser stops at three digits of fraction: a line it cannot read is a line it
 * shows untimed.
 */
const STAMP_RE = /^\[(\d+):(\d+(?:[.:]\d+)?)\]/;
/** `[ar: Artist]`, `[offset:+250]`, `[#: comment]` — a tag whose key is not a number. */
const TAG_RE = /^\[[^\d\]:][^\]:]*:[^\]]*\]$/;

interface LyricsAnalysis {
  /** Only the timed lines, timings normalised, tags dropped. */
  synced: string;
  plain: string;
  /** Lines with at least one timing, empty ones (instrumental breaks) included. */
  timed: number;
  /** Lines with words and no timing. */
  untimed: string[];
  lastStampMs: number | null;
}

function stampText(ms: number): string {
  // Through centiseconds, so 59.999 s cannot come out as ":60.00".
  const cs = Math.max(0, Math.round(ms / 10));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `[${pad(Math.floor(cs / 6000))}:${pad(Math.floor((cs % 6000) / 100))}.${pad(cs % 100)}]`;
}

/**
 * Split an entry's text into what LRCLIB gets as synced and as plain lyrics.
 *
 * Tags are dropped from both: the title, artist and album travel in the
 * payload's own fields, an `[offset:]` that Vybecord never applies would shift
 * the lines in every player that does, and `[au: instrumental]` makes LRCLIB
 * file the track as having no lyrics at all.
 *
 * The plain version is the synced one with the timings taken off — what the
 * server would derive itself (core/src/lyricsfile.rs, plain_lyrics_from_lrc) —
 * with blank lines kept as stanza breaks but never doubled, and none at either
 * end. Untimed blank lines are dropped from the synced version: the sync studio
 * writes them between stanzas, and they carry no timing for a player to use.
 */
export function analyseLyrics(text: string): LyricsAnalysis {
  const synced: string[] = [];
  const plainLines: string[] = [];
  const untimed: string[] = [];
  let timed = 0;
  let lastStampMs: number | null = null;

  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      plainLines.push('');
      continue;
    }
    const stamps: number[] = [];
    let rest = line;
    for (let m = STAMP_RE.exec(rest); m; m = STAMP_RE.exec(rest)) {
      const minutes = parseInt(m[1], 10);
      const seconds = parseFloat(m[2].replace(':', '.'));
      stamps.push(Math.round((minutes * 60 + seconds) * 1000));
      rest = rest.slice(m[0].length);
    }
    if (stamps.length) {
      const words = rest.trim();
      timed++;
      synced.push(stamps.map(stampText).join('') + (words ? ` ${words}` : ''));
      plainLines.push(words);
      for (const s of stamps) lastStampMs = lastStampMs === null ? s : Math.max(lastStampMs, s);
    } else if (!TAG_RE.test(line)) {
      untimed.push(line);
      plainLines.push(line);
    }
  }

  const plain: string[] = [];
  for (const l of plainLines) {
    if (!l && (!plain.length || !plain[plain.length - 1])) continue;
    plain.push(l);
  }
  while (plain.length && !plain[plain.length - 1]) plain.pop();

  return { synced: synced.join('\n'), plain: plain.join('\n'), timed, untimed, lastStampMs };
}

/** `211` → "3:31". */
function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A line quoted back in a message: short, and on one line. */
function quote(line: string): string {
  return `“${line.length > 40 ? `${line.slice(0, 39)}…` : line}”`;
}

/**
 * What this entry would send, and everything that stops it.
 *
 * A problem blocks; a warning is shown and left to the user. The split is about
 * who pays for a mistake: a missing album or an untimed line goes out to every
 * LRCLIB user and cannot be withdrawn, while a doubtful duration may well be
 * right.
 */
export function preparePublish(entry: PublishSource): {
  payload: PublishPayload | null;
  problems: PublishProblem[];
  warnings: string[];
  timedLines: number;
} {
  const problems: PublishProblem[] = [];
  const warnings: string[] = [];
  const title = String(entry.track_name ?? '').trim();
  const artist = String(entry.artist_name ?? '').trim();
  const album = String(entry.album_name ?? '').trim();
  const rawDuration = entry.duration;
  const lyrics = analyseLyrics(entry.synced_lyrics ?? '');

  if (!title) problems.push({ field: 'title', message: 'This entry has no title. Add one with Edit.' });
  if (!artist) problems.push({ field: 'artist', message: 'This entry has no artist. Add one with Edit.' });
  if (!album) {
    problems.push({
      field: 'album',
      message: 'No album. LRCLIB files every track under one — for a single, that is usually the single’s own title.',
    });
  }

  let duration: number | null = null;
  if (rawDuration === null || rawDuration === undefined || !Number.isFinite(rawDuration) || rawDuration <= 0) {
    problems.push({
      field: 'duration',
      message: 'No duration. LRCLIB matches lyrics to a song by its length, to within 2 seconds, so it needs one.',
    });
  } else {
    duration = Math.round(rawDuration);
    if (duration < MIN_DURATION_S || duration > MAX_DURATION_S) {
      problems.push({
        field: 'duration',
        message: `LRCLIB only matches songs from 1 second to 1 hour long, and this one says ${clock(rawDuration)}.`,
      });
    }
  }

  if (!lyrics.timed && !lyrics.untimed.length) {
    problems.push({ field: 'lyrics', message: 'There are no lyrics to publish.' });
  } else if (!lyrics.timed) {
    // Not offered as plain lyrics instead: LRCLIB serves a track's newest
    // revision to everybody, so an untimed publish would replace any synced
    // lyrics already there with worse ones.
    problems.push({
      field: 'lyrics',
      message: 'These lyrics have no timings yet. LRCLIB serves the newest version of a song to everyone, '
        + 'so untimed lines could replace synced ones already there — time them first with Re-time.',
    });
  } else if (lyrics.untimed.length) {
    const n = lyrics.untimed.length;
    problems.push({
      field: 'lyrics',
      message: `${n} line${n === 1 ? ' has' : 's have'} no timing, starting with ${quote(lyrics.untimed[0])}. `
        + 'Time them with Re-time, or remove them, first.',
    });
  }

  if (duration !== null && lyrics.lastStampMs !== null && lyrics.lastStampMs / 1000 > duration + DURATION_SLACK_S) {
    warnings.push(
      `The last line is timed at ${clock(lyrics.lastStampMs / 1000)}, after the end of the song (${clock(duration)}). `
      + 'LRCLIB matches lyrics by duration, so check it before publishing.',
    );
  }

  const payload = problems.length || duration === null ? null : {
    trackName: title,
    artistName: artist,
    albumName: album,
    duration,
    plainLyrics: lyrics.plain,
    syncedLyrics: lyrics.synced,
  };
  return { payload, problems, warnings, timedLines: lyrics.timed };
}

/** Fingerprint of a payload, kept with the entry so the same version is never sent twice. */
export function payloadHash(p: PublishPayload): string {
  return createHash('sha256')
    .update(JSON.stringify([p.trackName, p.artistName, p.albumName, p.duration, p.syncedLyrics, p.plainLyrics]))
    .digest('hex');
}

/** The entry with the dialog's edits laid over it. */
function withEdits(entry: PublishSource, edits: PublishEdits): PublishSource {
  return {
    ...entry,
    album_name: edits.album !== undefined ? edits.album : entry.album_name,
    duration: edits.duration !== undefined ? edits.duration : entry.duration,
  };
}

/** Just the edits that would change what the store holds, in its column names. */
function changedFields(entry: PublishSource, edits: PublishEdits): { album_name?: string; duration?: number | null } {
  const out: { album_name?: string; duration?: number | null } = {};
  if (edits.album !== undefined && edits.album !== (entry.album_name ?? '')) out.album_name = edits.album;
  if (edits.duration !== undefined && edits.duration !== entry.duration) out.duration = edits.duration;
  return out;
}

// ── The proof of work ─────────────────────────────────────────────────────────

/**
 * Scan `count` nonces upward from `start`; the first whose hash meets the
 * target, or null.
 *
 * SHA-256 by hand rather than node:crypto. Measured in Electron 41's Node on a
 * 42-byte input, crypto.hash() manages about 1.0M hashes a second — the cost
 * is the call into native code, not the hashing — while this loop, which
 * allocates nothing per try, does about 3.6M. At ~16.8M tries per challenge
 * that is ~17 s of one core against ~5. The answer is checked again with
 * node:crypto before it is sent (verifyNonce), so a slip in here costs a failed
 * solve, never a token LRCLIB turns down.
 *
 * SELF-CONTAINED ON PURPOSE. It runs in a worker started from its own source
 * text (solveChallenge), so it must not touch anything outside its body: no
 * module constants, no helpers, no nested functions — tsx's keepNames would
 * wrap those in a __name() call the worker does not have. The harness test runs
 * it through the worker, which is what catches a reference that slips in.
 *
 * The prefix must be ASCII, and prefix + nonce must fit one 64-byte block
 * (55 bytes of message): 32 characters of prefix leave 23 digits, and no nonce
 * here passes 11. A message that would not fit ends the search with null.
 */
export function searchNonce(prefix: string, targetHex: string, start: number, count: number): string | null {
  const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const IV = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  // The target as eight big-endian words: comparing words in order, unsigned,
  // is comparing the 32 bytes in order, which is the server's rule.
  const T = new Uint32Array(8);
  for (let i = 0; i < 8; i++) T[i] = parseInt(targetHex.slice(i * 8, i * 8 + 8), 16) >>> 0;

  const B = new Uint8Array(64);
  const W = new Int32Array(64);
  const H = new Uint32Array(8);
  const p = prefix.length;
  for (let j = 0; j < p; j++) B[j] = prefix.charCodeAt(j);
  // The nonce as decimal digits, most significant first, counted up in place:
  // String(n) on every try would be an allocation per hash.
  const digits = String(start).split('').map(Number);

  for (let n = 0; n < count; n++) {
    const len = p + digits.length;
    // Past 55 bytes the padding spills into a second block this does not
    // compute: give up rather than hash the wrong message.
    if (len > 55) return null;
    for (let j = 0; j < digits.length; j++) B[p + j] = 48 + digits[j];
    B[len] = 0x80;
    for (let j = len + 1; j < 62; j++) B[j] = 0;
    B[62] = (len * 8) >>> 8;
    B[63] = (len * 8) & 0xff;

    for (let i = 0; i < 16; i++) {
      W[i] = (B[i * 4] << 24) | (B[i * 4 + 1] << 16) | (B[i * 4 + 2] << 8) | B[i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a15 = W[i - 15];
      const a2 = W[i - 2];
      const s0 = ((a15 >>> 7) | (a15 << 25)) ^ ((a15 >>> 18) | (a15 << 14)) ^ (a15 >>> 3);
      const s1 = ((a2 >>> 17) | (a2 << 15)) ^ ((a2 >>> 19) | (a2 << 13)) ^ (a2 >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = IV[0], b = IV[1], c = IV[2], d = IV[3], e = IV[4], f = IV[5], g = IV[6], h = IV[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = a + IV[0]; H[1] = b + IV[1]; H[2] = c + IV[2]; H[3] = d + IV[3];
    H[4] = e + IV[4]; H[5] = f + IV[5]; H[6] = g + IV[6]; H[7] = h + IV[7];

    let ok = true;
    for (let i = 0; i < 8; i++) {
      if (H[i] < T[i]) break;
      if (H[i] > T[i]) { ok = false; break; }
    }
    if (ok) return digits.join('');

    let k = digits.length - 1;
    while (k >= 0 && digits[k] === 9) { digits[k] = 0; k--; }
    if (k < 0) digits.unshift(1);
    else digits[k]++;
  }
  return null;
}

/** The server's own check (utils.rs, verify_answer), on node:crypto. */
export function verifyNonce(prefix: string, targetHex: string, nonce: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(targetHex)) return false;
  const hash = createHash('sha256').update(prefix + nonce).digest();
  const target = Buffer.from(targetHex, 'hex');
  for (let i = 0; i < 32; i++) {
    if (hash[i] > target[i]) return false;
    if (hash[i] < target[i]) return true;
  }
  return true;
}

/** A challenge this solver can take: an ASCII prefix that leaves room in the block, and a 256-bit target. */
function isChallenge(v: unknown): v is { prefix: string; target: string } {
  const c = v as { prefix?: unknown; target?: unknown } | null;
  return !!c
    && typeof c.prefix === 'string' && /^[\x21-\x39\x3b-\x7e]{1,40}$/.test(c.prefix)  // printable, no ':'
    && typeof c.target === 'string' && /^[0-9a-f]{64}$/i.test(c.target);
}

/** How many threads to search with: all but one core, up to four. */
function workerCount(): number {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}

/**
 * Find a nonce for a challenge, on worker threads.
 *
 * Off the main thread because the main thread is the one keeping the Discord
 * socket, the IPC and the tray alive, and a solve is seconds of solid CPU —
 * tens of seconds on a slow machine with the difficulty raised. Several
 * threads, each on its own slice of the nonces, because the work splits
 * perfectly and the first answer is all that is wanted.
 *
 * The workers are started from searchNonce's source text with `eval`, not from
 * a bundled file. A file would need its own esbuild entry, an asarUnpack line
 * (a worker cannot start from inside app.asar) and a path threaded down from
 * main.ts — and forgetting any of those breaks only the installed build, which
 * no check here runs.
 */
export function solveChallenge(
  prefix: string,
  target: string,
  opts: { workers?: number; deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  if (!isChallenge({ prefix, target })) return Promise.reject(new Error('not a challenge this solver can take'));
  const count = Math.max(1, Math.floor(opts.workers ?? workerCount()));
  const source = [
    "const { parentPort, workerData } = require('node:worker_threads');",
    `const searchNonce = ${searchNonce.toString()};`,
    'parentPort.postMessage(searchNonce(workerData.prefix, workerData.target, workerData.start, workerData.count));',
  ].join('\n');

  return new Promise<string>((resolve, reject) => {
    const pool: Worker[] = [];
    let settled = false;
    let exhausted = 0;

    const finish = (err: Error | null, nonce?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      for (const w of pool) void w.terminate().catch(() => { /* already gone */ });
      if (err) reject(err);
      else resolve(nonce as string);
    };
    const onAbort = () => finish(new Error('cancelled'));
    const deadline = opts.deadlineMs ?? SOLVE_DEADLINE_MS;
    const timer = setTimeout(
      () => finish(new Error(`no answer after ${Math.round(deadline / 1000)} s, and the challenge expires at five minutes`)),
      deadline,
    );
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    for (let k = 0; k < count && !settled; k++) {
      let worker: Worker;
      try {
        worker = new Worker(source, {
          eval: true,
          workerData: { prefix, target, start: k * NONCE_RANGE, count: NONCE_RANGE },
        });
      } catch (e) {
        return finish(new Error(`could not start a worker thread: ${(e as Error).message}`));
      }
      // Never the reason the process stays up: finish() stops them all anyway.
      worker.unref();
      worker.on('message', (nonce: string | null) => {
        if (typeof nonce === 'string') finish(null, nonce);
        else if (++exhausted === count) finish(new Error('searched every nonce without an answer'));
      });
      worker.on('error', (e) => finish(e instanceof Error ? e : new Error(String(e))));
      worker.on('exit', (code) => {
        if (code !== 0) finish(new Error(`a worker thread stopped (exit code ${code})`));
      });
      pool.push(worker);
    }
  });
}

// ── Talking to LRCLIB ─────────────────────────────────────────────────────────

/** Why a request never got an answer, in a few words. */
function fetchFailure(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'it timed out';
  if (err?.cause?.code) return err.cause.code;
  return err?.message || String(e);
}

/**
 * An error answer, read the way LRCLIB writes them — `{ message, name,
 * statusCode }` — or as text, which is what its edge sends under load.
 */
async function apiError(res: Response, stage: 'challenge' | 'publish' | 'check'): Promise<LrclibPublishError> {
  const header = res.headers?.get?.('retry-after');
  const retryAfterS = header && /^\d+$/.test(header.trim()) ? parseInt(header, 10) : undefined;
  let name = '';
  let detail = '';
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { name?: unknown; error?: unknown; message?: unknown };
      name = String(body.name ?? body.error ?? '');
      detail = String(body.message ?? '');
    } catch {
      detail = text.trim().slice(0, 200);
    }
  } catch { /* no body */ }

  // A lookup sends nothing, so it has nothing to reassure about.
  const after = stage === 'publish' ? ' Nothing was published.' : stage === 'challenge' ? ' Nothing was sent.' : '';
  const wait = retryAfterS !== undefined ? ` — try again in ${retryAfterS} s` : '';
  const s = res.status;
  if (s === 429) {
    return new LrclibPublishError(`LRCLIB is rate-limiting this connection${wait}.${after}`, 'busy', s, name, retryAfterS);
  }
  if (s === 503) {
    return new LrclibPublishError(`LRCLIB is overloaded right now${wait}.${after}`, 'busy', s, name, retryAfterS);
  }
  if (s === 400 && name === 'IncorrectPublishTokenError') {
    return new LrclibPublishError(
      `LRCLIB turned down the proof-of-work token (it may have expired).${after}`, 'token', s, name);
  }
  if (s === 400) {
    return new LrclibPublishError(
      `LRCLIB rejected the ${stage === 'check' ? 'lookup' : 'entry'}${detail ? `: ${detail}` : ''}.${after}`, 'rejected', s, name);
  }
  if (s >= 500) {
    return new LrclibPublishError(
      stage === 'publish'
        ? `LRCLIB had an internal error (${s}). The lyrics were most likely not published — search lrclib.net for the song before trying again.`
        : `LRCLIB had an internal error (${s}).${after}`,
      'server', s, name);
  }
  return new LrclibPublishError(
    `LRCLIB answered ${s}${name ? ` ${name}` : ''}${detail ? `: ${detail}` : ''}.`
      + (stage === 'publish' ? ' It most likely did not publish them.' : after),
    'rejected', s, name);
}

/** Retry-After plus up to 30% at random, as LRCLIB's docs ask. */
function withJitter(seconds: number): number {
  const ms = Math.max(0, seconds) * 1000;
  return Math.round(ms + Math.random() * ms * 0.3);
}

/** A refusal that says "later", not "no" — and a later short enough to wait for. */
function worthWaiting(e: unknown): e is LrclibPublishError {
  return e instanceof LrclibPublishError && e.code === 'busy' && (e.retryAfterS ?? 1) <= MAX_RETRY_WAIT_S;
}

async function requestChallenge(
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
): Promise<{ prefix: string; target: string }> {
  let res: Response;
  try {
    res = await lrclibFetch(`${LRCLIB_BASE}/api/request-challenge`, {
      method: 'POST', headers, signal: AbortSignal.timeout(CHALLENGE_TIMEOUT_MS),
    }, fetchImpl);
  } catch (e) {
    throw new LrclibPublishError(`Could not reach LRCLIB (${fetchFailure(e)}). Nothing was sent.`, 'network');
  }
  if (!res.ok) throw await apiError(res, 'challenge');
  const body = await res.json().catch(() => null);
  if (!isChallenge(body)) {
    throw new LrclibPublishError(
      'LRCLIB answered the challenge request with something this version of Vybecord does not understand. Nothing was sent.',
      'bad_challenge');
  }
  return body;
}

/**
 * Send one payload: challenge, proof of work, publish — and again on a fresh
 * challenge when LRCLIB says "not now" briefly or turns the token down.
 *
 * Those are the only retries, and both are safe: a 429 or a 503 is answered
 * before the publish is handled, and a refused token means the server never got
 * past checking it. Anything that may have reached the database — a timeout, a
 * dropped connection, a 500 — is reported and left alone, because a second try
 * that also lands is a duplicate revision nobody can remove.
 */
export async function publishPayload(payload: PublishPayload, opts: PublishOptions): Promise<{ attempts: number; solveMs: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const solve = opts.solve ?? ((prefix: string, target: string) => solveChallenge(prefix, target));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const headers = { 'User-Agent': opts.userAgent, Accept: 'application/json' };
  const body = JSON.stringify(payload);
  let solveMs = 0;
  let tokenRetried = false;

  for (let attempt = 1; ; attempt++) {
    let challenge: { prefix: string; target: string };
    try {
      challenge = await requestChallenge(fetchImpl, headers);
    } catch (e) {
      if (attempt < MAX_ATTEMPTS && worthWaiting(e)) {
        await sleep(withJitter(e.retryAfterS ?? 1));
        continue;
      }
      throw e;
    }

    const started = Date.now();
    let nonce: string;
    try {
      nonce = await solve(challenge.prefix, challenge.target);
    } catch (e) {
      throw new LrclibPublishError(
        `Could not solve LRCLIB’s proof-of-work (${(e as Error).message || e}). Nothing was sent.`, 'solve_failed');
    }
    solveMs += Date.now() - started;
    if (!verifyNonce(challenge.prefix, challenge.target, nonce)) {
      throw new LrclibPublishError(
        'The proof-of-work answer did not check out, so it was not sent. Nothing was published.', 'solve_failed');
    }
    log.info(`[PUBLISH] Proof of work solved in ${Date.now() - started} ms (attempt ${attempt})`);

    let res: Response;
    try {
      res = await lrclibFetch(`${LRCLIB_BASE}/api/publish`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'X-Publish-Token': `${challenge.prefix}:${nonce}` },
        body,
        signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      }, fetchImpl);
    } catch (e) {
      throw new LrclibPublishError(
        `LRCLIB did not answer (${fetchFailure(e)}). The lyrics may or may not have been published — `
        + 'search lrclib.net for the song before trying again.',
        'unknown_outcome');
    }
    if (res.ok) return { attempts: attempt, solveMs };

    const err = await apiError(res, 'publish');
    const tokenRefused = err.code === 'token' && !tokenRetried;
    if (attempt < MAX_ATTEMPTS && (worthWaiting(err) || tokenRefused)) {
      if (tokenRefused) tokenRetried = true;
      log.info(`[PUBLISH] LRCLIB answered ${err.status} ${err.apiName || ''} — trying again on a new challenge`);
      if (err.code === 'busy') await sleep(withJitter(err.retryAfterS ?? 1));
      continue;
    }
    throw err;
  }
}

/**
 * What LRCLIB serves for this track today.
 *
 * Not provider.ts's directLookup: that answers null both for "LRCLIB has
 * nothing" and for "LRCLIB could not be reached", and here those mean opposite
 * things — "you would be the first" against "nobody knows".
 *
 * /api/get matches loosely (duration within 2 s, a cached answer) and may name
 * a neighbouring album, so this is a hint for the user, not a verdict — except
 * when LRCLIB's synced lines are exactly these, which makes publishing pointless.
 */
export async function checkLrclib(
  payload: PublishPayload,
  opts: { userAgent: string; fetchImpl?: typeof fetch },
): Promise<RemoteState> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const qs = new URLSearchParams({
    track_name: payload.trackName,
    artist_name: payload.artistName,
    album_name: payload.albumName,
    duration: String(payload.duration),
  });
  let res: Response;
  try {
    res = await lrclibFetch(`${LRCLIB_BASE}/api/get?${qs}`, {
      headers: { 'User-Agent': opts.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    }, fetchImpl);
  } catch (e) {
    return { status: 'unknown', error: `LRCLIB could not be reached (${fetchFailure(e)})` };
  }
  if (res.status === 404) return { status: 'none' };
  if (!res.ok) return { status: 'unknown', error: (await apiError(res, 'check')).message };

  const body = await res.json().catch(() => null) as {
    id?: unknown; albumName?: unknown; duration?: unknown; instrumental?: unknown;
    plainLyrics?: unknown; syncedLyrics?: unknown;
  } | null;
  if (!body || typeof body !== 'object') return { status: 'unknown', error: 'LRCLIB sent an answer that could not be read' };

  const theirs = typeof body.syncedLyrics === 'string' ? analyseLyrics(body.syncedLyrics).synced : '';
  const status = body.instrumental === true ? 'instrumental'
    : theirs ? 'synced'
      : typeof body.plainLyrics === 'string' && body.plainLyrics.trim() ? 'plain'
        : null;
  if (!status) return { status: 'none' };
  return {
    status,
    id: Number(body.id) || 0,
    same: status === 'synced' && theirs === payload.syncedLyrics,
    album: typeof body.albumName === 'string' ? body.albumName : '',
    duration: Number(body.duration) || 0,
  };
}

// ── An entry of the store ─────────────────────────────────────────────────────

/** One publish at a time: two would race for the CPU, and a double click would send twice. */
let inFlight = false;

/**
 * Everything the publish dialog shows: what would go, what stands in the way,
 * and — with `remote` — what LRCLIB holds now.
 */
export async function previewEntry(
  store: PublishStore,
  trackId: number,
  edits: PublishEdits,
  opts: { remote: boolean; userAgent: string; fetchImpl?: typeof fetch },
): Promise<PublishPreview> {
  const entry = store.get(trackId);
  if (!entry) throw new LrclibPublishError('This entry is no longer in your library.', 'invalid');
  const effective = withEdits(entry, edits);
  const prep = preparePublish(effective);
  const problems = [...prep.problems];

  let published: PublishPreview['published'] = null;
  if (entry.lrclib_published_at) {
    const unchanged = !!prep.payload && payloadHash(prep.payload) === entry.lrclib_published_hash;
    published = { at: entry.lrclib_published_at, unchanged };
    if (unchanged) {
      problems.push({ field: 'published', message: 'You already published exactly this version from Vybecord.' });
    }
  }

  let remote: RemoteState | null = null;
  // Asked only of a payload that could go: a lookup for an entry with no album
  // or duration would be answered for a different song.
  if (opts.remote && prep.payload && !problems.length) {
    remote = await checkLrclib(prep.payload, opts);
    if (remote.status !== 'none' && remote.status !== 'unknown' && remote.same) {
      problems.push({ field: 'remote', message: 'LRCLIB already has exactly these lyrics for this song.' });
    }
  }

  return {
    trackId,
    title: String(effective.track_name ?? '').trim(),
    artist: String(effective.artist_name ?? '').trim(),
    album: String(effective.album_name ?? '').trim(),
    duration: effective.duration ?? null,
    timedLines: prep.timedLines,
    ready: problems.length === 0,
    problems,
    warnings: prep.warnings,
    payload: problems.length ? null : prep.payload,
    published,
    remote,
  };
}

/**
 * Publish an entry, after checking it again from scratch.
 *
 * The dialog has checked already, but it checks what it was last told, and the
 * store may have moved since; a public, permanent write is worth one more
 * look. Edits are saved to the store before anything is sent, so My lyrics
 * holds the same album and duration LRCLIB gets — and keeps the correction even
 * if the send then fails.
 */
export async function publishEntry(
  store: PublishStore,
  trackId: number,
  edits: PublishEdits,
  opts: PublishOptions,
): Promise<PublishResult> {
  if (inFlight) throw new LrclibPublishError('Another publish is still running — wait for it to finish.', 'in_progress');
  inFlight = true;
  try {
    const entry = store.get(trackId);
    if (!entry) throw new LrclibPublishError('This entry is no longer in your library.', 'invalid');
    const prep = preparePublish(withEdits(entry, edits));
    if (!prep.payload) throw new LrclibPublishError(prep.problems[0]?.message || 'This entry cannot be published.', 'invalid');
    const hash = payloadHash(prep.payload);
    if (entry.lrclib_published_at && entry.lrclib_published_hash === hash) {
      throw new LrclibPublishError('You already published exactly this version from Vybecord.', 'invalid');
    }

    const changes = changedFields(entry, edits);
    const savedEdits = Object.keys(changes).length > 0;
    if (savedEdits && !store.save(trackId, changes)) {
      throw new LrclibPublishError('Could not save the album and duration to My lyrics, so nothing was sent.', 'invalid');
    }

    const { trackName, artistName } = prep.payload;
    log.info(`[PUBLISH] Publishing "${trackName}" by "${artistName}" to LRCLIB (entry #${trackId})`);
    const outcome = await publishPayload(prep.payload, opts);
    const publishedAt = new Date().toISOString();
    if (!store.markPublished(trackId, hash, publishedAt)) {
      // Published all the same — only the reminder against sending it twice is lost.
      log.warn(`[PUBLISH] Published entry #${trackId}, but could not record it in the store`);
    }
    log.info(`[PUBLISH] Published "${trackName}" (${outcome.attempts} attempt(s), ${outcome.solveMs} ms of proof of work)`);
    return { ok: true, publishedAt, attempts: outcome.attempts, solveMs: outcome.solveMs, savedEdits };
  } catch (e) {
    log.warn(`[PUBLISH] Entry #${trackId} not published: ${(e as Error).message}`);
    throw e;
  } finally {
    inFlight = false;
  }
}
