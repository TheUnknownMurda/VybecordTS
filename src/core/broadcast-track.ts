/**
 * One card shape for everything Twitch and Kick show.
 *
 * Both sources used to build their own TrackData for a live stream and nothing
 * else, so anything that was not a live channel fell through to the browser's
 * media session: a past broadcast arrived as an anonymous tab and was announced
 * under YouTube's name and icon, with its title on the card three times. A
 * channel that was not streaming announced nothing at all, and the extension
 * stopped pushing for it, so there was no way to say "offline".
 *
 * So each page a viewer can be on — a live channel, an offline channel, a past
 * broadcast, a clip — maps to the same layout here: the channel on the first
 * line, what it is showing on the second, and the category or the kind of
 * video in the cover's tooltip. Kept in one place so the two platforms cannot
 * drift apart again.
 */

import type { TrackData } from './types.js';

export type BroadcastKind = 'live' | 'offline' | 'vod' | 'clip';

export interface BroadcastView {
  platform: 'twitch' | 'kick';
  kind: BroadcastKind;
  /** The channel's login (live, offline) or the video's or clip's id. */
  id: string;
  channelName: string;
  channelUrl: string;
  avatarUrl: string;
  /** The stream's title, or the video's. */
  title: string;
  category: string;
  /** Live only: the page's follower line, shown where a playlist would be. */
  followers?: string;
  /** Live only: when the stream started, epoch ms. */
  startMs?: number;
  /** Offline only: the title of the channel's last stream, for the tooltip. */
  lastTitle?: string;
  /** Video and clip: the page to send a viewer to. */
  pageUrl?: string;
  /** Video and clip: what kind of video it is ("Past broadcast", "Clip"). */
  videoLabel?: string;
  /** Video and clip: the player's position when the tab last pushed. */
  positionMs?: number;
  durationMs?: number;
  /**
   * When the tab pushed, performance.now(). A playing video's position runs on
   * from there; an offline card counts from it so its timer does not restart
   * on every push.
   */
  receivedAt: number;
  /** Offline only: performance.now() of the first push from this page. */
  offlineSince?: number;
}

/** Whether a track is one of these cards rather than a song. */
export function isBroadcastSource(src: string | undefined): boolean {
  return src === 'twitch' || src === 'kick';
}

const OFFLINE_LABEL = '⚫ Offline';

export function broadcastTrack(v: BroadcastView, now: number): TrackData {
  const name = `📺 ${v.channelName}`;
  const base = {
    track_name: name,
    media_source: v.platform,
    artist_url: '',
    _received_at: now,
    _from_push: true,
  };

  if (v.kind === 'live') {
    return {
      ...base,
      track_id: `${v.platform}:${v.id}`,
      artist_name: v.title || v.category || 'Just Chatting',
      album_name: v.category ? `🎮 ${v.category}` : '',
      duration_ms: 0, // Live streams have no duration
      progress_ms: 0,
      is_playing: true,
      is_live: true,
      stream_start_time_ms: v.startMs || 0,
      album_art_url: v.avatarUrl,
      spotify_url: v.channelUrl,
      context_name: v.followers || '',
      context_url: v.channelUrl,
      context_type: 'live',
      video_url: v.channelUrl,
    };
  }

  if (v.kind === 'offline') {
    /*
     * The same track id as the live card, so a channel going live while the
     * tab is open stays on the card it already had (alignSlots matches on it).
     *
     * Not `is_live`: that would put a Live tag on the window's card and a
     * "live for" timer on Discord's. The timer counts from when the tab opened
     * the channel instead — a progress with no duration — so
     * every push agrees with the last one and the clock does not restart.
     */
    return {
      ...base,
      track_id: `${v.platform}:${v.id}`,
      artist_name: OFFLINE_LABEL,
      // The cover's tooltip, which would otherwise repeat the channel's name.
      album_name: v.lastTitle ? `Last stream: ${v.lastTitle}` : (v.platform === 'kick' ? 'Kick' : 'Twitch'),
      duration_ms: 0,
      progress_ms: Math.max(0, Math.round(now - (v.offlineSince ?? now))),
      is_playing: true,
      is_live: false,
      album_art_url: v.avatarUrl,
      spotify_url: v.channelUrl,
      context_name: '',
      context_url: v.channelUrl,
      context_type: 'offline',
      video_url: v.channelUrl,
    };
  }

  // A past broadcast or a clip: a video with a length and a position, which
  // the presence shows as a progress bar like any other.
  const dur = v.durationMs || 0;
  const elapsed = Math.max(0, now - v.receivedAt);
  const pos = Math.round((v.positionMs || 0) + elapsed);
  const tooltip = [v.category ? `🎮 ${v.category}` : '', v.videoLabel || ''].filter(Boolean).join(' · ');
  return {
    ...base,
    track_id: `${v.platform}:${v.kind === 'clip' ? 'c' : 'v'}:${v.id}`,
    artist_name: v.title || v.videoLabel || 'Video',
    album_name: tooltip,
    duration_ms: dur,
    progress_ms: dur > 0 ? Math.min(pos, dur) : pos,
    is_playing: true,
    is_live: false,
    album_art_url: v.avatarUrl,
    spotify_url: v.pageUrl || v.channelUrl,
    context_name: '',
    context_url: v.channelUrl,
    context_type: v.kind,
    video_url: v.pageUrl || v.channelUrl,
  };
}
