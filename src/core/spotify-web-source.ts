/**
 * Spotify playback read from the Web API, for people who do not use Spicetify.
 *
 * Polls GET /me/player with the user's own sign-in (spotify-auth.ts) and turns
 * the answer into the very payload the Spicetify extension pushes, through the
 * same normaliser and the same conversion to a track. So everything downstream
 * — the card, the handoff to and from the Windows media session, the history,
 * the scrobbles — treats the two alike, and a song reported by one and then the
 * other keeps its id.
 *
 * What it gives over the media session is what Spicetify gives: the real album
 * art, every artist, track, artist and album links, the playlist, shuffle and
 * repeat, and the position from Spotify itself. What it cannot give:
 *
 *   - Spotify's own lyrics. The Web API has no lyrics endpoint, and the one the
 *     client uses only takes the client's own token. Lyrics come from the usual
 *     providers instead, exactly as they do for the media session.
 *   - Instant track changes. A change is seen at the next poll, so the poll is
 *     timed for the end of the song as well as on a cadence, and the backend
 *     asks for one at once when Windows sees Spotify change (see pollSoon).
 *
 * It stands by while Spicetify reports: the extension already says all of this,
 * sooner, and asking Spotify as well would only spend the quota and put the
 * same song on two cards.
 *
 * Unlike Spicetify it sees whatever device the account is playing on — the
 * phone, a speaker, the web player — the way Spotify's own Discord integration
 * does.
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import { asBool, asNonNegativeInt, asRecord, asText, asUrl, evictOldest } from './utils.js';
import type { TrackData } from './types.js';
import { normalizeSpicetifyPayload, spotifyPayloadTrack, type SpicetifyPayload } from './spicetify-source.js';
import type { SpotifyAuth } from './spotify-auth.js';

const log = createLogger('SpotifyWeb');

const API = 'https://api.spotify.com/v1';
const FETCH_TIMEOUT_MS = 8_000;

/*
 * Cadence. Spotify publishes no number for a Development Mode app's rate
 * limit, only a rolling 30-second window, now counted per developer account.
 * Twenty requests a minute while a song plays is a fraction of what
 * now-playing tools commonly poll at; the end-of-song poll and the nudge from
 * Windows are what make track changes quick, not a tighter cadence.
 */
const PLAYING_POLL_MS = 3_000;
const PAUSED_POLL_MS = 5_000;
/** Nothing playing anywhere on the account. */
const IDLE_POLL_MS = 10_000;
/** While Spicetify reports: a local check, no request. */
const STANDBY_CHECK_MS = 5_000;
/** How long after a song's expected end to look for the next one. */
const END_OF_TRACK_SLACK_MS = 700;
const MIN_POLL_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** A 403 does not fix itself between two polls: it waits on the user. */
const FORBIDDEN_RETRY_MS = 60_000;
/**
 * How long a reading stands after the next one was due. Long enough to ride
 * out one failed request without the card dropping to the media session and
 * back; short enough that a lost connection is noticed.
 */
const STALE_GRACE_MS = 10_000;
/** A position this far from where the last reading put it is a seek. */
const SEEK_MS = 1_500;

/** Spotify's DJ plays from this one playlist — see spicetify-extension/vybecord.js. */
const DJ_PLAYLIST_ID = '37i9dQZF1EYkqdzj48dyYq';
const MAX_CONTEXT_NAMES = 50;

export type SpotifyWebState = 'off' | 'standby' | 'playing' | 'paused' | 'idle' | 'error';

export interface SpotifyWebStatus {
  state: SpotifyWebState;
  /** The device the account is playing on, as Spotify names it. */
  device: string;
  /** What went wrong with the last request, in words for the settings card. */
  error: string;
}

interface Hooks {
  /** True while something better reports the same playback — Spicetify. */
  standby(): boolean;
  /** The playback changed in a way worth acting on before the next tick. */
  onChange(): void;
}

export class SpotifyWebSource {
  private latestData: SpicetifyPayload | null = null;
  /** performance.now() at the moment the reading describes. */
  private receivedAt = 0;
  private freshUntil = 0;
  private latestContextUri = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Set on quitting: a sign-in or refresh landing after that must not start the poll again. */
  private closed = false;
  private inFlight = false;
  /** Asked to poll while a request was out: go again as soon as it lands. */
  private again = false;
  /** performance.now() when the last request went out, so a nudge cannot hammer. */
  private lastRequestAt = 0;
  private failures = 0;
  private state: SpotifyWebState = 'off';
  private device = '';
  private error = '';
  /** Spotify context URI → its name, '' when Spotify will not say. */
  private readonly contextNames = new Map<string, string>();
  private readonly contextLookups = new Set<string>();

  constructor(private readonly auth: SpotifyAuth, private readonly hooks: Hooks) {}

  /** Start polling once signed in, stop once signed out. Safe to call at any time. */
  sync(): void {
    if (this.closed) return;
    if (this.auth.signedIn) {
      if (this.running) return;
      this.running = true;
      this.failures = 0;
      this.error = '';
      this.state = 'idle';
      this.schedule(0);
      return;
    }
    if (!this.running) return;
    this.halt();
    this.hooks.onChange();
  }

  /** For good: the app is quitting. */
  stop(): void {
    this.closed = true;
    this.halt();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Ask now rather than at the next tick: Windows has just seen Spotify change
   * track or pause. Does nothing while standing by or signed out.
   */
  pollSoon(): void {
    // A backoff is Spotify's to lift, a rate limit above all.
    if (!this.running || this.state === 'error') return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    if (this.hooks.standby()) return;
    this.schedule(Math.max(0, MIN_POLL_MS - (performance.now() - this.lastRequestAt)));
  }

  // ── What the backend reads ──

  /** True while a recent reading has something playing or paused, and Spicetify is not reporting. */
  get isActive(): boolean {
    return this.running && !!this.latestData && performance.now() < this.freshUntil && !this.hooks.standby();
  }

  get isPaused(): boolean {
    return !this.isActive || !this.latestData!.is_playing;
  }

  get latest(): SpicetifyPayload | null {
    return this.isActive ? this.latestData : null;
  }

  getCurrentTrack(): TrackData | null {
    if (!this.isActive) return null;
    return spotifyPayloadTrack(this.latestData!, this.receivedAt);
  }

  /** For the [NEW TRACK] line: where it is playing. */
  get deviceLabel(): string {
    return this.device;
  }

  status(): SpotifyWebStatus {
    if (!this.running) return { state: 'off', device: '', error: '' };
    if (this.hooks.standby()) return { state: 'standby', device: '', error: '' };
    // A reading that has gone stale says nothing about now.
    const stale = this.latestData !== null && performance.now() >= this.freshUntil;
    return {
      state: stale && this.state !== 'error' ? 'idle' : this.state,
      device: stale ? '' : this.device,
      error: this.error,
    };
  }

  // ── Polling ──

  private halt(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.again = false;
    this.latestData = null;
    this.latestContextUri = '';
    this.state = 'off';
    this.device = '';
    this.error = '';
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    if (this.hooks.standby()) {
      if (this.state !== 'standby') log.info('Another source reports Spotify — Web API standing by');
      this.state = 'standby';
      this.latestData = null;
      this.device = '';
      // Not shown while standing by, and stale by the time it ends.
      this.error = '';
      this.schedule(STANDBY_CHECK_MS);
      return;
    }
    if (this.state === 'standby') {
      log.info('Spotify Web API polling again');
      this.state = 'idle';
    }

    this.inFlight = true;
    let next: number;
    try {
      next = await this.poll();
    } catch (e) {
      next = this.backoff(`Could not reach Spotify: ${(e as Error).message}`);
    } finally {
      this.inFlight = false;
    }
    if (!this.running) return;
    this.schedule(this.again && this.state !== 'error' ? MIN_POLL_MS : next);
    this.again = false;
  }

  /** One request. Returns how long to wait before the next. */
  private async poll(): Promise<number> {
    const token = await this.auth.getAccessToken();
    if (!token) {
      // Signed out meanwhile: the auth's own change notice stops this source.
      if (!this.auth.signedIn) return STANDBY_CHECK_MS;
      return this.backoff('Could not renew the Spotify sign-in — will keep trying.');
    }

    const started = performance.now();
    this.lastRequestAt = started;
    const resp = await fetch(`${API}/me/player?additional_types=episode`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // Spotify reads the position while answering, about halfway through.
    const at = started + (performance.now() - started) / 2;
    // Signed out or quitting while the request was out: the answer is nobody's now.
    if (!this.running) return STANDBY_CHECK_MS;

    if (resp.status === 204) return this.take(null, at);
    if (resp.ok) {
      const body = await resp.json().catch(() => null);
      return this.take(body ? asRecord(body) : null, at);
    }
    if (resp.status === 401) {
      // The token died before its time — a sign-in elsewhere, say. One quick
      // retry with a fresh one; a run of these backs off like anything else.
      this.auth.invalidateAccessToken();
      return this.backoff('Spotify did not accept the sign-in token.', MIN_POLL_MS);
    }
    if (resp.status === 429) {
      const after = Number(resp.headers.get('retry-after'));
      const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 30_000;
      log.warn(`Spotify Web API rate limit — waiting ${Math.round(wait / 1000)}s`);
      this.state = 'error';
      this.error = 'Spotify asked Vybecord to slow down for a moment.';
      return Math.min(Math.max(wait, 5_000), 10 * 60_000);
    }
    if (resp.status === 403) {
      const why = await spotifyErrorMessage(resp);
      if (this.state !== 'error') log.warn(`Spotify Web API refused: ${why}`);
      this.state = 'error';
      this.error = `Spotify refused (${why}). Add your Spotify account under User Management in your app’s `
        + 'dashboard, and check that the app’s owner has Premium — an app in development mode needs it.';
      return FORBIDDEN_RETRY_MS;
    }
    return this.backoff(`Spotify answered ${resp.status}.`);
  }

  private backoff(message: string, firstMs = 5_000): number {
    this.failures++;
    if (this.failures === 1) log.warn(`Spotify Web API: ${message}`);
    this.state = 'error';
    this.error = message;
    return Math.min(MAX_BACKOFF_MS, firstMs * 2 ** (this.failures - 1));
  }

  /** Keep a reading. Returns how long to wait before the next. */
  private take(body: Record<string, unknown> | null, at: number): number {
    if (this.failures || this.state === 'error') log.info('Spotify Web API answering again');
    this.failures = 0;
    this.error = '';

    const prev = this.latestData;
    const prevAt = this.receivedAt;
    const raw = body ? this.toPayload(body) : null;
    const next = raw ? normalizeSpicetifyPayload(raw) : null;
    this.latestData = next;
    this.receivedAt = at;
    this.device = body ? asText(asRecord(body.device).name, 80) : '';
    this.state = !next ? 'idle' : next.is_playing ? 'playing' : 'paused';

    const delay = this.nextDelay(next);
    this.freshUntil = performance.now() + delay + STALE_GRACE_MS;
    if (changed(prev, prevAt, next, at)) this.hooks.onChange();
    return delay;
  }

  private nextDelay(d: SpicetifyPayload | null): number {
    if (!d) return IDLE_POLL_MS;
    if (!d.is_playing) return PAUSED_POLL_MS;
    const left = d.duration_ms - d.progress_ms;
    if (d.duration_ms > 0 && left < PLAYING_POLL_MS + END_OF_TRACK_SLACK_MS) {
      return Math.max(MIN_POLL_MS, left + END_OF_TRACK_SLACK_MS);
    }
    return PLAYING_POLL_MS;
  }

  /**
   * Spotify's answer as the payload the Spicetify extension sends, field for
   * field, built the same way where the two can be compared. Null when there
   * is nothing to put on a card: no item, or an advertisement, which the
   * media session's own ad handling deals with.
   */
  private toPayload(b: Record<string, unknown>): Record<string, unknown> | null {
    const type = asText(b.currently_playing_type, 16);
    if (type === 'ad') return null;
    const item = b.item && typeof b.item === 'object' ? asRecord(b.item) : null;
    const ctx = b.context && typeof b.context === 'object' ? asRecord(b.context) : null;
    const ctxUri = asText(ctx?.uri, 200);
    const isDj = ctxUri === `spotify:playlist:${DJ_PLAYLIST_ID}`;
    // The DJ's voice is no track: Spotify gives it no item. Read only inside
    // the DJ's playlist, where nothing else explains an empty item.
    const narration = isDj && !item && asBool(b.is_playing);
    if (!item && !narration) return null;
    this.latestContextUri = ctxUri;

    const it = item ?? {};
    const isEpisode = asText(it.type, 16) === 'episode';
    const show = asRecord(it.show);
    const album = asRecord(it.album);
    const artists = Array.isArray(it.artists) ? it.artists.map(asRecord) : [];
    const uri = asText(it.uri, 200);
    const isLocal = it.is_local === true;
    // Only a catalogue track has an id worth keeping, as with the extension.
    const trackId = uri.startsWith('spotify:track:') && !isLocal ? asText(it.id, 64) : '';
    const images = isEpisode
      ? (firstImage(it.images) || firstImage(show.images))
      : firstImage(album.images);

    let contextType = '';
    let contextUrl = '';
    let contextName = '';
    if (isDj) {
      contextType = 'dj';
      contextUrl = `https://open.spotify.com/playlist/${DJ_PLAYLIST_ID}`;
      contextName = 'DJ';
    } else if (ctx) {
      const kind = asText(ctx.type, 32);
      const parts = ctxUri.split(':');
      if (kind === 'collection' || (parts[1] === 'user' && parts[3] === 'collection')) {
        contextType = 'collection';
        contextUrl = 'https://open.spotify.com/collection/tracks';
        contextName = 'Liked Songs';
      } else if (['playlist', 'album', 'artist', 'show'].includes(kind) && parts[2]) {
        contextType = kind;
        contextUrl = asUrl(asRecord(ctx.external_urls).spotify) || `https://open.spotify.com/${kind}/${parts[2]}`;
        contextName = this.contextName(kind, parts[2], ctxUri, album, artists, show);
      } else {
        contextType = kind || parts[1] || '';
      }
    }

    return {
      track_id: trackId,
      uri,
      track_name: asText(it.name),
      artist_name: isEpisode
        ? asText(show.name)
        : artists.map(a => asText(a.name)).filter(Boolean).join(', '),
      album_name: isEpisode ? asText(show.name) : asText(album.name),
      album_art_url: images,
      duration_ms: asNonNegativeInt(it.duration_ms),
      progress_ms: asNonNegativeInt(b.progress_ms),
      is_playing: asBool(b.is_playing),
      spotify_url: asUrl(asRecord(it.external_urls).spotify) || (trackId ? `https://open.spotify.com/track/${trackId}` : ''),
      artist_url: isEpisode
        ? asUrl(asRecord(show.external_urls).spotify)
        : asUrl(asRecord(asRecord(artists[0]).external_urls).spotify),
      album_url: isEpisode
        ? asUrl(asRecord(show.external_urls).spotify)
        : asUrl(asRecord(album.external_urls).spotify),
      context_name: contextName,
      context_url: contextUrl,
      context_type: contextType,
      is_shuffle: asBool(b.shuffle_state),
      repeat_mode: asText(b.repeat_state, 16),
      is_local: isLocal,
      is_dj: isDj,
      dj_narration: narration,
    };
  }

  /**
   * The playlist, album, artist or show being played from, by name.
   *
   * The player only gives the context's URI. An album or artist the track
   * itself names costs nothing; anything else is asked once and remembered,
   * and the card picks the name up when it lands. Spotify's own editorial and
   * algorithmic playlists answer 404 to a developer app since November 2024,
   * so Discover Weekly and the like stay unnamed, and are not asked again.
   */
  private contextName(
    kind: string, id: string, uri: string,
    album: Record<string, unknown>, artists: Record<string, unknown>[], show: Record<string, unknown>,
  ): string {
    if (kind === 'album' && asText(album.uri, 200) === uri) return asText(album.name);
    if (kind === 'artist') {
      const own = artists.find(a => asText(a.uri, 200) === uri);
      if (own) return asText(own.name);
    }
    if (kind === 'show' && asText(show.uri, 200) === uri) return asText(show.name);
    const known = this.contextNames.get(uri);
    if (known !== undefined) return known;
    if (/^[A-Za-z0-9]{22}$/.test(id)) void this.lookUpContextName(kind, id, uri);
    return '';
  }

  private async lookUpContextName(kind: string, id: string, uri: string): Promise<void> {
    if (this.contextLookups.has(uri)) return;
    this.contextLookups.add(uri);
    try {
      const token = await this.auth.getAccessToken();
      if (!token) return;
      const query = kind === 'playlist' ? '?fields=name' : '';
      const resp = await fetch(`${API}/${kind}s/${id}${query}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      let name = '';
      if (resp.ok) {
        name = asText(asRecord(await resp.json().catch(() => null)).name);
      } else if (resp.status !== 404 && resp.status !== 403) {
        // Worth asking again at the next poll: Spotify was busy, not unwilling.
        return;
      }
      this.contextNames.set(uri, name);
      evictOldest(this.contextNames, MAX_CONTEXT_NAMES);
      if (name && this.latestData && this.latestContextUri === uri && !this.latestData.context_name) {
        this.latestData.context_name = name;
        this.hooks.onChange();
      }
    } catch {
      // Unreachable for now; the next poll asks again.
    } finally {
      this.contextLookups.delete(uri);
    }
  }
}

/** Whether a new reading moved anything the card shows — a track, a pause, a seek. */
function changed(prev: SpicetifyPayload | null, prevAt: number, next: SpicetifyPayload | null, at: number): boolean {
  if (!prev || !next) return prev !== next;
  if (prev.uri !== next.uri || prev.track_name !== next.track_name || prev.is_playing !== next.is_playing) return true;
  if (prev.context_url !== next.context_url || prev.context_name !== next.context_name) return true;
  if (prev.is_shuffle !== next.is_shuffle || prev.repeat_mode !== next.repeat_mode) return true;
  const expected = prev.is_playing ? prev.progress_ms + (at - prevAt) : prev.progress_ms;
  return Math.abs(next.progress_ms - expected) > SEEK_MS;
}

/** The widest image of a Spotify image list, which Spotify sorts widest first. */
function firstImage(list: unknown): string {
  if (!Array.isArray(list)) return '';
  for (const img of list) {
    const url = asUrl(asRecord(img).url);
    if (url) return url;
  }
  return '';
}

/** Spotify's own words for a refusal, when it gave any. */
async function spotifyErrorMessage(resp: Response): Promise<string> {
  try {
    const body = asRecord(await resp.json());
    const msg = asText(asRecord(body.error).message, 200);
    return msg || `HTTP ${resp.status}`;
  } catch {
    return `HTTP ${resp.status}`;
  }
}
