/**
 * YouTube push-based track source (via Tampermonkey userscript).
 *
 * Receives real-time track data from the VybecordTS YouTube userscript
 * via HTTP POST. Far superior to SMTC for YouTube:
 *   - Event-driven (instant track/seek/pause detection)
 *   - Exact video.currentTime (no SMTC compensation guesswork)
 *   - Direct video ID (enables CC fetch by ID instead of ytsearch:)
 *   - Thumbnail URL available immediately
 *   - Proper title/artist from YouTube structured metadata
 *
 * Falls back to SMTC automatically if the userscript stops pushing (>10s stale).
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import type { TrackData } from './types.js';

const log = createLogger('YouTubeSource');

// Regex for cleaning video titles (same as desktop-source.ts)
const RE_TOPIC_SUFFIX = /\s*-\s*Topic\s*$/i;
const RE_VIDEO_SUFFIX = /\s*[([]*(?:official\s+(?:music\s+)?video|official\s+audio|official\s+lyric\s+video|music\s+video|lyric\s+video|official\s+visualizer|visualizer|official|audio|lyrics|with\s+lyrics|mv|m\/v|4k|hd|hq)[)\]]*\s*$/i;
const RE_UNRELEASED = /\s*[[(]\s*unreleased\s*\*?\s*[\])]\s*/gi;

/** Shape of JSON pushed by the Tampermonkey userscript. */
export interface YouTubePayload {
  video_id: string;
  title: string;
  artist: string;
  channel: string;
  duration_ms: number;
  progress_ms: number;
  is_playing: boolean;
  is_live: boolean;
  thumbnail_url: string;
  /** 'youtube' or 'youtube_music' */
  source: string;
}

const STALE_THRESHOLD_MS = 10_000; // Data older than 10s = userscript disconnected

export class YouTubeSource {
  private latestData: YouTubePayload | null = null;
  private receivedAt = 0;
  private _wasActive = false;

  /**
   * Ingest a push from the YouTube userscript.
   * Called by the web server on POST /api/youtube.
   */
  update(data: YouTubePayload): void {
    this.latestData = data;
    this.receivedAt = performance.now();

    if (!this._wasActive) {
      this._wasActive = true;
      log.info('YouTube userscript connected ✓ — using as primary YouTube source');
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

    // Parse artist from title if not provided by YouTube metadata
    let trackName = d.title;
    let artistName = d.artist || d.channel || 'Unknown';

    // Try to split "Artist - Title" format
    if (!d.artist || d.artist === d.channel) {
      const [parsed, parsedArtist] = parseBrowserTitle(trackName, artistName);
      trackName = parsed;
      artistName = parsedArtist;
    }

    // Clean video title suffixes
    trackName = cleanTitle(trackName);
    artistName = artistName.replace(RE_TOPIC_SUFFIX, '').trim();

    // Compensate progress for time since last push
    const elapsed = performance.now() - this.receivedAt;
    const compensatedProgress = d.is_live ? 0 : Math.min(
      Math.round(d.progress_ms + elapsed),
      d.duration_ms || Infinity,
    );

    return {
      track_id: `yt:${d.video_id}`,
      track_name: trackName,
      artist_name: artistName,
      album_name: '',
      duration_ms: d.is_live ? 0 : d.duration_ms,
      progress_ms: compensatedProgress,
      is_playing: true,
      is_live: d.is_live,
      album_art_url: d.thumbnail_url || `https://i.ytimg.com/vi/${d.video_id}/hqdefault.jpg`,
      spotify_url: '',
      artist_url: '',
      media_source: d.source || 'youtube',
      _received_at: performance.now(),
    };
  }

  /** True if the userscript has sent data recently (< 10s). */
  get isActive(): boolean {
    if (!this.latestData) return false;
    const stale = (performance.now() - this.receivedAt) > STALE_THRESHOLD_MS;
    if (stale && this._wasActive) {
      this._wasActive = false;
      log.warn('YouTube userscript stale (>10s) — falling back to SMTC');
    }
    return !stale;
  }

  /** Whether the userscript reports playback is paused. */
  get isPaused(): boolean {
    if (!this.latestData || !this.isActive) return true;
    return !this.latestData.is_playing;
  }

  /** Get the current video ID (for direct CC fetch). */
  get videoId(): string | null {
    return this.isActive ? (this.latestData?.video_id ?? null) : null;
  }

  /** The raw latest payload. */
  get latest(): YouTubePayload | null {
    return this.isActive ? this.latestData : null;
  }
}

// ── Title parsing helpers ──

function parseBrowserTitle(title: string, smtcArtist: string): [track: string, artist: string] {
  for (const sep of [' - ', ' – ', ' — ', ' | ']) {
    const idx = title.indexOf(sep);
    if (idx > 0) {
      const left = title.slice(0, idx).trim();
      const right = title.slice(idx + sep.length).trim();
      if (left && right) {
        return [right, left];
      }
    }
  }
  return [title, smtcArtist];
}

function cleanTitle(title: string): string {
  let cleaned = title.replace(/\s*\/\/\s*/g, ' - ').trim();
  cleaned = cleaned.replace(RE_UNRELEASED, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const result = cleaned.replace(RE_VIDEO_SUFFIX, '').replace(/[\s\-–—|]+$/, '');
    if (result === cleaned) break;
    cleaned = result;
  }
  return cleaned || title;
}
