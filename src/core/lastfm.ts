/**
 * Last.fm API integration — metadata autocorrection + album art + scrobbling.
 *
 * Uses `track.getInfo` with `autocorrect=1` to fix misspelled artist/track names
 * from browser sources (YouTube, SoundCloud) before lyrics lookup.
 * Also provides album art as an additional source.
 *
 * Scrobbling: Sends `track.updateNowPlaying` on track start and `track.scrobble`
 * after the user has listened for >50% of the track or >4 minutes (Last.fm rules).
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

let apiKey: string | null = null;
let apiSecret: string | null = null;
let sessionKey: string | null = null;
let configDir: string | null = null;
let scrobbleEnabled = false;

// Scrobble state (current track timing)
let scrobbleTrack: { track: string; artist: string; album: string; duration: number; startedAt: number } | null = null;
let scrobbled = false; // Has the current track been scrobbled?
let nowPlayingSent = false;

/** Corrected metadata returned by Last.fm. */
export interface LastFmCorrection {
  track: string;
  artist: string;
  album?: string;
  albumArtUrl?: string;
  durationMs?: number;
}

// In-memory cache: "rawTrack|rawArtist" → correction (or null if no result)
const correctionCache = new Map<string, LastFmCorrection | null>();
const MAX_CACHE = 200;

/** Initialize with an API key (+ optional secret for scrobbling). Call once at startup. */
export function initLastFm(key: string | undefined, secret?: string, cfgDir?: string): boolean {
  if (key && key.length >= 10) {
    apiKey = key;
    log.info('Last.fm API initialized ✓');
  } else {
    log.info('No LASTFM_API_KEY found — Last.fm autocorrect disabled (optional)');
    return false;
  }
  if (secret && secret.length >= 10 && cfgDir) {
    apiSecret = secret;
    configDir = cfgDir;
    // Load persisted session key
    const skPath = path.join(cfgDir, 'lastfm-session.txt');
    try {
      if (fs.existsSync(skPath)) {
        const sk = fs.readFileSync(skPath, 'utf-8').trim();
        if (sk.length >= 10) {
          sessionKey = sk;
          scrobbleEnabled = true;
          log.info('Last.fm scrobbling enabled ✓ (session key loaded)');
        }
      }
    } catch { /* ignore */ }
    if (!sessionKey) {
      log.info('Last.fm scrobbling available but not authenticated — use /lastfm-auth to connect');
    }
  }
  return true;
}

/** Check if Last.fm is available. */
export function hasLastFm(): boolean {
  return apiKey !== null;
}

interface LastFmTrackInfo {
  track?: {
    name?: string;
    artist?: { name?: string };
    album?: {
      title?: string;
      image?: { '#text'?: string; size?: string }[];
    };
    duration?: string;
  };
}

/**
 * Query Last.fm `track.getInfo` with autocorrect=1.
 * Returns corrected track/artist names + album info, or null.
 * Results are cached to avoid repeated API calls for the same track.
 */
export async function getCorrection(
  rawTrack: string,
  rawArtist: string,
  signal?: AbortSignal,
): Promise<LastFmCorrection | null> {
  if (!apiKey) return null;

  const cacheKey = `${rawTrack.toLowerCase()}|${rawArtist.toLowerCase()}`;
  if (correctionCache.has(cacheKey)) {
    return correctionCache.get(cacheKey) ?? null;
  }

  try {
    const timeoutSignal = AbortSignal.timeout(LASTFM_TIMEOUT);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    const params = new URLSearchParams({
      method: 'track.getInfo',
      api_key: apiKey,
      artist: rawArtist,
      track: rawTrack,
      autocorrect: '1',
      format: 'json',
    });

    const resp = await fetch(`${LASTFM_BASE}?${params}`, {
      headers: { 'User-Agent': 'VybecordTS/1.0' },
      signal: combinedSignal,
    });

    if (!resp.ok) {
      correctionCache.set(cacheKey, null);
      return null;
    }

    const data = (await resp.json()) as LastFmTrackInfo;
    const t = data.track;
    if (!t?.name || !t?.artist?.name) {
      correctionCache.set(cacheKey, null);
      return null;
    }

    // Extract album art (prefer extralarge → large)
    let albumArtUrl: string | undefined;
    if (t.album?.image?.length) {
      for (const size of ['extralarge', 'large', 'medium']) {
        const img = t.album.image.find(i => i.size === size);
        if (img?.['#text'] && !img['#text'].includes('2a96cbd8b46e442fc41c2b86b821562f')) {
          // Skip Last.fm's default "no image" placeholder
          albumArtUrl = img['#text'];
          break;
        }
      }
    }

    const correction: LastFmCorrection = {
      track: t.name,
      artist: t.artist.name,
      album: t.album?.title || undefined,
      albumArtUrl,
      durationMs: t.duration ? parseInt(t.duration, 10) : undefined,
    };

    // Only log when something actually changed
    const trackChanged = correction.track.toLowerCase() !== rawTrack.toLowerCase();
    const artistChanged = correction.artist.toLowerCase() !== rawArtist.toLowerCase();
    if (trackChanged || artistChanged) {
      log.info(`[CORRECT] "${rawArtist} - ${rawTrack}" → "${correction.artist} - ${correction.track}"`);
    }

    // Evict before inserting to never exceed MAX_CACHE
    if (correctionCache.size >= MAX_CACHE) {
      const firstKey = correctionCache.keys().next().value;
      if (firstKey) correctionCache.delete(firstKey);
    }
    correctionCache.set(cacheKey, correction);

    return correction;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════
// ── Last.fm Scrobbling ──
// ══════════════════════════════════════════════════

/** Build an API method signature (md5 of sorted params + secret). */
function apiSig(params: Record<string, string>): string {
  const sorted = Object.keys(params).sort();
  let str = '';
  for (const k of sorted) str += k + params[k];
  str += apiSecret!;
  return createHash('md5').update(str, 'utf-8').digest('hex');
}

/** Make a signed POST to Last.fm API. */
async function signedPost(params: Record<string, string>): Promise<Record<string, unknown> | null> {
  if (!apiKey || !apiSecret || !sessionKey) return null;
  const p: Record<string, string> = { ...params, api_key: apiKey, sk: sessionKey, format: 'json' };
  p.api_sig = apiSig(p);
  try {
    const body = new URLSearchParams(p).toString();
    const resp = await fetch(LASTFM_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(LASTFM_TIMEOUT),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      log.warn(`[SCROBBLE] ${params.method} failed: ${resp.status} ${text.slice(0, 200)}`);
      return null;
    }
    return (await resp.json()) as Record<string, unknown>;
  } catch (e: unknown) {
    log.warn(`[SCROBBLE] ${params.method} error: ${(e as Error).message}`);
    return null;
  }
}

/** Check if scrobbling is ready. */
export function isScrobbleEnabled(): boolean {
  return scrobbleEnabled;
}

/** Check if Last.fm auth is possible (has api key + secret but no session). */
export function canAuth(): boolean {
  return !!(apiKey && apiSecret && !sessionKey);
}

/** Get the URL to redirect the user to for Last.fm authentication. */
export function getAuthUrl(callbackUrl: string): string | null {
  if (!apiKey || !apiSecret) return null;
  return `https://www.last.fm/api/auth/?api_key=${apiKey}&cb=${encodeURIComponent(callbackUrl)}`;
}

/** Complete the auth flow: exchange token for session key. */
export async function completeAuth(token: string): Promise<boolean> {
  if (!apiKey || !apiSecret) return false;
  const params: Record<string, string> = {
    method: 'auth.getSession',
    api_key: apiKey,
    token,
  };
  params.api_sig = apiSig(params);
  params.format = 'json';

  try {
    const resp = await fetch(`${LASTFM_BASE}?${new URLSearchParams(params)}`, {
      signal: AbortSignal.timeout(LASTFM_TIMEOUT),
    });
    if (!resp.ok) {
      log.warn(`[SCROBBLE] auth.getSession failed: ${resp.status}`);
      return false;
    }
    const data = (await resp.json()) as { session?: { key?: string; name?: string } };
    if (!data.session?.key) {
      log.warn('[SCROBBLE] auth.getSession returned no session key');
      return false;
    }
    sessionKey = data.session.key;
    scrobbleEnabled = true;

    // Persist session key
    if (configDir) {
      const skPath = path.join(configDir, 'lastfm-session.txt');
      fs.mkdirSync(path.dirname(skPath), { recursive: true });
      fs.writeFileSync(skPath, sessionKey, 'utf-8');
    }

    log.info(`[SCROBBLE] Authenticated as "${data.session.name}" ✓`);
    return true;
  } catch (e: unknown) {
    log.warn(`[SCROBBLE] auth.getSession error: ${(e as Error).message}`);
    return false;
  }
}

/** Disconnect Last.fm scrobbling (remove session key). */
export function disconnectScrobble(): void {
  sessionKey = null;
  scrobbleEnabled = false;
  if (configDir) {
    const skPath = path.join(configDir, 'lastfm-session.txt');
    try { fs.unlinkSync(skPath); } catch { /* ignore */ }
  }
  log.info('[SCROBBLE] Disconnected');
}

/** Call when a new track starts playing. Sends updateNowPlaying + starts scrobble timer. */
export function scrobbleTrackStart(track: string, artist: string, album: string, durationMs: number): void {
  if (!scrobbleEnabled) return;

  // Finalise previous track
  checkAndScrobble();

  scrobbleTrack = {
    track,
    artist: artist.split(/[,&]/)[0].trim(), // Last.fm expects primary artist
    album,
    duration: Math.round(durationMs / 1000),
    startedAt: Math.round(Date.now() / 1000),
  };
  scrobbled = false;
  nowPlayingSent = false;

  // Send updateNowPlaying (fire-and-forget)
  signedPost({
    method: 'track.updateNowPlaying',
    track: scrobbleTrack.track,
    artist: scrobbleTrack.artist,
    album: scrobbleTrack.album,
    duration: String(scrobbleTrack.duration),
  }).then(r => {
    if (r) {
      nowPlayingSent = true;
      log.debug(`[SCROBBLE] Now Playing: "${track}" by ${artist}`);
    }
  });
}

/** Call periodically (e.g., on progress sync) to check if it's time to scrobble. */
export function checkAndScrobble(): void {
  if (!scrobbleEnabled || !scrobbleTrack || scrobbled) return;

  const elapsed = Math.round(Date.now() / 1000) - scrobbleTrack.startedAt;
  const halfDuration = scrobbleTrack.duration > 0 ? scrobbleTrack.duration / 2 : Infinity;

  // Last.fm scrobble rule: listened for >50% of track OR >4 minutes (240s)
  if (elapsed >= Math.min(halfDuration, 240)) {
    scrobbled = true;
    signedPost({
      method: 'track.scrobble',
      'timestamp[0]': String(scrobbleTrack.startedAt),
      'track[0]': scrobbleTrack.track,
      'artist[0]': scrobbleTrack.artist,
      'album[0]': scrobbleTrack.album,
      'duration[0]': String(scrobbleTrack.duration),
    }).then(r => {
      if (r) {
        log.info(`[SCROBBLE] Scrobbled: "${scrobbleTrack!.track}" by ${scrobbleTrack!.artist} (${elapsed}s)`);
      }
    });
  }
}

/** Call when playback stops. Finalises pending scrobble. */
export function scrobbleTrackEnd(): void {
  checkAndScrobble();
  scrobbleTrack = null;
  scrobbled = false;
  nowPlayingSent = false;
}
