/**
 * Native media source — reads Windows SMTC through a NAPI-RS addon.
 *
 * Replaces the PowerShell-based DesktopSource. Same public surface
 * (start/stop/getCurrentTrack/isReady) so the backend needed no restructuring,
 * but with three practical differences:
 *
 *   - No child process. Nothing spawns powershell.exe, so there is no .ps1 to
 *     ship, no window to hide, and none of the antivirus heuristics that a
 *     long-running PowerShell process attracts.
 *   - Event-driven. WinRT pushes media/timeline/playback changes to us instead
 *     of us polling for them, so a track change lands in ~0ms rather than up to
 *     one poll interval late.
 *   - Session list is addressable. Every media session stays visible (not just
 *     the winner of the priority contest), which is what lets the window show a
 *     player picker.
 *
 * The addon itself does not run here. Electron's main thread is an STA COM
 * apartment, where the WinRT calls block forever with no error to catch, so the
 * addon lives on a worker thread (electron/media-worker.ts) and this class
 * consumes the state it forwards. Everything below — priority, anchors, title
 * parsing — runs on the main thread, and getCurrentTrack() stays synchronous.
 *
 * Position handling is the one thing that got *harder*. The old reader received
 * a fresh position every 400ms; here, timeline events arrive only when the
 * player decides to publish one (Spotify: every ~4.5s, plus on seek). So each
 * timeline update becomes an *anchor* — a (position, monotonic timestamp) pair —
 * and the position we report is extrapolated from that anchor while playing.
 * See resync() for how anchors are kept honest.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { createLogger } from './logger.js';
import type { TrackData } from './types.js';

const log = createLogger('NativeMedia');

// Same path the PowerShell reader used. local-art.ts also writes here, the IPC
// layer serves it to the window, and lyrics-engine.ts special-cases the
// '/api/thumbnail' sentinel that points at it — so the name is load-bearing.
const THUMB_PATH = path.join(process.env.TEMP || os.tmpdir(), 'vybecord_thumb.jpg');

/**
 * Sessions never announced, and never offered as a player to pin.
 *
 * These are matched on the *raw* source — what the app id says — so a browser
 * tab that turns out to be one of these services is unaffected.
 *
 *   wmp, groove   video-or-file players, not a music service worth announcing.
 *   soundcloud    the Microsoft Store app. It publishes a title, an artist and
 *                 artwork, and no timeline whatsoever: position and duration
 *                 read zero for the whole track, every track. Announcing it
 *                 means a presence with an invented elapsed time and no length,
 *                 which is worse than staying quiet — and the browser, with the
 *                 extension, reports both to the second. That is the path.
 */
const IGNORED_SOURCES = new Set(['wmp', 'groove', 'soundcloud']);

/** Anything longer than 24h is a live stream or a bogus duration, not a track. */
const MAX_DUR_MS = 86_400_000;

/**
 * How often to re-read the winning session straight from WinRT.
 *
 * Anchor extrapolation is exact while a player advances at 1x and publishes a
 * timeline event on every seek. Not every player does — some only publish on
 * track change — so a seek can leave the anchor describing a position the user
 * left several seconds ago. This bounds that error. The call costs ~6ms, which
 * at this interval is ~0.2% of one core.
 */
const RESYNC_INTERVAL_MS = 3_000;

/** WinRT GlobalSystemMediaTransportControlsSessionPlaybackStatus. */
const STATUS_PLAYING = 4;

/**
 * Longest a Spotify advertisement is assumed to run.
 *
 * Spotify audio ads are 15s or 30s, occasionally 60s. The cap is what keeps the
 * title-equals-artist test from catching self-titled songs — "Bad Religion" by
 * Bad Religion runs 2:20, and the shortest real track in the sample used to
 * calibrate this was 83s.
 */
const AD_MAX_DURATION_MS = 55_000;

/**
 * Below this, a Spotify track is treated as an ad on duration alone.
 *
 * Set from both sides of the evidence: every observed ad ran 30s, and the
 * shortest of 44 sampled real tracks ran 83s. 60s sits in that gap with room
 * for a 60-second ad slot, which Spotify also sells.
 */
const AD_MAX_SHORT_MS = 60_000;

/** Wordings Spotify itself uses when it labels the break rather than the brand. */
const RE_AD_MARKER = /^(advertisement|spotify(?:\s*(?:ad|advert|advertisement))?|ad break|publicit[ée])$/i;

// Title-cleaning regexes, carried over unchanged from the PowerShell-era source.
const RE_TOPIC_SUFFIX = /\s*-\s*Topic\s*$/i;
const RE_VIDEO_SUFFIX = /\s*[([]*(?:official\s+(?:music\s+)?video|official\s+audio|official\s+lyric\s+video|music\s+video|lyric\s+video|official\s+visualizer|visualizer|official|audio|lyrics|with\s+lyrics|mv|m\/v|4k|hd|hq)[)\]]*\s*$/i;
const RE_UNRELEASED = /\s*[[(]\s*unreleased\s*\*?\s*[\])]\s*/gi;

// ── Addon types (mirrors @coooookies/windows-smtc-monitor's binding.d.ts) ──

interface MediaProps {
  title: string;
  artist: string;
  albumTitle: string;
  albumArtist: string;
  genres: string[];
  albumTrackCount: number;
  trackNumber: number;
  thumbnail?: Buffer;
}
interface PlaybackInfo { playbackStatus: number; playbackType: number }
interface TimelineProps { position: number; duration: number }  // seconds
interface MediaInfo {
  sourceAppId: string;
  media: MediaProps;
  playback: PlaybackInfo;
  timeline: TimelineProps;
  lastUpdatedTime: number;  // Unix ms
}

/** Messages the worker sends us. Mirrors WorkerOut in electron/media-worker.ts. */
type WorkerOut =
  | { t: 'ready'; sessions: MediaInfo[] }
  | { t: 'added'; info: MediaInfo }
  | { t: 'removed'; id: string }
  | { t: 'media'; id: string; media: MediaProps }
  | { t: 'timeline'; id: string; timeline: TimelineProps }
  | { t: 'playback'; id: string; playback: PlaybackInfo }
  | { t: 'resync'; id: string; info: MediaInfo | null }
  | { t: 'error'; message: string };

/** One tracked media session, with the timing anchor we maintain ourselves. */
interface SessionState {
  appId: string;
  source: string;
  media: MediaProps;
  playing: boolean;
  /** Position in ms at the moment the anchor was taken. */
  anchorPosMs: number;
  /** performance.now() when the anchor was taken. */
  anchorAt: number;
  /**
   * Raw position the anchor was built from, as last published by the player.
   *
   * Used to tell a genuine new reading from the same one being served again —
   * see the 'resync' handler for why that distinction matters.
   */
  lastRawPosMs: number;
  durationMs: number;
  hasThumb: boolean;
}

/** Public view of a session, for the window's player picker. */
export interface DetectedPlayer {
  appId: string;
  source: string;
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  hasThumb: boolean;
  /** Suppressed as an advertisement rather than announced. */
  isAd: boolean;
}

export class NativeMediaSource {
  private worker: Worker | null = null;
  private sessions = new Map<string, SessionState>();
  private ready = false;
  private _stopped = false;
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private workerPath: string;

  /** User-pinned player from the window's picker; null = automatic priority. */
  private preferredAppId: string | null = null;

  /** Mirrors the filter_spotify_ads setting; the backend pushes it in. */
  private adFilter = true;

  /**
   * Album of the last track accepted as real.
   *
   * Lets a short track that belongs to the album already playing be recognised
   * as an interlude rather than an ad — see looksLikeSpotifyAd().
   */
  private lastAlbum = '';

  /** appId+title+artist of the artwork currently at THUMB_PATH; '' when absent. */
  private thumbOnDisk = '';

  // Parsed track for the current key, reused so the title regexes don't re-run
  // on every poll. Never handed out directly — see snapshot().
  private cachedTemplate: TrackData | null = null;
  private cachedTrackKey = '';

  /** @param workerPath absolute path to the built media-worker.cjs */
  constructor(workerPath: string) {
    this.workerPath = workerPath;
  }

  start(): Promise<void> {
    if (process.platform !== 'win32') {
      log.warn('Windows media sessions are only available on Windows');
      return Promise.resolve();
    }
    this._stopped = false;
    return this.spawnWorker();
  }

  /**
   * Start the worker and resolve once it has sent its initial session list.
   *
   * Resolving on 'ready' rather than immediately matters: the backend polls as
   * soon as start() returns, and without the seed that first poll would report
   * nothing playing and briefly clear a presence that should have persisted.
   */
  private spawnWorker(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };

      let worker: Worker;
      try {
        worker = new Worker(this.workerPath);
      } catch (e) {
        log.error(`Failed to start the media worker: ${(e as Error).message}`);
        done();
        return;
      }
      this.worker = worker;

      worker.on('message', (msg: WorkerOut) => {
        this.onWorkerMessage(msg);
        if (msg.t === 'ready' || msg.t === 'error') done();
      });

      worker.on('error', (e) => {
        log.error(`Media worker error: ${e.message}`);
        this.ready = false;
        done();
        this.scheduleRestart();
      });

      worker.on('exit', (code) => {
        if (this._stopped) return;
        log.warn(`Media worker exited (code=${code})`);
        this.ready = false;
        done();
        this.scheduleRestart();
      });

      // A worker that never answers must not hold startup behind it.
      const guard = setTimeout(() => {
        if (!settled) log.warn('Media worker did not report ready in time — continuing');
        done();
      }, 5_000);
      guard.unref?.();
    });
  }

  /**
   * Bring the worker back after a crash.
   *
   * The stale session map is dropped first: it describes what was playing before
   * the thread died, and serving it would pin the presence to a track that may
   * have ended minutes ago.
   */
  private scheduleRestart(): void {
    if (this._stopped || this.restartTimer) return;
    this.sessions.clear();
    this.invalidateTemplate();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this._stopped) return;
      log.info('Restarting the media worker...');
      void this.spawnWorker();
    }, 3_000);
    this.restartTimer.unref?.();
  }

  private onWorkerMessage(msg: WorkerOut): void {
    switch (msg.t) {
      case 'ready': {
        this.sessions.clear();
        for (const info of msg.sessions) this.upsert(info);
        this.startResync();
        this.ready = true;
        log.info(`Media monitor ready — ${this.sessions.size} session(s) detected`);
        break;
      }

      case 'error':
        log.error(`Media addon failed to initialise: ${msg.message}`);
        log.error('Playback detection is unavailable. Windows 10 1809 (10.0.17763) or later is required.');
        this.ready = false;
        break;

      case 'added':
        this.upsert(msg.info);
        log.debug(`Session added: ${msg.info.sourceAppId} (${sourceFromAppId(msg.info.sourceAppId)})`);
        break;

      case 'removed':
        this.sessions.delete(msg.id);
        if (this.cachedTrackKey.startsWith(`${msg.id}:`)) this.invalidateTemplate();
        log.debug(`Session removed: ${msg.id}`);
        break;

      case 'media': {
        const s = this.sessions.get(msg.id);
        if (!s) break;
        // The other door metadata comes in by — capped the same way as upsert's.
        s.media = NativeMediaSource.capMeta(msg.media);
        s.hasThumb = !!msg.media.thumbnail?.length;
        // A new title means a new track: the old anchor described the old song.
        s.anchorPosMs = 0;
        s.anchorAt = performance.now();
        // And the reading it was built from belonged to that song too. Leaving
        // it in place let the new track's first timeline event be discarded as
        // "the same reading again" whenever the two happened to coincide —
        // which they do at 0 ms, exactly where a track most often starts.
        s.lastRawPosMs = -1;
        this.invalidateTemplate();
        this.writeThumb(s);
        break;
      }

      case 'timeline': {
        const s = this.sessions.get(msg.id);
        if (!s) break;
        s.durationMs = secToMs(msg.timeline.duration);
        const raw = secToMs(msg.timeline.position);
        // Same reading as the anchor already holds: nothing new to learn, and
        // re-anchoring would discard the time correctly extrapolated since.
        if (raw === s.lastRawPosMs) break;
        s.anchorPosMs = raw;
        s.anchorAt = performance.now();
        s.lastRawPosMs = raw;
        break;
      }

      case 'playback': {
        const s = this.sessions.get(msg.id);
        if (!s) break;
        const nowPlaying = msg.playback.playbackStatus === STATUS_PLAYING;
        if (nowPlaying === s.playing) break;
        // Freeze the extrapolated position into the anchor before flipping state,
        // otherwise pausing at 1:30 and resuming a minute later resumes at 2:30.
        s.anchorPosMs = this.positionOf(s);
        s.anchorAt = performance.now();
        // The anchor no longer corresponds to any published reading, so the next
        // one — whatever its value — must be allowed to replace it.
        s.lastRawPosMs = -1;
        s.playing = nowPlaying;
        // The player's own position at the moment of the transition beats ours.
        this.resyncOne(msg.id);
        break;
      }

      case 'resync': {
        const s = this.sessions.get(msg.id);
        if (!s || !msg.info) break;
        s.playing = msg.info.playback.playbackStatus === STATUS_PLAYING;
        s.durationMs = secToMs(msg.info.timeline.duration);

        const raw = secToMs(msg.info.timeline.position);
        /*
         * Only re-anchor on a reading the player has not served before.
         *
         * This guard is the whole reason the progress bar is steady. Spotify
         * republishes its position roughly every 4.5s but reports
         * lastUpdatedTime as the moment of *reading*, not of measurement — so a
         * resync in between looks like a fresh reading that happens to be two
         * seconds behind. Trusting it reset the anchor backwards, and the bar
         * sawtoothed: climb for three seconds, snap back, climb again.
         * Measured error went from 2.65s peak to well under a tenth of a second
         * once stale readings stopped being treated as new.
         */
        if (raw === s.lastRawPosMs) break;
        s.anchorPosMs = raw;
        s.lastRawPosMs = raw;
        // Rebase onto the monotonic clock. A no-op for players that report the
        // read time, and a genuine correction for those that report the real one.
        s.anchorAt = performance.now() - Math.max(0, Date.now() - msg.info.lastUpdatedTime);
        break;
      }
    }
  }

  /**
   * Longest title, artist or album kept from a media session.
   *
   * The same cap `asText` puts on anything the browser extension pushes, and
   * for the same reason — except this side had none. A media session's metadata
   * is whatever the playing application publishes, and for a browser tab that
   * is whatever the *page* passed to `navigator.mediaSession.metadata`. So a
   * page chooses this string, and it reaches the title-cleaning regexes, the
   * advertisement heuristic and the log unbounded.
   *
   * Discord truncates to 128 and no real track is close; 300 simply matches the
   * other door into the app.
   */
  private static readonly MAX_META_CHARS = 300;

  /** A media session's text, bounded. Mutates the worker's own copy. */
  private static capMeta(media: MediaProps): MediaProps {
    const cap = NativeMediaSource.MAX_META_CHARS;
    if (media.title.length > cap) media.title = media.title.slice(0, cap);
    if (media.artist.length > cap) media.artist = media.artist.slice(0, cap);
    if (media.albumTitle && media.albumTitle.length > cap) media.albumTitle = media.albumTitle.slice(0, cap);
    return media;
  }

  private upsert(info: MediaInfo): void {
    NativeMediaSource.capMeta(info.media);
    const existing = this.sessions.get(info.sourceAppId);
    const state: SessionState = {
      appId: info.sourceAppId,
      source: sourceFromAppId(info.sourceAppId),
      media: info.media,
      playing: info.playback.playbackStatus === STATUS_PLAYING,
      anchorPosMs: secToMs(info.timeline.position),
      // lastUpdatedTime is when the *player* published this position. Rebasing
      // onto our monotonic clock keeps extrapolation correct even when the
      // reading is already a second or two old.
      anchorAt: performance.now() - Math.max(0, Date.now() - info.lastUpdatedTime),
      lastRawPosMs: secToMs(info.timeline.position),
      durationMs: secToMs(info.timeline.duration),
      hasThumb: !!info.media.thumbnail?.length,
    };
    this.sessions.set(info.sourceAppId, state);
    if (!existing || existing.media.title !== state.media.title) {
      this.invalidateTemplate();
    }
    // Unconditional: writeThumb keys on the file it already wrote, so calling it
    // for an unchanged title is free — and necessary when the artwork is what
    // changed.
    this.writeThumb(state);
  }

  // ── Position ──

  /** Current position of a session in ms, extrapolated from its anchor. */
  private positionOf(s: SessionState): number {
    if (!s.playing) return s.anchorPosMs;
    const elapsed = performance.now() - s.anchorAt;
    if (elapsed < 0) return s.anchorPosMs;
    const pos = s.anchorPosMs + elapsed;
    return s.durationMs > 0 ? Math.min(pos, s.durationMs) : pos;
  }

  private startResync(): void {
    if (this.resyncTimer) return;
    this.resyncTimer = setInterval(() => {
      const winner = this.pickSession();
      if (winner) this.resyncOne(winner.appId);
    }, RESYNC_INTERVAL_MS);
    this.resyncTimer.unref?.();
  }

  /**
   * Ask the worker to re-read one session from WinRT.
   *
   * Fire-and-forget: the answer comes back as a 'resync' message and re-anchors
   * the session then. Nothing awaits it, so a slow WinRT call cannot stall a poll.
   */
  private resyncOne(appId: string): void {
    if (this._stopped || !this.worker) return;
    try {
      this.worker.postMessage({ t: 'resync', id: appId });
    } catch (e) {
      log.debug(`Resync request failed for ${appId}: ${(e as Error).message}`);
    }
  }

  // ── Session selection ──

  /**
   * The session the presence should follow, or null if nothing is playing.
   *
   * Advertisements are skipped rather than merely suppressed later, so that a
   * genuinely playing lower-priority source (a browser tab, say) can still win
   * the pick while Spotify is in an ad break.
   */
  private pickSession(): SessionState | null {
    /*
     * A pin is exclusive.
     *
     * It used to be a preference: the chosen player won while it was playing,
     * and anything else took over the moment it paused. That is not what
     * pinning means anywhere else, and it made the setting look like it did
     * nothing — pausing the pinned player handed the presence straight to
     * whatever else happened to be open, which is precisely what pinning it was
     * meant to prevent.
     *
     * So while a pin is set, no other session may take the presence. A pinned
     * player that is paused, showing an ad, or not running yet announces
     * nothing rather than letting another through. The window says so, and
     * Auto is one click away.
     */
    if (this.preferredAppId) {
      const pinned = this.sessions.get(this.preferredAppId);
      if (!pinned || !pinned.playing || !pinned.media.title || this.isAd(pinned)) return null;
      return pinned;
    }
    let best: SessionState | null = null;
    let bestPri = -1;
    for (const s of this.sessions.values()) {
      // Skipped here rather than only at the end, so an ignored player that
      // happens to be the loudest thing running does not win the pick and then
      // silence everything else by being dropped.
      if (IGNORED_SOURCES.has(s.source)) continue;
      if (!s.playing || !s.media.title || this.isAd(s)) continue;
      // Ranked on what it will be announced as, not on the app id it arrived
      // with — an identified YouTube tab is YouTube, not "a browser".
      const pri = sourcePriority(resolvedSource(s));
      if (pri > bestPri) { best = s; bestPri = pri; }
    }
    return best;
  }

  private isAd(s: SessionState): boolean {
    return this.adFilter
      && looksLikeSpotifyAd(s.source, s.media, s.durationMs, this.lastAlbum);
  }

  /** Turn the ad filter on or off (config-driven). */
  setAdFilter(enabled: boolean): void {
    if (this.adFilter === enabled) return;
    this.adFilter = enabled;
    this.invalidateTemplate();
  }

  /**
   * True while a playing session looks like an advertisement.
   *
   * Exposed so the window can say "advertisement" rather than "nothing
   * playing" — otherwise a 30-second gap in the presence looks like a bug.
   */
  isAdPlaying(): boolean {
    if (!this.adFilter) return false;
    for (const s of this.sessions.values()) {
      if (s.playing && s.media.title
        && looksLikeSpotifyAd(s.source, s.media, s.durationMs, this.lastAlbum)) return true;
    }
    return false;
  }

  /** Pin the presence to one player, or pass null to go back to automatic. */
  setPreferredSource(appId: string | null): void {
    this.preferredAppId = appId;
    this.invalidateTemplate();
    log.info(appId ? `Pinned to player: ${appId}` : 'Player selection back to automatic');
  }

  getPreferredSource(): string | null {
    return this.preferredAppId;
  }

  /**
   * What the pinned session is announced as ('spotify', 'youtube', …), or null.
   *
   * Null covers two different situations on purpose — nothing is pinned, and
   * pinned to something that is not running — because callers gate on it the
   * same way: with a pin set, a session that cannot be found must not let some
   * other player through. Ask getPreferredSource() first to tell them apart.
   *
   * This exists so the rest of the app can match a pin against a source that
   * never appears in `sessions` at all: the browser extension pushes for a
   * service, not for an app id, and a pin has to mean the same thing whichever
   * of the two is reporting.
   */
  pinnedSourceName(): string | null {
    if (!this.preferredAppId) return null;
    const s = this.sessions.get(this.preferredAppId);
    return s ? resolvedSource(s) : null;
  }

  /** Every detected session, playing or not — feeds the window's player picker. */
  listPlayers(): DetectedPlayer[] {
    const out: DetectedPlayer[] = [];
    for (const s of this.sessions.values()) {
      // Never announced, so never offered: a card you can pin that then shows
      // nothing would be worse than not listing it at all.
      if (IGNORED_SOURCES.has(s.source)) continue;
      out.push({
        appId: s.appId,
        // The service, not the browser hosting it, so the picker names players
        // the same way the presence does.
        source: resolvedSource(s),
        title: s.media.title || '',
        artist: s.media.artist || '',
        album: s.media.albumTitle || '',
        playing: s.playing,
        positionMs: Math.round(this.positionOf(s)),
        durationMs: s.durationMs,
        hasThumb: s.hasThumb,
        isAd: this.isAd(s),
      });
    }
    return out;
  }

  // ── Thumbnail ──

  /**
   * Persist the session's cover to THUMB_PATH.
   *
   * Two things here are deliberate.
   *
   * It keys on what is actually *on disk*, not on the last title seen. SMTC
   * publishes a track's metadata and its artwork as separate
   * MediaPropertiesChanged events — the first carries the new title with no
   * thumbnail, the second carries the same title with one. Keying on the title
   * made the second event look like a repeat, so the artwork was never written
   * while `hasThumb` still flipped to true: the app then advertised
   * '/api/thumbnail' for a file that did not exist, which cost the cover in the
   * window, the cover on Discord, and the provider lookup that would otherwise
   * have filled the gap.
   *
   * And it writes synchronously. `hasThumb` is set by the caller in the same
   * tick, so any async gap is a window where the app claims art it cannot yet
   * serve. One ~165KB write per track change is cheap enough that closing that
   * window outright beats trying to manage it.
   */
  private writeThumb(s: SessionState): void {
    const key = `${s.appId}:${s.media.title}:${s.media.artist}`;
    const buf = s.media.thumbnail;

    if (!buf?.length) {
      // No artwork in this event. Only clear the file if it belongs to another
      // track — an update for the *current* track that happens to omit the
      // artwork must not wipe a cover we already hold.
      if (this.thumbOnDisk && this.thumbOnDisk !== key) {
        try {
          fs.rmSync(THUMB_PATH, { force: true });
        } catch (e) {
          log.debug(`Could not clear stale thumbnail: ${(e as Error).message}`);
        }
        this.thumbOnDisk = '';
      }
      return;
    }

    if (key === this.thumbOnDisk) return;
    try {
      fs.writeFileSync(THUMB_PATH, buf);
      this.thumbOnDisk = key;
    } catch (e) {
      log.debug(`Could not write thumbnail: ${(e as Error).message}`);
      this.thumbOnDisk = '';
    }
  }

  // ── Public track API (same contract as the old DesktopSource) ──

  getCurrentTrack(): TrackData | null {
    const s = this.pickSession();
    if (!s || !s.media.title) return null;

    // Belt and braces: pickSession already skips these, and a pinned session
    // cannot be one because listPlayers never offers it.
    if (IGNORED_SOURCES.has(s.source)) return null;

    const trackKey = `${s.appId}:${s.media.title}:${s.media.artist}`;
    if (trackKey === this.cachedTrackKey && this.cachedTemplate) {
      return this.snapshot(this.cachedTemplate, s);
    }

    // This session passed the ad check, so its album is the context a following
    // short track is judged against.
    this.lastAlbum = s.media.albumTitle || '';

    let trackName = s.media.title;
    let artistName = s.media.artist || 'Unknown';
    const albumName = s.media.albumTitle || '';
    let source = s.source;

    // Browsers report the page's media metadata, which is whatever the site
    // chose to publish — usually a raw video title. Work out which service it
    // is, then unpick "Artist - Title" the way that service formats it.
    const fromWeb = source.startsWith('browser_') || source === 'unknown';
    if (fromWeb) {
      source = resolvedSource(s);

      if (source === 'spotify' || source === 'apple_music') {
        // Already clean — parsing it would only damage it.
      } else {
        // One parser for every browser tab.
        //
        // This used to branch on the site, with the richer rules reserved for
        // SoundCloud. That branch is now unreachable: without the userscripts,
        // nothing in a media session names the site a tab is on, so SoundCloud
        // arrives indistinguishable from YouTube. Rather than lose the better
        // parsing, all of it applies everywhere — the conventions are shared
        // ("Artist - Title", producer credits, slash separators), and the rules
        // are harmless where they do not apply.
        [trackName, artistName] = parseWebTitle(trackName, artistName);
        trackName = cleanMediaTitle(trackName);
        artistName = cleanMediaTitle(artistName).replace(RE_TOPIC_SUFFIX, '').trim();
      }
    }

    /*
     * A live stream, or a track whose length we simply do not know?
     *
     * Windows cannot say. It reports a duration of zero for a Twitch tab and
     * for a rip whose tags carry no length, and its timeline has no third field
     * to separate them — position and duration are all there is. Treating every
     * zero as "live" was the easy answer and it asserted something we had no
     * reason to believe: it hid the real state behind a claim, and because
     * `is_live` also suppresses the lyrics lookup, a local track with thin
     * metadata silently never got any.
     *
     * So the answer comes from where the audio originates, which we do know:
     *
     *   - Longer than a day is a stream whatever is playing it. Nothing else
     *     reports such a duration.
     *   - A browser tab with no duration is almost always a broadcast. Ordinary
     *     web audio publishes its length, so a tab that does not is the case
     *     that keeps Twitch and YouTube Live marked live when the extension is
     *     not installed to say so itself. Sessions we cannot identify are
     *     treated the same way, deliberately: guessing "live" for an unknown
     *     app is where this behaviour already was, and narrowing it is not
     *     worth the regression.
     *   - A player we *have* identified with no duration is a file with thin
     *     tags, not a broadcast. This is the only case whose answer changes,
     *     and it is the one that was wrong.
     *
     * The platforms this matters for do not rely on the guess anyway: Twitch,
     * Kick and YouTube Live arrive through the extension, which states is_live
     * outright.
     */
    const couldBroadcast = s.source.startsWith('browser_') || s.source === 'unknown';
    const isLive = s.durationMs > MAX_DUR_MS || (s.durationMs <= 0 && couldBroadcast);

    const template: TrackData = {
      track_id: `desktop:${trackName}:${artistName}`,
      track_name: trackName,
      artist_name: artistName,
      album_name: albumName,
      // Zero means "no length to report" — for a stream and for a track with
      // none alike. There is deliberately no fallback: the window renders it as
      // "—" and the presence sends no end timestamp, which is the truth in both
      // cases. What separates them is is_live below, not an invented number.
      duration_ms: s.durationMs > 0 && s.durationMs <= MAX_DUR_MS ? s.durationMs : 0,
      progress_ms: 0,       // per snapshot
      is_playing: true,
      is_live: isLive,
      album_art_url: '',    // per snapshot
      spotify_url: '',
      artist_url: '',
      media_source: source,
      // Apple Music plays local files too; those have no music.apple identity.
      is_local: source === 'apple_music' && !s.appId.includes('music.apple'),
      _received_at: 0,      // per snapshot
    };
    this.cachedTrackKey = trackKey;
    this.cachedTemplate = template;
    return this.snapshot(template, s);
  }

  /**
   * Build the TrackData handed to callers — a fresh object every call.
   *
   * Callers keep and mutate the returned reference: the backend stamps the
   * uploaded Catbox URL onto it, the lyrics engine holds it as trackData. Handing
   * out the cached instance would make those the same object, so the enriched art
   * would be overwritten by the local placeholder on the next poll and the
   * engine's `prev.album_art_url !== next.album_art_url` check would compare an
   * object with itself.
   */
  private snapshot(template: TrackData, s: SessionState): TrackData {
    // local-art.ts may have written the file after SMTC reported no cover.
    const hasThumb = s.hasThumb || fs.existsSync(THUMB_PATH);
    const pos = template.is_live ? 0 : this.positionOf(s);
    return {
      ...template,
      progress_ms: template.duration_ms > 0
        ? Math.min(Math.round(pos), template.duration_ms)
        : Math.round(pos),
      album_art_url: hasThumb ? '/api/thumbnail' : '',  // else enriched by provider
      _received_at: performance.now(),
    };
  }

  private invalidateTemplate(): void {
    this.cachedTrackKey = '';
    this.cachedTemplate = null;
  }

  get isReady(): boolean {
    return this.ready;
  }

  stop(): void {
    this._stopped = true;
    this.ready = false;
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.worker) {
      // Ask for a clean teardown so the addon releases its WinRT handles, but
      // don't wait on it — terminate() is the backstop if it doesn't comply.
      try { this.worker.postMessage({ t: 'stop' }); } catch { /* already gone */ }
      void this.worker.terminate();
      this.worker = null;
    }
    this.sessions.clear();
    this.invalidateTemplate();
    this.thumbOnDisk = '';
    this.lastAlbum = '';
  }
}

// ── Helpers ──

/** The addon reports seconds as floats; everything downstream speaks integer ms. */
function secToMs(sec: number): number {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.round(sec * 1000);
}

/**
 * Does this session look like a Spotify advertisement rather than a track?
 *
 * Spotify publishes no flag for ad breaks — it swaps the media session's
 * metadata for the advertiser's, so this is a heuristic. What it keys on comes
 * from observation, not guesswork:
 *
 *   - **Every ad seen ran 30 seconds.** Seven of them, across two shapes: the
 *     brand written into both title and artist ("Monster Energy" / "Monster
 *     Energy"), and marketing copy as the title with the brand as the artist
 *     ("Join now: 50 free spins…" / "PlayOJO", "Saturday 7PM ET" / "CBC").
 *     Only the first shape is recognisable from the text, which is why duration
 *     carries the rule.
 *   - **No real track came close.** Across 44 consecutive tracks sampled from
 *     ordinary listening, the shortest ran 83 seconds.
 *
 * The one thing a duration rule would otherwise catch by mistake is a genuine
 * short track — an album interlude or a skit. Those are distinguishable: an
 * interlude belongs to the album playing around it, whereas an ad never shares
 * an album with the music it interrupts. `previousAlbum` is that guard.
 *
 * `title === album` is deliberately unused, tempting as it looks: about two
 * thirds of the sampled real tracks matched it, because that is simply how
 * Spotify labels a single.
 *
 * This trades the other way from the first version of the rule, which required
 * title and artist to match and so let the marketing-copy ads straight through.
 * It now errs toward hiding a very short track rather than announcing an
 * advertiser. And it rests on how Spotify fills these fields, which is not a
 * contract — expect to revisit it.
 */
export function looksLikeSpotifyAd(
  source: string,
  media: { title: string; artist: string; albumTitle?: string },
  durationMs: number,
  previousAlbum?: string,
): boolean {
  // Spotify-specific quirk. Other players do not fill their session this way,
  // and applying it to them would only invent false positives.
  if (source !== 'spotify') return false;

  const title = normaliseForAd(media.title);
  if (!title) return false;
  const artist = normaliseForAd(media.artist);

  // Spotify sometimes labels the break outright instead of naming the brand.
  if (RE_AD_MARKER.test(title) || (artist && RE_AD_MARKER.test(artist))) return true;

  // A missing duration means a live stream, not an ad; nothing below applies.
  if (durationMs <= 0) return false;

  // The brand-in-both-fields shape, allowed a longer window because the text
  // itself is already strong evidence.
  if (artist && title === artist && durationMs <= AD_MAX_DURATION_MS) return true;

  if (durationMs > AD_MAX_SHORT_MS) return false;

  // Short, and part of the album already playing — an interlude, not an ad.
  const album = normaliseForAd(media.albumTitle ?? '');
  if (album && previousAlbum && album === normaliseForAd(previousAlbum)) return false;

  return true;
}

/** Lowercase, collapse whitespace, drop punctuation Spotify styles freely. */
function normaliseForAd(value: string): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Map a WinRT source app id to our internal source name.
 * Ports Get-SourceName from the retired smtc-reader.ps1.
 */
const sourceCache = new Map<string, string>();
export function sourceFromAppId(appId: string): string {
  const hit = sourceCache.get(appId);
  if (hit) return hit;

  const s = appId.replace(/\s/g, '').toLowerCase();
  let result = 'unknown';
  if (/spotify/.test(s)) result = 'spotify';
  else if (/apple\.?music|appleinc|itunes/.test(s)) result = 'apple_music';
  else if (/deezer/.test(s)) result = 'deezer';
  else if (/tidal/.test(s)) result = 'tidal';
  else if (/amazon\.?music|amzn/.test(s)) result = 'amazon_music';
  // The Microsoft Store app reports SoundcloudLtd.SoundCloud-MusicAudio_…!App.
  // Without this it fell through to 'unknown', so the desktop app was detected
  // as a nameless player while the same account playing in a browser tab was
  // recognised — which reads as "the desktop app is not supported".
  else if (/soundcloud/.test(s)) result = 'soundcloud';
  else if (/chrome|google/.test(s)) result = 'browser_chrome';
  else if (/firefox|mozilla/.test(s)) result = 'browser_firefox';
  else if (/msedge|microsoft\.edge/.test(s)) result = 'browser_edge';
  else if (/brave/.test(s)) result = 'browser_brave';
  else if (/opera/.test(s)) result = 'browser_opera';
  else if (/vivaldi/.test(s)) result = 'browser_vivaldi';
  else if (/zen/.test(s)) result = 'browser_zen';
  else if (/vlc/.test(s)) result = 'vlc';
  else if (/foobar/.test(s)) result = 'foobar2000';
  else if (/musicbee/.test(s)) result = 'musicbee';
  else if (/aimp/.test(s)) result = 'aimp';
  else if (/winamp/.test(s)) result = 'winamp';
  else if (/mediamonkey/.test(s)) result = 'mediamonkey';
  else if (/groove/.test(s)) result = 'groove';
  else if (/wmplayer|windows\.media|zunevideo|zunemusic|microsoft\.media|msnvideo|movies&tv|mswindowsmusic/.test(s)) result = 'wmp';

  sourceCache.set(appId, result);
  return result;
}

/**
 * Which session wins when several play at once.
 *
 * The ladder ranks by how confidently a session names what you are listening
 * to. A service we can name is ranked as that service, whether it reached us as
 * its own application or as a tab the extension identified — SoundCloud in a
 * browser is SoundCloud, not "a browser". "Browser" is the name for what is
 * left when we could not tell, and it comes last for exactly that reason.
 *
 * That is a change: the named web services used to fall through to the default
 * and score 0, below the very "unidentified tab" bucket they should outrank, so
 * any random tab playing anything beat an identified YouTube or Twitch session.
 *
 * Video and stream platforms sit one rung under the music services. A Twitch
 * tab left running is more often background than the thing worth announcing.
 */
function sourcePriority(src: string): number {
  switch (src) {
    case 'spotify': return 10;
    case 'apple_music':
    case 'deezer':
    case 'tidal': return 9;
    case 'amazon_music': return 8;
    case 'soundcloud':
    case 'bandcamp':
    case 'youtube_music': return 7;
    case 'youtube':
    case 'twitch':
    case 'kick': return 6;
    default:
      if (/vlc|foobar|musicbee|aimp|winamp|mediamonkey|groove|wmp/.test(src)) return 5;
      // Everything we could not name: an unidentified tab, an unknown app.
      return 1;
  }
}

/** Identify the web service behind a browser session from its metadata. */
/**
 * The service a session will actually be announced as.
 *
 * A browser tab is only "a browser" until we can name what is playing in it;
 * once named it is that service, and it must be *ranked* as that service too.
 * Resolving this in one place is what keeps the picker and the label agreeing —
 * ranking used to happen on the raw app id and naming afterwards, so an
 * identified YouTube tab was still ranked as an anonymous browser and lost to
 * one.
 *
 * Note this is never used for the ignore list: that is matched on the raw
 * source, so silencing the SoundCloud desktop app cannot silence a browser tab
 * whose metadata happens to mention SoundCloud.
 */
function resolvedSource(s: SessionState): string {
  if (s.source.startsWith('browser_') || s.source === 'unknown') {
    return detectWebService(s) ?? s.source;
  }
  return s.source;
}

function detectWebService(s: SessionState): string | null {
  const haystack = `${s.media.title}\0${s.media.artist}\0${s.media.albumTitle}\0${s.appId}`.toLowerCase();
  if (haystack.includes('soundcloud')) return 'soundcloud';
  if (haystack.includes('bandcamp')) return 'bandcamp';
  if (haystack.includes('deezer')) return 'deezer';
  if (haystack.includes('tidal')) return 'tidal';
  // Named here too, so a tab that does identify itself is ranked and gated as
  // the platform rather than as an anonymous browser. Without the extension the
  // metadata rarely says so, and it stays a browser — which is correct: we
  // genuinely could not tell.
  if (haystack.includes('twitch')) return 'twitch';
  if (haystack.includes('kick.com')) return 'kick';
  if (haystack.includes('apple music') || haystack.includes('music.apple')) return 'apple_music';
  // Before YouTube: the Spotify web player's metadata mentions both.
  if (haystack.includes('spotify')) return 'spotify';
  if (haystack.includes('youtube music')) return 'youtube_music';
  if (haystack.includes('youtube')) return 'youtube';

  // Nothing named itself. The Spotify web player publishes an album and a clean
  // title; YouTube publishes no album and usually a "Artist - Title" video name.
  const title = s.media.title;
  const hasAlbum = (s.media.albumTitle || '').length > 0;
  const hasYtPattern = /\((official|music)\s*(video|audio|mv|lyrics?)\)|\[(official|music)\s*(video|audio|mv|lyrics?)\]|\bMV\b|\blyric video\b/i.test(title);
  if (hasAlbum && !hasYtPattern && !title.includes(' - ')) return 'spotify';
  return null;
}

// ── Title parsing (unchanged from the PowerShell-era source) ──

const WEB_SEPARATORS = [' - ', ' – ', ' — ', ' // ', ' | '];
const RE_PRODUCER_TAG = /\s*[\[(](?:prod\.?|produced\s+by)\s*.+[\])]\s*$/i;

/**
 * Split a browser tab's title into track and artist.
 *
 * The artist a browser reports is whoever uploaded the page's media — the
 * YouTube channel, the SoundCloud account — which is frequently not the artist.
 * The real one is usually the left half of the title, which is the convention on
 * both sites. When there is no separator the uploader is the best guess left.
 *
 * Producer credits are stripped first: "Artist - Track (prod. Nick Mira)" would
 * otherwise carry the credit into the track name and spoil every lookup that
 * follows.
 */
function parseWebTitle(title: string, sessionArtist: string): [track: string, artist: string] {
  const cleaned = title.replace(RE_PRODUCER_TAG, '').trim();
  for (const sep of WEB_SEPARATORS) {
    const idx = cleaned.indexOf(sep);
    if (idx > 0) {
      const left = cleaned.slice(0, idx).trim();
      const right = cleaned.slice(idx + sep.length).trim();
      if (left && right) return [right, left];
    }
  }
  return [cleaned || title, sessionArtist.replace(RE_TOPIC_SUFFIX, '').trim()];
}

function cleanMediaTitle(title: string): string {
  let cleaned = title.replace(/\s*\/\/\s*/g, ' - ').trim();
  cleaned = cleaned.replace(RE_UNRELEASED, ' ').trim();
  // Titles stack these ("… (Official Video) [HD]"), so strip repeatedly.
  for (let i = 0; i < 3; i++) {
    const result = cleaned.replace(RE_VIDEO_SUFFIX, '').replace(/[\s\-–—|]+$/, '');
    if (result === cleaned) break;
    cleaned = result;
  }
  return cleaned || title;
}
