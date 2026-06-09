/**
 * Kick push-based track source (via Tampermonkey userscript).
 *
 * Receives real-time stream data from the VybecordTS Kick userscript
 * via HTTP POST. Far superior to SMTC for Kick:
 *   - Event-driven (instant stream detection)
 *   - Exact streamer username from URL (not guessed from title)
 *   - Direct Kick URL for Discord RPC button
 *   - No "Adin Ross" → "adinross" guessing issues
 *
 * Falls back to SMTC automatically if the userscript stops pushing (>10s stale).
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import type { TrackData } from './types.js';

const log = createLogger('KickSource');

/** Shape of JSON pushed by the Tampermonkey userscript. */
export interface KickPayload {
  /** Streamer username from URL (kick.com/{username}) */
  streamer: string;
  /** Stream title */
  title: string;
  /** Viewer count (optional) */
  viewers?: number;
  /** Is the stream live */
  is_live: boolean;
  /** Is the tab active (visible) */
  is_playing: boolean;
  /** Full Kick URL */
  kick_url: string;
  /** Stream thumbnail URL (optional) */
  thumbnail_url?: string;
}

const STALE_THRESHOLD_MS = 10_000; // Data older than 10s = userscript disconnected

export class KickSource {
  private latestData: KickPayload | null = null;
  private receivedAt = 0;
  private _wasActive = false;

  /**
   * Ingest a push from the Kick userscript.
   * Called by the web server on POST /api/kick.
   */
  update(data: KickPayload): void {
    this.latestData = data;
    this.receivedAt = performance.now();

    if (!this._wasActive) {
      this._wasActive = true;
      log.info('Kick userscript connected ✓ — using as primary Kick source');
    }
  }

  /**
   * Convert the latest push into a TrackData.
   * Returns null if not playing, no data, or data is stale.
   */
  getCurrentTrack(): TrackData | null {
    if (!this.latestData || !this.isActive) return null;
    if (!this.latestData.is_playing) return null;

    const d = this.latestData;
    if (!d.title || !d.streamer) return null;

    // Use streamer username as "artist" and title as "track"
    // This ensures Discord RPC button links directly to the streamer
    return {
      track_id: `kick:${d.streamer}`,
      track_name: d.title,
      artist_name: d.streamer,
      album_name: '',
      duration_ms: 0, // Live stream has no fixed duration
      progress_ms: 0, // Live streams don't need progress tracking
      is_playing: true,
      is_live: d.is_live,
      album_art_url: d.thumbnail_url || 'https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/MUt6rne1YSKthqduqQF4N.jpg',
      spotify_url: d.kick_url,
      artist_url: d.kick_url,
      media_source: 'kick',
      _received_at: performance.now(),
      _from_push: true,
    };
  }

  /** True if the userscript has sent data recently (< 10s). */
  get isActive(): boolean {
    if (!this.latestData) return false;
    const stale = (performance.now() - this.receivedAt) > STALE_THRESHOLD_MS;
    if (stale && this._wasActive) {
      this._wasActive = false;
      log.warn('Kick userscript stale (>10s) — falling back to SMTC');
    }
    return !stale;
  }

  /** Whether the userscript reports playback is paused (tab hidden). */
  get isPaused(): boolean {
    if (!this.latestData || !this.isActive) return true;
    return !this.latestData.is_playing;
  }

  /** The raw latest payload. */
  get latest(): KickPayload | null {
    return this.isActive ? this.latestData : null;
  }
}
