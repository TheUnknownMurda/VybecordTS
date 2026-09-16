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
 * Falls back to SMTC automatically if the userscript stops pushing, judged against the cadence it had been keeping -- see push-freshness.ts.
 *
 * Several tabs at once are several streams at once — one entry per tab, one
 * track per live tab. See push-instances.ts and the same note in
 * twitch-source.ts.
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import { asBool, asNonNegativeInt, asRecord, asText, asUrl } from './utils.js';
import type { TrackData } from './types.js';
import { PushInstances, type PushInstance } from './push-instances.js';

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
  stream_start_time_ms?: number;
  /** Which tab pushed this — see the same field in twitch-source.ts. */
  tab_id?: string;
}

/** Coerce a push into the shape above, whatever actually arrived. */
export function normalizeKickPayload(raw: unknown): KickPayload {
  const d = asRecord(raw);
  return {
    tab_id: asText(d.tab_id, 32),
    username: asText(d.username, 64),
    display_name: asText(d.display_name, 64),
    followers: asText(d.followers, 32),
    category: asText(d.category, 64),
    stream_title: asText(d.stream_title),
    profile_url: asUrl(d.profile_url),
    is_live: asBool(d.is_live),
    thumbnail_url: asUrl(d.thumbnail_url),
    profile_picture_url: asUrl(d.profile_picture_url),
    stream_start_time_ms: asNonNegativeInt(d.stream_start_time_ms),
  };
}

/** One tab's latest push, plus the start estimate it has settled on. */
interface KickTab extends KickPayload {
  startEstimateMs: number;
}

export class KickSource {
  /** One entry per tab — or per channel, for a script that names no tab. */
  private readonly tabs = new PushInstances<KickTab>();
  private _wasActive = false;

  /**
   * Ingest a push from the Kick userscript.
   * Called by the web server on POST /api/kick.
   */
  update(raw: unknown): KickPayload {
    const data = normalizeKickPayload(raw);
    const now = performance.now();
    const key = data.tab_id || data.username.toLowerCase() || 'tab';
    const prev = this.tabs.get(key);

    if (!this._wasActive) {
      this._wasActive = true;
      log.info('Kick userscript connected ✓ — using as primary Kick source');
    }

    // Use stream start time from Tampermonkey script, else what this tab
    // settled on earlier, else now. Reset when the stream goes offline.
    const startEstimateMs = !data.is_live ? 0
      : data.stream_start_time_ms || prev?.data.startEstimateMs || Date.now();
    this.tabs.seen(key, { ...data, startEstimateMs }, now);
    return data;
  }

  /**
   * One track per live stream some fresh tab is on. Two tabs on the same
   * channel are one stream: the one pushed most recently speaks for it.
   */
  getCurrentTracks(): TrackData[] {
    const now = performance.now();
    const byLogin = new Map<string, PushInstance<KickTab>>();
    for (const t of this.tabs.fresh(now)) {
      const d = t.data;
      if (!d.is_live || !d.username) continue;
      const login = d.username.toLowerCase();
      const held = byLogin.get(login);
      if (!held || t.receivedAt >= held.receivedAt) byLogin.set(login, t);
    }
    return [...byLogin.values()].map(({ data: d }) => ({
      track_id: `kick:${d.username}`,
      track_name: `📺 ${d.display_name || d.username}`,
      artist_name: d.stream_title || d.category || 'Just Chatting',
      album_name: d.category ? `🎮 ${d.category}` : '',
      duration_ms: 0, // Live streams have no duration
      progress_ms: 0,
      is_playing: true,
      is_live: true,
      stream_start_time_ms: d.startEstimateMs,
      album_art_url: d.profile_picture_url || d.thumbnail_url || '',
      spotify_url: d.profile_url || '',
      artist_url: '',
      context_name: d.followers || '',
      context_url: d.profile_url || '',
      context_type: 'live',
      media_source: 'kick',
      _received_at: now,
      _from_push: true,
      video_url: d.profile_url || '',
    }));
  }

  /** The first live stream, for callers that want one — see getCurrentTracks(). */
  getCurrentTrack(): TrackData | null {
    return this.getCurrentTracks()[0] ?? null;
  }

  /** True while some tab is still pushing at the cadence it has been keeping. */
  get isActive(): boolean {
    const fresh = this.tabs.fresh(performance.now()).length > 0;
    if (!fresh && this._wasActive) {
      this._wasActive = false;
      log.warn(`Kick userscript stale (>${this.tabs.windowSeconds}s) — falling back to SMTC`);
    }
    return fresh;
  }

  /** Whether the userscript reports nothing playing: no fresh tab on a live stream. */
  get isPaused(): boolean {
    if (!this.isActive) return true;
    return this.getCurrentTracks().length === 0;
  }

  /** The most recent payload from any fresh tab. */
  get latest(): KickPayload | null {
    return this.tabs.latest(performance.now())?.data ?? null;
  }
}
