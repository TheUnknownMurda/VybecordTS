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
}

const STALE_THRESHOLD_MS = 10_000; // Data older than 10s = extension disconnected

export class SpicetifySource {
  private latestData: SpicetifyPayload | null = null;
  private receivedAt = 0;
  private _wasActive = false; // Track activation for logging

  /**
   * Ingest a push from the Spicetify extension.
   * Called by the web server on POST /api/spicetify.
   */
  update(data: SpicetifyPayload): void {
    this.latestData = data;
    this.receivedAt = performance.now();

    if (!this._wasActive) {
      this._wasActive = true;
      log.info('Spicetify extension connected ✓ — using as primary Spotify source');
    }
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

    return {
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
      _received_at: performance.now(),
    };
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

  /** The raw latest payload (for direct field access by backend). */
  get latest(): SpicetifyPayload | null {
    return this.isActive ? this.latestData : null;
  }
}
