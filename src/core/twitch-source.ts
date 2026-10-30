/**
 * Twitch push-based track source (via the browser extension).
 *
 * Receives what a Twitch tab is showing from the extension via HTTP POST — a
 * channel, live or not, a past broadcast, or a clip — and turns it into a card
 * (see broadcast-track.ts).
 *
 * The page is a poor witness, so most of what the card says is asked of Twitch
 * here rather than read off it. Twitch is a single-page app that renders the
 * channel a second or more after the URL changes, and until then the page
 * holds the previous channel, the followed-channels sidebar and the viewer's
 * own avatar in the top bar. The old script read whatever matched first: the
 * card opened on a chatter's name with the signed-in user's own picture, and
 * corrected itself a few seconds later. Its liveness check matched any element
 * whose class contained "live" — every live channel in the sidebar — so an
 * offline channel read as live.
 *
 * The desktop app already calls out to half a dozen music APIs, and Twitch's
 * public GraphQL API answers one small query with the channel's display name,
 * its picture, whether it is streaming and since when, and what it last
 * streamed. A content script cannot make that request without costing the
 * extension its "only contacts 127.0.0.1" claim, so it is made here, and its
 * answer outranks the page wherever both speak. Until it lands (a hundred
 * milliseconds, normally) a new tab is held back rather than shown with
 * guesses — see HOLD_MS.
 *
 * Liveness follows the same rule: Twitch's own answer stands until it is
 * re-checked, and a page that disagrees with it only hastens the re-check.
 * Failing to reach Twitch is not evidence of anything, so it changes nothing.
 *
 * Falls back to SMTC automatically if the extension stops pushing, judged
 * against the cadence it had been keeping -- see push-freshness.ts.
 *
 * Several tabs at once are several cards at once: each push is filed under
 * the tab it came from (see push-instances.ts), and getCurrentTracks() hands
 * back one track per channel or video, so two streams watched side by side can
 * take two presence cards rather than fighting over one.
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import { asBool, asNonNegativeInt, asRecord, asText, asUrl, evictOldest } from './utils.js';
import type { TrackData } from './types.js';
import { PushInstances, type PushInstance } from './push-instances.js';
import { broadcastTrack, type BroadcastView } from './broadcast-track.js';

const log = createLogger('TwitchSource');

/** What kind of page a tab is on. Scripts older than this field mean 'channel'. */
export type TwitchPageKind = 'channel' | 'vod' | 'clip';

/** Shape of JSON pushed by the extension. */
export interface TwitchPayload {
  page_kind: TwitchPageKind;
  /** The channel's login. Empty on a past broadcast, which names only its id. */
  username: string;
  display_name: string;
  followers: string;
  category: string;
  stream_title: string;
  profile_url: string;
  /** The page's reading: true only when it shows the live player. */
  is_live: boolean;
  /**
   * Whether the page had rendered the channel when it pushed. Before that,
   * `is_live` is false for want of a reading, not because the channel is
   * offline. Older scripts send none, and their reading is taken as it is.
   */
  page_ready: boolean;
  thumbnail_url: string;
  profile_picture_url: string;
  /** Estimated — superseded by the GraphQL lookup below once it resolves. */
  stream_start_time_ms?: number;
  /** Past broadcast: the number in /videos/<id>. */
  video_id: string;
  /** Clip: the slug in /<channel>/clip/<slug>. */
  clip_slug: string;
  /** Past broadcast and clip: the player's state when the tab pushed. */
  position_ms: number;
  duration_ms: number;
  paused: boolean;
  /**
   * Which tab pushed this, so a tab moving from one channel to the next
   * replaces its own entry rather than leaving the old channel on a card
   * until it ages out. Older scripts send none; the channel stands in.
   */
  tab_id?: string;
}

const RE_VIDEO_ID = /^\d{1,20}$/;
const RE_CLIP_SLUG = /^[A-Za-z0-9_-]{1,100}$/;

/** Coerce a push into the shape above, whatever actually arrived. */
export function normalizeTwitchPayload(raw: unknown): TwitchPayload {
  const d = asRecord(raw);
  const kind = asText(d.page_kind, 16);
  const videoId = asText(d.video_id, 20);
  const clipSlug = asText(d.clip_slug, 100);
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
    page_ready: d.page_ready === undefined ? true : asBool(d.page_ready),
    thumbnail_url: asUrl(d.thumbnail_url),
    profile_picture_url: asUrl(d.profile_picture_url),
    stream_start_time_ms: asNonNegativeInt(d.stream_start_time_ms),
    // Pasted into URLs and GraphQL queries, so only what real ids look like.
    video_id: RE_VIDEO_ID.test(videoId) ? videoId : '',
    clip_slug: RE_CLIP_SLUG.test(clipSlug) ? clipSlug : '',
    position_ms: asNonNegativeInt(d.position_ms),
    duration_ms: asNonNegativeInt(d.duration_ms),
    paused: asBool(d.paused),
  };
}

// ── Lookups ──

const USER_AGENT = 'VybecordTS v1.0.0 (by TheUnknownMurda)';
const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';

// The Client-Id twitch.tv bakes into its own page HTML and sends with every
// request to gql.twitch.tv — the public identifier for unauthenticated,
// read-only queries (the same one tools like Streamlink use), not a credential.
const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

const GQL_TIMEOUT_MS = 4_000;
/** How long a live channel's answer is trusted before it is checked again. */
const RESOLVE_TTL_MS = 10 * 60_000;
/** Backoff after a lookup that returned nothing usable. */
const RETRY_AFTER_MS = 60_000;
/**
 * How long a "not streaming" verdict stands before it is checked again.
 *
 * This is the delay before a stream that starts while the tab is already open
 * reaches Discord when the page does not notice first, so it is deliberately
 * short — the request is one small POST.
 */
const OFFLINE_RECHECK_MS = 45_000;
/**
 * How soon a page that disagrees with Twitch's last answer gets it re-asked.
 *
 * The page sees a stream start or end the moment Twitch's player does, so it
 * is the faster signal; it is not the more reliable one, which is why it only
 * prompts a lookup instead of overruling one.
 */
const DISAGREE_RECHECK_MS = 15_000;
/** Stop retrying after this many consecutive failures. */
const MAX_ATTEMPTS = 8;
/**
 * How long a tab new to a channel or video waits for the lookup before it is
 * shown with only what the page said. Long enough for the lookup, which takes
 * a tenth of that; short enough that a Twitch outage costs two seconds.
 */
const HOLD_MS = 2_500;
/** Allowance for clock skew between this machine and Twitch. */
const MAX_FUTURE_SKEW_MS = 60_000;
/** Older than this is stale or bogus data, not a stream running right now. */
const MAX_STREAM_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
/** A handful of channels and videos are open at a time; the cap is hygiene. */
const MAX_CACHED = 32;

/** Twitch logins are lowercase alphanumerics and underscores. */
const RE_TWITCH_LOGIN = /^[a-z0-9_]{3,25}$/;

/** What Twitch calls each kind of video, as a viewer would read it. */
const VIDEO_LABELS: Record<string, string> = {
  ARCHIVE: 'Past broadcast',
  HIGHLIGHT: 'Highlight',
  UPLOAD: 'Video',
  PREMIERE_UPLOAD: 'Premiere',
  PAST_PREMIERE: 'Premiere',
};

interface GqlUser {
  login?: string;
  displayName?: string;
  profileImageURL?: string;
}

/**
 * What Twitch last said about a channel.
 *
 * `unknown` is not a synonym for offline: it means nothing was learned, so the
 * page's own reading of liveness stands.
 */
type Liveness = 'live' | 'offline' | 'unknown';

interface ChannelInfo {
  /**
   * False once Twitch has said no such channel exists: a section of the site
   * missing from the script's NOT_A_CHANNEL list, which is not a channel to
   * show as offline.
   */
  exists: boolean;
  liveness: Liveness;
  /** Epoch ms, or 0 when not live / not resolved. */
  startMs: number;
  displayName: string;
  avatarUrl: string;
  title: string;
  category: string;
  /** The last stream's title, for an offline card. */
  lastTitle: string;
  /** `Date.now()` of the last completed attempt. */
  checkedAt: number;
  /** Consecutive failures; reset on any answer. */
  attempts: number;
}

interface VideoInfo {
  /** False while unresolved, or for a video Twitch says does not exist. */
  found: boolean;
  title: string;
  durationMs: number;
  label: string;
  category: string;
  login: string;
  displayName: string;
  avatarUrl: string;
  checkedAt: number;
  attempts: number;
}

/** Lowercase a pushed username, or '' if it is not a plausible Twitch login. */
function normaliseLogin(username: string | undefined): string {
  const login = (username || '').trim().toLowerCase();
  return RE_TWITCH_LOGIN.test(login) ? login : '';
}

/** Run one query; `null` means Twitch was not reached or answered garbage. */
async function gql<T>(query: string): Promise<T | null> {
  try {
    const resp = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Id': TWITCH_WEB_CLIENT_ID,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(GQL_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { data?: T | null };
    return body?.data ?? null;
  } catch {
    return null;
  }
}

/** A `createdAt` that is in the past and not absurdly old, as epoch ms; else 0. */
function sanePast(iso: string | undefined): number {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!ms || Number.isNaN(ms)) return 0;
  const now = Date.now();
  if (ms > now + MAX_FUTURE_SKEW_MS || ms < now - MAX_STREAM_AGE_MS) return 0;
  return ms;
}

type ChannelLookup = Omit<ChannelInfo, 'exists' | 'checkedAt' | 'attempts'> | 'missing' | null;

/**
 * Ask Twitch about `login`: who it is, and whether and since when it streams.
 *
 * `missing` is a login Twitch does not know — not an offline channel, and not
 * something a re-check will fix.
 */
async function fetchChannel(login: string): Promise<ChannelLookup> {
  // JSON.stringify quotes and escapes the login the way GraphQL wants, so the
  // query cannot be steered by whatever the push happened to claim.
  const data = await gql<{
    user?: GqlUser & {
      stream?: { createdAt?: string; title?: string; game?: { displayName?: string } | null } | null;
      lastBroadcast?: { title?: string | null } | null;
    } | null;
  }>(`query { user(login: ${JSON.stringify(login)}) { login displayName profileImageURL(width: 300) `
    + 'stream { createdAt title game { displayName } } lastBroadcast { title } } }');
  if (!data) return null;
  const user = data.user;
  if (!user) return 'missing';
  const stream = user.stream;
  return {
    liveness: stream ? 'live' : 'offline',
    startMs: stream ? sanePast(stream.createdAt) : 0,
    displayName: asText(user.displayName, 64),
    avatarUrl: asUrl(user.profileImageURL),
    title: asText(stream?.title),
    category: asText(stream?.game?.displayName, 64),
    lastTitle: asText(user.lastBroadcast?.title),
  };
}

type VideoLookup = Omit<VideoInfo, 'checkedAt' | 'attempts'> | null;

/** Ask Twitch about a past broadcast (`v:<id>`) or a clip (`c:<slug>`). */
async function fetchVideo(key: string): Promise<VideoLookup> {
  const id = key.slice(2);
  const owner = 'login displayName profileImageURL(width: 300)';
  if (key.startsWith('v:')) {
    const data = await gql<{
      video?: { title?: string; lengthSeconds?: number; broadcastType?: string;
        game?: { displayName?: string } | null; owner?: GqlUser | null } | null;
    }>(`query { video(id: ${JSON.stringify(id)}) { title lengthSeconds broadcastType game { displayName } owner { ${owner} } } }`);
    if (!data) return null;
    const v = data.video;
    if (!v) return { found: false, title: '', durationMs: 0, label: '', category: '', login: '', displayName: '', avatarUrl: '' };
    return {
      found: true,
      title: asText(v.title),
      durationMs: asNonNegativeInt(v.lengthSeconds) * 1000,
      label: VIDEO_LABELS[v.broadcastType || ''] || 'Video',
      category: asText(v.game?.displayName, 64),
      login: normaliseLogin(v.owner?.login),
      displayName: asText(v.owner?.displayName, 64),
      avatarUrl: asUrl(v.owner?.profileImageURL),
    };
  }
  const data = await gql<{
    clip?: { title?: string; durationSeconds?: number;
      game?: { displayName?: string } | null; broadcaster?: GqlUser | null } | null;
  }>(`query { clip(slug: ${JSON.stringify(id)}) { title durationSeconds game { displayName } broadcaster { ${owner} } } }`);
  if (!data) return null;
  const c = data.clip;
  if (!c) return { found: false, title: '', durationMs: 0, label: '', category: '', login: '', displayName: '', avatarUrl: '' };
  return {
    found: true,
    title: asText(c.title),
    durationMs: asNonNegativeInt(c.durationSeconds) * 1000,
    label: 'Clip',
    category: asText(c.game?.displayName, 64),
    login: normaliseLogin(c.broadcaster?.login),
    displayName: asText(c.broadcaster?.displayName, 64),
    avatarUrl: asUrl(c.broadcaster?.profileImageURL),
  };
}

/** One tab's latest push, plus what this side has settled on for it. */
interface TwitchTab extends TwitchPayload {
  /** The script's start estimate, kept across pushes that omit it. */
  startEstimateMs: number;
  /** performance.now() of the first push on this tab's current page. */
  firstSeenAt: number;
  /** performance.now() of the first push on this page, which an offline card counts from. */
  offlineSince: number;
}

/** What a tab is showing, as one key: `ch:<login>`, `v:<id>` or `c:<slug>`. */
function pageKey(d: TwitchPayload): string {
  if (d.page_kind === 'vod') return d.video_id ? `v:${d.video_id}` : '';
  if (d.page_kind === 'clip') return d.clip_slug ? `c:${d.clip_slug}` : '';
  const login = normaliseLogin(d.username);
  return login ? `ch:${login}` : '';
}

export class TwitchSource {
  /** One entry per tab — or per channel, for a script that names no tab. */
  private readonly tabs = new PushInstances<TwitchTab>();
  private _wasActive = false;

  private readonly channels = new Map<string, ChannelInfo>();
  private readonly videos = new Map<string, VideoInfo>();
  private readonly lookupsInFlight = new Set<string>();

  /** @param onResolved  told when a lookup lands, so a held tab need not wait for its next push. */
  constructor(private readonly onResolved?: () => void) {}

  /**
   * Ingest a push from the extension.
   * Called by the web server on POST /api/twitch.
   */
  update(raw: unknown): TwitchPayload {
    const data = normalizeTwitchPayload(raw);
    const now = performance.now();
    const page = pageKey(data);
    const key = data.tab_id || page || 'tab';
    const prev = this.tabs.get(key)?.data;
    const samePage = !!prev && pageKey(prev) === page;

    if (!this._wasActive) {
      this._wasActive = true;
      log.info('Twitch extension connected ✓ — using as primary Twitch source');
    }

    // The script's estimate, and only what the timer falls back to until the
    // GraphQL lookup lands.
    const startEstimateMs = !data.is_live ? 0
      : data.stream_start_time_ms || (samePage ? prev!.startEstimateMs : 0) || Date.now();
    this.tabs.seen(key, {
      ...data,
      startEstimateMs,
      firstSeenAt: samePage ? prev!.firstSeenAt : now,
      offlineSince: samePage ? prev!.offlineSince : now,
    }, now);

    if (page.startsWith('ch:')) void this.resolveChannel(page.slice(3), data.page_ready ? data.is_live : null);
    else if (page) void this.resolveVideo(page);
    return data;
  }

  /** Every page some fresh tab is on, as pageKey() spells it. */
  private openPages(now = performance.now()): Set<string> {
    const out = new Set<string>();
    for (const t of this.tabs.fresh(now)) {
      const k = pageKey(t.data);
      if (k) out.add(k);
    }
    return out;
  }

  /**
   * Look `login` up — and occasionally again. Fire-and-forget: the answer is
   * picked up by the next getCurrentTracks(). Cached per channel because every
   * tab pushes every few seconds and this must not become one request per push.
   */
  private async resolveChannel(login: string, pageSaysLive: boolean | null): Promise<void> {
    if (this.lookupsInFlight.has(`ch:${login}`)) return;

    const cached = this.channels.get(login);
    if (cached) {
      const age = Date.now() - cached.checkedAt;
      const disagrees = cached.liveness !== 'unknown' && pageSaysLive !== null
        && (cached.liveness === 'live') !== pageSaysLive;
      if (disagrees && age >= DISAGREE_RECHECK_MS) {
        // the page saw a stream start or end — ask now
      } else if (cached.liveness === 'live') {
        if (age < RESOLVE_TTL_MS) return;
      } else if (cached.liveness === 'offline') {
        if (age < OFFLINE_RECHECK_MS) return;
      } else {
        if (cached.attempts >= MAX_ATTEMPTS) return; // stop retrying forever
        if (age < RETRY_AFTER_MS) return;
      }
    }

    this.lookupsInFlight.add(`ch:${login}`);
    try {
      const result = await fetchChannel(login);
      if (!this.openPages().has(`ch:${login}`)) return; // every tab moved on, discard

      const prev = this.channels.get(login);
      const entry: ChannelInfo = result === null || result === 'missing'
        ? {
            exists: result === 'missing' ? false : prev?.exists ?? true,
            liveness: prev?.liveness ?? 'unknown',
            startMs: prev?.startMs ?? 0,
            displayName: prev?.displayName ?? '',
            avatarUrl: prev?.avatarUrl ?? '',
            title: prev?.title ?? '',
            category: prev?.category ?? '',
            lastTitle: prev?.lastTitle ?? '',
            checkedAt: Date.now(),
            // A login Twitch does not know will not become one on a retry.
            attempts: result === 'missing' ? MAX_ATTEMPTS : (prev?.attempts ?? 0) + 1,
          }
        : { ...result, exists: true, checkedAt: Date.now(), attempts: 0 };

      // Re-insert so the channel being watched is the newest key, and so never
      // the entry evicted below.
      this.channels.delete(login);
      this.channels.set(login, entry);
      evictOldest(this.channels, MAX_CACHED);

      if (entry.liveness === 'live' && entry.startMs > 0 && entry.startMs !== prev?.startMs) {
        log.info(`[TWITCH] Real stream start for ${login} ✓ ${new Date(entry.startMs).toISOString()}`);
      } else if (entry.liveness === 'offline' && prev?.liveness !== 'offline') {
        log.info(`[TWITCH] Twitch reports ${login} is not streaming — showing it offline`);
      } else if (result === null && entry.attempts === MAX_ATTEMPTS) {
        log.debug(`[TWITCH] Gave up looking up ${login} — keeping what the page says`);
      }
      this.onResolved?.();
    } finally {
      this.lookupsInFlight.delete(`ch:${login}`);
    }
  }

  /** Look a past broadcast or a clip up, once. */
  private async resolveVideo(key: string): Promise<void> {
    if (this.lookupsInFlight.has(key)) return;
    const cached = this.videos.get(key);
    if (cached && (cached.attempts === 0 || cached.attempts >= MAX_ATTEMPTS
      || Date.now() - cached.checkedAt < RETRY_AFTER_MS)) return;

    this.lookupsInFlight.add(key);
    try {
      const result = await fetchVideo(key);
      if (!this.openPages().has(key)) return;
      const entry: VideoInfo = result === null
        ? {
            found: false, title: '', durationMs: 0, label: '', category: '', login: '', displayName: '', avatarUrl: '',
            checkedAt: Date.now(), attempts: (cached?.attempts ?? 0) + 1,
          }
        : { ...result, checkedAt: Date.now(), attempts: result.found ? 0 : MAX_ATTEMPTS };
      this.videos.delete(key);
      this.videos.set(key, entry);
      evictOldest(this.videos, MAX_CACHED);
      if (entry.found) log.info(`[TWITCH] ${entry.label} by ${entry.login}: "${entry.title}"`);
      this.onResolved?.();
    } finally {
      this.lookupsInFlight.delete(key);
    }
  }

  /** What one tab should be shown as, or null for nothing (held, paused, not a page). */
  private viewFor(t: PushInstance<TwitchTab>, now: number): BroadcastView | null {
    const d = t.data;
    const page = pageKey(d);
    if (!page) return null;

    if (page.startsWith('ch:')) {
      const login = page.slice(3);
      const info = this.channels.get(login);
      if (!info && now - d.firstSeenAt < HOLD_MS) return null;
      if (info && !info.exists) return null;
      const live = info && info.liveness !== 'unknown' ? info.liveness === 'live' : d.is_live;
      const channelUrl = `https://www.twitch.tv/${login}`;
      const common = {
        platform: 'twitch' as const,
        id: d.username || login,
        channelName: info?.displayName || d.display_name || d.username,
        channelUrl,
        avatarUrl: info?.avatarUrl || d.profile_picture_url,
        receivedAt: t.receivedAt,
      };
      if (live) {
        return {
          ...common,
          kind: 'live',
          // The page's title and category update as the streamer changes them;
          // the lookup's are up to ten minutes old.
          title: d.stream_title || info?.title || '',
          category: d.category || info?.category || '',
          followers: d.followers,
          // Twitch's own createdAt once it has resolved, else the script's estimate
          startMs: info?.startMs || d.startEstimateMs || 0,
        };
      }
      return {
        ...common,
        kind: 'offline',
        title: '',
        category: '',
        lastTitle: info?.lastTitle || '',
        offlineSince: d.offlineSince,
      };
    }

    // A paused video is not playing anything, the same as a paused song.
    if (d.paused) return null;
    const info = this.videos.get(page);
    if (!info && now - d.firstSeenAt < HOLD_MS) return null;
    const found = info?.found ? info : null;
    const login = found?.login || normaliseLogin(d.username);
    const channelUrl = login ? `https://www.twitch.tv/${login}` : 'https://www.twitch.tv';
    const isClip = page.startsWith('c:');
    return {
      platform: 'twitch',
      kind: isClip ? 'clip' : 'vod',
      id: page.slice(2),
      channelName: found?.displayName || d.display_name || d.username || login || 'Twitch',
      channelUrl,
      avatarUrl: found?.avatarUrl || d.profile_picture_url,
      title: found?.title || d.stream_title,
      category: found?.category || d.category,
      pageUrl: isClip
        ? `${channelUrl}/clip/${page.slice(2)}`
        : `https://www.twitch.tv/videos/${page.slice(2)}`,
      videoLabel: found?.label || (isClip ? 'Clip' : 'Past broadcast'),
      positionMs: d.position_ms,
      // Twitch's length first: right after a navigation the page's player can
      // still be the previous video's for a push.
      durationMs: found?.durationMs || d.duration_ms || 0,
      receivedAt: t.receivedAt,
    };
  }

  /**
   * One track per channel or video some fresh tab is on.
   *
   * Two tabs on the same page are one card: the one pushed most recently
   * speaks for it.
   */
  getCurrentTracks(): TrackData[] {
    const now = performance.now();
    const byPage = new Map<string, PushInstance<TwitchTab>>();
    for (const t of this.tabs.fresh(now)) {
      const page = pageKey(t.data);
      if (!page) continue;
      const held = byPage.get(page);
      if (!held || t.receivedAt >= held.receivedAt) byPage.set(page, t);
    }
    const out: TrackData[] = [];
    for (const t of byPage.values()) {
      const view = this.viewFor(t, now);
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
      log.warn(`Twitch extension stale (>${this.tabs.windowSeconds}s) — falling back to SMTC`);
    }
    return fresh;
  }

  /** Whether the extension reports nothing to show: no fresh tab with a card. */
  get isPaused(): boolean {
    if (!this.isActive) return true;
    return this.getCurrentTracks().length === 0;
  }

  /** The most recent payload from any fresh tab. */
  get latest(): TwitchPayload | null {
    return this.tabs.latest(performance.now())?.data ?? null;
  }
}
