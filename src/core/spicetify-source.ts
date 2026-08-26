/**
 * Spicetify push-based track source.
 *
 * Receives real-time track data from the VybecordTS Spicetify extension
 * via HTTP POST. Far superior to SMTC for Spotify:
 *   - Event-driven (instant track change, no polling delay)
 *   - Full Spotify metadata (album art CDN, all artists, URIs)
 *   - Accurate progress (no SMTC delay compensation)
 *   - Eliminates need for Deezer/iTunes/Last.fm metadata enrichment
 *
 * Falls back to SMTC automatically if the extension stops pushing (>10s stale).
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import { asBool, asNonNegativeInt, asRecord, asText, asUrl } from './utils.js';
import type { TrackData } from './types.js';

const log = createLogger('Spicetify');

/** Shape of JSON pushed by the Spicetify extension. */
export interface SpicetifyPayload {
  track_id: string;
  uri: string;
  track_name: string;
  artist_name: string;
  album_name: string;
  album_art_url: string;
  duration_ms: number;
  progress_ms: number;
  is_playing: boolean;
  spotify_url: string;
  artist_url: string;
  album_url: string;
  context_name: string;
  context_url: string;
  context_type: string;
  artist_art_url?: string;
  is_shuffle?: boolean;
  repeat_mode?: string;
  is_local?: boolean;
  /** The Spotify client is in a private session — see isPrivateSession. */
  private_session?: boolean;
}

/**
 * Coerce a push into the shape above, whatever actually arrived.
 *
 * The interface describes what the shipped Spicetify extension sends; this is
 * what makes it true of the object the rest of the app then handles. See the
 * coercion helpers in utils.ts for why the *type* is the part that matters.
 */
export function normalizeSpicetifyPayload(raw: unknown): SpicetifyPayload {
  const d = asRecord(raw);
  const repeat = asText(d.repeat_mode, 16);
  return {
    track_id: asText(d.track_id, 200),
    uri: asText(d.uri, 200),
    track_name: asText(d.track_name),
    artist_name: asText(d.artist_name),
    album_name: asText(d.album_name),
    // Spotify hands local files a `spotify:localfileimage:` URI, which is
    // recognised downstream and swapped for something Discord can fetch.
    album_art_url: asUrl(d.album_art_url, ['spotify:']),
    duration_ms: asNonNegativeInt(d.duration_ms),
    progress_ms: asNonNegativeInt(d.progress_ms),
    is_playing: asBool(d.is_playing),
    spotify_url: asUrl(d.spotify_url),
    artist_url: asUrl(d.artist_url),
    album_url: asUrl(d.album_url),
    context_name: asText(d.context_name),
    context_url: asUrl(d.context_url),
    context_type: asText(d.context_type, 32),
    artist_art_url: asUrl(d.artist_art_url),
    is_shuffle: asBool(d.is_shuffle),
    repeat_mode: repeat === 'track' || repeat === 'context' ? repeat : 'off',
    is_local: asBool(d.is_local),
    private_session: asBool(d.private_session),
  };
}

const STALE_THRESHOLD_MS = 10_000; // Data older than 10s = extension disconnected

/**
 * How long the private-session flag is trusted after the last push.
 *
 * Longer than the playback staleness above, and deliberately so: those ten
 * seconds answer "is the extension still driving the presence", which stops
 * being true the moment music pauses. Whether the user asked Spotify not to
 * broadcast does not stop being true then — it is a setting, not a playback
 * state, and forgetting it after ten seconds of silence would put the presence
 * back up the instant they pressed play.
 *
 * It does expire, though. Without that, an extension removed or a client closed
 * mid-session would leave the flag stuck on and Spotify permanently unable to
 * show a presence again. A minute is long enough to cover any pause worth
 * covering — a resumed track pushes within milliseconds — and short enough that
 * a genuinely departed extension is forgotten quickly.
 */
const PRIVATE_TTL_MS = 60_000;

export class SpicetifySource {
  private latestData: SpicetifyPayload | null = null;
  private receivedAt = 0;
  private _wasActive = false; // Track activation for logging
  private privateSession = false;

  /**
   * Ingest a push from the Spicetify extension.
   * Called by the web server on POST /api/spicetify.
   *
   * Takes `unknown` because that is what comes off the socket, and returns the
   * coerced payload so the caller works from the same checked object this
   * source stored rather than from the raw one.
   */
  update(raw: unknown): SpicetifyPayload {
    const data = normalizeSpicetifyPayload(raw);
    this.latestData = data;
    this.receivedAt = performance.now();
    this.privateSession = data.private_session ?? false;

    if (!this._wasActive) {
      this._wasActive = true;
      log.info('Spicetify extension connected ✓ — using as primary Spotify source');
    }
    return data;
  }

  /**
   * Convert the latest push into a TrackData.
   * Returns null if paused, no data, or data is stale.
   */
  getCurrentTrack(): TrackData | null {
    if (!this.latestData || !this.isActive) return null;
    if (!this.latestData.is_playing) return null;

    const d = this.latestData;
    if (!d.track_name) return null;

    // Compensate progress for time since last push
    const elapsed = performance.now() - this.receivedAt;
    const compensatedProgress = Math.min(
      Math.round(d.progress_ms + elapsed),
      d.duration_ms || Infinity,
    );

    const result = {
      track_id: d.track_id || `spicetify:${d.track_name}:${d.artist_name}`,
      track_name: d.track_name,
      artist_name: d.artist_name,
      album_name: d.album_name,
      duration_ms: d.duration_ms,
      progress_ms: compensatedProgress,
      is_playing: true,
      is_live: false,
      album_art_url: d.album_art_url,
      spotify_url: d.spotify_url,
      artist_url: d.artist_url,
      album_url: d.album_url || '',
      context_name: d.context_name || '',
      context_url: d.context_url || '',
      context_type: d.context_type || '',
      artist_art_url: d.artist_art_url || '',
      media_source: 'spotify',
      is_shuffle: d.is_shuffle ?? false,
      repeat_mode: ((d.repeat_mode === 'track' || d.repeat_mode === 'context') ? d.repeat_mode : 'off') as 'off' | 'track' | 'context',
      is_local: d.is_local ?? false,
      _received_at: performance.now(),
      _from_push: true,
    };
    return result;
  }

  /** True if the extension has sent data recently (< 10s). */
  get isActive(): boolean {
    if (!this.latestData) return false;
    const stale = (performance.now() - this.receivedAt) > STALE_THRESHOLD_MS;
    if (stale && this._wasActive) {
      this._wasActive = false;
      log.warn('Spicetify extension stale (>10s) — falling back to SMTC');
    }
    return !stale;
  }

  /** Whether the extension reports playback is paused. */
  get isPaused(): boolean {
    if (!this.latestData || !this.isActive) return true;
    return !this.latestData.is_playing;
  }

  /**
   * Whether the Spotify client is in a private session.
   *
   * Only the extension can answer this — a private session plays, publishes to
   * Windows and sounds exactly like any other, so an install without the
   * extension always reads false here. That is the honest answer rather than a
   * guess: there is nothing else to read.
   */
  get isPrivateSession(): boolean {
    if (!this.privateSession) return false;
    return (performance.now() - this.receivedAt) <= PRIVATE_TTL_MS;
  }

  /** The raw latest payload (for direct field access by backend). */
  get latest(): SpicetifyPayload | null {
    return this.isActive ? this.latestData : null;
  }
}
