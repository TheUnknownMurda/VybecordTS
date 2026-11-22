/**
 * Amazon Music push-based track source (via the browser extension).
 *
 * Receives what Amazon Music's web player is playing (see
 * extension/src/sites/amazonmusic.js). Better than the Windows media session
 * for it in two ways that show on the card:
 *   - The session names no site, and a tab publishing an album beside a clean
 *     title was taken for Spotify (detectWebService's last guess in
 *     native-media-source.ts): the card read "Spotify" for a song on Amazon.
 *   - The position comes off the page's own media element, exactly, and the
 *     artist's and the album's pages come with it for the card's links.
 *
 * The Amazon Music desktop app is read off the Windows media session, as it
 * always was, under the same name; this is only the web player.
 *
 * Falls back to the media session if the extension stops pushing, judged
 * against the cadence it had been keeping (see push-freshness.ts).
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import { asBool, asNonNegativeInt, asRecord, asText, asUrl } from './utils.js';
import type { TrackData } from './types.js';
import { PushFreshness } from './push-freshness.js';

const log = createLogger('AmazonMusicSource');

/** Shape of JSON pushed by the extension (sites/amazonmusic.js). */
export interface AmazonMusicPayload {
  /** Amazon's id for the song (an ASIN) when the player's links name it, else a slug of the names. */
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

/**
 * Amazon Music's own pages, on any of its country sites. A link becomes a
 * button and a link on the card, so anything else is no link at all.
 */
const RE_AMAZON_MUSIC_PAGE = /^https:\/\/music\.amazon\.(?:com|ca|co\.uk|de|fr|it|es|co\.jp|com\.br|com\.mx|com\.au|in)\/\S*$/i;

/** A link on Amazon Music, or ''. */
function ownPage(v: unknown): string {
  const url = asUrl(v);
  return RE_AMAZON_MUSIC_PAGE.test(url) ? url : '';
}

/** Coerce a push into the shape above, whatever actually arrived. */
export function normalizeAmazonMusicPayload(raw: unknown): AmazonMusicPayload {
  const d = asRecord(raw);
  const art = asUrl(d.art_url);
  return {
    track_id: asText(d.track_id, 64),
    title: asText(d.title, 200),
    artist: asText(d.artist, 200),
    album: asText(d.album, 200),
    duration_ms: asNonNegativeInt(d.duration_ms),
    progress_ms: asNonNegativeInt(d.progress_ms),
    is_playing: asBool(d.is_playing),
    art_url: /^https:\/\//i.test(art) ? art : '',
    track_url: ownPage(d.track_url),
    artist_url: ownPage(d.artist_url),
    album_url: ownPage(d.album_url),
  };
}

export class AmazonMusicSource {
  private latestData: AmazonMusicPayload | null = null;
  private receivedAt = 0;
  private readonly freshness = new PushFreshness();
  private _wasActive = false;

  /** Ingest a push from the extension, as the web server hands it over (POST /api/amazonmusic). */
  update(raw: unknown): AmazonMusicPayload {
    const data = normalizeAmazonMusicPayload(raw);
    this.latestData = data;
    this.receivedAt = performance.now();
    this.freshness.seen(this.receivedAt);

    if (!this._wasActive) {
      this._wasActive = true;
      log.info('Amazon Music extension connected ✓ — using as primary Amazon Music source');
    }
    return data;
  }

  /** The latest push as a track, or null when paused, empty or stale. */
  getCurrentTrack(): TrackData | null {
    if (!this.latestData || !this.isActive) return null;
    const d = this.latestData;
    if (!d.is_playing || !d.title) return null;

    // The time since the push, played on.
    const elapsed = performance.now() - this.receivedAt;
    const progress = Math.min(Math.round(d.progress_ms + elapsed), d.duration_ms || Infinity);
    const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);

    return {
      track_id: `amz:${d.track_id || slug(`${d.artist}-${d.title}`)}`,
      track_name: d.title,
      artist_name: d.artist || 'Unknown',
      album_name: d.album || '',
      duration_ms: d.duration_ms,
      progress_ms: progress,
      is_playing: true,
      is_live: false,
      album_art_url: d.art_url || '',
      // The song's own page, as Bandcamp's track page; the card links a
      // search for it without one.
      spotify_url: d.track_url || '',
      artist_url: d.artist_url || '',
      album_url: d.album_url || '',
      media_source: 'amazon_music',
      _received_at: performance.now(),
      // Read off the page's own media element — exact, unlike an OS session's.
      _from_push: true,
    };
  }

  /** True while pushes are still arriving at the cadence this source has been keeping. */
  get isActive(): boolean {
    if (!this.latestData) return false;
    const stale = this.freshness.isStale(performance.now());
    if (stale && this._wasActive) {
      this._wasActive = false;
      log.warn(`Amazon Music extension stale (>${this.freshness.windowSeconds}s) — falling back to SMTC`);
    }
    return !stale;
  }

  /** Whether the extension reports playback is paused. */
  get isPaused(): boolean {
    if (!this.latestData || !this.isActive) return true;
    return !this.latestData.is_playing;
  }

  /** The raw latest payload. */
  get latest(): AmazonMusicPayload | null {
    return this.isActive ? this.latestData : null;
  }
}
