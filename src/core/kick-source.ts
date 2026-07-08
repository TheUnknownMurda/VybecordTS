/**
 * Kick push-based track source (via Tampermonkey userscript).
 *
 * Receives real-time stream data from the VybecordTS Kick userscript
 * via HTTP POST. Shows streamer details in Discord RPC:
 *   - Streamer username and display name
 *   - Category/game being played
 *   - Follower count
 *   - Profile URL
 *   - Live status
 *
 * Falls back to SMTC automatically if the userscript stops pushing (>10s stale).
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import type { TrackData } from './types.js';

const log = createLogger('KickSource');

/** Shape of JSON pushed by the Tampermonkey userscript. */
export interface KickPayload {
  username: string;
  display_name: string;
  followers: string;
  category: string;
  stream_title: string;
  profile_url: string;
  is_live: boolean;
  thumbnail_url: string;
  profile_picture_url: string;
}

const STALE_THRESHOLD_MS = 10_000;

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
   * Returns null if not live, no data, or data is stale.
   */
  getCurrentTrack(): TrackData | null {
    if (!this.latestData || !this.isActive) return null;
    if (!this.latestData.is_live) return null;

    const d = this.latestData;
    if (!d.username) return null;

    return {
      track_id: `kick:${d.username}`,
      track_name: `📺 ${d.display_name || d.username}`,
      artist_name: d.stream_title || d.category || 'Just Chatting',
      album_name: d.category ? `🎮 ${d.category}` : '',
      duration_ms: 0, // Live streams have no duration
      progress_ms: 0,
      is_playing: true,
      is_live: true,
      album_art_url: d.profile_picture_url || d.thumbnail_url || '',
      spotify_url: d.profile_url || '',
      artist_url: '',
      context_name: d.followers || '',
      context_url: d.profile_url || '',
      context_type: 'live',
      media_source: 'kick',
      _received_at: performance.now(),
      video_url: d.profile_url || '',
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

  /** Whether the userscript reports playback is paused. */
  get isPaused(): boolean {
    if (!this.latestData || !this.isActive) return true;
    return !this.latestData.is_live;
  }

  /** The raw latest payload. */
  get latest(): KickPayload | null {
    return this.isActive ? this.latestData : null;
  }
}
