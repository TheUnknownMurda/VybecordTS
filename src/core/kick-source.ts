/**
 * Kick push-based track source (via the browser extension).
 *
 * Receives what a Kick tab is showing from the extension via HTTP POST — a
 * channel, live or not, a past broadcast, or a clip — and turns it into a card
 * the same way Twitch's are (see broadcast-track.ts).
 *
 * Falls back to SMTC automatically if the userscript stops pushing, judged against the cadence it had been keeping -- see push-freshness.ts.
 *
 * Several tabs at once are several cards at once — one entry per tab, one
 * track per channel or video. See push-instances.ts and the same note in
 * twitch-source.ts.
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import { asBool, asNonNegativeInt, asRecord, asText, asUrl } from './utils.js';
import type { TrackData } from './types.js';
import { PushInstances, type PushInstance } from './push-instances.js';
import { broadcastTrack, type BroadcastView } from './broadcast-track.js';

const log = createLogger('KickSource');

/** What kind of page a tab is on. Scripts older than this field mean 'channel'. */
export type KickPageKind = 'channel' | 'vod' | 'clip';

/** Shape of JSON pushed by the extension. */
export interface KickPayload {
  page_kind: KickPageKind;
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
  /** Offline channel: the title of its last stream, when Kick said. */
  last_title: string;
  /** Past broadcast: the uuid in /<channel>/videos/<uuid>. */
  video_id: string;
  /** Clip: its id, from /<channel>/clips/<id> or ?clip=<id>. */
  clip_id: string;
  /** Past broadcast and clip: the player's state when the tab pushed. */
  position_ms: number;
  duration_ms: number;
  paused: boolean;
  /** Which tab pushed this — see the same field in twitch-source.ts. */
  tab_id?: string;
}

const RE_VIDEO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_CLIP_ID = /^clip_[A-Za-z0-9]{1,40}$/;
const RE_KICK_SLUG = /^[A-Za-z0-9_-]{1,64}$/;

/** Coerce a push into the shape above, whatever actually arrived. */
export function normalizeKickPayload(raw: unknown): KickPayload {
  const d = asRecord(raw);
  const kind = asText(d.page_kind, 16);
  const videoId = asText(d.video_id, 36);
  const clipId = asText(d.clip_id, 45);
  return {
    page_kind: kind === 'vod' || kind === 'clip' ? kind : 'channel',
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
    last_title: asText(d.last_title),
    // Pasted into URLs, so only what real ids look like.
    video_id: RE_VIDEO_UUID.test(videoId) ? videoId : '',
    clip_id: RE_CLIP_ID.test(clipId) ? clipId : '',
    position_ms: asNonNegativeInt(d.position_ms),
    duration_ms: asNonNegativeInt(d.duration_ms),
    paused: asBool(d.paused),
  };
}

/** One tab's latest push, plus the start estimate it has settled on. */
interface KickTab extends KickPayload {
  startEstimateMs: number;
  /** performance.now() of the first push on this page, which an offline card counts from. */
  pageSince: number;
}

/** What a tab is showing, as one key: `ch:<slug>`, `v:<uuid>` or `c:<clip id>`. */
function pageKey(d: KickPayload): string {
  if (d.page_kind === 'vod') return d.video_id ? `v:${d.video_id}` : '';
  if (d.page_kind === 'clip') return d.clip_id ? `c:${d.clip_id}` : '';
  return RE_KICK_SLUG.test(d.username) ? `ch:${d.username.toLowerCase()}` : '';
}

export class KickSource {
  /** One entry per tab — or per channel, for a script that names no tab. */
  private readonly tabs = new PushInstances<KickTab>();
  private _wasActive = false;

  /**
   * Ingest a push from the extension.
   * Called by the web server on POST /api/kick.
   *
   * Unlike Twitch, everything here comes from the page: Kick refuses every
   * request that does not come from a browser on kick.com (see the header of
   * extension/src/sites/kick.js), so the extension asks Kick's own API from
   * the tab and sends the answer along.
   */
  update(raw: unknown): KickPayload {
    const data = normalizeKickPayload(raw);
    const now = performance.now();
    const page = pageKey(data);
    const key = data.tab_id || page || 'tab';
    const prev = this.tabs.get(key)?.data;
    const samePage = !!prev && pageKey(prev) === page;

    if (!this._wasActive) {
      this._wasActive = true;
      log.info('Kick extension connected ✓ — using as primary Kick source');
    }

    // Use stream start time from the extension, else what this tab settled on
    // earlier, else now. Reset when the stream goes offline.
    const startEstimateMs = !data.is_live ? 0
      : data.stream_start_time_ms || (samePage ? prev!.startEstimateMs : 0) || Date.now();
    this.tabs.seen(key, { ...data, startEstimateMs, pageSince: samePage ? prev!.pageSince : now }, now);
    return data;
  }

  /** What one tab should be shown as, or null for nothing (paused, not a page). */
  private viewFor(t: PushInstance<KickTab>): BroadcastView | null {
    const d = t.data;
    const page = pageKey(d);
    if (!page) return null;
    const slug = d.username;
    const channelUrl = d.profile_url || (slug ? `https://kick.com/${slug}` : 'https://kick.com');
    const common = {
      platform: 'kick' as const,
      channelName: d.display_name || slug || 'Kick',
      channelUrl,
      avatarUrl: d.profile_picture_url || d.thumbnail_url,
      receivedAt: t.receivedAt,
    };
    if (page.startsWith('ch:')) {
      if (d.is_live) {
        return {
          ...common, kind: 'live', id: slug,
          title: d.stream_title, category: d.category, followers: d.followers,
          startMs: d.startEstimateMs,
        };
      }
      return { ...common, kind: 'offline', id: slug, title: '', category: '', lastTitle: d.last_title, offlineSince: d.pageSince };
    }
    // A paused video is not playing anything, the same as a paused song.
    if (d.paused) return null;
    const isClip = page.startsWith('c:');
    const id = page.slice(2);
    return {
      ...common,
      kind: isClip ? 'clip' : 'vod',
      id,
      title: d.stream_title,
      category: d.category,
      pageUrl: isClip ? `${channelUrl}/clips/${id}` : `${channelUrl}/videos/${id}`,
      videoLabel: isClip ? 'Clip' : 'Past broadcast',
      positionMs: d.position_ms,
      durationMs: d.duration_ms,
    };
  }

  /**
   * One track per channel or video some fresh tab is on. Two tabs on the same
   * page are one card: the one pushed most recently speaks for it.
   */
  getCurrentTracks(): TrackData[] {
    const now = performance.now();
    const byPage = new Map<string, PushInstance<KickTab>>();
    for (const t of this.tabs.fresh(now)) {
      const page = pageKey(t.data);
      if (!page) continue;
      const held = byPage.get(page);
      if (!held || t.receivedAt >= held.receivedAt) byPage.set(page, t);
    }
    const out: TrackData[] = [];
    for (const t of byPage.values()) {
      const view = this.viewFor(t);
      if (view) out.push(broadcastTrack(view, now));
    }
    return out;
  }

  /** The first card, for callers that want one — see getCurrentTracks(). */
  getCurrentTrack(): TrackData | null {
    return this.getCurrentTracks()[0] ?? null;
  }

  /** True while some tab is still pushing at the cadence it has been keeping. */
  get isActive(): boolean {
    const fresh = this.tabs.fresh(performance.now()).length > 0;
    if (!fresh && this._wasActive) {
      this._wasActive = false;
      log.warn(`Kick extension stale (>${this.tabs.windowSeconds}s) — falling back to SMTC`);
    }
    return fresh;
  }

  /** Whether the extension reports nothing to show: no fresh tab with a card. */
  get isPaused(): boolean {
    if (!this.isActive) return true;
    return this.getCurrentTracks().length === 0;
  }

  /** The most recent payload from any fresh tab. */
  get latest(): KickPayload | null {
    return this.tabs.latest(performance.now())?.data ?? null;
  }
}
