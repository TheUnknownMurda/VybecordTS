/**
 * High-precision lyrics sync engine.
 *
 * Design:
 *   - Event-driven (setTimeout-based), NOT polling — zero CPU between updates
 *   - Binary search for O(log n) initial positioning
 *   - Schedules next update at the exact ms when the next lyric line begins
 *   - Compensates for measured Discord IPC latency (EMA)
 *   - Drift detection + recalibration from Spotify progress updates
 *
 * This is the performance-critical path. Every optimization matters here.
 */

import { performance } from 'node:perf_hooks';
import { findLyricIndex } from '../core/lrc-parser.js';
import { createLogger } from '../core/logger.js';
import { romanize } from '../core/romanize.js';
import { getCachedTranslation, isTranslationWorthFetching, translateText } from '../core/translate.js';
import { evictOldest } from '../core/utils.js';
import type { LyricLine, DiscordActivity, TrackData } from '../core/types.js';

const log = createLogger('LyricsEngine');

// Status message types for unified status system
 type StatusType = 'fetching' | 'found' | 'noLyrics' | 'flagged' | 'disabled';

// ── Timing constants ──
const BASE_OFFSET_MS = 100;       // Compensate for IPC + display delay (fire-and-forget ~10-30ms)
const DRIFT_THRESHOLD_MS = 500;   // Recalibrate if drift > 500ms (tighter sync)
const CC_DRIFT_THRESHOLD_MS = 800; // YouTube CC: tolerate poll jitter, only recalib on real desync
// Push sources don't use a cooldown at all — they report exact player position,
// so syncProgress() recalibrates on every drift above threshold (see syncProgress).
const RECALIB_COOLDOWN_MS = 120_000;  // Max 1 recalibration per 2 minutes (SMTC/desktop)
/**
 * Disagreement large enough that the playhead moved, rather than the clock slipping.
 *
 * The cooldown above exists so a burst of coarse OS readings cannot cascade
 * into a burst of re-seeks. It is the wrong answer for a user dragging the
 * progress bar: the engine's own clock is free-running, so a seek leaves it
 * describing a position the song left seconds ago, and under the cooldown the
 * lyrics stayed wrong for up to two minutes — for the rest of most songs.
 *
 * Four seconds separates the two cases with room to spare. The monotonic timer
 * drifts against a player by hundreds of milliseconds over a whole track, never
 * by seconds; a seek, a stall or a buffering pause clears this on the first
 * reading. isRepeatJump below catches the one shape this does not — a jump back
 * to the very start, which is a repeat rather than a seek and resets more state.
 */
const SEEK_DRIFT_MS = 4_000;
const MIN_UPDATE_INTERVAL_MS = 800;  // Discord rate-limit protection (~6 updates/5s)
const CC_UPDATE_INTERVAL_MS = 250;   // Fast updates for YouTube CC (lines change every 200-500ms)
const RPC_HEARTBEAT_MS = 5_000;       // Force RPC push every 5s even if text unchanged (keeps Discord UI fresh)
const EMA_ALPHA = 0.3;            // Exponential moving average weight for latency
const LYRIC_GAP_MS = 25_000;      // Switch to no-lyrics RPC display during gaps longer than this
// Floor between a normal push and the extra one a late-arriving translation
// asks for — see onTranslationArrived().
const TRANSLATION_REPUSH_MIN_MS = 400;

// ── Default album art (animated GIF) ──
const DEFAULT_ART = 'https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/zkR9FspOnC79sb6532RdH.gif';

// ── Random icon pool (all custom small image modes) ──
const RANDOM_ICON_POOL: [string, string][] = [
  ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/CmyJXMf4iahs7L24VfYDQ.gif', '🎧 Club Mode'],
  ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/VVjYzmfdMIF5hHA8SUnbi.gif', '✨ Radiate'],
  ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/I9CeTrPc17wqbDilQPN9K.gif', '💜 Purple Rad'],
  ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/HrMk6Gy5NrHDuNewWnUOR.gif', '🔴 Rouge'],
  ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/BUo3vfJ4QVWlghZJYuyIB.gif', '💙 Blue Rad'],
];

// ── Platform icons (external URLs — rendered by Discord image proxy) ──
// Note: Discord no longer supports external URLs for small_image. Using compatible host.
const PLATFORM_ICONS: Record<string, [string, string]> = {
  // Streaming services
  spotify: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/ynkf4PMICGeuMIvv7CXpC.png', 'Spotify'],
  apple_music: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/ICa0AUJOip2kfiPnSCfDq.png', 'Apple Music'],
  deezer: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/VVjYzmfdMIF5hHA8SUnbi.gif', 'Deezer'],
  tidal: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/VVjYzmfdMIF5hHA8SUnbi.gif', 'Tidal'],
  amazon_music: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/VVjYzmfdMIF5hHA8SUnbi.gif', 'Amazon Music'],
  soundcloud: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/AUyaLDvEnlp1O2fX4HTvX.png', 'SoundCloud'],
  bandcamp: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/VVjYzmfdMIF5hHA8SUnbi.gif', 'Bandcamp'],
  youtube_music: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/2Fhe7kDaQIQjvCtdlhlmo.png', 'YouTube Music'],
  youtube: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/2Fhe7kDaQIQjvCtdlhlmo.png', 'YouTube'],
  kick: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/MUt6rne1YSKthqduqQF4N.jpg', 'Kick'],
  twitch: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/VGmX6BMle1xqCoM7LDX4w.png', 'Twitch'],
  // Browsers (YouTube / web player)
  browser_chrome: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/2Fhe7kDaQIQjvCtdlhlmo.png', 'YouTube'],
  browser_firefox: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/2Fhe7kDaQIQjvCtdlhlmo.png', 'YouTube'],
  browser_edge: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/2Fhe7kDaQIQjvCtdlhlmo.png', 'YouTube'],
  browser_brave: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/2Fhe7kDaQIQjvCtdlhlmo.png', 'YouTube'],
  browser_opera: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/2Fhe7kDaQIQjvCtdlhlmo.png', 'YouTube'],
  // Desktop players
  vlc: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/VVjYzmfdMIF5hHA8SUnbi.gif', 'VLC'],
  foobar2000: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/VVjYzmfdMIF5hHA8SUnbi.gif', 'foobar2000'],
  musicbee: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/VVjYzmfdMIF5hHA8SUnbi.gif', 'MusicBee'],
  aimp: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/VVjYzmfdMIF5hHA8SUnbi.gif', 'AIMP'],
  winamp: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/VVjYzmfdMIF5hHA8SUnbi.gif', 'Winamp'],
  mediamonkey: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/VVjYzmfdMIF5hHA8SUnbi.gif', 'MediaMonkey'],
  groove: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/VVjYzmfdMIF5hHA8SUnbi.gif', 'Groove Music'],
  wmp: ['https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/VVjYzmfdMIF5hHA8SUnbi.gif', 'Windows Media Player'],
};

// ── Platform-specific large images (Discord rich presence assets) ──
// These are asset names uploaded to the Discord application, not full URLs
const PLATFORM_LARGE_IMAGES: Record<string, string> = {
  kick: 'kicklogo.png',
};

export interface LyricsEngineCallbacks {
  /** Called when the lyric display should update. Return measured RPC latency in ms (or 0). */
  onLyricChange: (current: string, next: string, prev: string) => number;
  /** Called to update Discord RPC with the full activity payload. */
  onRpcUpdate: (activity: DiscordActivity) => void;
}

export class LyricsEngine {
  private lyrics: LyricLine[] = [];
  private currentIdx = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;

  // High-resolution timing
  private trackStartHr = 0;      // performance.now() at track start
  private initialProgressMs = 0; // progress_ms at track start

  // Track metadata (for building RPC payloads)
  private trackData: TrackData | null = null;
  private rpcConfig: Record<string, unknown> = {};

  // RPC latency compensation
  private measuredLatencyMs = 0;

  // Rate limiting
  private lastUpdateTime = 0;
  private lastCurrentText = '';
  private lastEmittedIdx = -1;

  // Timer optimization: avoid re-scheduling if target unchanged
  private nextFireTimeMs = -1;

  // RPC dedup (match Python: only push when content actually changes)
  private lastRpcDetails = '';
  private lastRpcState = '';
  private lastLargeImage = '';
  private lastLargeText = '';
  private lastRpcIdx = -1;
  private lastRpcPushTime = 0; // Monotonic timestamp of last RPC push (for heartbeat)
  private lineChangeCount = 0; // Count line changes for Discord refresh every 2 lines

  // Per-track cached constants (avoid re-computing on every lyric line change)
  private cachedSpotifySearch = '';
  private cachedArtistSearch = '';
  private cachedButtons: { label: string; url: string }[] = [];
  private cachedLargeImage = '';
  private cachedIcon: [string, string] | null = null;
  private cachedPlatText = '';  // Pre-built "Playing on X" string (avoids concat per emit)

  // Pre-resolved per-track URLs (avoid 3× resolveUrl + config lookups per emit)
  private cachedDetailsUrl = '';
  private cachedStateUrl = '';
  private cachedLargeUrl = '';

  // Pre-computed no-lyrics display parts (avoid deduplicateArtist + toLowerCase per emit)
  private cachedDisplayArtist = '';
  private cachedHasAlbum = false;
  private cachedInfoText = '';
  private cachedIsRedundantCtx = true;  // Pre-computed per track (avoids 3× toLowerCase per emit)
  private cachedContextName = '';  // Displayable context name (with Liked Songs fallback)
  private cachedPlayModeSuffix = '';  // '🔀' or '🔂' appended to playlist/album in RPC

  private callbacks: LyricsEngineCallbacks | null = null;
  private running = false;

  // Unified status message system with priority (higher = more important)
  // Priority: disabled(50) > flagged(40) > noLyrics(30) > found(20) > fetching(10) > none(0)
  private statusMessage: { type: StatusType; text: string; priority: number } | null = null;
  private statusMessageTimer: ReturnType<typeof setTimeout> | null = null;
  private statusMessageExpiry = 0; // timestamp when current message expires

  // Instrumental gap: switch RPC to no-lyrics display when gap between lines > LYRIC_GAP_MS
  private inLyricGap = false;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // CC-sourced lyrics use faster update interval
  private isCC = false;
  // Push sources skip the recalibration cooldown entirely: they report the
  // player's own position, so there is nothing to debounce. Set for every
  // extension-fed source (Spicetify, YouTube, SoundCloud, Bandcamp, Kick,
  // Twitch) — see _from_push in types.ts.
  private isPushSource = false;
  private lastRecalibTime = 0;

  // Auto-offset detection: compensates for systematically early/late lyrics
  private autoOffsetMs = 0;

  // Random icon mode: icon picked once per track
  private randomIconPick: [string, string] | null = null;

  // Pre-computed repeat group table (built once per lyrics load, O(1) lookups on emit)
  private groupStart: Int32Array = new Int32Array(0);  // groupStart[i] = first index of the group containing i
  private groupDisplay: string[] = [];                 // groupDisplay[i] = display text for line i (with xN suffix)
  private groupMultiplier: number[] = [];               // groupMultiplier[i] = multiplier value for line i (0 = no multiplier)

  // Romanization cache: avoids re-computing romanize() for the same lyric text
  private romanizeCache = new Map<string, string>();

  // Cached config flags (rebuilt on config change, avoid per-emit boolean casts)
  private cfgShowLyrics = true;
  private cfgRomanize = false;
  private cfgActivityType = 2;
  private cfgStatusDisplay = 'app';
  private cachedStatusName = '';
  private cfgHideSmallIcon = false;
  private cfgIconMode: 'default' | 'dance' | 'radiate' | 'purple_rad' | 'rouge' | 'lrc_off' | 'bleeding' | 'blue_rad' | 'random' = 'default';
  private cfgRpcTranslate = false;
  private cfgTranslateLang = '';

  setCallbacks(cbs: LyricsEngineCallbacks): void {
    this.callbacks = cbs;
  }

  /**
   * Unified status message handler with priority system.
   * Higher priority messages override lower priority ones.
   * Messages auto-expire after durationMs.
   */
  private setStatusMessage(type: StatusType, text: string, priority: number, durationMs: number): void {
    const now = performance.now();

    // Check if a higher priority message is currently active and not expired
    if (this.statusMessage && this.statusMessage.priority > priority && now < this.statusMessageExpiry) {
      return; // Don't override higher priority message
    }

    // Update unified status
    this.statusMessage = { type, text, priority };
    this.statusMessageExpiry = now + durationMs;

    // Clear existing timer
    if (this.statusMessageTimer) {
      clearTimeout(this.statusMessageTimer);
      this.statusMessageTimer = null;
    }

    this.lastUpdateTime = 0; // bypass rate limiter
    this.emitUpdate();

    // Set expiry timer
    if (durationMs > 0 && durationMs < 60000) { // sanity check: max 60s
      this.statusMessageTimer = setTimeout(() => {
        // Only clear if this message is still the current one
        if (this.statusMessage?.type === type) {
          this.clearStatusMessage();
        }
      }, durationMs);
    }
  }

  /** Clear current status message and reset to normal display. */
  private clearStatusMessage(): void {
    this.statusMessage = null;
    this.statusMessageExpiry = 0;
    if (this.statusMessageTimer) {
      clearTimeout(this.statusMessageTimer);
      this.statusMessageTimer = null;
    }
    this.emitUpdate();
  }

  /** Flash "🚩 Lyrics Not Matching" for 5s when the user flags bad lyrics. */
  setLyricsFlagged(): void {
    // Clear lyrics first so they stop displaying before the message appears
    this.lyrics = [];
    this.currentIdx = -1;
    this.setStatusMessage('flagged', '🚩 Lyrics Not Matching', 40, 5000);
  }

  /**
   * Flash "🚫 Lyrics Disabled" for 7s when lyrics are toggled off.
   * Currently unused — kept as the entry point for the `disabled` status type.
   */
  setLyricsDisabled(): void {
    this.setStatusMessage('disabled', '🚫 Lyrics Disabled', 50, 7000);
  }

  /**
   * Start syncing lyrics for a new track.
   * Called when a new track is detected.
   */
  startTrack(
    lyrics: LyricLine[],
    trackData: TrackData,
    rpcConfig: Record<string, unknown>,
  ): void {
    // Preserve status message when restarting (e.g., when flagging lyrics)
    const preserveStatus = this.statusMessage !== null;
    this.stop(preserveStatus);
    this.running = true;
    this.lyrics = lyrics;
    this.isCC = lyrics.length > 0 && lyrics[0].source === 'cc';
    this.isPushSource = !!trackData._from_push;
    this.lastRecalibTime = 0;
    this.buildGroupTable();
    this.detectAutoOffset();
    this.trackData = trackData;
    this.rpcConfig = rpcConfig;
    this.initialProgressMs = trackData.progress_ms;
    this.trackStartHr = performance.now();
    this.lastCurrentText = '';
    this.lastUpdateTime = 0;
    this.lastEmittedIdx = -1;
    this.lastRpcDetails = '';
    this.lastRpcState = '';
    this.lastLargeText = '';
    this.lastLargeImage = '';
    this.lastRpcIdx = -1;
    this.lastRpcPushTime = 0;
    this.nextFireTimeMs = -1;
    this.inLyricGap = false;
    this.romanizeCache.clear();
    this.lineChangeCount = 0;

    // Pick random icon for this track (if random mode is on)
    if ((rpcConfig.random_icon_mode as boolean) === true) {
      this.randomIconPick = RANDOM_ICON_POOL[Math.floor(Math.random() * RANDOM_ICON_POOL.length)];
    } else {
      this.randomIconPick = null;
    }

    // Pre-compute per-track constants (hot-path optimization)
    this.rebuildTrackCache();
    this.rebuildNoLyricsCache();

    // Find initial position
    const baseMs = this.isCC ? 50 : BASE_OFFSET_MS;
    const offset = baseMs + this.measuredLatencyMs + this.getTotalOffsetMs();
    this.currentIdx = findLyricIndex(lyrics, trackData.progress_ms + offset);

    // Don't force display of first line if before its timestamp
    // Let it display naturally when its time comes to avoid showing it too early

    log.info(`[START] Track "${trackData.track_name}" | ${lyrics.length} lyrics | progress=${trackData.progress_ms}ms | idx=${this.currentIdx} | autoOffset=${this.autoOffsetMs}ms`);

    // Emit initial state immediately
    this.emitUpdate();

    // Schedule next
    if (lyrics.length > 0) {
      this.scheduleNext();
    }

    // Start RPC heartbeat — forces Discord to refresh display periodically
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.running) this.emitUpdate();
    }, RPC_HEARTBEAT_MS);
  }

  /**
   * Hot-inject lyrics into the running engine without restarting timing.
   * Called when lyrics arrive asynchronously after startTrack([], ...).
   * Avoids the stop/start gap that causes a visible Discord freeze.
   */
  injectLyrics(lyrics: LyricLine[], trackData?: TrackData): void {
    if (!this.running) return;
    if (trackData) {
      this.trackData = trackData;
      this.rebuildTrackCache();
    }
    this.lyrics = lyrics;
    const wasCC = this.isCC;
    this.isCC = lyrics.length > 0 && lyrics[0].source === 'cc';
    this.buildGroupTable();
    this.detectAutoOffset();

    // Rebuild buttons when CC state changed (e.g. "Listen on Spotify" → "Watch on YouTube")
    if (this.isCC !== wasCC && this.trackData) {
      this.rebuildButtons(this.trackData, this.trackData.media_source || 'spotify');
    }

    // Position within the lyrics using current elapsed time
    const baseMs = this.isCC ? 50 : BASE_OFFSET_MS;
    const offset = baseMs + this.measuredLatencyMs + this.getTotalOffsetMs();
    this.currentIdx = findLyricIndex(lyrics, this.getElapsedMs() + offset);

    // Don't force display of first line if before its timestamp
    // Let it display naturally when its time comes

    // Reset dedup so the first lyric pushes immediately
    this.lastRpcDetails = '';
    this.lastRpcState = '';
    this.lastRpcIdx = -1;
    this.lastUpdateTime = 0;
    this.lastEmittedIdx = -1;
    this.lineChangeCount = 0;

    log.info(`[INJECT] ${lyrics.length} lyrics injected at idx=${this.currentIdx}`);
    this.emitUpdate();

    // Reschedule from current position
    this.cancelTimer();
    if (lyrics.length > 0) {
      this.scheduleNext();
    }
  }

  /**
   * Hot-update track metadata (e.g. enriched album art) without restarting the engine.
   */
  updateTrackData(trackData: TrackData): void {
    if (!this.running) return;
    this.trackData = trackData;
    // Refresh cached values (album art, URLs, display text may have changed)
    this.rebuildTrackCache();
    this.rebuildNoLyricsCache();
    // Reset RPC dedup + rate limiter so the enriched art pushes immediately
    this.lastLargeImage = '';
    this.lastUpdateTime = 0;
    this.emitUpdate();
  }

  /**
   * Live-update the lyrics offset without restarting the engine.
   * Called when the user drags the offset slider.
   */
  updateOffset(offsetMs: number): void {
    this.rpcConfig.lyrics_offset_ms = offsetMs;
    if (!this.running || !this.lyrics.length) return;

    // Re-position within lyrics
    const baseMs = this.isCC ? 50 : BASE_OFFSET_MS;
    const offset = baseMs + this.measuredLatencyMs + offsetMs + this.autoOffsetMs;
    this.currentIdx = findLyricIndex(this.lyrics, this.getElapsedMs() + offset);

    // Reset dedup so the new position pushes immediately
    this.lastRpcDetails = '';
    this.lastRpcState = '';
    this.lastRpcIdx = -1;
    this.lastUpdateTime = 0;

    this.emitUpdate();

    // Reschedule from new position
    this.cancelTimer();
    this.nextFireTimeMs = -1;
    this.scheduleNext();
  }

  /**
   * Update progress from a Spotify poll (drift correction).
   * Called periodically with fresh progress from the API.
   */
  syncProgress(progressMs: number, trackData?: TrackData): void {
    if (!this.running) return;

    let artChanged = false;
    let modeChanged = false;

    if (trackData) {
      /*
       * Keep the resolved cover across polls.
       *
       * The OS session hands over a fresh object every tick carrying the local
       * '/api/thumbnail' placeholder, which would otherwise overwrite the public
       * URL resolved for this track and blank the art on Discord.
       *
       * This used to test for 'catbox.moe' specifically, from when covers were
       * uploaded to that host. Uploading is gone — covers now come from a music
       * CDN — so that test could never fire again. Matching any resolved http(s)
       * URL is what was meant all along, and it does not care where it came from.
       */
      const resolvedArt = /^https?:\/\//.test(this.trackData?.album_art_url ?? '')
        ? this.trackData!.album_art_url
        : null;
      if (resolvedArt && !/^https?:\/\//.test(trackData.album_art_url ?? '')) {
        trackData.album_art_url = resolvedArt;
      }

      // Compare AFTER the restore, not before: the OS hands us a fresh object
      // every poll carrying the local '/api/thumbnail' placeholder, so comparing the
      // raw incoming value would report a change on every tick and force a redundant
      // RPC push. What matters is whether the *effective* art actually moved.
      if (this.trackData) {
        artChanged = trackData.album_art_url !== this.trackData.album_art_url;
        modeChanged = trackData.is_shuffle !== this.trackData.is_shuffle ||
                      trackData.repeat_mode !== this.trackData.repeat_mode;
      }
      this.trackData = trackData;
    }

    // Force RPC update when album art changes (even without lyrics)
    if (artChanged) {
      this.rebuildTrackCache();   // rebuild cached image BEFORE emitting
      this.lastLargeImage = '';   // reset dedup so the new art actually pushes
      this.lastUpdateTime = 0;
      this.emitUpdate();
    }

    // Force RPC update when shuffle/repeat mode changes
    if (modeChanged) {
      this.rebuildNoLyricsCache();
      this.lastRpcDetails = '';   // reset dedup so new suffix pushes
      this.lastUpdateTime = 0;
      this.emitUpdate();
    }

    // progressMs = -1 means "metadata-only update, skip drift recalibration"
    // Used by web sources (SoundCloud, browser) where SMTC position is unreliable
    if (progressMs < 0) return;

    // Live streams: no lyrics, no duration — skip drift recalibration entirely
    if (this.trackData?.is_live) return;

    const currentElapsed = this.getElapsedMs();
    const drift = Math.abs(currentElapsed - progressMs);
    const threshold = this.isCC ? CC_DRIFT_THRESHOLD_MS : DRIFT_THRESHOLD_MS;
    const now = performance.now();

    // Detect track repeat/loop: progress jumped far backward (e.g. 240s → 0s).
    // This bypasses the cooldown — the track genuinely restarted.
    const isRepeatJump = currentElapsed > 5000 && progressMs < currentElapsed * 0.5 && drift > 3000;

    if (isRepeatJump) {
      log.info(`[REPEAT] Progress jumped ${currentElapsed.toFixed(0)}ms → ${progressMs}ms — track looped, force recalibrating`);
      this.lastRecalibTime = now;
      this.initialProgressMs = progressMs;
      this.trackStartHr = performance.now();
      this.inLyricGap = false;
      this.clearGapTimer();
      this.romanizeCache.clear();

      // Reset to the beginning of the lyrics
      const baseMs = this.isCC ? 50 : BASE_OFFSET_MS;
      const offset = baseMs + this.measuredLatencyMs + this.getTotalOffsetMs();
      this.currentIdx = findLyricIndex(this.lyrics, progressMs + offset);
      this.resetDedup();
      this.emitUpdate();
      this.cancelTimer();
      this.scheduleNext();
      return;
    }

    // Push sources: always trust the player's reported progress (no cooldown).
    // The free-running timer inevitably drifts vs. the real player position.
    // Only log when drift is significant to avoid spam.
    if (this.isPushSource && drift > threshold) {
      this.initialProgressMs = progressMs;
      this.trackStartHr = performance.now();
      if (drift > threshold * 4) {
        log.info(`[DRIFT] ${drift.toFixed(0)}ms (engine=${currentElapsed.toFixed(0)} vs player=${progressMs}) — push recalib`);
      }

      // Reschedule from new position
      const baseMs = this.isCC ? 50 : BASE_OFFSET_MS;
      const offset = baseMs + this.measuredLatencyMs;
      const newIdx = findLyricIndex(this.lyrics, progressMs + offset);
      if (newIdx !== this.currentIdx) {
        this.currentIdx = newIdx;
        this.emitUpdate();
      }
      this.cancelTimer();
      this.scheduleNext();
      return;
    }

    // Desktop/SMTC sources: cooldown to prevent poll-burst cascades — waived
    // when the gap is too large to be drift. See SEEK_DRIFT_MS.
    const cooldown = drift > SEEK_DRIFT_MS ? 0 : RECALIB_COOLDOWN_MS;
    /*
     * 0 means "not yet recalibrated on this track", which has to read as
     * "the cooldown has expired", not as a timestamp.
     *
     * It was compared directly against `now`, which is performance.now() —
     * milliseconds since the process started. For the first two minutes of the
     * app's life `now - 0` is below the cooldown, so the very first drift
     * correction of a session was refused whatever its size. Launch the app,
     * start a song, seek: nothing happened, and it looked like seeking simply
     * was not supported.
     */
    const sinceLast = this.lastRecalibTime === 0 ? Infinity : now - this.lastRecalibTime;
    if (drift > threshold && sinceLast >= cooldown) {
      const direction = currentElapsed > progressMs ? 'AHEAD' : 'BEHIND';
      log.info(`[DRIFT] ${drift.toFixed(0)}ms ${direction} (engine=${currentElapsed.toFixed(0)} vs player=${progressMs}) after ${Number.isFinite(sinceLast) ? (sinceLast / 1000).toFixed(1) + "s" : "first sync"} — recalibrating`);
      this.lastRecalibTime = now;
      this.initialProgressMs = progressMs;
      this.trackStartHr = performance.now();

      // Reschedule from new position
      const baseMs = this.isCC ? 50 : BASE_OFFSET_MS;
      const offset = baseMs + this.measuredLatencyMs;
      const newIdx = findLyricIndex(this.lyrics, progressMs + offset);
      if (newIdx !== this.currentIdx) {
        this.currentIdx = newIdx;
        this.emitUpdate();
      }
      this.cancelTimer();
      this.scheduleNext();
    }
  }

  /**
   * Stop the engine (pause/track end).
   */
  stop(preserveStatus = false): void {
    this.running = false;
    if (!preserveStatus) {
      this.clearStatusMessage(); // Clear unified status message
    }
    this.inLyricGap = false;
    this.cancelTimer();
    this.clearHeartbeat();
    this.lyrics = [];
    this.currentIdx = -1;
    this.lastEmittedIdx = -1;
  }

  /** Whether the engine is currently running (not stopped). */
  isRunning(): boolean { return this.running; }

  /** Get real-time playback position (public, for SSE progress emission). */
  getElapsed(): number {
    if (!this.running) return 0;
    return this.getElapsedMs();
  }

  /** Get the current lyrics array (for server-side pre-translation). */
  getLyrics(): LyricLine[] {
    return this.lyrics;
  }

  /** Get the current lyric index (for server-side pre-translation). */
  getCurrentIndex(): number {
    return this.currentIdx;
  }

  // ── Core scheduling ──

  /** Get current playback position using high-res timer. */
  private getElapsedMs(): number {
    return this.initialProgressMs + (performance.now() - this.trackStartHr);
  }

  /** User lyrics offset: negative = lyrics earlier, positive = later. */
  private getUserOffsetMs(): number {
    return (this.rpcConfig.lyrics_offset_ms as number) || 0;
  }

  /** Get the total combined offset (auto + user). */
  private getTotalOffsetMs(): number {
    return this.getUserOffsetMs() + this.autoOffsetMs;
  }

  /**
   * Auto-detect if lyrics have a systematic timing offset.
   * Heuristics:
   *   - CC lyrics that start at t=0 but actual vocal starts later → shift forward
   *   - LRC lyrics where first line starts > 30s → likely has long intro, no correction needed
   *   - Detect if timestamps cluster suspiciously early (all < 500ms apart, starting at 0)
   * Sets this.autoOffsetMs (0 if no correction needed).
   */
  private detectAutoOffset(): void {
    this.autoOffsetMs = 0;
    const lyrics = this.lyrics;
    if (lyrics.length < 4) return;

    // Only auto-correct CC lyrics — LRC from providers is generally well-timed
    if (!this.isCC) return;

    // Check if CC timestamps start at 0 or near-0 and have very small initial gaps
    // This pattern indicates auto-generated captions that don't account for intro
    const firstTime = lyrics[0].time;
    if (firstTime > 2000) return; // First line already > 2s in — no correction needed

    // Compute median gap between first 10 lines
    const gaps: number[] = [];
    const sampleSize = Math.min(10, lyrics.length - 1);
    for (let i = 0; i < sampleSize; i++) {
      gaps.push(lyrics[i + 1].time - lyrics[i].time);
    }
    gaps.sort((a, b) => a - b);
    const medianGap = gaps[Math.floor(gaps.length / 2)];

    // If CC lines are very dense (< 400ms median gap) and start near 0,
    // they're likely auto-generated with a systematic early bias
    if (medianGap < 400 && firstTime < 500) {
      // Apply a small forward shift to compensate for CC display delay
      this.autoOffsetMs = -200;
      log.info(`[AUTO-OFFSET] CC lyrics start at ${firstTime}ms with ${medianGap}ms median gap → auto offset ${this.autoOffsetMs}ms`);
    }
  }

  /** Get the detected auto-offset (exposed for dashboard display). */
  getAutoOffset(): number {
    return this.autoOffsetMs;
  }

  /** Schedule a timeout for exactly when the next lyric line begins. */
  private scheduleNext(): void {
    if (!this.running || !this.lyrics.length) return;

    const nextIdx = this.currentIdx + 1;
    if (nextIdx >= this.lyrics.length) {
      // Last line — schedule end-of-track check
      const remaining = this.trackData ? this.trackData.duration_ms - this.getElapsedMs() - this.getUserOffsetMs() : 0;
      if (remaining > 0) {
        this.cancelTimer();
        this.nextFireTimeMs = -1;
        // Always schedule song title display 5 seconds after last line
        this.gapTimer = setTimeout(() => {
          if (!this.running) return;
          this.inLyricGap = true;
          this.resetDedup();
          this.emitUpdate();
        }, 5000);
        this.timer = setTimeout(() => {
          log.info('[END] Track duration reached');
          this.stop();
        }, remaining);
      }
      return;
    }

    const nextTime = this.lyrics[nextIdx].time;

    // Skip re-schedule if we're already targeting the same lyric line AND timer is live
    if (nextTime === this.nextFireTimeMs && this.timer !== null) return;
    this.nextFireTimeMs = nextTime;

    this.cancelTimer();
    const elapsed = this.getElapsedMs();
    const baseMs = this.isCC ? 50 : BASE_OFFSET_MS;
    const dynamicOffset = baseMs + this.measuredLatencyMs + this.getTotalOffsetMs();
    const delay = nextTime - dynamicOffset - elapsed;

    // Schedule gap display if the delay until next line exceeds threshold
    if (delay > LYRIC_GAP_MS) {
      this.gapTimer = setTimeout(() => {
        if (!this.running) return;
        this.inLyricGap = true;
        this.resetDedup();
        this.emitUpdate();
      }, LYRIC_GAP_MS);
    }

    this.timer = setTimeout(() => {
      if (!this.running) return;
      this.inLyricGap = false;
      this.clearGapTimer();
      this.currentIdx = nextIdx;
      this.emitUpdate();
      this.scheduleNext();
    }, Math.max(0, delay));
  }

  // ── Pre-computed group table (built once per lyrics set) ──

  /** Build group lookup tables from current lyrics array. O(n) once, then O(1) per emit. */
  private buildGroupTable(): void {
    const n = this.lyrics.length;
    if (n === 0) {
      this.groupStart = new Int32Array(0);
      this.groupDisplay = [];
      this.groupMultiplier = [];
      return;
    }
    const gs = new Int32Array(n);
    const gd: string[] = new Array(n);
    const gm: number[] = new Array(n); // Multiplier values (0 = no multiplier)

    // Detect 2-line consecutive repeats (A, B, A, B pattern) - ONLY consecutive repeats
    // Mark second line of each occurrence with decreasing multiplier (x3, x2, then none)
    // NEVER show multiplier on first line of any pair
    // IGNORE pairs where both lines are identical (handled by consecutive repeat logic)
    const pairRepeatMultipliers = new Map<number, number>(); // index -> multiplier value
    const pairRepeatFirstLines = new Set<number>(); // First lines of pairs to exclude from consecutive logic
    const processedIndices = new Set<number>(); // Indices already part of a detected pair
    let pairIdx = 0;
    while (pairIdx < n - 1) {
      // Skip if this index is already part of a detected pair
      if (processedIndices.has(pairIdx)) {
        pairIdx++;
        continue;
      }

      const text1 = this.lyrics[pairIdx].text;
      const text2 = this.lyrics[pairIdx + 1].text;

      // Skip if both lines are identical (handled by consecutive repeat logic)
      if (text1 === text2) {
        pairIdx++;
        continue;
      }

      // Find only CONSECUTIVE occurrences of this pair (i+2, i+4, i+6, etc.)
      const occurrences: number[] = [pairIdx]; // Start with first occurrence
      let j = pairIdx + 2;
      while (j < n - 1) {
        if (this.lyrics[j].text === text1 && this.lyrics[j + 1].text === text2) {
          occurrences.push(j);
          j += 2; // Check next consecutive pair
        } else {
          break; // Stop if pattern breaks
        }
      }

      // If we have multiple consecutive occurrences, assign decreasing multipliers
      if (occurrences.length > 1) {
        for (let occ = 0; occ < occurrences.length; occ++) {
          const idx = occurrences[occ];
          const remaining = occurrences.length - occ;
          // Mark both lines of each occurrence as processed to avoid overlapping pairs
          processedIndices.add(idx);
          processedIndices.add(idx + 1);
          // Mark first line to exclude from consecutive repeat logic
          pairRepeatFirstLines.add(idx);
          // Only show multiplier on second line if more than 1 remaining (skip last occurrence)
          if (remaining > 1) {
            pairRepeatMultipliers.set(idx + 1, remaining); // Mark second line of pair
          }
        }
      }

      // Move to next line
      pairIdx++;
    }

    let i = 0;
    while (i < n) {
      const text = this.lyrics[i].text;
      let j = i + 1;
      while (j < n && this.lyrics[j].text === text) j++;
      const count = j - i;
      for (let k = i; k < j; k++) {
        gs[k] = i;
        const lineText = this.lyrics[k].text;
        // Check if this line has a pair repeat multiplier
        const pairMultiplier = pairRepeatMultipliers.get(k);
        // Check if this line is a first line of a pair (exclude from consecutive logic)
        const isFirstLineOfPair = pairRepeatFirstLines.has(k);
        // For pair repeat, use the assigned multiplier
        // For consecutive repeats, use total remaining count (like pair style)
        // BUT exclude first line if it's part of a pair repeat
        let shouldShowMultiplier = false;
        let multiplier = count - k + i; // Total remaining from current position
        if (pairMultiplier !== undefined) {
          shouldShowMultiplier = true;
          multiplier = pairMultiplier;
        } else if (count > 1 && multiplier > 1 && !isFirstLineOfPair) {
          shouldShowMultiplier = true;
        }
        // Store multiplier separately, don't include in text
        gm[k] = shouldShowMultiplier ? multiplier : 0;
        gd[k] = !lineText ? '♪♪' : lineText;
      }
      i = j;
    }
    this.groupStart = gs;
    this.groupDisplay = gd;
    this.groupMultiplier = gm;
  }

  // ── Consecutive repeat helpers (O(1) via pre-computed table) ──

  private getDisplayText(idx: number): string {
    if (idx < 0 || idx >= this.groupDisplay.length) return '♪♪';
    return this.groupDisplay[idx];
  }

  private getPrevGroupEnd(idx: number): number {
    if (idx <= 0 || idx >= this.groupStart.length) return -1;
    const start = this.groupStart[idx];
    return start > 0 ? start - 1 : -1;
  }

  /**
   * Publish the current presence again immediately.
   *
   * Discord drops the activity when the socket closes, and the app closes it on
   * purpose every time the announced player changes — a different platform means
   * a different Discord application, so switching player means reconnecting.
   * Nothing else republishes until the next heartbeat, which is long enough that
   * pinning a player looks like it did nothing, and long enough for the new
   * player's track to arrive under the old one's app name.
   *
   * The heartbeat clock is reset rather than the dedupe fields: buildActivity
   * suppresses an unchanged payload, and after a reconnect the payload is
   * unchanged by definition — it is the socket underneath that is new.
   *
   * Returns false when there is nothing to publish, so the caller can fall back
   * to whatever it shows when no track is playing.
   */
  pushRpcNow(): boolean {
    if (!this.running || !this.trackData || !this.callbacks) return false;
    const [current, next] = this.displayPair();
    this.lastRpcPushTime = 0;  // past buildActivity's dedupe
    const activity = this.buildActivity(current, next);
    if (!activity) return false;
    this.callbacks.onRpcUpdate(activity);
    return true;
  }

  /** The current and next lines as the presence should show them. */
  private displayPair(): [current: string, next: string] {
    if (!this.lyrics.length) return ['♪♪', ''];
    if (this.currentIdx < 0) return ['♪♪', this.getDisplayText(0)];
    const nextIdx = this.currentIdx + 1;
    return [
      this.getDisplayText(this.currentIdx),
      nextIdx < this.lyrics.length ? this.getDisplayText(nextIdx) : '',
    ];
  }

  /** Emit the current lyric state to callbacks. */
  private emitUpdate(): void {
    if (!this.callbacks || !this.trackData) return;

    // Build display text with consecutive repeat collapsing
    const [current, next] = this.displayPair();
    const prevGroupIdx = this.lyrics.length && this.currentIdx >= 0
      ? this.getPrevGroupEnd(this.currentIdx)
      : -1;
    const prev = prevGroupIdx >= 0 ? this.getDisplayText(prevGroupIdx) : '';

    // Rate limiting: protect Discord from too-frequent updates.
    // Bypass conditions (always allow update):
    //   - Lyric INDEX changed (new line scheduled by timer)
    //   - Display TEXT changed (new group for CC, or different line)
    //   - Heartbeat due (>5s since last RPC push — keeps Discord UI fresh)
    const now = performance.now();
    const minInterval = this.isCC ? CC_UPDATE_INTERVAL_MS : MIN_UPDATE_INTERVAL_MS;
    const tooSoon = now - this.lastUpdateTime < minInterval;
    const idxChanged = this.currentIdx !== this.lastEmittedIdx;
    const textChanged = current !== this.lastCurrentText;
    const heartbeatDue = now - this.lastRpcPushTime >= RPC_HEARTBEAT_MS;
    if (tooSoon && !idxChanged && !textChanged && !heartbeatDue) {
      return;
    }

    this.lastEmittedIdx = this.currentIdx;
    this.lastCurrentText = current;
    this.lastUpdateTime = now;

    // Beautiful lyrics log display — same columns as a real log line, so it
    // never looks like a stray/cut-off line between real log messages.
    if (current && current !== '♪♪' && idxChanged) {
      log.lyrics(current);
    }

    // Discord RPC: only update every 2 lines, but always show first line
    if (idxChanged) {
      this.lineChangeCount++;
    }
    const isFirstLine = this.lineChangeCount === 1;
    const shouldUpdateRpc = idxChanged && (isFirstLine || this.lineChangeCount % 2 === 0);

    // Heartbeat only applies when NOT showing lyrics (keeps Discord UI fresh during gaps/no-lyrics)
    const isShowingLyrics = current && current !== '♪♪' && !this.inLyricGap;
    const shouldHeartbeat = heartbeatDue && !isShowingLyrics;

    // CRITICAL ORDER: RPC first (latency-sensitive), then SSE (latency-tolerant).
    // Build and emit full RPC activity before onLyricChange triggers EventEmitter + SSE.
    if (shouldUpdateRpc || shouldHeartbeat) {
      const activity = this.buildActivity(current, next);
      if (activity) {
        this.callbacks.onRpcUpdate(activity);
      }
    }

    // SSE broadcast + dashboard update (always update, regardless of line parity)
    // Dashboard gets lyrics WITHOUT music notes (clean display)
    const latencyMs = this.callbacks.onLyricChange(current, next, prev);
    if (latencyMs > 0 && latencyMs < 500) {
      this.measuredLatencyMs = EMA_ALPHA * latencyMs + (1 - EMA_ALPHA) * this.measuredLatencyMs;
    }
  }

  // ── Per-track cache (rebuilt on track change / metadata update) ──

  private rebuildTrackCache(): void {
    const d = this.trackData;
    if (!d) return;

    // Clickable URLs — platform-aware
    const source = d.media_source || 'spotify';

    // /api/thumbnail is a local-only path (SMTC thumb) — Discord needs a public URL
    // Also spotify:localfileimage:... are internal Spotify URLs that Discord cannot access
    const isLocalFileImage = d.album_art_url?.startsWith('spotify:localfileimage:');
    const art = d.album_art_url && d.album_art_url !== '/api/thumbnail' && !isLocalFileImage
      ? d.album_art_url
      : '';
    // Use platform-specific large image if available, but prioritize actual album art for Kick/Twitch
    // Kick/Twitch use streamer profile pictures as album art, so don't override with platform logo
    const platformLargeImage = PLATFORM_LARGE_IMAGES[source];
    this.cachedLargeImage = art || platformLargeImage || DEFAULT_ART;

    this.cachedSpotifySearch = platformSearchUrl(source, `${d.artist_name} ${d.track_name}`);
    this.cachedArtistSearch = platformSearchUrl(source, d.artist_name);

    // Buttons (stable per-track + config)
    this.rebuildButtons(d, source);

    // Platform icon (reuse `source` from above)
    this.cachedIcon = PLATFORM_ICONS[source] ?? null;
    this.cachedPlatText = this.cachedIcon ? `Playing on ${this.cachedIcon[1]}` : '';

    // Cache config flags to avoid per-emit boolean casts
    this.cfgShowLyrics = (this.rpcConfig.show_lyrics as boolean) !== false;
    this.cfgRomanize = (this.rpcConfig.romanize_lyrics as boolean) === true;
    this.cfgRpcTranslate = (this.rpcConfig.rpc_translate_lyrics as boolean) === true;
    this.cfgTranslateLang = (this.rpcConfig.translate_target_lang as string) || 'en';
    this.cfgActivityType = (this.rpcConfig.rpc_activity_type as number) ?? 2;
    this.cfgStatusDisplay = (this.rpcConfig.rpc_status_display as string) || 'app';
    // Resolved once per track — the status line only depends on metadata, never on
    // the current lyric, so it never needs rebuilding between lines.
    const statusTpl = this.cfgStatusDisplay === 'custom'
      ? (this.rpcConfig.rpc_status_template as string) || ''
      : STATUS_TEMPLATES[this.cfgStatusDisplay] || '';
    this.cachedStatusName = statusTpl
      ? truncate(renderStatusTemplate(statusTpl, statusVars(d)), 128)
      : '';
    this.cfgHideSmallIcon = (this.rpcConfig.hide_small_icon as boolean) === true;
    // Custom icon modes are Spotify-specific — force 'default' (platform icon) for other sources
    const isSpotify = source === 'spotify';
    this.cfgIconMode =
      this.cfgHideSmallIcon ? 'default' :
      !isSpotify ? 'default' :
      (this.rpcConfig.random_icon_mode as boolean) ? 'random' :
      (this.rpcConfig.lrc_off_mode as boolean) ? 'lrc_off' :
      (this.rpcConfig.rouge_mode as boolean) ? 'rouge' :
      (this.rpcConfig.bleeding_mode as boolean) ? 'bleeding' :
      (this.rpcConfig.blue_rad_mode as boolean) ? 'blue_rad' :
      (this.rpcConfig.purple_rad_mode as boolean) ? 'purple_rad' :
      (this.rpcConfig.radiate_mode as boolean) ? 'radiate' :
      (this.rpcConfig.dance_mode as boolean) ? 'dance' : 'default';

    // Pre-resolve clickable URLs (avoids 3× config lookups + switch per emit)
    // Kick/Twitch: make only state non-clickable (details remains clickable to profile)
    // Local files: make both details and state non-clickable
    if (d.is_local) {
      this.cachedDetailsUrl = '';
      this.cachedStateUrl = '';
    } else if (d.media_source === 'kick' || d.media_source === 'twitch') {
      this.cachedDetailsUrl = this.resolveUrl(d, 'rpc_details_url', d.spotify_url || d.context_url || '');
      this.cachedStateUrl = '';
    } else {
      this.cachedDetailsUrl = this.resolveUrl(d, 'rpc_details_url', d.spotify_url || this.cachedSpotifySearch);
      this.cachedStateUrl = this.resolveUrl(d, 'rpc_state_url', d.context_url || d.artist_url || this.cachedArtistSearch);
    }
    this.cachedLargeUrl = this.resolveUrl(d, 'rpc_large_url', d.album_url || d.spotify_url || this.cachedSpotifySearch);
  }

  /** Pre-compute no-lyrics display parts (avoid deduplicateArtist + toLowerCase per emit). */
  private rebuildNoLyricsCache(): void {
    const d = this.trackData;
    if (!d) return;
    this.cachedDisplayArtist = deduplicateArtist(d.track_name, d.artist_name);
    this.cachedHasAlbum = !!(d.album_name && d.album_name.trim());
    this.cachedContextName = getContextDisplayName(d);
    // Mark context as redundant if empty OR if it matches album name exactly
    const ctxMatchesAlbum = !!(this.cachedContextName && d.album_name && this.cachedContextName.toLowerCase() === d.album_name.toLowerCase());
    this.cachedIsRedundantCtx = !this.cachedContextName || ctxMatchesAlbum;
    // Shuffle / repeat indicator (appended to playlist/album, not track name)
    this.cachedPlayModeSuffix =
      d.is_shuffle ? ' | 🔀' :
      d.repeat_mode === 'track' ? ' | 🔂' : '';
    this.cachedInfoText = buildInfoText(d, '', '');
    // Insert play mode suffix after context/album in infoText (visible in large_text when lyrics are showing)
    if (this.cachedPlayModeSuffix) {
      this.cachedInfoText = truncate(this.cachedInfoText + this.cachedPlayModeSuffix, 128);
    }
  }

  /** Build RPC buttons — overrides to "Watch on YouTube" when CC lyrics are active. */
  private rebuildButtons(d: TrackData, source: string): void {
    const btn1Label = (this.rpcConfig.rpc_button1_label as string) || '';
    const btn1Url = (this.rpcConfig.rpc_button1_url as string) || '';
    const btn2Label = (this.rpcConfig.rpc_button2_label as string) || '';
    const buttons: { label: string; url: string }[] = [];
    if (btn1Label && btn1Url) {
      buttons.push({ label: truncate(btn1Label, 32), url: btn1Url });
    }
    if (btn2Label && !d.is_local) {
      // CC active → override to YouTube
      const effectiveSource = this.isCC ? 'youtube' : source;
      const btn2Resolved = platformButtonLabel(btn2Label, effectiveSource);
      let btn2Url: string;
      // Use direct video URL if available (YouTube, Twitch, Kick), otherwise search
      if (d.video_url && (effectiveSource === 'youtube' || effectiveSource === 'youtube_music' || effectiveSource === 'twitch' || effectiveSource === 'kick')) {
        btn2Url = d.video_url;
      } else if (this.isCC) {
        const ytSearch = platformSearchUrl('youtube', `${d.artist_name} ${d.track_name}`);
        btn2Url = ytSearch;
      } else {
        btn2Url = d.spotify_url || this.cachedSpotifySearch;
      }
      buttons.push({ label: truncate(btn2Resolved, 32), url: btn2Url });
    }
    this.cachedButtons = buttons;
  }

  // ── RPC payload building ──

  private buildActivity(currentText: string, nextText: string): DiscordActivity | null {
    const d = this.trackData!;
    const hasLyrics = this.cfgShowLyrics && this.lyrics.length > 0;
    // Force Twitch and Kick to always use Listening (type 2)
    const source = d.media_source || '';
    const activityType = (source === 'twitch' || source === 'kick') ? 2 : this.cfgActivityType;

    // Timestamps (elapsed timer on Discord) — clamp to duration to avoid overflowing the bar
    const nowUnix = Math.floor(Date.now() / 1000);
    const rawElapsed = this.getElapsedMs();
    const elapsedSec = Math.floor((d.duration_ms > 0 ? Math.min(rawElapsed, d.duration_ms) : rawElapsed) / 1000);
    
    // For live streams, use stream start time to show total stream duration instead of resetting to 0
    let startTs: number;
    if (d.is_live && d.stream_start_time_ms) {
      startTs = Math.floor(d.stream_start_time_ms / 1000);
      log.debug(`[LYRICS] Live stream: using start time ${startTs} (from ${d.stream_start_time_ms})`);
    } else {
      startTs = nowUnix - elapsedSec;
      log.debug(`[LYRICS] Non-live or no start time: using elapsed ${elapsedSec}s`);
    }
    
    const endTs = d.duration_ms > 0 ? startTs + Math.floor(d.duration_ms / 1000) : 0;

    let details: string;
    let state: string;
    let largeText: string;

    // Status message (shown alone when active — no extra text)
    // Use unified statusMessage system if active, fallback to legacy flags
    let status = '';
    if (this.statusMessage && performance.now() < this.statusMessageExpiry) {
      status = this.statusMessage.text;
    }

    if (hasLyrics && currentText && currentText !== '♪♪' && !this.inLyricGap) {
      // Lyrics mode: details = current lyric, state = → next lyric
      //
      // Translation goes first, on the raw line, before anything is added to
      // it. The cache is keyed on the text itself, and what the backend warms
      // when a track loads is the raw lyric — so decorating first (romanising,
      // prefixing the note, appending the repeat count) built a key that warm
      // cache never holds. Every displayed line missed, opened its own request,
      // and handed the note characters to the translator along with the words;
      // the (xN) suffix made the key different again on every repeat. Order
      // also settles romanisation: a line that came back translated is already
      // in the target script and must not be romanised on top of that.
      let cur = currentText;
      let nxt = nextText;
      let curTranslated = false;
      let nxtTranslated = false;

      if (this.cfgRpcTranslate && this.cfgTranslateLang) {
        const lang = this.cfgTranslateLang;
        const tCur = this.translateForRpc(currentText, lang);
        if (tCur) { cur = tCur; curTranslated = true; }
        if (nextText) {
          const tNxt = this.translateForRpc(nextText, lang);
          if (tNxt) { nxt = tNxt; nxtTranslated = true; }
        }
      }

      if (this.cfgRomanize) {
        if (!curTranslated) cur = this.cachedRomanize(cur);
        if (!nxtTranslated && nxt) nxt = this.cachedRomanize(nxt);
      }

      // Add music notes for Spotify and SoundCloud (Discord RPC only)
      const source = this.trackData?.media_source || '';
      if (source === 'spotify' || source === 'soundcloud') {
        if (cur && cur !== '♪♪') {
          cur = '♪ ' + cur;
        }
        if (nxt && nxt !== '♪♪') {
          // Add multiplier after music note on next line only
          const nextIdx = this.currentIdx + 1;
          const nextMultiplier = this.groupMultiplier[nextIdx] || 0;
          nxt = nxt + ' ♪' + (nextMultiplier > 0 ? ` (x${nextMultiplier})` : '');
        }
      }

      details = truncate(cur, 128);
      state = nxt ? truncate(`→${nxt}`, 128) : '  ';
      // When lyrics are showing, details/state contain lyric LINES, not metadata.
      largeText = status
        ? truncate(status, 128)
        : this.cachedInfoText;
    } else {
      // No lyrics / lyrics disabled — use pre-computed display parts
      details = truncate(d.track_name, 128);
      const ctx = this.cachedContextName;

      if (ctx && !this.cachedIsRedundantCtx) {
        // Kick/Twitch: don't add context emoji
        state = truncate((d.media_source === 'kick' || d.media_source === 'twitch') ? `${ctx}${this.cachedPlayModeSuffix}` : `🎼 ${ctx}${this.cachedPlayModeSuffix}`, 128);
        if (status) {
          largeText = truncate(status, 128);
        } else {
          const parts: string[] = [];
          // Kick/Twitch: don't add emojis
          if (d.media_source === 'kick' || d.media_source === 'twitch') {
            if (this.cachedDisplayArtist) parts.push(this.cachedDisplayArtist);
            if (this.cachedHasAlbum) parts.push(d.album_name);
          } else {
            if (this.cachedDisplayArtist) parts.push(`🎤 ${this.cachedDisplayArtist}`);
            if (this.cachedHasAlbum) parts.push(`💽 ${d.album_name}`);
          }
          largeText = truncate(parts.join(' | ') || d.track_name, 128);
        }
      } else {
        // Kick/Twitch: don't add emoji to state
        state = this.cachedDisplayArtist ? truncate((d.media_source === 'kick' || d.media_source === 'twitch') ? this.cachedDisplayArtist : `🎤 ${this.cachedDisplayArtist}`, 128) : '  ';
        if (status) {
          largeText = truncate(status, 128);
        } else {
          // Kick/Twitch: don't add album emoji
          largeText = this.cachedHasAlbum
            ? truncate((d.media_source === 'kick' || d.media_source === 'twitch') ? `${d.album_name}${this.cachedPlayModeSuffix}` : `💽 ${d.album_name}${this.cachedPlayModeSuffix}`, 128)
            : truncate(d.track_name, 128);
        }
      }
    }

    // RPC dedup: skip if same content AND same lyric index (repeated lines must push)
    // Heartbeat: always push after RPC_HEARTBEAT_MS to keep Discord UI fresh
    const rpcNow = performance.now();
    const heartbeatDue = rpcNow - this.lastRpcPushTime >= RPC_HEARTBEAT_MS;
    if (
      !heartbeatDue &&
      this.currentIdx === this.lastRpcIdx &&
      details === this.lastRpcDetails &&
      state === this.lastRpcState &&
      largeText === this.lastLargeText &&
      this.cachedLargeImage === this.lastLargeImage
    ) {
      return null;
    }
    this.lastRpcIdx = this.currentIdx;
    this.lastRpcDetails = details;
    this.lastRpcState = state;
    this.lastLargeText = largeText;
    this.lastLargeImage = this.cachedLargeImage;
    this.lastRpcPushTime = rpcNow;

    // Status line ("Listening to …" in the member list). It can only read from
    // name / state / details, so the metadata presets route through `name` — the
    // one slot the lyrics don't already occupy, leaving details/state intact.
    // An empty render (e.g. {playlist} on a track with no context) omits `name`
    // entirely, which falls back to the application name.
    const activity: DiscordActivity = {
      type: activityType,
      ...(this.cachedStatusName
        ? { name: this.cachedStatusName, status_display_type: 0 }
        : this.cfgStatusDisplay === 'details' ? { status_display_type: 2 }
        : this.cfgStatusDisplay === 'state' ? { status_display_type: 1 }
        : {}),
      details,
      state,
      timestamps: endTs > startTs ? { start: startTs, end: endTs } : { start: startTs },
      assets: {
        large_image: this.cachedLargeImage,
        large_text: largeText,
      },
      buttons: this.cachedButtons.length > 0 ? this.cachedButtons : undefined,
      details_url: this.cachedDetailsUrl,
      state_url: this.cachedStateUrl,
      large_url: this.cachedLargeUrl,
    };

    // Small icon — resolved from cached icon mode (no per-emit boolean casts)
    this.applySmallIcon(activity, d);

    return activity;
  }

  /** Resolve a clickable URL from config choice. Falls back to autoUrl if the chosen source is empty. */
  private resolveUrl(d: TrackData, configKey: string, autoUrl: string): string {
    const choice = (this.rpcConfig[configKey] as string) || 'auto';
    if (choice === 'auto') return autoUrl;
    // Inline lookup — avoids object allocation on every call
    let resolved: string | undefined;
    switch (choice) {
      case 'track':   resolved = d.spotify_url; break;
      case 'artist':  resolved = d.artist_url; break;
      case 'album':   resolved = d.album_url; break;
      case 'context': resolved = d.context_url; break;
    }
    return resolved || ((choice === 'artist') ? this.cachedArtistSearch : this.cachedSpotifySearch) || autoUrl;
  }

  /** Apply small icon to activity based on cached icon mode. */
  private applySmallIcon(activity: DiscordActivity, d: TrackData): void {
    if (this.cfgHideSmallIcon) return;
    const pt = this.cachedPlatText; // Pre-built per-track (no concat per emit)
    switch (this.cfgIconMode) {
      case 'random':
        if (this.randomIconPick) {
          activity.assets!.small_image = this.randomIconPick[0];
          activity.assets!.small_text = pt || this.randomIconPick[1];
        }
        break;
      case 'radiate':
        activity.assets!.small_image = 'https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/VVjYzmfdMIF5hHA8SUnbi.gif';
        activity.assets!.small_text = pt || '✨ Radiate';
        break;
      case 'purple_rad':
        activity.assets!.small_image = 'https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/I9CeTrPc17wqbDilQPN9K.gif';
        activity.assets!.small_text = pt || '💜 Purple Rad';
        break;
      case 'rouge':
        activity.assets!.small_image = 'https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/HrMk6Gy5NrHDuNewWnUOR.gif';
        activity.assets!.small_text = pt || '🔴 Rouge';
        break;
      case 'bleeding':
        activity.assets!.small_image = 'https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/6sALSWqWzao3chNZzHCXy.gif';
        activity.assets!.small_text = pt || '🩸 Bleeding';
        break;
      case 'blue_rad':
        activity.assets!.small_image = 'https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/BUo3vfJ4QVWlghZJYuyIB.gif';
        activity.assets!.small_text = pt || '💙 Blue Rad';
        break;
      case 'dance':
        if ((d.media_source || '') === 'spotify') {
          activity.assets!.small_image = 'https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/CmyJXMf4iahs7L24VfYDQ.gif';
          activity.assets!.small_text = pt || '🎧 Club Mode';
        } else if (this.cachedIcon) {
          activity.assets!.small_image = this.cachedIcon[0];
          activity.assets!.small_text = pt;
        }
        break;
      default:
        if (this.cachedIcon) {
          activity.assets!.small_image = this.cachedIcon[0];
          activity.assets!.small_text = pt;
        }
        break;
    }
  }

  /**
   * The translated form of a lyric line, when it is already to hand.
   *
   * Cache only. This runs on the emit path, and awaiting a round trip here
   * would hold the line itself off Discord — the whole point of the engine is
   * that the line lands on the beat. A miss starts one fetch and asks for a
   * re-push when it arrives, so the translation shows a moment later instead of
   * never: the presence pushes only every other line, so a line whose
   * translation landed after its own push would otherwise stay in the original
   * for as long as it is on screen.
   *
   * Nothing is fetched for a line the providers have already declined, or one
   * somebody else is already asking about — that check is what keeps an English
   * song with the target left at English from opening a request per line.
   */
  private translateForRpc(text: string, lang: string): string | null {
    const trimmed = text.trim();
    const hit = getCachedTranslation(trimmed, lang);
    if (hit) return hit;
    if (!isTranslationWorthFetching(trimmed, lang)) return null;

    translateText(trimmed, lang)
      .then(res => { if (res) this.onTranslationArrived(trimmed); })
      .catch(() => {});
    return null;
  }

  /**
   * A translation landed after the line it belongs to had already been pushed.
   *
   * Only the line on screen earns a second push: a translation for the next
   * line is read straight from the cache when that line's own push comes round.
   * The dedup fields are cleared because from buildActivity's point of view
   * nothing has changed — the index is the same and it has no way to know the
   * text it is about to build differs from the text it built last time.
   *
   * Guarded on the last push so a burst of arrivals cannot turn into a burst of
   * RPC writes; anything that lands inside that window rides the next line's
   * push instead. After the batch warm-up at track load this path is rare — it
   * covers captions that stream in mid-song and lines the warm-up missed.
   */
  private onTranslationArrived(trimmed: string): void {
    if (!this.running || !this.callbacks || !this.trackData) return;
    if (performance.now() - this.lastRpcPushTime < TRANSLATION_REPUSH_MIN_MS) return;

    const [current, next] = this.displayPair();
    if (current.trim() !== trimmed) return;

    this.lastRpcDetails = '';
    this.lastRpcState = '';
    this.lastRpcIdx = -1;
    const activity = this.buildActivity(current, next);
    if (activity) this.callbacks.onRpcUpdate(activity);
  }

  /** Romanize with per-text memoization. Cache cleared on track change. */
  private cachedRomanize(text: string): string {
    let r = this.romanizeCache.get(text);
    if (r === undefined) {
      r = romanize(text);
      this.romanizeCache.set(text, r);
      evictOldest(this.romanizeCache, 500);
    }
    return r;
  }

  /** Reset RPC dedup + rate limiter so the next emitUpdate() always pushes. */
  private resetDedup(): void {
    this.lastRpcDetails = '';
    this.lastRpcState = '';
    this.lastLargeText = '';
    this.lastRpcIdx = -1;
    this.lastUpdateTime = 0;
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearGapTimer(): void {
    if (this.gapTimer) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.clearGapTimer();
    this.nextFireTimeMs = -1;
  }
}

// ── Helpers ──

function truncate(text: string, max: number): string {
  // Discord's RPC text fields (details/state/largeText/button labels) render
  // on a single line — raw newlines (e.g. from a multi-line Kick/Twitch
  // stream title) don't display well there. Turn line breaks into the same
  // ' | ' single-line separator used elsewhere in this file, dropping empty
  // lines so blank-line runs don't produce repeated separators, and collapse
  // any other run of whitespace down to a single space.
  const normalized = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' | ')
    .replace(/[ \t\f\v]+/g, ' ')
    .trim();
  if (normalized.length <= max) return normalized;
  // For very short limits, just cut and add ellipsis
  if (max <= 10) return normalized.slice(0, max - 3) + '...';
  // For longer limits, try to preserve whole words
  const cut = normalized.slice(0, max - 3);
  const lastSpace = cut.lastIndexOf(' ');
  const lastPunct = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf(','), cut.lastIndexOf(';'), cut.lastIndexOf(':'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
  const boundary = Math.max(lastSpace, lastPunct);
  const trimmed = boundary > max * 0.7 ? cut.slice(0, boundary) : cut.trim();
  return dropLoneSurrogate(trimmed) + '...';
}

/**
 * Remove a trailing half of an emoji.
 *
 * `slice` counts UTF-16 units, and everything outside the basic plane — every
 * emoji, and a good deal else — is two of them. Cutting a line at unit 125
 * therefore lands inside a pair once in every two positions, leaving a lone
 * high surrogate at the end. That is not a character: JSON.stringify writes it
 * as a bare `\ud83d`, which is not valid UTF-8, and what Discord does with it
 * is its business rather than something to rely on.
 *
 * Emoji in titles are not an edge case here — stream titles are full of them,
 * and the app puts one in front of every Kick and Twitch name itself.
 *
 * Dropping the orphan rather than widening to include its partner keeps the
 * result inside the caller's limit, which is the whole point of truncating.
 */
function dropLoneSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

/** Returns true if context_name is redundant (same as artist, album, or track name). */
function isRedundantContext(d: TrackData): boolean {
  // Don't skip collection type (Liked Songs) or local files even if context_name is empty
  if (d.context_type === 'collection' || d.is_local) return false;
  // Don't skip if context is explicitly "Local Files" / "Fichiers locaux" playlist
  if (d.context_name?.toLowerCase().includes('local') || d.context_name?.toLowerCase().includes('fichiers')) return false;
  if (!d.context_name) return true;
  const ctx = d.context_name.toLowerCase().trim();
  if (!ctx) return true;
  return ctx === d.artist_name.toLowerCase()
    || ctx === d.album_name?.toLowerCase()
    || ctx === d.track_name.toLowerCase();
}

/** Get display name for context, with fallback for Liked Songs (collection) and Local Files. */
function getContextDisplayName(d: TrackData): string {
  const ctx = d.context_name?.trim();
  if (ctx) return ctx;
  // Fallback: Local files (no Spotify ID) or Local Files playlist
  if (d.is_local || d.context_type === 'local') return 'Local Files';
  // Fallback: Liked Songs has type 'collection' but often no name
  if (d.context_type === 'collection') return 'Liked Songs';
  return '';
}

/**
 * Remove artists from the display string that already appear in the track title.
 * E.g. title="Song (feat. B)" artist="A, B" → "A"
 * Always keeps the primary (first) artist even if it appears in the title.
 */
function deduplicateArtist(trackName: string, artistName: string): string {
  const parts = artistName.split(/,\s*|\s*&\s+/).map(a => a.trim()).filter(Boolean);
  if (parts.length <= 1) return artistName;
  const titleLow = trackName.toLowerCase();
  // Keep primary artist always + others not found in title
  const kept = parts.filter((a, i) => i === 0 || !titleLow.includes(a.toLowerCase()));
  if (kept.length === parts.length) return artistName; // nothing changed
  return kept.join(', ');
}

// ── Status-line templating ──

/** Preset templates behind the dashboard's status-line choices. */
const STATUS_TEMPLATES: Record<string, string> = {
  title:        '{title}',
  title_artist: '{title} - {artist}',
  artist_title: '{artist} - {title}',
  artist:       '{artist}',
  album:        '{album}',
  playlist:     '{playlist}',
};

const RE_STATUS_TOKEN = /\{(\w+)\}/g;
/** Separators left stranded once a leading placeholder resolves to nothing. */
const RE_LEADING_SEP = /^[\s\-–—|·•,:/]+/;

/** Placeholder values for the status line. Lyrics are deliberately not exposed here. */
function statusVars(d: TrackData): Record<string, string> {
  return {
    title:    d.track_name || '',
    artist:   deduplicateArtist(d.track_name, d.artist_name) || '',
    album:    d.album_name || '',
    playlist: getContextDisplayName(d),
    platform: PLATFORM_ICONS[d.media_source || '']?.[1] || '',
  };
}

/**
 * Render a status template, dropping the literal that *precedes* any placeholder
 * resolving to nothing — so "{title} - {artist}" on a track with no artist gives
 * "Title", not "Title - ", and "{a} - {b} - {c}" with an empty middle gives
 * "A - C". A template with no placeholders at all is taken as a literal.
 */
function renderStatusTemplate(tpl: string, vars: Record<string, string>): string {
  let out = '';
  let seen = 0;
  let kept = 0;
  let last = 0;
  let lastWasEmpty = false;
  for (const m of tpl.matchAll(RE_STATUS_TOKEN)) {
    seen++;
    const idx = m.index ?? 0;
    const value = (vars[m[1].toLowerCase()] ?? '').trim();
    if (value) {
      out += tpl.slice(last, idx) + value;
      kept++;
    }
    lastWasEmpty = !value;
    last = idx + m[0].length;
  }
  if (seen === 0) return tpl.trim();
  // The trailing literal belongs to the final placeholder: keeping it after an
  // empty one strands its closing half — "{title} [{lyric}]" would end in "]".
  if (kept > 0 && !lastWasEmpty) out += tpl.slice(last);
  return out.replace(RE_LEADING_SEP, '').trim();
}

/** Build large_text from metadata parts, excluding values already visible in other fields. */
function buildInfoText(d: TrackData, currentText: string, nextText: string): string {
  // Concatenate shown texts once for fast substring check (avoids per-field .some().includes())
  const vis = currentText + '\0' + nextText;
  const displayArtist = deduplicateArtist(d.track_name, d.artist_name);
  const parts: string[] = [];
  if (d.track_name && !vis.includes(d.track_name))   parts.push(`♫${d.track_name}`);
  if (displayArtist && !vis.includes(displayArtist)) parts.push(`🎤${displayArtist}`);
  if (d.album_name && !vis.includes(d.album_name))   parts.push(`💽${d.album_name}`);
  const ctxName = getContextDisplayName(d);
  // Skip context if it matches album name exactly (avoid redundancy)
  const ctxMatchesAlbum = ctxName && d.album_name && ctxName.toLowerCase() === d.album_name.toLowerCase();
  if (ctxName && !ctxMatchesAlbum && !isRedundantContext(d) && !vis.includes(ctxName)) parts.push(`🎼${ctxName}`);
  return truncate(parts.join(' | ') || '  ', 128);
}


// ── Platform-aware search URLs ──

const PLATFORM_SEARCH: Record<string, (q: string) => string> = {
  spotify:        q => `https://open.spotify.com/search/${encodeURIComponent(q)}`,
  apple_music:    q => `https://music.apple.com/search?term=${encodeURIComponent(q)}`,
  deezer:         q => `https://www.deezer.com/search/${encodeURIComponent(q)}`,
  tidal:          q => `https://listen.tidal.com/search?q=${encodeURIComponent(q)}`,
  amazon_music:   q => `https://music.amazon.com/search/${encodeURIComponent(q)}`,
  soundcloud:     q => `https://soundcloud.com/search?q=${encodeURIComponent(q)}`,
  bandcamp:       q => `https://bandcamp.com/search?q=${encodeURIComponent(q)}`,
  youtube_music:  q => `https://music.youtube.com/search?q=${encodeURIComponent(q)}`,
  youtube:         q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  kick:            q => `https://kick.com/search?q=${encodeURIComponent(q)}`,
  twitch:          q => `https://www.twitch.tv/search?q=${encodeURIComponent(q)}`,
  browser_chrome: q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  browser_firefox:q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  browser_edge:   q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  browser_brave:  q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  browser_opera:  q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  browser_vivaldi:q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  browser_zen:    q => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
};

function platformSearchUrl(source: string, query: string): string {
  const builder = PLATFORM_SEARCH[source];
  return builder ? builder(query) : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

const PLATFORM_NAMES: Record<string, string> = {
  spotify: 'Spotify', apple_music: 'Apple Music', deezer: 'Deezer',
  tidal: 'Tidal', amazon_music: 'Amazon Music', soundcloud: 'SoundCloud',
  bandcamp: 'Bandcamp', youtube_music: 'YouTube Music', youtube: 'YouTube', kick: 'Kick', twitch: 'Twitch',
  browser_chrome: 'YouTube', browser_firefox: 'YouTube',
  browser_edge: 'YouTube', browser_brave: 'YouTube', browser_opera: 'YouTube',
};

/** Replace platform name in button label dynamically.
 *  Supports: {platform} template, or auto-detect "Listen on X" / "Search on X" / "Play on X" patterns. */
function platformButtonLabel(label: string, source: string): string {
  const name = PLATFORM_NAMES[source];
  if (!name) return label;
  const isVideo = source === 'youtube' || source === 'youtube_music' || source.startsWith('browser_');
  const verb = isVideo ? 'Watch' : 'Listen';
  // Template: {platform} → resolved name (also swap verb for video platforms)
  if (label.includes('{platform}')) {
    let resolved = label.replace('{platform}', name);
    if (isVideo) resolved = resolved.replace(/\bListen\b/i, 'Watch');
    // Kick: show "📺 Watch on Kick"
    if (source === 'kick') resolved = `📺 Watch on ${name}`;
    // Twitch: show "📺 Watch on Twitch"
    if (source === 'twitch') resolved = `📺 Watch on ${name}`;
    // YouTube: show "📺 Watch on YouTube"
    if (source === 'youtube') resolved = `📺 Watch on ${name}`;
    return resolved;
  }
  // Legacy/auto: "Listen on Spotify" → "Watch on YouTube"
  return label.replace(/(?:Listen|Search|Play|Watch)\s+on\s+\S+/i, `${verb} on ${name}`);
}
