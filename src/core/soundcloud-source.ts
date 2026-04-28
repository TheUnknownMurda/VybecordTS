/**
 * SoundCloud push-based track source (via Tampermonkey userscript).
 *
 * Receives real-time track data from the VybecordTS SoundCloud userscript
 * via HTTP POST. Superior to SMTC for SoundCloud:
 *   - Accurate artist name (SMTC gives uploader, not real artist)
 *   - High-res album art directly from SoundCloud CDN
 *   - Precise progress/duration from the player UI
 *   - Track & artist URLs for Discord RPC buttons
 *
 * Falls back to SMTC automatically if the userscript stops pushing (>10s stale).
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import type { TrackData } from './types.js';

const log = createLogger('SoundCloudSource');

// Regex for cleaning track titles
const RE_PROD = /\s*[\[(](?:prod\.?|produced\s+by)\s*.+[\])]\s*$/i;
const RE_FEAT = /\s*[\[(](?:feat\.?|ft\.?|featuring)\s+.+[\])]\s*$/i;

/** Shape of JSON pushed by the Tampermonkey userscript. */
export interface SoundCloudPayload {
  track_id: string;
  title: string;
  artist: string;
  duration_ms: number;
  progress_ms: number;
  is_playing: boolean;
  art_url: string;
  track_url: string;
  artist_url: string;
  likes: number;
}

const STALE_THRESHOLD_MS = 10_000;

export class SoundCloudSource {
  private latestData: SoundCloudPayload | null = null;
  private receivedAt = 0;
  private _wasActive = false;

  /**
   * Ingest a push from the SoundCloud userscript.
   * Called by the web server on POST /api/soundcloud.
   */
  update(data: SoundCloudPayload): void {
    this.latestData = data;
    this.receivedAt = performance.now();

    if (!this._wasActive) {
      this._wasActive = true;
      log.info('SoundCloud userscript connected ✓ — using as primary SoundCloud source');
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
    if (!d.title) return null;

    let trackName = d.title;
    let artistName = d.artist || 'Unknown';

    // Try to split "Artist - Title" format (common on SoundCloud)
    if (artistName === 'Unknown' || !artistName) {
      const parsed = parseScTitle(trackName, artistName);
      trackName = parsed[0];
      artistName = parsed[1];
    }

    // Clean title
    trackName = cleanTitle(trackName);

    // Compensate progress for time since last push
    const elapsed = performance.now() - this.receivedAt;
    const compensatedProgress = Math.min(
      Math.round(d.progress_ms + elapsed),
      d.duration_ms || Infinity,
    );

    return {
      track_id: `sc:${d.track_id}`,
      track_name: trackName,
      artist_name: artistName,
      album_name: '',
      duration_ms: d.duration_ms,
      progress_ms: compensatedProgress,
      is_playing: true,
      is_live: false,
      album_art_url: d.art_url || '',
      spotify_url: d.track_url || '',
      artist_url: d.artist_url || '',
      media_source: 'soundcloud',
      _received_at: performance.now(),
    };
  }

  /** True if the userscript has sent data recently (< 10s). */
  get isActive(): boolean {
    if (!this.latestData) return false;
    const stale = (performance.now() - this.receivedAt) > STALE_THRESHOLD_MS;
    if (stale && this._wasActive) {
      this._wasActive = false;
      log.warn('SoundCloud userscript stale (>10s) — falling back to SMTC');
    }
    return !stale;
  }

  /** Whether the userscript reports playback is paused. */
  get isPaused(): boolean {
    if (!this.latestData || !this.isActive) return true;
    return !this.latestData.is_playing;
  }

  /** The raw latest payload. */
  get latest(): SoundCloudPayload | null {
    return this.isActive ? this.latestData : null;
  }
}

// ── Title parsing helpers ──

const SC_SEPARATORS = [' - ', ' – ', ' — ', ' // ', ' | '];

function parseScTitle(title: string, fallbackArtist: string): [track: string, artist: string] {
  // Strip producer tags: "Artist - Track (prod. X)" → "Artist - Track"
  let cleaned = title.replace(RE_PROD, '').trim();

  for (const sep of SC_SEPARATORS) {
    const idx = cleaned.indexOf(sep);
    if (idx > 0) {
      const left = cleaned.slice(0, idx).trim();
      const right = cleaned.slice(idx + sep.length).trim();
      if (left && right) {
        return [right, left]; // "Artist - Track" → [Track, Artist]
      }
    }
  }
  return [cleaned || title, fallbackArtist];
}

function cleanTitle(title: string): string {
  let cleaned = title;
  cleaned = cleaned.replace(RE_PROD, '').trim();
  // Keep feat. in title but clean up brackets if malformed
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return cleaned || title;
}
