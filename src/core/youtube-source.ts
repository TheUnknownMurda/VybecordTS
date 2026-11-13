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
 * Falls back to SMTC automatically if the userscript stops pushing, judged against the cadence it had been keeping -- see push-freshness.ts.
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import { asBool, asId, asNonNegativeInt, asRecord, asText, asUrl } from './utils.js';
import type { TrackData } from './types.js';
import { PushFreshness } from './push-freshness.js';
import { asChannelUrl, channelPageOf } from './youtube-channel.js';

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
  stream_start_time_ms?: number;
  /** The uploader's channel page, when the page links it (extension 2.2.2+). */
  channel_url: string;
  /** A Short (youtube.com/shorts/…) rather than a video (extension 2.2.2+). */
  is_short: boolean;
}

/** Coerce a push into the shape above, whatever actually arrived. */
export function normalizeYouTubePayload(raw: unknown): YouTubePayload {
  const d = asRecord(raw);
  return {
    // Pasted into watch and thumbnail URLs, which become Discord button
    // targets — so only the characters a real id uses survive.
    video_id: asId(d.video_id, 64),
    title: asText(d.title),
    artist: asText(d.artist),
    channel: asText(d.channel),
    duration_ms: asNonNegativeInt(d.duration_ms),
    progress_ms: asNonNegativeInt(d.progress_ms),
    is_playing: asBool(d.is_playing),
    is_live: asBool(d.is_live),
    thumbnail_url: asUrl(d.thumbnail_url),
    // This endpoint speaks for YouTube and nothing else. The value drives the
    // per-platform detection gate, the pin check and which Discord application
    // the presence is published under, so it is pinned to the two it may be
    // rather than passed through.
    source: asText(d.source, 32) === 'youtube_music' ? 'youtube_music' : 'youtube',
    stream_start_time_ms: asNonNegativeInt(d.stream_start_time_ms),
    channel_url: asChannelUrl(d.channel_url),
    is_short: asBool(d.is_short),
  };
}

export class YouTubeSource {
  private latestData: YouTubePayload | null = null;
  private receivedAt = 0;
  private readonly freshness = new PushFreshness();
  private _wasActive = false;
  private _staleAt = 0;  // timestamp when userscript went stale
  private streamStartTime = 0; // Store stream start time once

  /**
   * Ingest a push from the YouTube userscript.
   * Called by the web server on POST /api/youtube.
   */
  update(raw: unknown): YouTubePayload {
    const data = normalizeYouTubePayload(raw);
    this.latestData = data;
    this.receivedAt = performance.now();
    this.freshness.seen(this.receivedAt);

    if (!this._wasActive) {
      this._wasActive = true;
      log.info('YouTube userscript connected ✓ — using as primary YouTube source');
    }
    
    // Use stream start time from Tampermonkey script
    if (data.stream_start_time_ms) {
      this.streamStartTime = data.stream_start_time_ms;
    } else if (data.is_live && this.streamStartTime === 0) {
      // Fallback: set locally if not provided by script
      this.streamStartTime = Date.now();
    }
    // Reset when stream goes offline or when switching to non-live content
    if (!data.is_live) {
      this.streamStartTime = 0;
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
    if (d.is_short) return this.shortTrack(d);

    // Parse artist from title if not provided by YouTube metadata
    let trackName = d.title;
    let artistName = d.artist || d.channel || 'Unknown';
    let artistIsChannel = false;

    // Try to split "Artist - Title" format. A "… - Topic" channel is YouTube's
    // own upload of a release: its title is the song name as released, and a
    // dash in it is part of that name ("Song - Remastered"), not a separator.
    if ((!d.artist || d.artist === d.channel) && !RE_TOPIC_SUFFIX.test(artistName)) {
      const [parsed, parsedArtist] = parseBrowserTitle(trackName, artistName);
      // Nothing split off: the title is a video's title and the name beside
      // it is whoever uploaded it. YouTube Music always names a real artist.
      artistIsChannel = parsed === trackName && d.source !== 'youtube_music' && !d.is_live;
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
      stream_start_time_ms: d.is_live ? this.streamStartTime : undefined,
      album_art_url: d.thumbnail_url || `https://i.ytimg.com/vi/${d.video_id}/hqdefault.jpg`,
      spotify_url: '',
      // The channel's page, where the line shows the channel. Where it shows
      // an artist read out of the title, the channel is often a label's or a
      // fan's, and a search for the artist is the better link.
      artist_url: artistIsChannel ? d.channel_url : '',
      media_source: d.source || 'youtube',
      _received_at: performance.now(),
      _from_push: true,
      video_url: `https://www.youtube.com/watch?v=${d.video_id}`,
      artist_is_channel: artistIsChannel,
    };
  }

  /**
   * A Short, as the card shows it: its title with the hashtags at the end, its
   * channel as a plain name leading to the channel, its own link and its
   * vertical frame.
   *
   * The title is never split into "Artist - Title". A Short's title is a
   * caption written for the feed, and the song under it, when there is one, is
   * not what it names. The position is the loop's, which the captions and the
   * card's bar follow: both start over with every loop.
   */
  private shortTrack(d: YouTubePayload): TrackData {
    const elapsed = performance.now() - this.receivedAt;
    return {
      track_id: `yt:${d.video_id}`,
      track_name: shortTitle(d.title),
      artist_name: d.channel || 'Unknown',
      album_name: '',
      duration_ms: d.duration_ms,
      progress_ms: Math.min(Math.round(d.progress_ms + elapsed), d.duration_ms || Infinity),
      is_playing: true,
      is_live: false,
      album_art_url: d.thumbnail_url || `https://i.ytimg.com/vi/${d.video_id}/hqdefault.jpg`,
      spotify_url: '',
      // The panel's link when the extension could take it, else the one
      // YouTube names for the video, once it has answered (youtube-channel.ts).
      artist_url: d.channel_url || channelPageOf(d.video_id),
      media_source: 'youtube',
      _received_at: performance.now(),
      _from_push: true,
      video_url: `https://www.youtube.com/shorts/${d.video_id}`,
      artist_is_channel: true,
      is_short: true,
    };
  }

  /** True while pushes are still arriving at the cadence this source has been keeping. */
  get isActive(): boolean {
    if (!this.latestData) return false;
    const stale = this.freshness.isStale(performance.now());
    if (stale && this._wasActive) {
      this._wasActive = false;
      this._staleAt = performance.now();
      log.warn(`YouTube userscript stale (>${this.freshness.windowSeconds}s) — falling back to SMTC`);
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

  /** True if the userscript was recently active (within last 30s).
   *  Used to block SMTC ghost sessions from browser after it closes. */
  get wasRecentlyActive(): boolean {
    if (this.isActive) return true;
    if (this._staleAt === 0) return false;
    return (performance.now() - this._staleAt) < 30_000;
  }
}

// ── Title parsing helpers ──

/** What a tag's word is made of: letters, their marks (Hindi, Thai), digits, joiners. */
const TAG_CHAR = String.raw`\p{L}\p{M}\p{N}_\u200C\u200D`;
/**
 * A hashtag: # and a word, in any script, with a letter in it ("We're #1" has
 * none). It has to end where the word does: "#don't" and "#k-pop" are left as
 * written rather than cut into a tag and a stray "'t" or "-pop".
 */
const HASHTAG = String.raw`#[\p{N}_]*\p{L}[${TAG_CHAR}]*(?![${TAG_CHAR}]|['’-][${TAG_CHAR}])`;
/**
 * Hashtags one after another, glued ("#caseoh#gaming") or alone. Never right
 * after a letter or a digit: the "#m" of "F#m" is a chord's, not a tag.
 */
const TAG_RUN = String.raw`(?<![${TAG_CHAR}])(?:${HASHTAG})+`;
const RE_TAG_RUNS = new RegExp(TAG_RUN, 'gu');
const RE_ONE_TAG = new RegExp(HASHTAG, 'gu');
/** The tags a title opens with, and what sets them off from the words after them. */
const RE_LEADING_TAGS = new RegExp(String.raw`^\s*${TAG_RUN}(?:[\s.,|·]*${TAG_RUN})*[\s.,:;|·–—-]*`, 'u');
/**
 * The tags a title ends with, and what sets them off from the words before
 * them. A full stop or a comma before them is the sentence's own and stays
 * ("Wait for it... #fyp" keeps its dots); a bar or a dash is only there to
 * set the tags off.
 */
const RE_TRAILING_TAGS = new RegExp(String.raw`[\s|·–—-]*${TAG_RUN}(?:[\s.,|·]*${TAG_RUN})*[\s.,|·]*$`, 'u');
/** Tags among the words, with the space before them. */
const RE_INNER_TAGS = new RegExp(String.raw`\s*${TAG_RUN}(?:[\s.,|·]*${TAG_RUN})*`, 'gu');
/** Brackets a tag was alone in. */
const RE_EMPTY_BRACKETS = /\(\s*\)|\[\s*\]/g;
/** Two bars, or dots, that had tags between them ("Clip | #a #b | Part 2"). */
const RE_DOUBLED_BARS = /\s*([|·])(?:\s*[|·])+/g;
/** Format characters (zero-width joiners and spaces, word joiners) at either end. */
const RE_EDGE_INVISIBLE = /^[\p{Cf}\s]+|[\p{Cf}\s]+$/gu;
/** #shorts and #short: the feed's own label, which the card says in its own words ([Shorts]). */
const RE_SHORTS_TAG = /^#shorts?$/iu;

/**
 * A Short's title with its hashtags at the end.
 *
 * Short titles carry runs of tags for the feed, at the end ("…on a horror
 * game? 💀🥀 #caseoh#gaming#funny") or up front ("#caseoh #gaming He really
 * did that"). They used to be cut off, which also cut what some of them say:
 * who is in the clip, which game it is. They are kept now, but after the
 * words, so the bold line on the card opens on what the Short says: every tag
 * moves to the end, in the order written, once each, a space apart. A tag
 * among the words moves as well ("my first #Minecraft build" ends "my first
 * build #Minecraft"): words first, then tags, whatever the uploader wrote, and
 * titles like that are rare next to the runs. #shorts goes, since the card
 * says [Shorts] already (cardTitle in lyrics-engine.ts). A title that is
 * nothing but tags is its tags.
 */
export function shortTitle(title: string): string {
  // Invisible marks some uploaders lead with (a word joiner, U+2060, on the
  // first Short this was written for): they hide a leading tag run from the
  // edge test below, and are nothing on a card.
  const raw = title.replace(RE_EDGE_INVISIBLE, '');
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const run of raw.matchAll(RE_TAG_RUNS)) {
    for (const tag of run[0].match(RE_ONE_TAG) ?? []) {
      const key = tag.toLowerCase();
      if (RE_SHORTS_TAG.test(tag) || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
    }
  }
  const words = raw
    .replace(RE_LEADING_TAGS, '')
    .replace(RE_TRAILING_TAGS, '')
    .replace(RE_INNER_TAGS, '')
    .replace(RE_EMPTY_BRACKETS, '')
    .replace(RE_DOUBLED_BARS, ' $1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return [words, ...tags].join(' ').trim() || title.trim();
}

/**
 * Dashes only. A bar was on this list and read the wrong way round on YouTube,
 * where "Title | Series" is the convention rather than "Artist | Title":
 * "The Boston Marathon Bombing, minute by minute | xQc Reacts" was announced as
 * a song called "xQc Reacts" by an artist called "The Boston Marathon Bombing".
 */
function parseBrowserTitle(title: string, smtcArtist: string): [track: string, artist: string] {
  for (const sep of [' - ', ' – ', ' — ']) {
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
