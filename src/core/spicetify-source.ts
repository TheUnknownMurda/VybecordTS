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
 * Falls back to SMTC automatically if the extension stops pushing, judged against the cadence it had been keeping -- see push-freshness.ts.
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import { asBool, asNonNegativeInt, asRecord, asText, asUrl } from './utils.js';
import type { TrackData } from './types.js';
import { PushFreshness } from './push-freshness.js';

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
  /** Playing from Spotify's DJ. */
  is_dj?: boolean;
  /** The DJ is talking between songs rather than a track playing. */
  dj_narration?: boolean;
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
    is_dj: asBool(d.is_dj),
    dj_narration: asBool(d.dj_narration),
  };
}

export class SpicetifySource {
  private latestData: SpicetifyPayload | null = null;
  private receivedAt = 0;
  private readonly freshness = new PushFreshness();
  private _wasActive = false; // Track activation for logging

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
    this.freshness.seen(this.receivedAt);

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
    // A DJ voice segment may come with no title at all; it still deserves a card.
    if (!d.track_name && !d.dj_narration) return null;

    // Compensate progress for time since last push
    const elapsed = performance.now() - this.receivedAt;
    const compensatedProgress = Math.min(
      Math.round(d.progress_ms + elapsed),
      d.duration_ms || Infinity,
    );

    /*
     * The DJ talking between songs. Whatever Spotify calls the segment, it is
     * not a song: announced under its own name it would be looked up for
     * lyrics, could match some real track called that, and would be scrobbled.
     * One fixed identity, flagged so the backend skips all three.
     */
    const narration = !!d.dj_narration;
    const result = {
      track_id: narration ? `spicetify:dj:${d.uri}` : d.track_id || `spicetify:${d.track_name}:${d.artist_name}`,
      track_name: narration ? 'DJ is talking' : d.track_name,
      artist_name: narration ? 'Spotify DJ' : d.artist_name,
      album_name: narration ? '' : d.album_name,
      duration_ms: d.duration_ms,
      progress_ms: compensatedProgress,
      is_playing: true,
      is_live: false,
      album_art_url: d.album_art_url,
      spotify_url: narration ? d.context_url : d.spotify_url,
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
      is_dj: d.is_dj ?? false,
      is_dj_narration: narration,
      _received_at: performance.now(),
      _from_push: true,
    };
    return result;
  }

  /** True while pushes are still arriving at the cadence this source has been keeping. */
  get isActive(): boolean {
    if (!this.latestData) return false;
    const stale = this.freshness.isStale(performance.now());
    if (stale && this._wasActive) {
      this._wasActive = false;
      log.warn(`Spicetify extension stale (>${this.freshness.windowSeconds}s) — falling back to SMTC`);
    }
    return !stale;
  }

  /** Whether the extension reports playback is paused. */
  get isPaused(): boolean {
    if (!this.latestData || !this.isActive) return true;
    return !this.latestData.is_playing;
  }

  /** The raw latest payload (for direct field access by backend). */
  get latest(): SpicetifyPayload | null {
    return this.isActive ? this.latestData : null;
  }
}
