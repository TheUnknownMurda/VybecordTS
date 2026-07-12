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
import { getCachedTranslation, translateText } from '../core/translate.js';
import { evictOldest } from '../core/utils.js';
import type { LyricLine, DiscordActivity, TrackData } from '../core/types.js';

const log = createLogger('LyricsEngine');

// Status message types for unified status system
 type StatusType = 'fetching' | 'found' | 'noLyrics' | 'flagged' | 'disabled';

// ── Timing constants ──
const BASE_OFFSET_MS = 100;       // Compensate for IPC + display delay (fire-and-forget ~10-30ms)
const DRIFT_THRESHOLD_MS = 500;   // Recalibrate if drift > 500ms (tighter sync)
const CC_DRIFT_THRESHOLD_MS = 800; // YouTube CC: tolerate poll jitter, only recalib on real desync
const RECALIB_COOLDOWN_MS = 120_000;  // Max 1 recalibration per 2 minutes (SMTC/desktop)
const CC_RECALIB_COOLDOWN_MS = 10_000; // Push sources (YouTube CC): precise data, allow faster recalib
const MIN_UPDATE_INTERVAL_MS = 800;  // Discord rate-limit protection (~6 updates/5s)
const CC_UPDATE_INTERVAL_MS = 250;   // Fast updates for YouTube CC (lines change every 200-500ms)
const RPC_HEARTBEAT_MS = 5_000;      // Force RPC push every 5s even if text unchanged (keeps Discord UI fresh)
const EMA_ALPHA = 0.3;            // Exponential moving average weight for latency
const LYRIC_GAP_MS = 10_000;      // Switch to no-lyrics RPC display during gaps longer than this

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

  // Legacy flags for backward compatibility during transition
  private fetchingLyrics = false;
  private noLyricsFound = false;
  private lyricsFound = false;
  private lyricsFlagged = false;
  private lyricsDisabled = false;

  // Instrumental gap: switch RPC to no-lyrics display when gap between lines > LYRIC_GAP_MS
  private inLyricGap = false;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // CC-sourced lyrics use faster update interval
  private isCC = false;
  private isPushSource = false; // Push-based sources (YouTube, SC, BC, Spicetify) → shorter recalib cooldown
  private lastRecalibTime = 0;

  // Auto-offset detection: compensates for systematically early/late lyrics
  private autoOffsetMs = 0;

  // Random icon mode: icon picked once per track
  private randomIconPick: [string, string] | null = null;

  // Pre-computed repeat group table (built once per lyrics load, O(1) lookups on emit)
  private groupStart: Int32Array = new Int32Array(0);  // groupStart[i] = first index of the group containing i
  private groupEnd: Int32Array = new Int32Array(0);    // groupEnd[i] = last index of the group containing i
  private groupDisplay: string[] = [];                 // groupDisplay[i] = display text for line i (with xN suffix)

  // Romanization cache: avoids re-computing romanize() for the same lyric text
  private romanizeCache = new Map<string, string>();

  // Cached config flags (rebuilt on config change, avoid per-emit boolean casts)
  private cfgShowLyrics = true;
  private cfgRomanize = false;
  private cfgActivityType = 2;
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

    // Sync legacy flags for backward compatibility
    this.fetchingLyrics = type === 'fetching';
    this.noLyricsFound = type === 'noLyrics';
    this.lyricsFound = type === 'found';
    this.lyricsFlagged = type === 'flagged';
    this.lyricsDisabled = type === 'disabled';

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
    // Reset legacy flags
    this.fetchingLyrics = false;
    this.noLyricsFound = false;
    this.lyricsFound = false;
    this.lyricsFlagged = false;
    this.lyricsDisabled = false;
    this.emitUpdate();
  }

  /** Show "Fetching Lyrics..." in RPC state while lyrics are loading. */
  setFetchingLyrics(fetching: boolean): void {
    if (fetching) {
      if (!this.cfgShowLyrics) return; // Don't show when lyrics are disabled
      this.setStatusMessage('fetching', '🔍 Fetching Lyrics...', 10, 30000); // 30s max timeout
    } else {
      // Only clear if we're still showing fetching
      if (this.statusMessage?.type === 'fetching') {
        this.clearStatusMessage();
      }
      this.fetchingLyrics = false;
    }
  }

  /** Flash "🚩 Lyrics Not Matching" for 5s when the user flags bad lyrics. */
  setLyricsFlagged(): void {
    // Clear lyrics first so they stop displaying before the message appears
    this.lyrics = [];
    this.currentIdx = -1;
    this.setStatusMessage('flagged', '🚩 Lyrics Not Matching', 40, 5000);
  }

  /** Flash "🚫 Lyrics Disabled" for 7s when lyrics are toggled off, then show normal metadata. */
  setLyricsDisabled(): void {
    this.setStatusMessage('disabled', '🚫 Lyrics Disabled', 50, 7000);
  }

  /** Flash "No Lyrics Found" for 5 seconds, then revert to normal display. */
  setNoLyricsFound(): void {
    // Disabled - do not show "No Lyrics Found" message
    return;
  }

  /** Flash "Lyrics Found" for 5 seconds. */
  private setLyricsFound(): void {
    if (!this.cfgShowLyrics) return; // Don't show when lyrics are disabled
    this.setStatusMessage('found', '✅ Lyrics Found', 20, 5000);
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
    this.fetchingLyrics = false;

    // Rebuild buttons when CC state changed (e.g. "Listen on Spotify" → "Watch on YouTube")
    if (this.isCC !== wasCC && this.trackData) {
      this.rebuildButtons(this.trackData, this.trackData.media_source || 'spotify');
    }

    // Position within the lyrics using current elapsed time
    const baseMs = this.isCC ? 50 : BASE_OFFSET_MS;
    const offset = baseMs + this.measuredLatencyMs + this.getTotalOffsetMs();
    this.currentIdx = findLyricIndex(lyrics, this.getElapsedMs() + offset);

    // If lyrics haven't started yet, flash "Lyrics Found" for 5 seconds
    // If lyrics are already in progress, skip the message entirely
    // Don't show when lyrics are disabled
    const lyricsNotStarted = lyrics.length > 0 && (this.currentIdx < 0 || !this.lyrics[this.currentIdx]?.text);
    if (lyricsNotStarted && this.cfgShowLyrics) {
      this.setLyricsFound();
    }

    // Reset dedup so the first lyric pushes immediately
    this.lastRpcDetails = '';
    this.lastRpcState = '';
    this.lastRpcIdx = -1;
    this.lastUpdateTime = 0;
    this.lastEmittedIdx = -1;

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

    // Detect album art change (enrichment arrived via poll merge)
    const artChanged = trackData && this.trackData &&
      trackData.album_art_url !== this.trackData.album_art_url;

    // Detect shuffle/repeat mode change
    const modeChanged = trackData && this.trackData &&
      (trackData.is_shuffle !== this.trackData.is_shuffle ||
       trackData.repeat_mode !== this.trackData.repeat_mode);

    if (trackData) {
      // Preserve Catbox URL if current track has one and new trackData doesn't
      const currentCatboxUrl = this.trackData?.album_art_url?.includes('catbox.moe') ? this.trackData.album_art_url : null;
      if (currentCatboxUrl && !trackData.album_art_url?.includes('catbox.moe')) {
        trackData.album_art_url = currentCatboxUrl;
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

    // Desktop/SMTC sources: cooldown to prevent poll-burst cascades
    const cooldown = RECALIB_COOLDOWN_MS;
    if (drift > threshold && now - this.lastRecalibTime >= cooldown) {
      const direction = currentElapsed > progressMs ? 'AHEAD' : 'BEHIND';
      const sinceLast = (now - this.lastRecalibTime) / 1000;
      log.info(`[DRIFT] ${drift.toFixed(0)}ms ${direction} (engine=${currentElapsed.toFixed(0)} vs player=${progressMs}) after ${sinceLast.toFixed(1)}s — recalibrating`);
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
        // If >10s until track ends, switch to no-lyrics display during the outro
        if (remaining > LYRIC_GAP_MS) {
          this.gapTimer = setTimeout(() => {
            if (!this.running) return;
            this.inLyricGap = true;
            this.resetDedup();
            this.emitUpdate();
          }, LYRIC_GAP_MS);
        }
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
      this.groupEnd = new Int32Array(0);
      this.groupDisplay = [];
      return;
    }
    const gs = new Int32Array(n);
    const ge = new Int32Array(n);
    const gd: string[] = new Array(n);

    let i = 0;
    while (i < n) {
      const text = this.lyrics[i].text;
      let j = i + 1;
      while (j < n && this.lyrics[j].text === text) j++;
      const count = j - i;
      for (let k = i; k < j; k++) {
        gs[k] = i;
        ge[k] = j - 1;
        const remaining = j - k;
        gd[k] = !text ? '♪♪' : (count > 1 && remaining > 1 ? `${text} (x${remaining})` : text);
      }
      i = j;
    }
    this.groupStart = gs;
    this.groupEnd = ge;
    this.groupDisplay = gd;
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

  private getNextGroupStart(idx: number): number {
    if (idx < 0 || idx >= this.groupEnd.length) return -1;
    const end = this.groupEnd[idx] + 1;
    return end < this.lyrics.length ? end : -1;
  }

  /** Emit the current lyric state to callbacks. */
  private emitUpdate(): void {
    if (!this.callbacks || !this.trackData) return;

    // Build display text with consecutive repeat collapsing
    let current: string;
    let next: string;
    let prev: string;
    if (!this.lyrics.length) {
      current = '♪♪';
      next = '';
      prev = '';
    } else if (this.currentIdx < 0) {
      current = '♪♪';
      next = this.getDisplayText(0);
      prev = '';
    } else {
      current = this.getDisplayText(this.currentIdx);
      const nextGroupIdx = this.getNextGroupStart(this.currentIdx);
      next = nextGroupIdx >= 0 ? this.getDisplayText(nextGroupIdx) : '';
      const prevGroupIdx = this.getPrevGroupEnd(this.currentIdx);
      prev = prevGroupIdx >= 0 ? this.getDisplayText(prevGroupIdx) : '';

      // Add music notes for Spotify and SoundCloud
      const source = this.trackData?.media_source || '';
      if (source === 'spotify' || source === 'soundcloud') {
        if (current && current !== '♪♪') {
          current = '♪ ' + current;
        }
        if (next && next !== '♪♪') {
          next = next + ' ♪';
        }
        // Add music note at the end of the last lyric line
        if (this.currentIdx === this.lyrics.length - 1 && current && current !== '♪♪') {
          current = current + ' ♪';
        }
      }
    }

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

    // CRITICAL ORDER: RPC first (latency-sensitive), then SSE (latency-tolerant).
    // Build and emit full RPC activity before onLyricChange triggers EventEmitter + SSE.
    const activity = this.buildActivity(current, next);
    if (activity) {
      this.callbacks.onRpcUpdate(activity);
    }

    // SSE broadcast + dashboard update (non-blocking, latency-tolerant)
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
    // Use platform-specific large image if available (e.g., Kick uses kicklogo.png asset)
    const platformLargeImage = PLATFORM_LARGE_IMAGES[source];
    this.cachedLargeImage = platformLargeImage || art || DEFAULT_ART;

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
    const activityType = this.cfgActivityType;

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
      let cur = this.cfgRomanize ? this.cachedRomanize(currentText) : currentText;
      let nxt = this.cfgRomanize && nextText ? this.cachedRomanize(nextText) : nextText;

      // RPC translate mode: use cached translations, fire async for misses
      if (this.cfgRpcTranslate && this.cfgTranslateLang) {
        const lang = this.cfgTranslateLang;
        const tCur = getCachedTranslation(cur, lang);
        if (tCur) cur = tCur;
        else translateText(cur, lang).catch(() => {});
        if (nxt) {
          const tNxt = getCachedTranslation(nxt, lang);
          if (tNxt) nxt = tNxt;
          else translateText(nxt, lang).catch(() => {});
        }
        // Look-ahead: pre-translate upcoming lines so they're cached before display
        const idx = this.currentIdx;
        if (idx >= 0) {
          for (let i = 2; i <= 6 && idx + i < this.lyrics.length; i++) {
            const txt = this.lyrics[idx + i]?.text;
            if (txt && txt.length >= 2 && !getCachedTranslation(txt, lang)) {
              translateText(txt, lang).catch(() => {});
            }
          }
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

    const activity: DiscordActivity = {
      type: activityType,
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
  if (text.length <= max) return text;
  // For very short limits, just cut and add ellipsis
  if (max <= 10) return text.slice(0, max - 3) + '...';
  // For longer limits, try to preserve whole words
  const cut = text.slice(0, max - 3);
  const lastSpace = cut.lastIndexOf(' ');
  const lastPunct = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf(','), cut.lastIndexOf(';'), cut.lastIndexOf(':'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
  const boundary = Math.max(lastSpace, lastPunct);
  const trimmed = boundary > max * 0.7 ? cut.slice(0, boundary) : cut.trim();
  return trimmed + '...';
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
