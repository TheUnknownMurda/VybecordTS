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
 *
 * A tab on a live channel or a past broadcast also reports what Kick's caption
 * overlay says, when the viewer has captions on; each tab's reports are
 * stitched into lines here (see live-captions.ts) and the backend puts them on
 * the card as lyrics.
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import { asBool, asNonNegativeInt, asRecord, asText, asUrl } from './utils.js';
import type { LyricLine, TrackData } from './types.js';
import { PushInstances, type PushInstance } from './push-instances.js';
import { broadcastTrack, type BroadcastView } from './broadcast-track.js';
import { LiveCaptions } from './live-captions.js';

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
  /** What Kick's caption overlay said when the tab pushed; '' with captions off or nothing said. */
  caption: string;
  /** When the overlay last changed, by the tab's clock (epoch ms); 0 if it never has. */
  caption_at: number;
  /** How long it had been unchanged when the tab pushed. */
  caption_age_ms: number;
  /** Captions the stream carries ('manifest', Kick's word) rather than speech recognition. */
  caption_from_stream: boolean;
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
    // Twenty words at most, as Kick shows them; the slack is for long words.
    caption: asText(d.caption, 400),
    caption_at: asNonNegativeInt(d.caption_at),
    caption_age_ms: asNonNegativeInt(d.caption_age_ms),
    caption_from_stream: asText(d.caption_source, 16) === 'manifest',
  };
}

/** One tab's latest push, plus the start estimate it has settled on. */
interface KickTab extends KickPayload {
  startEstimateMs: number;
  /** performance.now() of the first push on this page, which an offline card counts from. */
  pageSince: number;
  /** The captions this tab has reported on this page, as lines. Handed on from push to push. */
  captions: LiveCaptions;
}

const NO_LINES: LyricLine[] = [];

/**
 * How far a past broadcast may land from where its last push said it would be
 * before it counts as a seek: the same line the lyrics engine draws (see
 * SEEK_DRIFT_MS there). Pushes from a tab in front come 2.5 s apart at most,
 * so a stall cannot open a gap that wide between two of them.
 */
const SEEK_MS = 4_000;

/** Whether a video's position moved by more than playing on since the last push explains. */
function seeked(prev: KickPayload, next: KickPayload, sinceMs: number): boolean {
  const expected = prev.position_ms + (prev.paused ? 0 : sinceMs);
  return Math.abs(next.position_ms - expected) > SEEK_MS;
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
    const entry = this.tabs.get(key);
    const prev = entry?.data;
    const samePage = !!prev && pageKey(prev) === page;

    if (!this._wasActive) {
      this._wasActive = true;
      log.info('Kick extension connected ✓ — using as primary Kick source');
    }

    // Use stream start time from the extension, else what this tab settled on
    // earlier, else now. Reset when the stream goes offline.
    const startEstimateMs = !data.is_live ? 0
      : data.stream_start_time_ms || (samePage ? prev!.startEstimateMs : 0) || Date.now();
    /*
     * A new page, or a stream that went off the air, starts a new transcript:
     * the last channel's words do not belong under this one's name. A past
     * broadcast has captions too, in the same overlay; a clip is too short to
     * bother with. A past broadcast that was skipped through starts its lines
     * over: the ones already cut were said somewhere else in the video, and on
     * the card, beside the first line said after the jump, they read as what
     * is being said now.
     */
    const captioned = data.page_kind === 'vod' || (data.page_kind === 'channel' && data.is_live);
    const captions = samePage && captioned ? prev!.captions : new LiveCaptions();
    const jumped = samePage && data.page_kind === 'vod' && seeked(prev!, data, now - entry!.receivedAt);
    if (jumped) captions.restart();
    if (captioned) {
      captions.add(data.caption, data.caption_at, data.caption_age_ms, data.caption_from_stream, now);
    }
    this.tabs.seen(key, { ...data, startEstimateMs, pageSince: samePage ? prev!.pageSince : now, captions }, now);
    return data;
  }

  /**
   * The caption lines for a card, by its track id: `kick:<channel>` for a live
   * channel, `kick:v:<id>` for a past broadcast. From whichever fresh tab on
   * that page has the most, since a second tab with captions off reports none.
   * An empty list when no tab has any, and for any other card.
   */
  captionLines(trackId: string): LyricLine[] {
    if (!trackId.startsWith('kick:') || trackId.startsWith('kick:c:')) return NO_LINES;
    const rest = trackId.slice(5);
    const vod = rest.startsWith('v:');
    const page = vod ? rest : `ch:${rest.toLowerCase()}`;
    let best = NO_LINES;
    for (const t of this.tabs.fresh(performance.now())) {
      if (pageKey(t.data) !== page || (!vod && !t.data.is_live)) continue;
      const lines = t.data.captions.lines;
      if (lines.length > best.length) best = lines;
    }
    return best;
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
