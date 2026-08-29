/**
 * Bandcamp push-based track source (via Tampermonkey userscript).
 *
 * Receives real-time track data from the VybecordTS Bandcamp userscript
 * via HTTP POST. Superior to SMTC for Bandcamp:
 *   - Proper artist/album/track metadata from the Bandcamp DOM
 *   - High-res album art directly from Bandcamp CDN
 *   - Accurate progress/duration from the <audio> element
 *   - Track & artist URLs for Discord RPC buttons
 *
 * Falls back to SMTC automatically if the userscript stops pushing (>10s stale).
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import { asBool, asNonNegativeInt, asRecord, asText, asUrl } from './utils.js';
import type { TrackData } from './types.js';

const log = createLogger('BandcampSource');

/** Shape of JSON pushed by the Tampermonkey userscript. */
export interface BandcampPayload {
  track_id: string;
  title: string;
  artist: string;
  album: string;
  duration_ms: number;
  progress_ms: number;
  is_playing: boolean;
  art_url: string;
  track_url: string;
  artist_url: string;
  album_url: string;
}

/** Coerce a push into the shape above, whatever actually arrived. */
export function normalizeBandcampPayload(raw: unknown): BandcampPayload {
  const d = asRecord(raw);
  return {
    track_id: asText(d.track_id, 64),
    title: asText(d.title),
    artist: asText(d.artist),
    album: asText(d.album),
    duration_ms: asNonNegativeInt(d.duration_ms),
    progress_ms: asNonNegativeInt(d.progress_ms),
    is_playing: asBool(d.is_playing),
    art_url: asUrl(d.art_url),
    track_url: asUrl(d.track_url),
    artist_url: asUrl(d.artist_url),
    album_url: asUrl(d.album_url),
  };
}

const STALE_THRESHOLD_MS = 10_000;

export class BandcampSource {
  private latestData: BandcampPayload | null = null;
  private receivedAt = 0;
  private _wasActive = false;

  /**
   * Ingest a push from the Bandcamp userscript.
   * Called by the web server on POST /api/bandcamp.
   */
  update(raw: unknown): BandcampPayload {
    const data = normalizeBandcampPayload(raw);
    this.latestData = data;
    this.receivedAt = performance.now();

    if (!this._wasActive) {
      this._wasActive = true;
      log.info('Bandcamp userscript connected ✓ — using as primary Bandcamp source');
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
    if (!d.title) return null;

    // Compensate progress for time since last push
    const elapsed = performance.now() - this.receivedAt;
    const compensatedProgress = Math.min(
      Math.round(d.progress_ms + elapsed),
      d.duration_ms || Infinity,
    );

    return {
      track_id: `bc:${d.track_id}`,
      track_name: d.title,
      artist_name: d.artist || 'Unknown',
      album_name: d.album || '',
      duration_ms: d.duration_ms,
      progress_ms: compensatedProgress,
      is_playing: true,
      is_live: false,
      album_art_url: d.art_url || '',
      spotify_url: d.track_url || '',
      artist_url: d.artist_url || '',
      album_url: d.album_url || '',
      media_source: 'bandcamp',
      _received_at: performance.now(),
      // Read off the page's own audio element — exact, unlike an OS session's.
      _from_push: true,
    };
  }

  /** True if the userscript has sent data recently (< 10s). */
  get isActive(): boolean {
    if (!this.latestData) return false;
    const stale = (performance.now() - this.receivedAt) > STALE_THRESHOLD_MS;
    if (stale && this._wasActive) {
      this._wasActive = false;
      log.warn('Bandcamp userscript stale (>10s) — falling back to SMTC');
    }
    return !stale;
  }

  /** Whether the userscript reports playback is paused. */
  get isPaused(): boolean {
    if (!this.latestData || !this.isActive) return true;
    return !this.latestData.is_playing;
  }

  /** The raw latest payload. */
  get latest(): BandcampPayload | null {
    return this.isActive ? this.latestData : null;
  }
}
