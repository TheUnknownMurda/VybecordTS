/**
 * Lightweight push-payload validators.
 *
 * Goal: reject malformed/malicious payloads at the boundary before they reach
 * the source classes (which trust their input). All validators are pure,
 * dependency-free, and return either a typed payload or null.
 *
 * Rules applied:
 *   - Required fields present + correct primitive type
 *   - Strings clamped to MAX_STR_LEN (prevents memory abuse via huge titles)
 *   - Numbers clamped to non-negative finite range with sane upper bounds
 *   - Unknown extra fields are kept (forward-compat) but typed fields are coerced
 *
 * These validators are intentionally permissive on *missing* optional fields
 * (defaulted to empty string / 0) so existing legitimate userscripts/extensions
 * keep working even when they don't push every field.
 */

import type { SpicetifyPayload } from '../core/spicetify-source.js';
import type { YouTubePayload } from '../core/youtube-source.js';
import type { SoundCloudPayload } from '../core/soundcloud-source.js';
import type { BandcampPayload } from '../core/bandcamp-source.js';

const MAX_STR_LEN = 512;          // Track names / artist names — Discord caps at 128
const MAX_URL_LEN = 2048;         // Album art URLs, etc.
const MAX_DURATION_MS = 24 * 3600 * 1000;   // 24h — anything above is invalid
const MAX_TRACK_ID_LEN = 256;
const MAX_LYRICS_LINES = 5000;    // Synced lyrics: very long songs ~500 lines; 5000 is safe
const MAX_LYRIC_TEXT_LEN = 1024;  // Per-line text

/** Type guard: value is a plain object. */
function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Clamp a string: must be a string, non-empty after trim, length-capped. */
function cleanStr(v: unknown, max = MAX_STR_LEN): string {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

/** Clamp a URL: must be string, length-capped, basic http(s) sanity check. */
function cleanUrl(v: unknown): string {
  if (typeof v !== 'string' || !v) return '';
  const s = v.length > MAX_URL_LEN ? v.slice(0, MAX_URL_LEN) : v;
  // Allow http(s)://, data: (album art base64), spotify:image:..., or relative paths
  if (/^(https?:\/\/|data:|spotify:|\/)/i.test(s)) return s;
  return '';
}

/** Clamp a number to [0, max], coercing non-finite/negative to 0. */
function cleanNum(v: unknown, max = MAX_DURATION_MS): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > max ? max : Math.round(n);
}

function cleanBool(v: unknown): boolean {
  return v === true;
}

// ── Spicetify push payload ──

export function validateSpicetify(raw: unknown): SpicetifyPayload | null {
  if (!isObj(raw)) return null;
  const track_name = cleanStr(raw.track_name);
  if (!track_name) return null; // track_name is the minimum required field
  return {
    track_id: cleanStr(raw.track_id, MAX_TRACK_ID_LEN),
    uri: cleanStr(raw.uri, MAX_TRACK_ID_LEN),
    track_name,
    artist_name: cleanStr(raw.artist_name),
    album_name: cleanStr(raw.album_name),
    album_art_url: cleanUrl(raw.album_art_url),
    duration_ms: cleanNum(raw.duration_ms),
    progress_ms: cleanNum(raw.progress_ms),
    is_playing: cleanBool(raw.is_playing),
    spotify_url: cleanUrl(raw.spotify_url),
    artist_url: cleanUrl(raw.artist_url),
    album_url: cleanUrl(raw.album_url),
    context_name: cleanStr(raw.context_name),
    context_url: cleanUrl(raw.context_url),
    context_type: cleanStr(raw.context_type, 64),
    artist_art_url: cleanUrl(raw.artist_art_url),
    is_shuffle: cleanBool(raw.is_shuffle),
    repeat_mode: typeof raw.repeat_mode === 'string'
      ? cleanStr(raw.repeat_mode, 16)
      : 'off',
    is_local: cleanBool(raw.is_local),
  };
}

// ── YouTube userscript payload ──

export function validateYouTube(raw: unknown): YouTubePayload | null {
  if (!isObj(raw)) return null;
  const title = cleanStr(raw.title);
  const video_id = cleanStr(raw.video_id, 32);
  if (!title || !video_id) return null;
  return {
    video_id,
    title,
    artist: cleanStr(raw.artist),
    channel: cleanStr(raw.channel),
    duration_ms: cleanNum(raw.duration_ms),
    progress_ms: cleanNum(raw.progress_ms),
    is_playing: cleanBool(raw.is_playing),
    is_live: cleanBool(raw.is_live),
    thumbnail_url: cleanUrl(raw.thumbnail_url),
    source: raw.source === 'youtube_music' ? 'youtube_music' : 'youtube',
  };
}

// ── SoundCloud userscript payload ──

export function validateSoundCloud(raw: unknown): SoundCloudPayload | null {
  if (!isObj(raw)) return null;
  const title = cleanStr(raw.title);
  if (!title) return null;
  return {
    track_id: cleanStr(raw.track_id, MAX_TRACK_ID_LEN),
    title,
    artist: cleanStr(raw.artist),
    duration_ms: cleanNum(raw.duration_ms),
    progress_ms: cleanNum(raw.progress_ms),
    is_playing: cleanBool(raw.is_playing),
    art_url: cleanUrl(raw.art_url),
    track_url: cleanUrl(raw.track_url),
    artist_url: cleanUrl(raw.artist_url),
    likes: cleanNum(raw.likes, 1e9),
  };
}

// ── Bandcamp userscript payload ──

export function validateBandcamp(raw: unknown): BandcampPayload | null {
  if (!isObj(raw)) return null;
  const title = cleanStr(raw.title);
  if (!title) return null;
  return {
    track_id: cleanStr(raw.track_id, MAX_TRACK_ID_LEN),
    title,
    artist: cleanStr(raw.artist),
    album: cleanStr(raw.album),
    duration_ms: cleanNum(raw.duration_ms),
    progress_ms: cleanNum(raw.progress_ms),
    is_playing: cleanBool(raw.is_playing),
    art_url: cleanUrl(raw.art_url),
    track_url: cleanUrl(raw.track_url),
    artist_url: cleanUrl(raw.artist_url),
    album_url: cleanUrl(raw.album_url),
  };
}

// ── Spotify Web lyrics push (from userscript) ──

export interface SpotifyLyricsPayload {
  track_id: string;
  lines: { time: number; text: string }[];
}

export function validateSpotifyLyrics(raw: unknown): SpotifyLyricsPayload | null {
  if (!isObj(raw)) return null;
  const track_id = cleanStr(raw.track_id, MAX_TRACK_ID_LEN);
  if (!track_id) return null;
  if (!Array.isArray(raw.lines)) return null;
  if (raw.lines.length > MAX_LYRICS_LINES) return null;

  const lines: { time: number; text: string }[] = [];
  for (const item of raw.lines) {
    if (!isObj(item)) continue;
    const text = cleanStr(item.text, MAX_LYRIC_TEXT_LEN);
    if (!text) continue;
    // Spotify uses -1 for unsynced lyrics — accept negatives for that case only
    const time = typeof item.time === 'number' && Number.isFinite(item.time)
      ? Math.max(-1, Math.min(item.time, MAX_DURATION_MS))
      : 0;
    lines.push({ time, text });
  }
  return { track_id, lines };
}
