/**
 * Twitch push-based track source (via Tampermonkey userscript).
 *
 * Receives real-time stream data from the VybecordTS Twitch userscript
 * via HTTP POST. Shows streamer details in Discord RPC:
 *   - Streamer username and display name
 *   - Category/game being played
 *   - Follower count
 *   - Profile URL
 *   - Live status
 *
 * Uptime is resolved here rather than in the browser. The pushed
 * `stream_start_time_ms` is an estimate — the page never says when a stream
 * began, so the script reports when its tab first saw the channel live, which
 * is hours late if the tab was opened mid-stream. The exact value is one query
 * away on Twitch's public GraphQL API, which a content script cannot reach and
 * which would cost the browser extension its "only contacts 127.0.0.1" claim.
 * It costs this process nothing — it already calls out to LRCLib, Deezer,
 * iTunes and friends — so it asks Twitch itself, and the real `createdAt`
 * supersedes the estimate as soon as it lands.
 *
 * The same answer settles liveness, which the page is also only guessing at:
 * its check reads "live" whenever it finds no offline marker. Twitch returning
 * a null `stream` is the one thing that overrules it — see isKnownOffline(),
 * and note that failing to reach Twitch is not evidence of anything.
 *
 * Falls back to SMTC automatically if the userscript stops pushing, judged against the cadence it had been keeping -- see push-freshness.ts.
 *
 * Several tabs at once are several streams at once: each push is filed under
 * the tab it came from (see push-instances.ts), and getCurrentTracks() hands
 * back one track per live tab, so two streams watched side by side can take two
 * presence cards rather than fighting over one.
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import { asBool, asNonNegativeInt, asRecord, asText, asUrl, evictOldest } from './utils.js';
import type { TrackData } from './types.js';
import { PushInstances, type PushInstance } from './push-instances.js';

const log = createLogger('TwitchSource');

/** Shape of JSON pushed by the Tampermonkey userscript. */
export interface TwitchPayload {
  username: string;
  display_name: string;
  followers: string;
  category: string;
  stream_title: string;
  profile_url: string;
  is_live: boolean;
  thumbnail_url: string;
  profile_picture_url: string;
  /** Estimated — superseded by the GraphQL lookup below once it resolves. */
  stream_start_time_ms?: number;
  /**
   * Which tab pushed this, so a tab moving from one channel to the next
   * replaces its own entry rather than leaving the old channel on a card
   * until it ages out. Older scripts send none; the channel stands in.
   */
  tab_id?: string;
}

/** Coerce a push into the shape above, whatever actually arrived. */
export function normalizeTwitchPayload(raw: unknown): TwitchPayload {
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

// ── Stream start resolution ──

const USER_AGENT = 'VybecordTS v1.0.0 (by TheUnknownMurda)';
const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';

// The Client-Id twitch.tv bakes into its own page HTML and sends with every
// request to gql.twitch.tv — the public identifier for unauthenticated,
// read-only queries (the same one tools like Streamlink use), not a credential.
const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

const GQL_TIMEOUT_MS = 4_000;
/** How long a resolved start is trusted before it is checked again. */
const RESOLVE_TTL_MS = 10 * 60_000;
/** Backoff after a lookup that returned nothing usable. */
const RETRY_AFTER_MS = 60_000;
/**
 * How long an "not streaming" verdict stands before it is checked again.
 *
 * This is the delay before a stream that starts while the tab is already open
 * reaches Discord, so it is deliberately short — the request is one small POST.
 */
const OFFLINE_RECHECK_MS = 45_000;
/** Stop retrying a streamer after this many consecutive failures. */
const MAX_ATTEMPTS = 8;
/** Allowance for clock skew between this machine and Twitch. */
const MAX_FUTURE_SKEW_MS = 60_000;
/** Older than this is stale or bogus data, not a stream running right now. */
const MAX_STREAM_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
/** One streamer is active at a time; the cap is hygiene, not pressure. */
const MAX_CACHED_STREAMERS = 16;

/** Twitch logins are lowercase alphanumerics and underscores. */
const RE_TWITCH_LOGIN = /^[a-z0-9_]{3,25}$/;

interface TwitchGqlResponse {
  data?: { user?: { stream?: { createdAt?: string } | null } | null } | null;
}

/**
 * What Twitch last said about a channel.
 *
 * `unknown` is not a synonym for offline: it means nothing was learned, so the
 * page's own reading of liveness stands. Only `offline` is Twitch contradicting
 * the page, and only that is acted on.
 */
type Liveness = 'live' | 'offline' | 'unknown';

interface ResolvedStart {
  /** Epoch ms, or 0 when not live / not resolved. */
  startMs: number;
  liveness: Liveness;
  /** `Date.now()` of the last completed attempt. */
  checkedAt: number;
  /** Consecutive failures; reset on any answer. */
  attempts: number;
}

/** Outcome of one lookup. `null` means Twitch was not reached at all. */
type StreamLookup = { live: true; startMs: number } | { live: false } | null;

/** Lowercase a pushed username, or '' if it is not a plausible Twitch login. */
function normaliseLogin(username: string | undefined): string {
  const login = (username || '').trim().toLowerCase();
  return RE_TWITCH_LOGIN.test(login) ? login : '';
}

/**
 * Ask Twitch's public GraphQL API about `username`'s current stream.
 *
 * The query answers two questions at once, and the caller needs both: whether
 * the channel is streaming (`stream` is null when it is not) and, if so, when
 * that stream began. A `startMs` of 0 on a live channel means the timestamp
 * failed the sanity checks below — live, but with no usable start.
 */
async function fetchStreamStart(username: string): Promise<StreamLookup> {
  try {
    const resp = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Id': TWITCH_WEB_CLIENT_ID,
        'User-Agent': USER_AGENT,
      },
      // JSON.stringify quotes and escapes the login the way GraphQL wants, so
      // the query cannot be steered by whatever the push happened to claim.
      body: JSON.stringify({
        query: `query { user(login: ${JSON.stringify(username)}) { stream { createdAt } } }`,
      }),
      signal: AbortSignal.timeout(GQL_TIMEOUT_MS),
    });
    if (!resp.ok) return null;

    const body = (await resp.json()) as TwitchGqlResponse;
    // A `user` of null is a login that does not exist — not an offline channel,
    // and not something a re-check will fix, so it stays `unknown`.
    const user = body?.data?.user;
    if (!user) return null;

    const stream = user.stream;
    if (!stream) return { live: false }; // Twitch is explicit: not streaming

    const createdAt = stream.createdAt;
    if (!createdAt) return { live: true, startMs: 0 };

    const startMs = Date.parse(createdAt);
    if (!startMs || Number.isNaN(startMs)) return { live: true, startMs: 0 };

    // Sanity check — must be in the past and not absurdly old, in case the
    // API ever returns stale or unexpected data.
    const now = Date.now();
    if (startMs > now + MAX_FUTURE_SKEW_MS || startMs < now - MAX_STREAM_AGE_MS) {
      return { live: true, startMs: 0 };
    }

    return { live: true, startMs };
  } catch {
    return null;
  }
}

/** One tab's latest push, plus the start estimate it has settled on. */
interface TwitchTab extends TwitchPayload {
  /** The userscript's estimate, kept across pushes that omit it. */
  startEstimateMs: number;
}

export class TwitchSource {
  /** One entry per tab — or per channel, for a script that names no tab. */
  private readonly tabs = new PushInstances<TwitchTab>();
  private _wasActive = false;

  /** Real `createdAt` per streamer, so poll() reuses it instead of re-querying. */
  private readonly resolvedStarts = new Map<string, ResolvedStart>();
  private readonly lookupsInFlight = new Set<string>();

  /**
   * Ingest a push from the Twitch userscript.
   * Called by the web server on POST /api/twitch.
   */
  update(raw: unknown): TwitchPayload {
    const data = normalizeTwitchPayload(raw);
    const now = performance.now();
    const login = normaliseLogin(data.username);
    const key = data.tab_id || login || 'tab';
    const prev = this.tabs.get(key);

    if (!this._wasActive) {
      this._wasActive = true;
      log.info('Twitch userscript connected ✓ — using as primary Twitch source');
    }

    if (!data.is_live) {
      // Kept, not dropped: the script is still talking, which is what
      // isActive answers, and it now says this tab shows no stream. The
      // resolved start goes if no other tab has the channel live — if it
      // comes back it is a new stream with a new createdAt.
      this.tabs.seen(key, { ...data, startEstimateMs: 0 }, now);
      if (login && !this.liveLogins(now).has(login)) this.resolvedStarts.delete(login);
      return data;
    }

    // Use stream start time from Tampermonkey script — an estimate, and only
    // what the timer falls back to until the GraphQL lookup lands.
    const startEstimateMs = data.stream_start_time_ms || prev?.data.startEstimateMs || Date.now();
    this.tabs.seen(key, { ...data, startEstimateMs }, now);

    if (login) void this.resolveStreamStart(login);
    return data;
  }

  /** Every channel some fresh tab reports live, lowercased. */
  private liveLogins(now = performance.now()): Set<string> {
    const out = new Set<string>();
    for (const t of this.tabs.fresh(now)) {
      if (t.data.is_live) {
        const login = normaliseLogin(t.data.username);
        if (login) out.add(login);
      }
    }
    return out;
  }

  /**
   * Resolve — and occasionally re-check — the real start time for `username`.
   * Fire-and-forget: the value is picked up by the next getCurrentTrack().
   * Cached per streamer because update() and poll() both run every few
   * seconds and this must not become one request per tick.
   */
  private async resolveStreamStart(username: string): Promise<void> {
    if (!username || this.lookupsInFlight.has(username)) return;

    const cached = this.resolvedStarts.get(username);
    if (cached) {
      const age = Date.now() - cached.checkedAt;
      if (cached.liveness === 'live' && cached.startMs > 0) {
        if (age < RESOLVE_TTL_MS) return; // still fresh
      } else if (cached.liveness === 'offline') {
        if (age < OFFLINE_RECHECK_MS) return; // suppressing; re-check soon
      } else {
        if (cached.attempts >= MAX_ATTEMPTS) return; // stop retrying forever
        if (age < RETRY_AFTER_MS) return;
      }
    }

    this.lookupsInFlight.add(username);
    try {
      const result = await fetchStreamStart(username);
      if (!this.liveLogins().has(username)) return; // every tab moved on, discard

      const prev = this.resolvedStarts.get(username);
      const entry: ResolvedStart = result === null
        ? {
            startMs: prev?.startMs ?? 0,
            liveness: prev?.liveness ?? 'unknown',
            checkedAt: Date.now(),
            attempts: (prev?.attempts ?? 0) + 1,
          }
        : {
            startMs: result.live ? result.startMs : 0,
            liveness: result.live ? 'live' : 'offline',
            checkedAt: Date.now(),
            attempts: 0,
          };

      // Re-insert so the active streamer is the newest key, and so never the
      // entry evicted below.
      this.resolvedStarts.delete(username);
      this.resolvedStarts.set(username, entry);
      evictOldest(this.resolvedStarts, MAX_CACHED_STREAMERS);

      if (entry.liveness === 'live' && entry.startMs > 0 && entry.startMs !== prev?.startMs) {
        log.info(`[TWITCH] Real stream start for ${username} ✓ ${new Date(entry.startMs).toISOString()}`);
      } else if (entry.liveness === 'offline' && prev?.liveness !== 'offline') {
        log.info(`[TWITCH] Twitch reports ${username} is not streaming — ignoring the page's "live"`);
      } else if (result === null && entry.attempts === MAX_ATTEMPTS) {
        log.debug(`[TWITCH] Gave up resolving stream start for ${username} — keeping the estimate`);
      }
    } finally {
      this.lookupsInFlight.delete(username);
    }
  }

  /**
   * True only when Twitch itself said the channel is not streaming.
   *
   * The page's liveness check is a guess — it reads "live" whenever it fails to
   * find an offline marker — so on Twitch's own pages, and on a channel that
   * has just ended, it can be confidently wrong. This is the one signal that
   * can overrule it, and it deliberately does not fire on a failed lookup:
   * being unable to reach Twitch is not evidence of anything.
   *
   * The verdict stands until another one replaces it. It used to expire after
   * OFFLINE_RECHECK_MS, which dropped the only evidence there was a moment
   * before the re-check could answer — so every 45 seconds an idle tab on an
   * offline channel took the presence for one round-trip, and with a second
   * stream source open each takeover started a fresh history entry. That
   * constant still governs when resolveStreamStart() looks again, which is
   * where a re-check belongs; it just no longer un-suppresses on its own.
   */
  private isKnownOffline(username: string): boolean {
    const entry = this.resolvedStarts.get(normaliseLogin(username));
    return !!entry && entry.liveness === 'offline';
  }

  /** The verified start for `username`, or 0 if none has resolved yet. */
  private resolvedStartFor(username: string): number {
    const entry = this.resolvedStarts.get(normaliseLogin(username));
    return entry ? entry.startMs : 0;
  }

  /**
   * One track per live stream some fresh tab is on.
   *
   * Two tabs on the same channel are one stream: the one pushed most recently
   * speaks for it. A channel Twitch itself has called offline is left out —
   * see isKnownOffline().
   */
  getCurrentTracks(): TrackData[] {
    const now = performance.now();
    const byLogin = new Map<string, PushInstance<TwitchTab>>();
    for (const t of this.tabs.fresh(now)) {
      const d = t.data;
      if (!d.is_live || !d.username) continue;
      if (this.isKnownOffline(d.username)) continue;
      const login = normaliseLogin(d.username) || d.username.toLowerCase();
      const held = byLogin.get(login);
      if (!held || t.receivedAt >= held.receivedAt) byLogin.set(login, t);
    }
    return [...byLogin.values()].map(({ data: d }) => ({
      track_id: `twitch:${d.username}`,
      track_name: `📺 ${d.display_name || d.username}`,
      artist_name: d.stream_title || d.category || 'Just Chatting',
      album_name: d.category ? `🎮 ${d.category}` : '',
      duration_ms: 0, // Live streams have no duration
      progress_ms: 0,
      is_playing: true,
      is_live: true,
      // Twitch's own createdAt once it has resolved, else the script's estimate
      stream_start_time_ms: this.resolvedStartFor(d.username) || d.startEstimateMs,
      album_art_url: d.profile_picture_url || d.thumbnail_url || '',
      spotify_url: d.profile_url || '',
      artist_url: '',
      context_name: d.followers || '',
      context_url: d.profile_url || '',
      context_type: 'live',
      media_source: 'twitch',
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
      log.warn(`Twitch userscript stale (>${this.tabs.windowSeconds}s) — falling back to SMTC`);
    }
    return fresh;
  }

  /**
   * Whether the userscript reports nothing playing: no fresh tab on a live
   * stream.
   *
   * Also true once Twitch has contradicted every page, which is what clears a
   * presence a page is still claiming: the backend stops a track whose source
   * reports paused.
   */
  get isPaused(): boolean {
    if (!this.isActive) return true;
    return this.getCurrentTracks().length === 0;
  }

  /** The most recent payload from any fresh tab. */
  get latest(): TwitchPayload | null {
    return this.tabs.latest(performance.now())?.data ?? null;
  }
}
