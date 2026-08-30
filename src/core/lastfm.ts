/**
 * Last.fm API integration — scrobbling only.
 *
 * The app sends plays and nothing else: Last.fm is never asked about a track,
 * so no metadata, album art or name correction comes back from it. Lyrics and
 * cover art are resolved entirely by the other providers.
 *
 * Scrobbling follows Last.fm's own rule: a track longer than 30 seconds, played
 * for half its length or four minutes — whichever comes first. "Played" means
 * time the audio actually moved, so pausing a song halfway and coming back to it
 * still scrobbles once, and leaving it paused all afternoon never does.
 *
 * A scrobble that cannot be delivered (offline, Last.fm down, session expired)
 * is written to `lastfm-queue.json` and re-sent in batches on the next track or
 * the next launch, so a dropped connection costs nothing.
 *
 * Requires LASTFM_API_KEY + LASTFM_API_SECRET + session key (one-time auth).
 *
 * API keys: https://www.last.fm/api/account/create
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('LastFM');

const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0';
const LASTFM_TIMEOUT = 5_000;
const USER_AGENT = 'VybecordTS/1.0';

/** Last.fm refuses anything shorter, so a short track is never worth a request. */
const MIN_TRACK_SECONDS = 30;
/** The "or four minutes, whichever comes first" half of the scrobble rule. */
const SCROBBLE_CAP_SECONDS = 240;
/**
 * Ceiling on one step of the listening clock. A poll tick is well under a
 * second; anything longer means the app was suspended (lid closed, machine
 * asleep), and time the machine spent asleep is not time the user spent
 * listening to the song that happened to be loaded.
 */
const MAX_TICK_MS = 10_000;

/** `track.scrobble` accepts 50 plays per call; the backlog keeps a long session. */
const QUEUE_BATCH = 50;
const QUEUE_MAX = 500;

/** Body error codes worth another attempt later. Everything else is terminal. */
const RETRYABLE_ERRORS = new Set([8, 11, 16, 29]);
/** "Invalid session key — please re-authenticate." */
const ERR_INVALID_SESSION = 9;

let apiKey: string | null = null;
let apiSecret: string | null = null;
let sessionKey: string | null = null;
let sessionUser: string | null = null;
let sessionPath: string | null = null;
let scrobbleEnabled = false;

/**
 * Initialize with an API key + shared secret. Both are required: every
 * scrobbling method is a signed call, and signing needs the secret.
 *
 * Safe to call again when the credentials change in the settings, which is what
 * spares the user a restart after pasting them in. Swapping in a *different* key
 * drops the stored session with it: that session belongs to the old API account
 * and would only ever earn an "invalid session key" back.
 */
export function initLastFm(key: string | undefined, secret?: string, cfgDir?: string): boolean {
  const previousKey = apiKey;
  const previousSecret = apiSecret;
  const nextKey = (key ?? '').trim();
  const nextSecret = (secret ?? '').trim();

  apiKey = nextKey.length >= 10 ? nextKey : null;
  apiSecret = nextSecret.length >= 10 ? nextSecret : null;

  if (cfgDir) {
    sessionPath = path.join(cfgDir, 'lastfm-session.txt');
    queuePath = path.join(cfgDir, 'lastfm-queue.json');
  }

  if (!apiKey) {
    if (previousKey) log.info('Last.fm API key removed — scrobbling is off');
    else log.info('No LASTFM_API_KEY found — Last.fm scrobbling disabled (optional)');
    forgetSession(false);
    return false;
  }

  if (previousKey && (previousKey !== apiKey || previousSecret !== apiSecret)) {
    forgetSession(true);
  }
  if (previousKey !== apiKey) log.info('Last.fm API initialized ✓');

  if (!apiSecret) {
    // The key on its own buys nothing: every scrobbling method is a signed call,
    // and signing needs the secret.
    forgetSession(false);
    log.info('No Last.fm shared secret — scrobbling disabled');
    return false;
  }

  loadSession();
  loadQueue();

  if (sessionKey) {
    log.info(`Last.fm scrobbling enabled ✓${sessionUser ? ` (as ${sessionUser})` : ''}`);
    void flushQueue();
  } else {
    log.info('Last.fm scrobbling available but not authenticated — connect it from the Last.fm page');
  }
  return true;
}

// ══════════════════════════════════════════════════
// ── Signed API calls ──
// ══════════════════════════════════════════════════

interface ApiResult {
  ok: boolean;
  /** Whether the caller should hold on to the payload and try again later. */
  retry: boolean;
  data?: Record<string, unknown>;
}

/**
 * Build an API method signature (md5 of the sorted params + secret).
 *
 * `format` and `callback` are excluded because the spec excludes them: Last.fm
 * rebuilds the signature from everything it received *except* those two, so
 * signing them is the standard way to get "Invalid method signature supplied"
 * (error 13) back on every single call.
 */
function apiSig(params: Record<string, string>): string {
  const parts: string[] = [];
  for (const key of Object.keys(params).sort()) {
    if (key === 'format' || key === 'callback' || key === 'api_sig') continue;
    parts.push(key, params[key]);
  }
  return createHash('md5').update(parts.join('') + apiSecret!, 'utf-8').digest('hex');
}

/** Read Last.fm's answer, whichever of the two shapes it arrives in. */
function readResult(status: number, data: Record<string, unknown> | null): ApiResult {
  const code = typeof data?.error === 'number' ? data.error as number : 0;
  if (status >= 200 && status < 300 && !code) return { ok: true, retry: false, data: data ?? {} };

  if (code === ERR_INVALID_SESSION) {
    log.warn('[SCROBBLE] Last.fm no longer accepts the saved session — reconnect from the Last.fm page');
    forgetSession(true);
    // Held, not dropped: these plays are still valid once the user reconnects.
    return { ok: false, retry: true };
  }
  return { ok: false, retry: RETRYABLE_ERRORS.has(code) || status === 429 || status >= 500 };
}

/** Make a signed POST to the Last.fm API. Never throws — failures come back as a result. */
async function signedPost(params: Record<string, string>): Promise<ApiResult> {
  if (!apiKey || !apiSecret || !sessionKey) return { ok: false, retry: true };

  const signed: Record<string, string> = { ...params, api_key: apiKey, sk: sessionKey };
  const body = new URLSearchParams({ ...signed, api_sig: apiSig(signed), format: 'json' });

  try {
    const resp = await fetch(LASTFM_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body,
      signal: AbortSignal.timeout(LASTFM_TIMEOUT),
    });
    const data = await resp.json().catch(() => null) as Record<string, unknown> | null;
    const result = readResult(resp.status, data);
    if (!result.ok) {
      const message = typeof data?.message === 'string' ? data.message : `HTTP ${resp.status}`;
      log.warn(`[SCROBBLE] ${params.method} failed: ${message}`);
    }
    return result;
  } catch (e: unknown) {
    // Offline, DNS, timeout — all worth another go once there is a network again.
    log.debug(`[SCROBBLE] ${params.method} error: ${(e as Error).message}`);
    return { ok: false, retry: true };
  }
}

// ══════════════════════════════════════════════════
// ── Session ──
// ══════════════════════════════════════════════════

/** Read the stored session key (and the account it belongs to), once. */
function loadSession(): void {
  if (sessionKey || !sessionPath) return;
  try {
    const [key = '', user = ''] = fs.readFileSync(sessionPath, 'utf-8').split('\n');
    if (key.trim().length >= 10) {
      sessionKey = key.trim();
      sessionUser = user.trim() || null;
      scrobbleEnabled = true;
    }
  } catch { /* never connected, or the file went away — either way, not connected */ }
}

function saveSession(): void {
  if (!sessionPath || !sessionKey) return;
  try {
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    // Written synchronously and owner-only: it is a credential, and the app is
    // routinely closed within a second of the exchange completing.
    fs.writeFileSync(sessionPath, `${sessionKey}\n${sessionUser ?? ''}`, { encoding: 'utf-8', mode: 0o600 });
  } catch (e: unknown) {
    log.error(`Failed to save Last.fm session: ${(e as Error).message}`);
  }
}

/** Drop the session. `erase` also removes it from disk, for a key that is no good. */
function forgetSession(erase: boolean): void {
  sessionKey = null;
  sessionUser = null;
  scrobbleEnabled = false;
  if (erase && sessionPath) {
    try { fs.rmSync(sessionPath, { force: true }); } catch { /* already gone */ }
  }
}

/** Everything the settings page needs to describe the connection. */
export function scrobbleStatus(): {
  scrobbling: boolean;
  canAuth: boolean;
  configured: boolean;
  user: string | null;
  pending: number;
} {
  return {
    scrobbling: scrobbleEnabled,
    canAuth: !!(apiKey && apiSecret && !sessionKey),
    configured: !!(apiKey && apiSecret),
    user: sessionUser,
    pending: queue.length,
  };
}

/** Check if scrobbling is ready. */
export function isScrobbleEnabled(): boolean {
  return scrobbleEnabled;
}

/**
 * Desktop auth, step 1: ask Last.fm for a request token.
 *
 * The web flow this replaced sent the user to Last.fm with a `cb=` callback URL
 * and caught the redirect on the app's own HTTP server. There is no server to
 * catch it now, so the app uses Last.fm's desktop flow instead: get a token up
 * front, have the user approve *that token* in their browser, then exchange it.
 * No callback, and nothing listening on a port.
 */
export async function requestAuthToken(): Promise<string | null> {
  if (!apiKey || !apiSecret) return null;
  const params = new URLSearchParams({ method: 'auth.getToken', api_key: apiKey, format: 'json' });
  try {
    const resp = await fetch(`${LASTFM_BASE}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(LASTFM_TIMEOUT),
    });
    if (!resp.ok) {
      log.warn(`[SCROBBLE] auth.getToken failed: ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as { token?: string };
    return data.token ?? null;
  } catch (e: unknown) {
    log.warn(`[SCROBBLE] auth.getToken error: ${(e as Error).message}`);
    return null;
  }
}

/** Desktop auth, step 2: the page the user has to approve in their browser. */
export function getAuthUrlForToken(token: string): string | null {
  if (!apiKey) return null;
  return `https://www.last.fm/api/auth/?api_key=${apiKey}&token=${encodeURIComponent(token)}`;
}

/** Complete the auth flow: exchange token for session key. */
export async function completeAuth(token: string): Promise<boolean> {
  if (!apiKey || !apiSecret) return false;
  const params: Record<string, string> = { method: 'auth.getSession', api_key: apiKey, token };
  const query = new URLSearchParams({ ...params, api_sig: apiSig(params), format: 'json' });

  try {
    const resp = await fetch(`${LASTFM_BASE}?${query}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(LASTFM_TIMEOUT),
    });
    const data = await resp.json().catch(() => null) as
      { session?: { key?: string; name?: string }; error?: number; message?: string } | null;

    if (!resp.ok || !data?.session?.key) {
      const why = data?.message || `HTTP ${resp.status}`;
      log.warn(`[SCROBBLE] auth.getSession failed: ${why}`);
      return false;
    }

    sessionKey = data.session.key;
    sessionUser = data.session.name ?? null;
    scrobbleEnabled = true;
    saveSession();
    loadQueue();

    log.info(`[SCROBBLE] Authenticated as "${sessionUser ?? 'unknown'}" ✓`);
    // Anything banked while disconnected belongs on the account that just
    // arrived — a re-auth after an expired session is exactly this case.
    void flushQueue();
    return true;
  } catch (e: unknown) {
    log.warn(`[SCROBBLE] auth.getSession error: ${(e as Error).message}`);
    return false;
  }
}

/** Disconnect Last.fm scrobbling (remove session key). */
export function disconnectScrobble(): void {
  current = null;
  forgetSession(true);
  log.info('[SCROBBLE] Disconnected');
}

// ══════════════════════════════════════════════════
// ── Offline queue ──
// ══════════════════════════════════════════════════

interface QueuedScrobble {
  track: string;
  artist: string;
  album: string;
  duration: number;
  timestamp: number;
}

let queue: QueuedScrobble[] = [];
let queuePath: string | null = null;
let queueLoaded = false;
let flushing = false;

function loadQueue(): void {
  if (queueLoaded || !queuePath) return;
  queueLoaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(queuePath, 'utf-8')) as QueuedScrobble[];
    if (!Array.isArray(parsed)) return;
    queue = parsed.filter(e => e?.track && e?.artist && e?.timestamp > 0).slice(-QUEUE_MAX);
    if (queue.length) log.info(`[SCROBBLE] ${queue.length} scrobble(s) held over from a previous session`);
  } catch { /* nothing queued, or the file is unreadable — start clean */ }
}

function saveQueue(): void {
  if (!queuePath) return;
  try {
    if (!queue.length) fs.rmSync(queuePath, { force: true });
    else fs.writeFileSync(queuePath, JSON.stringify(queue), 'utf-8');
  } catch (e: unknown) {
    log.warn(`[SCROBBLE] Could not write the queue: ${(e as Error).message}`);
  }
}

function enqueue(entry: QueuedScrobble): void {
  queue.push(entry);
  if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
  saveQueue();
}

/** Send one batch. Last.fm answers with how many of them it actually took. */
async function submitBatch(batch: QueuedScrobble[]): Promise<ApiResult> {
  const params: Record<string, string> = { method: 'track.scrobble' };
  batch.forEach((e, i) => {
    params[`artist[${i}]`] = e.artist;
    params[`track[${i}]`] = e.track;
    params[`timestamp[${i}]`] = String(e.timestamp);
    // Empty or unknown values are left out rather than sent blank: they are
    // optional, and a blank album only ever confuses Last.fm's matching.
    if (e.album) params[`album[${i}]`] = e.album;
    if (e.duration > 0) params[`duration[${i}]`] = String(e.duration);
  });

  const result = await signedPost(params);
  if (!result.ok) return result;

  const attr = (result.data?.scrobbles as { '@attr'?: { accepted?: number; ignored?: number } } | undefined)?.['@attr'];
  const ignored = Number(attr?.ignored ?? 0);
  const accepted = Number(attr?.accepted ?? batch.length);
  const first = batch[0];
  const label = batch.length === 1 ? `"${first.track}" by ${first.artist}` : `${batch.length} tracks`;
  if (ignored > 0) log.warn(`[SCROBBLE] Last.fm ignored ${ignored} of ${batch.length} (${label})`);
  if (accepted > 0) log.info(`[SCROBBLE] Scrobbled ${label}`);
  return result;
}

/**
 * Drain the backlog, oldest first.
 *
 * A batch Last.fm refuses for a reason time will not fix (bad metadata) is
 * dropped so it cannot block the ones behind it; anything transient — offline,
 * rate limited, session expired — is left in place for the next attempt.
 */
async function flushQueue(): Promise<void> {
  if (flushing || !scrobbleEnabled || !queue.length) return;
  flushing = true;
  try {
    while (queue.length && scrobbleEnabled) {
      const batch = queue.slice(0, QUEUE_BATCH);
      const result = await submitBatch(batch);
      if (!result.ok && result.retry) break;
      /*
       * Drop the entries that were actually sent, by identity.
       *
       * Removing batch.length from the front assumes the front has not moved,
       * and it can: enqueue() trims the queue from the front whenever a new
       * play pushes it past QUEUE_MAX, which is exactly the state a drain
       * starts in. One play earned during a batch's flight shifted everything
       * by one, and the splice then discarded a scrobble that had never left.
       */
      const sent = new Set(batch);
      queue = queue.filter(e => !sent.has(e));
      saveQueue();
    }
  } finally {
    flushing = false;
  }
}

// ══════════════════════════════════════════════════
// ── Scrobbling ──
// ══════════════════════════════════════════════════

interface ScrobbleState {
  key: string;
  track: string;
  artist: string;
  album: string;
  /** Seconds; 0 when the source did not say. */
  duration: number;
  /** Unix seconds — when this play started, which is what Last.fm records. */
  timestamp: number;
  /** Listening time banked so far. */
  playedMs: number;
  /** Date.now() of the last tick; 0 while paused. */
  lastTickAt: number;
  /** Last progress_ms seen; -1 when the source has not reported one yet. */
  lastProgressMs: number;
  done: boolean;
}

let current: ScrobbleState | null = null;

/** Last.fm matches on one artist, and the rest of the app splits the same way. */
function primaryArtist(artist: string): string {
  return artist.split(',')[0].trim() || artist.trim();
}

/** How much listening this track has to earn before it counts. */
function targetMs(s: ScrobbleState): number {
  // No duration (a stream, or a source that never said) — the four-minute rule
  // is the only half of the test that can be applied.
  if (s.duration <= 0) return SCROBBLE_CAP_SECONDS * 1_000;
  // Last.fm rejects anything this short, so never spend a request on it.
  if (s.duration < MIN_TRACK_SECONDS) return Infinity;
  return Math.min(s.duration / 2, SCROBBLE_CAP_SECONDS) * 1_000;
}

/**
 * Advance the listening clock.
 *
 * Credit is the *smaller* of how far the track moved and how much wall time
 * passed, which is what makes this survive the two ways playback lies: a paused
 * player reports the same position forever (no movement, no credit), and seeking
 * ten minutes ahead moves the position without anyone having heard it (capped at
 * the wall time). Seeking backwards credits nothing rather than going negative.
 */
function advance(s: ScrobbleState, progressMs?: number): void {
  const now = Date.now();
  if (s.lastTickAt) {
    const wall = Math.min(now - s.lastTickAt, MAX_TICK_MS);
    const moved = progressMs !== undefined && s.lastProgressMs >= 0
      ? progressMs - s.lastProgressMs
      : wall;
    s.playedMs += Math.max(0, Math.min(moved, wall));
  }
  s.lastTickAt = now;
  if (progressMs !== undefined) s.lastProgressMs = progressMs;
}

/**
 * Call when a new track starts playing. Sends updateNowPlaying and starts the
 * listening clock — or picks the previous one back up, when this is the same
 * song resuming after a pause.
 */
export function scrobbleTrackStart(track: string, artist: string, album: string, durationMs: number): void {
  if (!scrobbleEnabled) return;

  const name = track.trim();
  const who = primaryArtist(artist);
  if (!name || !who) return; // Last.fm requires both, and rejects the call without them

  const key = `${who.toLowerCase()}|${name.toLowerCase()}`;

  /*
   * A pause is not a new play. scrobblePause() parks the state instead of
   * dropping it, so the second half of an interrupted song still counts towards
   * the same scrobble rather than restarting the clock from zero — which used to
   * mean a song paused halfway never scrobbled at all. A track that already
   * scrobbled falls through on purpose: hearing it a second time is a second play.
   */
  if (current && !current.done && current.key === key) {
    current.lastTickAt = Date.now();
    current.lastProgressMs = -1;
    sendNowPlaying(current);
    return;
  }

  checkAndScrobble(); // finalise the outgoing track if it earned it
  current = {
    key,
    track: name,
    artist: who,
    album: album.trim(),
    duration: durationMs > 0 ? Math.round(durationMs / 1_000) : 0,
    timestamp: Math.round(Date.now() / 1_000),
    playedMs: 0,
    lastTickAt: Date.now(),
    lastProgressMs: -1,
    done: false,
  };

  sendNowPlaying(current);
  void flushQueue(); // a new song is as good a moment as any to retry the backlog
}

function sendNowPlaying(s: ScrobbleState): void {
  const params: Record<string, string> = {
    method: 'track.updateNowPlaying',
    track: s.track,
    artist: s.artist,
  };
  if (s.album) params.album = s.album;
  if (s.duration > 0) params.duration = String(s.duration);

  void signedPost(params).then(r => {
    if (r.ok) log.debug(`[SCROBBLE] Now Playing: "${s.track}" by ${s.artist}`);
  });
}

/**
 * Call on every progress sync. Advances the listening clock with the position
 * the source just reported and queues the scrobble once it is earned.
 */
export function checkAndScrobble(progressMs?: number): void {
  const s = current;
  if (!s || s.done || !scrobbleEnabled) return;

  advance(s, progressMs);
  if (s.playedMs < targetMs(s)) return;

  s.done = true;
  enqueue({
    track: s.track,
    artist: s.artist,
    album: s.album,
    duration: s.duration,
    timestamp: s.timestamp,
  });
  void flushQueue();
}

/**
 * Call when playback pauses. Stops the listening clock but keeps the play open,
 * so coming back to the song continues it instead of starting over.
 */
export function scrobblePause(): void {
  if (!current) return;
  checkAndScrobble();
  current.lastTickAt = 0;
  current.lastProgressMs = -1;
}

/** Call on shutdown. Finalises the pending scrobble and closes the play. */
export function scrobbleTrackEnd(): void {
  checkAndScrobble();
  current = null;
}
