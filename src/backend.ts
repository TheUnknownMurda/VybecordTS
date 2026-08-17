/**
 * VybecordBackend — main orchestrator.
 *
 * Track sources, in priority order:
 *   1. SpicetifySource (push) → Spicetify extension posts real-time Spotify data
 *      - Event-driven (instant), full metadata, album art CDN, accurate progress,
 *        playlist context, shuffle/repeat — none of which needs a Spotify API key
 *   2. Browser userscripts (push) → YouTube, SoundCloud, Bandcamp, Twitch, Kick
 *   3. DesktopSource (SMTC) → anything else with a Windows media session
 *
 * There is no Spotify Web API path: the Spicetify extension supersedes it and
 * needs no developer application, client secret or OAuth round-trip.
 * Push sources need no startup step — they activate on their first POST.
 *
 * Flow:
 *   1. Start SMTC (Windows only; its absence is non-fatal)
 *   2. Connect to Discord IPC
 *   3. Poll the active source every N ms for the current track
 *   4. On new track → fetch lyrics (local DB → LRCLib/Netease/Musixmatch race)
 *   5. Feed lyrics to LyricsEngine → precise setTimeout scheduling → RPC updates
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createLogger } from './core/logger.js';
import { ConfigManager, sanitizeConfigUpdate } from './core/config.js';
import { DesktopSource } from './core/desktop-source.js';
import { SpicetifySource, type SpicetifyPayload } from './core/spicetify-source.js';
import { YouTubeSource, type YouTubePayload } from './core/youtube-source.js';
import { SoundCloudSource, type SoundCloudPayload } from './core/soundcloud-source.js';
import { BandcampSource, type BandcampPayload } from './core/bandcamp-source.js';
import { KickSource, type KickPayload } from './core/kick-source.js';
import { TwitchSource, type TwitchPayload } from './core/twitch-source.js';
import { DiscordIPC } from './core/discord-ipc.js';
import { LyricsEngine } from './sync/lyrics-engine.js';
import { fetchLyrics, fetchPlainLyrics } from './core/provider.js';
import { fetchYouTubeCaptions, clearCCCache } from './core/youtube-captions.js';
import { initLocalDb, closeLocalDb, insertCustomLyrics, listCustomLyrics, getCustomLyrics, updateCustomLyrics, deleteCustomLyrics, findExistingCustomLyrics, searchLrclibDump as searchLrclibDumpDb, getLrclibTrackLyrics as getLrclibTrackLyricsDb } from './core/local-lyrics-db.js';
import { initLastFm, scrobbleTrackStart, checkAndScrobble, scrobbleTrackEnd } from './core/lastfm.js';
import { uploadThumbForRpc } from './core/image-upload.js';
import { extractLocalArt, extractArtFromPath } from './core/local-art.js';
import { initBlacklist, flagLyrics, isLyricsFlagged, clearFlags, listFlaggedTracks, clearFlagsByKey } from './core/lyrics-blacklist.js';
import { initHistory, historyTrackStart, historyTrackEnd, getRecentHistory, getHistoryCount, getWrappedStats } from './core/listening-history.js';
import { translateBatch } from './core/translate.js';
import { evictOldest, evictUntil } from './core/utils.js';
import type { TrackData, LyricLine, VybecordConfig } from './core/types.js';

const log = createLogger('Backend');

// ── Stats history (persisted across sessions) ──
const MAX_HISTORY_SESSIONS = 10;
interface SessionSnapshot {
  date: string;  // ISO date string
  topTracks: { name: string; artist: string; art: string; plays: number }[];
  topArtists: { name: string; art: string; artist_art: string; plays: number }[];
}

// ── Module-level constants (avoid re-creating on every 400ms poll) ──
const MUSIC_APPS = new Set(['spotify', 'apple_music', 'deezer', 'tidal', 'amazon_music']);
const WEB_SOURCES = ['browser_', 'soundcloud', 'bandcamp', 'youtube'];
const VIDEO_SOURCES = ['browser_', 'youtube'];
const ARTIST_SPLIT_RE = /[,]/;  // Precompiled — used in recordPlay + artist key extraction

/**
 * Discord App ID used when the user has not configured one.
 * A distributed .exe ships without an `.env`, so without this fallback the app
 * could not start at all on someone else's machine. An application ID is public
 * information (Discord sends it to every client that sees the presence), unlike
 * a client secret — same reasoning as the platform IDs below.
 * Override it with `discord_app_id` in config.json or DISCORD_CLIENT_ID in .env.
 */
const DEFAULT_DISCORD_APP_ID = '1396531182426128394';

// Platform-specific Discord App IDs (changes the app name shown in Discord)
const PLATFORM_DISCORD_APP_IDS: Record<string, string> = {
  spotify: '1513867708851294299',
  youtube: '1513868157897412759',
  youtube_music: '1513868157897412759',
  soundcloud: '1513868059948093501',
  apple_music: '1530715817334018189',
  kick: '1519781115144044636',
  twitch: '1489626057588998164',
  // Default falls back to config discord_app_id or env DISCORD_CLIENT_ID
};

/** Map a media_source string to its per-platform config key. */
function platformConfigKey(src: string): keyof import('./core/types.js').VybecordConfig | null {
  if (src === 'spotify') return 'detect_spotify';
  if (src === 'youtube' || src === 'youtube_music') return 'detect_youtube';
  if (src === 'soundcloud') return 'detect_soundcloud';
  if (src === 'apple_music') return 'detect_apple_music';
  if (src === 'kick') return 'detect_kick';
  if (src === 'twitch') return 'detect_twitch';
  if (src === 'bandcamp' || src === 'deezer' || src === 'tidal' || src === 'amazon_music') return 'detect_other_apps';
  if (src.startsWith('browser_') || src === 'unknown') return 'detect_browser';
  return null; // unknown — allow by default
}

export class VybecordBackend extends EventEmitter {
  private config: ConfigManager;
  private desktop: DesktopSource | null = null;
  private spicetify: SpicetifySource;
  private youtubeSource: YouTubeSource;
  private soundcloudSource: SoundCloudSource;
  private bandcampSource: BandcampSource;
  private kickSource: KickSource;
  private twitchSource: TwitchSource;
  private discord: DiscordIPC;
  private lyricsEngine: LyricsEngine;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;  // re-entrance guard for the async poll() (see poll())
  private currentTrack: TrackData | null = null;
  private currentTrackKey = '';
  private currentCacheKey = '';
  private lyricsCache = new Map<string, LyricLine[]>();
  private lastLyricsState: { current: string; next: string; prev: string; progress_ms: number; duration_ms: number } | null = null;
  private spotifyLyricsStore = new Map<string, LyricLine[]>();  // track_id → synced lyrics from Spotify Web
  private fetchAbort: AbortController | null = null;  // cancel in-flight fetches on track skip
  private shuttingDown = false;
  private idleSince = 0;  // grace period timestamp (prevent SMTC flicker)
  private configDir: string;
  private cachedIsWebSource = false;  // cached per-track: avoids WEB_SOURCES.some() on every 400ms poll
  private currentDiscordAppId = '';  // tracks current Discord App ID for platform-specific switching

  // Session stats (reset on app restart)
  private sessionTrackPlays = new Map<string, { name: string; artist: string; art: string; count: number }>();
  private sessionArtistPlays = new Map<string, { name: string; art: string; artist_art: string; count: number }>();
  private cachedStats: { topTracks: any[]; topArtists: any[] } | null = null;
  private statsDirty = true;
  private _lastCcLang: string | undefined;
  private statsHistory: SessionSnapshot[] = [];
  private statsHistoryPath: string;

  constructor(configDir: string) {
    super();
    this.configDir = configDir;
    this.statsHistoryPath = path.join(configDir, 'stats-history.json');
    this.statsHistory = this.loadStatsHistory();
    this.config = new ConfigManager(configDir, (cfg) => {
      log.info('Config changed — will apply on next poll');
      // Clear CC cache when language changes so new language takes effect immediately
      if (this._lastCcLang !== undefined && this._lastCcLang !== cfg.cc_lang) {
        clearCCCache();
        log.info(`CC language changed: ${this._lastCcLang} → ${cfg.cc_lang}`);
      }
      this._lastCcLang = cfg.cc_lang;
      this.emit('configUpdate', cfg);
    });

    const discordAppId = this.config.get('discord_app_id')
      || process.env.DISCORD_CLIENT_ID
      || DEFAULT_DISCORD_APP_ID;

    this.discord = new DiscordIPC(discordAppId);
    this.currentDiscordAppId = discordAppId; // Track current App ID for platform switching
    this.lyricsEngine = new LyricsEngine();
    this.spicetify = new SpicetifySource();
    this.youtubeSource = new YouTubeSource();
    this.soundcloudSource = new SoundCloudSource();
    this.bandcampSource = new BandcampSource();
    this.kickSource = new KickSource();
    this.twitchSource = new TwitchSource();

    // Wire lyrics engine callbacks
    this.wireEngineCallbacks();

    // React to config toggles in real-time
    this.on('configUpdate', (cfg) => {
      // Emit status update for dashboard (showLyrics badge, etc.)
      this.emitStatus();

      if (!this.discord.isConnected) return;

      if (!cfg.rpc_enabled) {
        // RPC disabled → clear everything
        this.discord.clearActivity().catch(() => {});
      } else if (!this.currentTrack) {
        // No music playing → apply idle preference immediately
        if (cfg.rpc_only_when_playing) {
          this.discord.clearActivity().catch(() => {});
        } else {
          this.setIdlePresence();
        }
      } else {
        // Track is playing → restart lyrics engine with new config
        // (handles show_lyrics toggle, template changes, button changes, etc.)
        const rpcConfig = this.getRpcConfig();
        const cachedLyrics = this.lyricsCache.get(this.currentCacheKey);
        if (!cachedLyrics) {
          // Lyrics never fetched for this track — trigger a full fetch
          this.onNewTrack(this.currentTrack).catch(() => {});
        } else {
          this.lyricsEngine.startTrack(cachedLyrics, this.currentTrack, rpcConfig);

          // Re-translate lyrics for RPC when language/toggle changes
          if (cfg.rpc_translate_lyrics && cachedLyrics.length > 0) {
            const tgtLang = (cfg.translate_target_lang as string) || 'en';
            const lines = cachedLyrics.map((l: LyricLine) => l.text).filter((t: string) => t && t.trim().length >= 2);
            translateBatch(lines, tgtLang).catch(() => {});
          }
        }
      }
    });
  }

  async start(): Promise<void> {
    log.info('VybecordTS starting...');

    // 0. Init optional enhancements
    let localDbInitialized = false;
    try {
      localDbInitialized = await Promise.race([
        initLocalDb(this.configDir, this.config.get('lrclib_dump_path')),
        new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('Database initialization timeout (30s)')), 30000))
      ]);
    } catch (e) {
      log.error(`Local database initialization failed: ${e}`);
      log.error('Imported lyrics will not be available. Run: npm rebuild better-sqlite3');
    }

    if (localDbInitialized) {
      log.info('Local lyrics database initialized successfully');
    }

    initLastFm(
      (this.config.getAll().lastfm_api_key as string | undefined) || process.env.LASTFM_API_KEY,
      (this.config.getAll().lastfm_api_secret as string | undefined) || process.env.LASTFM_API_SECRET,
      this.configDir,
    );

    const blacklistInitialized = initBlacklist(this.configDir);
    if (blacklistInitialized) {
      log.info('Lyrics blacklist initialized successfully');
    } else {
      log.warn('Lyrics blacklist initialization failed - flagged lyrics will not work');
    }

    initHistory(this.configDir);

    // 1. Start the desktop (SMTC) source. Push sources — Spicetify and the
    //    browser userscripts — need no startup step: they activate on first push.
    //    SMTC is Windows-only, and its absence is not fatal: everything the push
    //    sources cover keeps working without it.
    try {
      this.startDesktopSource();
    } catch (e) {
      log.warn(`Desktop SMTC source unavailable: ${e}`);
      log.warn('Only push sources (Spicetify extension, browser userscripts) will be detected.');
    }

    // 2. Discord RPC connect (with retry)
    this.wireDiscordHandlers();

    // Connect in background (don't block startup)
    this.discord.connectWithRetry().catch(e => {
      log.error(`Discord connection failed: ${e}`);
    });

    // 3. Start polling
    const interval = this.config.get('poll_interval_ms') || 1500;
    log.info(`Starting polling (every ${interval}ms)`);
    this.pollTimer = setInterval(() => this.poll(), interval);

    // Immediate first poll
    this.poll();
  }

  // ── Track source ──

  private startDesktopSource(): void {
    if (process.platform !== 'win32') {
      log.error('SMTC desktop source is only available on Windows.');
      log.error('On other platforms, use the Spicetify extension or the browser userscripts.');
      throw new Error('SMTC requires Windows — use the Spicetify extension or userscripts elsewhere');
    }
    this.desktop = new DesktopSource();
    this.desktop.start();
    log.info('Desktop SMTC source started ✓');
  }

  // ── Spicetify push handler (event-driven, called by web server) ──

  handleSpicetifyPush(data: SpicetifyPayload): void {
    log.debug(`[SPICETIFY-PUSH] track="${data.track_name}" album="${data.album_name}" context="${data.context_name}" ctx_type="${data.context_type}" shuffle=${data.is_shuffle} repeat=${data.repeat_mode}`);
    this.spicetify.update(data);

    if (!this.config.get('detect_spotify')) return;

    if (!data.is_playing) {
      // Paused via Spicetify — clear immediately (push is authoritative, no grace period needed)
      this.onTrackStopped();
      return;
    }

    const track = this.spicetify.getCurrentTrack();
    if (!track) return;

    this.idleSince = 0;
    const trackKey = this.buildTrackKey(track);

    if (trackKey === this.currentTrackKey) {
      log.debug(`[SPOTIFY] Same track detected: ${track.track_name} — ${track.artist_name} (key: ${trackKey})`);
      // Same track — sync progress to lyrics engine (instant, no poll delay)
      if (this.checkRepeatLoop(track)) return;

      // Engine stopped (track duration reached) but same track still playing → repeat loop restart
      if (!this.lyricsEngine.isRunning() && track.progress_ms < 5000) {
        log.info(`[REPEAT] Engine stopped but track restarted (progress=${track.progress_ms}ms) — re-starting`);
        this.currentTrack = track;
        this.recordPlay(track);
        this.emit('trackUpdate', track);
        this.onNewTrack(track).catch(e => log.error(`[REPEAT] Error: ${e}`));
        return;
      }

      this.syncTrackProgress(track, true);
      // Update artist image if it arrived asynchronously (Tampermonkey fetches after first push)
      if (track.artist_art_url) {
        const primaryArtist = track.artist_name.split(ARTIST_SPLIT_RE)[0].trim().toLowerCase();
        const aEntry = this.sessionArtistPlays.get(primaryArtist);
        if (aEntry && !aEntry.artist_art) {
          aEntry.artist_art = track.artist_art_url;
          this.statsDirty = true;
          this.emit('statsUpdate', this.getSessionStats());
        }
      }
      return;
    }

    // New track detected — instant response (no 3s poll delay!)
    this.currentTrackKey = trackKey;
    this.currentTrack = track;
    this.cachedIsWebSource = false; // Spicetify is Spotify — never a web source
    log.info(`[NEW TRACK] ${track.track_name} — ${track.artist_name} (spicetify)${track.is_local ? ' [local]' : ''}${track.context_name ? ` [${track.context_name}]` : ''}`);
    this.recordPlay(track);
    this.emit('trackUpdate', track);
    this.onNewTrack(track).catch(e => log.error(`[NEW TRACK] Error: ${e}`));
  }

  // ── YouTube push handler (event-driven, called by web server) ──

  handleYouTubePush(data: YouTubePayload): void {
    this.youtubeSource.update(data);

    if (!this.config.get('detect_youtube')) return;

    if (!data.is_playing) {
      // Paused via userscript — clear immediately (push is authoritative)
      if (this.currentTrack?.media_source === 'youtube' || this.currentTrack?.media_source === 'youtube_music') {
        this.onTrackStopped();
      }
      return;
    }

    const track = this.youtubeSource.getCurrentTrack();
    if (!track) return;

    this.idleSince = 0;
    const trackKey = this.buildTrackKey(track);

    if (trackKey === this.currentTrackKey) {
      log.debug(`[YOUTUBE] Same track detected: ${track.track_name} — ${track.artist_name} (key: ${trackKey})`);
      // Same track — update to ensure stream_start_time_ms is passed to lyrics-engine
      this.currentTrack = track;
      if (this.checkRepeatLoop(track)) return;
      // For live streams, force syncProgress to update trackData with stream_start_time_ms
      if (track.is_live) {
        this.lyricsEngine.syncProgress(track.progress_ms, track);
      } else {
        this.syncTrackProgress(track);
      }
      return;
    }

    // New video detected — instant response
    this.currentTrackKey = trackKey;
    this.currentTrack = track;
    this.cachedIsWebSource = true; // YouTube is a web source
    log.info(`[NEW TRACK] ${track.track_name} — ${track.artist_name} (youtube-userscript)`);
    this.recordPlay(track);
    this.emit('trackUpdate', track);
    this.onNewTrack(track).catch(e => log.error(`[NEW TRACK] Error: ${e}`));
  }

  isYouTubeSourceActive(): boolean { return this.youtubeSource.isActive; }

  // ── SoundCloud push handler (event-driven, called by web server) ──

  handleSoundCloudPush(data: SoundCloudPayload): void {
    this.soundcloudSource.update(data);

    if (!this.config.get('detect_soundcloud')) return;

    if (!data.is_playing) {
      if (this.currentTrackKey.startsWith('sc:')) this.onTrackStopped();
      return;
    }

    const track = this.soundcloudSource.getCurrentTrack();
    if (!track) return;

    this.idleSince = 0;
    const trackKey = this.buildTrackKey(track);

    if (trackKey === this.currentTrackKey) {
      log.debug(`[SOUNDCLOUD] Same track detected: ${track.track_name} — ${track.artist_name} (key: ${trackKey})`);
      // Same track — sync progress
      if (this.checkRepeatLoop(track)) return;
      this.syncTrackProgress(track);
      return;
    }

    // New track detected
    this.currentTrackKey = trackKey;
    this.currentTrack = track;
    this.cachedIsWebSource = true; // SoundCloud is a web source
    log.info(`[NEW TRACK] ${track.track_name} — ${track.artist_name} (soundcloud-userscript)`);
    this.recordPlay(track);
    this.emit('trackUpdate', track);
    this.onNewTrack(track).catch(e => log.error(`[NEW TRACK] Error: ${e}`));
  }

  isSoundCloudSourceActive(): boolean { return this.soundcloudSource.isActive; }

  // ── Bandcamp push handler (event-driven, called by web server) ──

  handleBandcampPush(data: BandcampPayload): void {
    this.bandcampSource.update(data);

    if (this.config.get('detect_other_apps') === false) return;

    if (!data.is_playing) {
      if (this.currentTrackKey.startsWith('bc:')) this.onTrackStopped();
      return;
    }

    const track = this.bandcampSource.getCurrentTrack();
    if (!track) return;

    this.idleSince = 0;
    const trackKey = this.buildTrackKey(track);

    if (trackKey === this.currentTrackKey) {
      log.debug(`[BANDCAMP] Same track detected: ${track.track_name} — ${track.artist_name} (key: ${trackKey})`);
      // Same track — sync progress
      if (this.checkRepeatLoop(track)) return;
      this.syncTrackProgress(track, true);
      return;
    }

    // New track detected
    this.currentTrackKey = trackKey;
    this.currentTrack = track;
    this.cachedIsWebSource = true; // Bandcamp is a web source
    log.info(`[NEW TRACK] ${track.track_name} — ${track.artist_name} (bandcamp-userscript)`);
    this.recordPlay(track);
    this.emit('trackUpdate', track);
    this.onNewTrack(track).catch(e => log.error(`[NEW TRACK] Error: ${e}`));
  }

  isBandcampSourceActive(): boolean { return this.bandcampSource.isActive; }

  // ── Kick push handler (event-driven, called by web server) ──

  handleKickPush(data: KickPayload): void {
    this.kickSource.update(data);

    if (this.config.get('detect_kick') === false) return;

    if (!data.is_live) {
      if (this.currentTrackKey.startsWith('kick:')) this.onTrackStopped();
      return;
    }

    const track = this.kickSource.getCurrentTrack();
    if (!track) return;

    this.idleSince = 0;
    const trackKey = this.buildTrackKey(track);

    if (trackKey === this.currentTrackKey) {
      log.debug(`[KICK] Same stream detected: ${track.track_name} — ${track.artist_name} (key: ${trackKey})`);
      // Same stream — update track to ensure stream_start_time_ms is passed to lyrics-engine
      this.currentTrack = track;
      // Force syncProgress to update trackData in lyrics-engine (even for live streams)
      this.lyricsEngine.syncProgress(track.progress_ms, track);
      return;
    }

    // New stream detected
    this.currentTrackKey = trackKey;
    this.currentTrack = track;
    this.cachedIsWebSource = true; // Kick is a web source
    log.info(`[NEW TRACK] ${track.track_name} — ${track.artist_name} (kick-userscript)`);
    this.recordPlay(track);
    this.emit('trackUpdate', track);
    this.onNewTrack(track).catch(e => log.error(`[NEW TRACK] Error: ${e}`));
  }

  isKickSourceActive(): boolean { return this.kickSource.isActive; }

  // ── Twitch push handler (event-driven, called by web server) ──

  handleTwitchPush(data: TwitchPayload): void {
    this.twitchSource.update(data);

    if (this.config.get('detect_twitch') === false) return;

    if (!data.is_live) {
      if (this.currentTrackKey.startsWith('twitch:')) this.onTrackStopped();
      return;
    }

    const track = this.twitchSource.getCurrentTrack();
    if (!track) return;

    this.idleSince = 0;
    const trackKey = this.buildTrackKey(track);

    if (trackKey === this.currentTrackKey) {
      log.debug(`[TWITCH] Same stream detected: ${track.track_name} — ${track.artist_name} (key: ${trackKey})`);
      // Same stream — update track to ensure stream_start_time_ms is passed to lyrics-engine
      this.currentTrack = track;
      // Force syncProgress to update trackData in lyrics-engine (even for live streams)
      this.lyricsEngine.syncProgress(track.progress_ms, track);
      return;
    }

    // New stream detected
    this.currentTrackKey = trackKey;
    this.currentTrack = track;
    this.cachedIsWebSource = true; // Twitch is a web source
    log.info(`[NEW TRACK] ${track.track_name} — ${track.artist_name} (twitch-userscript)`);
    this.recordPlay(track);
    this.emit('trackUpdate', track);
    this.onNewTrack(track).catch(e => log.error(`[NEW TRACK] Error: ${e}`));
  }

  isTwitchSourceActive(): boolean { return this.twitchSource.isActive; }

  // ── Spotify Web lyrics handler (event-driven, called by web server) ──

  handleSpotifyLyrics(data: { track_id: string; lines: { time: number; text: string }[] }): void {
    if (!data.track_id || !Array.isArray(data.lines)) return;

    // Convert to LyricLine format
    const lines: LyricLine[] = data.lines
      .filter(l => l.text && l.text.trim())
      .map(l => ({ time: l.time, text: l.text.trim() }));

    // Store for later lookup (onNewTrack will check this)
    this.spotifyLyricsStore.set(data.track_id, lines);
    evictOldest(this.spotifyLyricsStore, 10);

    log.info(`[SPOTIFY-LYRICS] Received ${lines.length} lines for track ${data.track_id}`);

    // Hot-inject if this is the currently playing track
    if (this.currentTrack && lines.length > 0) {
      const currentId = this.currentTrack.track_id;
      const spotifyId = data.track_id;
      // Direct match (track_id identical) or Spicetify key starts with the Spotify ID
      const directMatch = currentId === spotifyId || this.currentTrackKey.startsWith(spotifyId + '|');
      // Fallback: SMTC track (desktop: prefix) — match by name similarity
      const nameMatch = !directMatch && currentId.startsWith('desktop:') &&
        currentId.toLowerCase().includes(this.currentTrack.track_name.toLowerCase().slice(0, 20));
      if (directMatch || nameMatch) {
        const cacheKey = this.currentCacheKey;
        this.lyricsCache.set(cacheKey, lines);
        this.lyricsEngine.injectLyrics(lines, this.currentTrack);
        log.info(`[SPOTIFY-LYRICS] Hot-injected ${lines.length} official lyrics for current track (${directMatch ? 'id' : 'name'} match)`);
      }
    }
  }

  // ── Polling (supports Premium API, Spicetify, & Free SMTC) ──

  /**
   * Declarative source table used by poll() to iterate push-based sources.
   * Each entry describes a single web source: how to detect it, how to get
   * its track, the config gate, and the key-prefix for paused-stop detection.
   * The order matters: higher-priority sources are checked first.
   */
  private readonly pollSources: {
    source: { readonly isActive: boolean; readonly isPaused: boolean; getCurrentTrack(): TrackData | null };
    configKey: keyof VybecordConfig;
    keyPrefix: string;
    isLive?: boolean;  // live-stream sources skip checkRepeatLoop
    scrobble?: boolean; // track scrobble eligibility
  }[] = [];

  /** Initialised lazily because the sources are set in the constructor body. */
  private ensurePollSources(): void {
    if (this.pollSources.length) return;
    this.pollSources.push(
      { source: this.youtubeSource,    configKey: 'detect_youtube',     keyPrefix: 'yt:' },
      { source: this.soundcloudSource, configKey: 'detect_soundcloud',  keyPrefix: 'sc:' },
      { source: this.bandcampSource,   configKey: 'detect_other_apps',  keyPrefix: 'bc:',     scrobble: true },
      { source: this.kickSource,       configKey: 'detect_kick',        keyPrefix: 'kick:',   isLive: true },
      { source: this.twitchSource,     configKey: 'detect_twitch',      keyPrefix: 'twitch:', isLive: true },
    );
  }

  /**
   * Try each push-based web source in priority order.
   * Returns `true` if a source claimed the poll tick (either because it's
   * actively playing or because its paused state stopped the current track).
   */
  private pollWebSources(): boolean {
    for (const { source, configKey, keyPrefix, isLive, scrobble } of this.pollSources) {
      if (!source.isActive || this.config.get(configKey) === false) continue;
      const track = source.getCurrentTrack();
      if (track) {
        const trackKey = this.buildTrackKey(track);
        if (trackKey === this.currentTrackKey) {
          if (isLive) {
            // Live streams: update trackData (stream_start_time_ms) without checkRepeatLoop
            this.currentTrack = track;
            this.lyricsEngine.syncProgress(track.progress_ms, track);
          } else if (!this.checkRepeatLoop(track)) {
            this.syncTrackProgress(track, scrobble);
          }
        }
        // Whether same or new track, this source claims the tick.
        // New-track detection is handled by the push handler, not poll.
        return true;
      }
      // Source active but paused — stop if current track belongs to it
      if (source.isPaused && this.currentTrackKey.startsWith(keyPrefix)) {
        this.onTrackStopped();
        return true;
      }
    }
    return false;
  }

  private async poll(): Promise<void> {
    // Re-entrance guard: the Spotify API branch below awaits a fetch with an 8s
    // timeout while the interval fires every poll_interval_ms (3s by default).
    // Without this, slow API responses stack overlapping polls, each re-emitting
    // progress and potentially racing onNewTrack against itself.
    if (this.polling) return;
    this.polling = true;
    try {
      this.ensurePollSources();

      // Priority 1: Spicetify extension (push-based, highest quality for Spotify)
      if (this.spicetify.isActive) {
        const spTrack = this.spicetify.getCurrentTrack();
        if (spTrack && this.config.get('detect_spotify') !== false) {
          // Spicetify is playing — sync progress as a safety net (push is primary)
          const trackKey = this.buildTrackKey(spTrack);
          if (trackKey === this.currentTrackKey) {
            if (!this.checkRepeatLoop(spTrack)) {
              // Engine stopped but track still playing → repeat restart
              if (!this.lyricsEngine.isRunning() && spTrack.progress_ms < 5000) {
                log.info(`[REPEAT] Engine stopped but track restarted via poll (progress=${spTrack.progress_ms}ms)`);
                this.currentTrack = spTrack;
                this.recordPlay(spTrack);
                this.emit('trackUpdate', spTrack);
                this.onNewTrack(spTrack).catch(e => log.error(`[REPEAT] Error: ${e}`));
              } else {
                this.syncTrackProgress(spTrack, true);
              }
            }
          }
          return;
        }
        // Spicetify disabled or paused — check web sources for non-Spotify media
        if (this.pollWebSources()) return;

        // Fall through to SMTC for desktop apps (non-browser)
        if (this.desktop) {
          const desktopTrack = this.desktop.getCurrentTrack();
          const dSrc = desktopTrack?.media_source || '';
          const isBrowserSrc = dSrc.startsWith('browser_') || dSrc === 'unknown';
          const spicetifyPlaying = !this.spicetify.isPaused;
          const blocked = spicetifyPlaying ? (dSrc === 'spotify' || isBrowserSrc) : isBrowserSrc;
          if (desktopTrack && !blocked) {
            this.handleDesktopTrack(desktopTrack);
            return;
          }
        }
        // Spicetify paused AND no other source found
        if (this.spicetify.isPaused && !this.currentTrack) {
          this.onTrackStopped();
        }
        if (this.spicetify.isPaused && this.config.get('rpc_only_when_playing')) {
          this.setIdlePresence();
        }
        return;
      }

      // Priority 2: YouTube userscript (when no Spicetify)
      if (this.youtubeSource.isActive && this.config.get('detect_youtube') !== false) {
        const ytTrack = this.youtubeSource.getCurrentTrack();
        if (ytTrack) {
          const trackKey = this.buildTrackKey(ytTrack);
          if (trackKey === this.currentTrackKey && !this.checkRepeatLoop(ytTrack)) {
            this.syncTrackProgress(ytTrack);
          }
          return;
        }
        // YouTube paused — check SMTC for non-YouTube media
        if (this.desktop) {
          const desktopTrack = this.desktop.getCurrentTrack();
          const src = desktopTrack?.media_source || '';
          const isYtSrc = src === 'youtube' || src === 'youtube_music' || src.startsWith('browser_');
          if (desktopTrack && !isYtSrc) {
            this.handleDesktopTrack(desktopTrack);
            return;
          }
        }
        if (this.youtubeSource.isPaused && !this.currentTrackKey) {
          this.onTrackStopped();
        }
        return;
      }

      // Priority 3: all push-based web sources (table-driven)
      if (this.pollWebSources()) return;

      // Priority 4: Desktop SMTC
      if (this.desktop) {
        const track = this.desktop.getCurrentTrack();
        this.handleDesktopTrack(track);
      }
    } catch (e) {
      log.error(`Poll error: ${e}`);
    } finally {
      this.polling = false;
    }
  }

  // ── Desktop SMTC ──

  private handleDesktopTrack(track: TrackData | null): void {
    if (!track) {
      // Grace period: wait 1.5s before treating as truly idle (prevents SMTC flicker)
      if (this.currentTrack) {
        const now = Date.now();
        if (this.idleSince === 0) {
          this.idleSince = now;
        }
        if (now - this.idleSince < 1500) {
          return; // Still in grace period — don't clear yet
        }
      }
      this.idleSince = 0;
      this.onTrackStopped();
      return;
    }

    this.idleSince = 0; // Reset grace period when track is detected

    // Per-platform detection gate
    const src = track.media_source || '';
    if (!this.config.get('detect_all_media') && !MUSIC_APPS.has(src)) {
      return;
    }
    const pKey = platformConfigKey(src);
    if (pKey && this.config.get(pKey) === false) {
      // Platform explicitly disabled — if it was the active track, stop it
      if (this.currentTrack && this.currentTrack.media_source === src) {
        this.onTrackStopped();
      }
      return;
    }

    // Block SMTC Spotify when Spicetify/TM script is actively playing.
    // When Spicetify is inactive or paused, SMTC Spotify desktop should pass through.
    if (src === 'spotify' && this.spicetify.isActive && !this.spicetify.isPaused) {
      return;
    }

    // Block SMTC YouTube/browser sources when the userscript is active, was recently active
    // (prevents ghost sessions after browser close), or owns the current track.
    const isYtSmtc = src === 'youtube' || src === 'youtube_music' || src.startsWith('browser_');
    if (isYtSmtc && (this.youtubeSource.isActive || this.youtubeSource.wasRecentlyActive || this.currentTrackKey.startsWith('yt:'))) {
      return;
    }

    // Block SMTC SoundCloud when the userscript is active (userscript has real artist/art)
    if (src === 'soundcloud' && (this.soundcloudSource.isActive || this.currentTrackKey.startsWith('sc:'))) {
      return;
    }

    // Block SMTC Bandcamp when the userscript is active (userscript has proper metadata/art)
    if (src === 'bandcamp' && (this.bandcampSource.isActive || this.currentTrackKey.startsWith('bc:'))) {
      return;
    }

    const trackKey = this.buildTrackKey(track);

    if (trackKey === this.currentTrackKey) {
      // NOTE: Do NOT use checkRepeatLoop for SMTC — browser sources report
      // progress_ms clamped to duration_ms, triggering false repeats and
      // an infinite REPEAT→DRIFT→REPEAT cycle. The web source handler below
      // already guards against stale positions, and syncProgress's built-in
      // isRepeatJump handles genuine repeats for native apps.

      this.currentTrack = track;

      // Web sources (browser, YouTube, SoundCloud): SMTC progress is unreliable
      // when a userscript is active (the userscript pushes accurate progress via
      // its own path). When NO userscript is active, SMTC is the only data source
      // so we must use it — otherwise the engine free-runs and the bar gets stuck.
      const hasUserscript = this.youtubeSource.isActive || this.soundcloudSource.isActive
        || this.bandcampSource.isActive;
      if (!this.cachedIsWebSource || !hasUserscript) {
        this.lyricsEngine.syncProgress(track.progress_ms, track);
      } else {
        // Userscript active — metadata-only update (album art, etc.)
        this.lyricsEngine.syncProgress(-1, track);
      }

      // Emit progress: use engine elapsed for web sources (more accurate)
      const progressMs = this.cachedIsWebSource
        ? Math.round(this.lyricsEngine.getElapsed())
        : track.progress_ms;
      this.emit('progressUpdate', {
        progress_ms: progressMs,
        duration_ms: track.duration_ms,
      });
      return;
    }

    this.currentTrackKey = trackKey;
    this.currentTrack = track;
    this.cachedIsWebSource = WEB_SOURCES.some(s => (track.media_source || '').startsWith(s));
    log.info(`[NEW TRACK] ${track.track_name} — ${track.artist_name} (${track.media_source})`);
    this.recordPlay(track);
    this.emit('trackUpdate', track);
    this.onNewTrack(track).catch(e => log.error(`[NEW TRACK] Error: ${e}`));
  }

  private onTrackStopped(): void {
    if (this.currentTrack) {
      log.info('Music paused');
      scrobbleTrackEnd();
      this.currentTrack = null;
      this.currentTrackKey = '';
      this.currentCacheKey = '';
      this.lyricsEngine.stop();
      this.setIdlePresence();
      this.emit('trackUpdate', null);
      this.lastLyricsState = null;
      this.emit('lyricsUpdate', { current: '', next: '', prev: '' });
    } else {
      // Even if no current track, ensure Discord presence is cleared
      // This handles cases where pause was detected but track was already null
      this.setIdlePresence();
    }
  }

  /**
   * Detect track repeat/loop: engine elapsed exceeds track duration.
   * Push sources clamp compensated progress to duration, masking the backward jump.
   * When detected, resets lyrics engine to position 0 and re-records the play.
   * Returns true if a repeat was detected and handled.
   */
  private checkRepeatLoop(track: TrackData): boolean {
    const dur = track.duration_ms;
    if (dur <= 0 || track.is_live) return false;
    const elapsed = this.lyricsEngine.getElapsed();
    if (elapsed <= dur + 2000) return false;
    // Engine elapsed significantly exceeds track duration — song looped
    log.info(`[REPEAT] ${track.track_name} looped (elapsed ${Math.round(elapsed)}ms > duration ${dur}ms)`);
    this.currentTrack = track;
    this.lyricsEngine.syncProgress(0, track);
    this.emit('progressUpdate', { progress_ms: 0, duration_ms: dur });
    this.recordPlay(track);
    return true;
  }

  /** Common fast-path: sync progress + emit update. Called from 14 poll/push sites. */
  private syncTrackProgress(track: TrackData, scrobble = false): void {
    this.currentTrack = track;
    this.lyricsEngine.syncProgress(track.progress_ms, track);
    if (scrobble) checkAndScrobble();
    this.emit('progressUpdate', { progress_ms: track.progress_ms, duration_ms: track.duration_ms });

    // Detect track end: engine stopped but progress is at the end (not a repeat loop)
    // Only call onTrackStopped if track key matches (to avoid interfering with new song detection)
    if (!this.lyricsEngine.isRunning() && track.duration_ms > 0) {
      const trackKey = this.buildTrackKey(track);
      if (trackKey === this.currentTrackKey) {
        const elapsed = this.lyricsEngine.getElapsed();
        const isAtEnd = track.progress_ms >= track.duration_ms - 2000 || elapsed >= track.duration_ms - 2000;
        if (isAtEnd && track.progress_ms > 5000) {
          log.info(`[END] Track ended naturally (progress=${track.progress_ms}ms, duration=${track.duration_ms}ms)`);
          this.onTrackStopped();
        }
      }
    }
  }

  // ── New track handler ──

  private async onNewTrack(trackData: TrackData): Promise<void> {
    const rpcConfig = this.getRpcConfig();

    log.info(`[NEW TRACK] media_source: ${trackData.media_source}, track: ${trackData.track_name}`);

    // Switch Discord App ID based on media source (changes app name in Discord)
    await this.reconnectDiscordForSource(trackData.media_source || '');

    // Abort any in-flight fetches from a previous track
    if (this.fetchAbort) this.fetchAbort.abort();
    this.fetchAbort = new AbortController();
    const { signal } = this.fetchAbort;

    // Phase 0: Extract embedded album art from local files (Apple Music, Spotify local files, etc.)
    // SMTC often doesn't provide thumbnails for local music files, or provides incorrect ones.
    // Spotify local files have spotify:localfileimage: URIs that Discord can't access.
    const isLocalMusicApp = trackData.media_source === 'apple_music' || trackData.media_source === 'groove_music';
    const isSpotifyLocalUrl = trackData.album_art_url?.startsWith('spotify:localfileimage:');
    // For Apple Music, always try local art extraction even if SMTC provides a thumbnail
    // (SMTC thumbnails are often incorrect for local files)
    const needsLocalArtExtraction = isLocalMusicApp || isSpotifyLocalUrl;

    if (needsLocalArtExtraction) {
      let artFound = false;

      // For spotify:localfileimage: URLs, try direct file path extraction first
      if (isSpotifyLocalUrl && trackData.album_art_url) {
        try {
          const encodedPath = trackData.album_art_url.replace('spotify:localfileimage:', '');
          const filePath = decodeURIComponent(encodedPath);
          log.info(`[ART] Trying direct path extraction from: ${filePath}`);
          artFound = await extractArtFromPath(filePath);
        } catch (e) {
          log.debug(`[ART] Direct path extraction failed: ${e}`);
        }
      }

      // Fallback: search in Music directories (for Apple Music local files)
      if (!artFound) {
        artFound = await extractLocalArt(
          trackData.track_name, trackData.artist_name,
          trackData.album_name, this.currentTrackKey,
        );
      }

      if (artFound) {
        trackData.album_art_url = '/api/thumbnail';
        log.info(`[ART] Extracted local art for: ${trackData.track_name} (replacing SMTC thumbnail)`);
      } else if (isSpotifyLocalUrl) {
        log.debug(`[ART] No local art found for Spotify local file: ${trackData.track_name}`);
      } else {
        log.debug(`[ART] No local art found, will use SMTC thumbnail if available`);
      }
    }

    // SMTC browser sources often report progress clamped to 0 or duration.
    // Sanitize before starting the engine to avoid initializing at a bogus position.
    const src = trackData.media_source || '';
    if (this.cachedIsWebSource && trackData.duration_ms > 0) {
      if (trackData.progress_ms >= trackData.duration_ms - 1000 || trackData.progress_ms <= 0) {
        trackData.progress_ms = 0;
      }
    }

    // Phase 1: INSTANT — show track info with no lyrics (< 1ms)
    this.lyricsEngine.startTrack([], trackData, rpcConfig);

    // Start local thumb upload immediately (Apple Music etc.) — async, non-blocking
    if (trackData.album_art_url === '/api/thumbnail') {
      this.uploadLocalThumbForRpc(trackData, signal);
    }

    // Phase 2: ASYNC — fetch lyrics in background
    const cacheKey = `${trackData.track_id}|${trackData.track_name}|${trackData.artist_name}|${trackData.duration_ms}`;
    this.currentCacheKey = cacheKey;

    // Preserve original album_art_url to prevent losing local art during lyrics search
    const originalAlbumArtUrl = trackData.album_art_url;

    let lyrics: LyricLine[];
    const cached = this.lyricsCache.get(cacheKey);
    if (cached && cached.length > 0) {
      lyrics = cached;
      log.info(`[LYRICS] Cache hit (${lyrics.length} lines)`);
    } else {
      const isVideoSource = VIDEO_SOURCES.some(s => src.startsWith(s));

      // Video sources: duration ≠ song duration (music videos have intros/outros)
      // Skip duration matching only for video-based sources
      // SoundCloud & Bandcamp report accurate audio duration — keep it for better matching
      const lyricsDuration = isVideoSource ? 0 : trackData.duration_ms;

      const lyricsPromise = (!trackData.is_live)
        ? (async (): Promise<LyricLine[]> => {
            // Priority 0: Spotify Web lyrics (official synced lyrics from Tampermonkey)
            // If already in store (pre-fetched from previous track or fast push), use immediately.
            // Otherwise, fall through to LRCLib/Netease. If TM lyrics arrive later,
            // handleSpotifyLyrics() will hot-inject them and the Phase 3 guard prevents overwrite.
            const isYouTubeSource = trackData.track_id.startsWith('yt:');
            const spotifyLyrics = this.spotifyLyricsStore.get(trackData.track_id);
            if (spotifyLyrics && spotifyLyrics.length > 0) {
              log.info(`[SPOTIFY-LYRICS] Using ${spotifyLyrics.length} pre-fetched official lyrics`);
              return spotifyLyrics;
            }

            if (isYouTubeSource) {
              // Priority 0.5: Local DB FIRST for YouTube — user-imported lyrics beat auto-CC
              // YouTube titles like "Artist - Song (Official Video)" need extra matching:
              // try the full title, then strip "Artist - " prefix for better local DB hits
              const localLyrics = await (async () => {
                const local = await fetchLyrics(trackData.track_name, trackData.artist_name, trackData.album_name, lyricsDuration, signal);
                if (local.length > 0) return local;
                // Try stripping "Artist - " prefix from YouTube title (very common format)
                const dashIdx = trackData.track_name.indexOf(' - ');
                if (dashIdx > 0) {
                  const stripped = trackData.track_name.slice(dashIdx + 3).trim();
                  const prefixArtist = trackData.track_name.slice(0, dashIdx).trim();
                  const result = await fetchLyrics(stripped, prefixArtist, trackData.album_name, lyricsDuration, signal);
                  if (result.length > 0) return result;
                }
                return [];
              })();
              if (localLyrics.length > 0) {
                log.info(`[LYRICS] Local/provider match for YouTube track — skipping CC`);
                return localLyrics;
              }

              // Stale guard: skip CC if track changed during lyrics fetch
              if (this.currentTrackKey !== this.buildTrackKey(trackData)) return [];

              // CC disabled by user → skip entirely
              if (this.config.get('cc_enabled') === false) {
                log.info('[CC] YouTube CC disabled by config — skipping');
                return [];
              }

              // Extract video ID from YouTubeSource (yt:VIDEO_ID) for direct CC fetch
              const ytVideoId = trackData.track_id.startsWith('yt:') ? trackData.track_id.slice(3) : undefined;
              const ccLang = this.config.get('cc_lang') || 'auto';
              
              log.info(`[CC] Fetching captions for "${trackData.track_name}" (videoId: ${ytVideoId || 'search'}, lang: ${ccLang})`);
              
              const ccResult = await fetchYouTubeCaptions(trackData.track_name, trackData.artist_name, signal, ytVideoId, ccLang);
              
              log.info(`[CC] Result: ${ccResult.lines.length} lines, thumbnail: ${ccResult.thumbnailUrl ? 'yes' : 'no'}`);
              
              // YouTube thumbnail takes priority — more relevant than generic album art
              // But preserve local album art if it was already extracted
              if (ccResult.thumbnailUrl && trackData.album_art_url !== '/api/thumbnail') {
                trackData.album_art_url = ccResult.thumbnailUrl;
                log.info(`[CC] Using YouTube thumbnail as album art`);
              }
              
              // Handle age-restricted videos
              if (ccResult.ageRestricted) {
                log.info('[CC] Age-restricted video — showing message');
                // Return special lyrics line for age-restricted
                return [{ time: 0, text: '🔞 CC unavailable — age-restricted video', source: 'cc' }];
              }
              
              if (ccResult.lines.length > 0) {
                log.info(`[CC] Using ${ccResult.lines.length} caption lines`);
                return ccResult.lines;
              }
              
              // Stale guard: skip fallback if track changed during CC fetch
              if (this.currentTrackKey !== this.buildTrackKey(trackData)) {
                log.info('[CC] Track changed during fetch, aborting');
                return [];
              }
              
              log.info(`[CC] No captions found — falling back to LRCLib/Netease...`);
              // Fall through to LRCLib/Netease fetch
            }
            return fetchLyrics(trackData.track_name, trackData.artist_name, trackData.album_name, lyricsDuration, signal);
          })()
        : Promise.resolve([]);

      lyrics = await lyricsPromise;

      // Check blacklist: discard if this exact match was flagged as wrong
      if (lyrics.length > 0 && isLyricsFlagged(trackData.track_name, trackData.artist_name, lyrics)) {
        log.info(`[LYRICS] Discarded flagged match for "${trackData.track_name}"`);
        lyrics = [];
      }

      // Cache lyrics (only if found, to allow retry on empty results)
      if (lyrics.length > 0) {
        this.lyricsCache.set(cacheKey, lyrics);
        this.evictCache();
      }
    }

    // Persist enriched track + re-emit to dashboard
    // Restore original album_art_url to prevent losing local art during lyrics search
    // But preserve uploaded public URL if uploadLocalThumbForRpc completed during lyrics search
    // Also preserve /api/thumbnail (local art extracted by local-art.ts)
    const uploadedUrl = this.currentTrack?.album_art_url?.startsWith('https://') ? this.currentTrack.album_art_url : null;
    const localArtUrl = this.currentTrack?.album_art_url === '/api/thumbnail' ? '/api/thumbnail' : null;
    trackData.album_art_url = uploadedUrl || localArtUrl || originalAlbumArtUrl;
    this.currentTrack = trackData;
    this.emit('trackUpdate', trackData);

    // Check if track is still the same (user might have skipped)
    const expectedKey = this.buildTrackKey(trackData);
    if (this.currentTrackKey !== expectedKey) {
      log.debug(`[LYRICS] Track changed while fetching — abort (expected=${expectedKey}, current=${this.currentTrackKey})`);
      return;
    }

    // Phase 3: Inject lyrics into the running engine (no restart = no gap)
    // Guard: if Spotify official lyrics were hot-injected while we were fetching,
    // don't overwrite them with external (LRCLib/Netease) results.
    const spotifyInjected = this.spotifyLyricsStore.has(trackData.track_id) &&
      (this.spotifyLyricsStore.get(trackData.track_id)?.length ?? 0) > 0;

    if (spotifyInjected) {
      log.info(`[LYRICS] Skipping external inject — Spotify official lyrics already active`);
    } else if (lyrics.length > 0) {
      this.lyricsEngine.injectLyrics(lyrics, trackData);
      log.info(`[LYRICS] Injected ${lyrics.length} lines into running engine`);

      // Pre-translate lyrics for RPC display (fire-and-forget, warms cache)
      if (this.config.get('rpc_translate_lyrics') && !signal.aborted) {
        const tgtLang = this.config.get('translate_target_lang') || 'en';
        const lines = lyrics.map(l => l.text).filter(t => t && t.trim().length >= 2);
        translateBatch(lines, tgtLang, signal).catch(() => {});
      }
    } else {
      // No lyrics found
      const noLyricsSource = trackData.track_id.startsWith('yt:') ? 'CC fetch failed or empty' : 'LRCLib/Netease fetch failed';
      log.info(`[LYRICS] No lyrics found for "${trackData.track_name}" — ${noLyricsSource}`);
      this.lyricsEngine.updateTrackData(trackData);

      // Async: fetch plain (unsynced) lyrics for dashboard display only (not RPC)
      if (!signal.aborted) {
        fetchPlainLyrics(trackData.track_name, trackData.artist_name, trackData.album_name, trackData.duration_ms, signal)
          .then(lines => {
            if (lines && lines.length > 0 && this.currentTrackKey === expectedKey) {
              this.emit('plainLyricsUpdate', { lines });
              log.info(`[PLAIN] Emitted ${lines.length} unsynced lines for dashboard`);
            }
          })
          .catch(() => {}); // Non-critical — dashboard-only fallback
      }
    }
  }

  /** Build a consistent track key from TrackData (must match what handlers store). */
  private buildTrackKey(t: TrackData): string {
    // Desktop, YouTube, SoundCloud & Bandcamp sources use track_id directly as key
    if (t.track_id.startsWith('desktop:') || t.track_id.startsWith('yt:') || t.track_id.startsWith('sc:') || t.track_id.startsWith('bc:')) return t.track_id;
    // Spotify source uses id|name|first_artist (indexOf avoids split allocation)
    const artist = t.artist_name;
    const commaIdx = artist.indexOf(', ');
    return `${t.track_id}|${t.track_name}|${commaIdx >= 0 ? artist.slice(0, commaIdx) : artist}`;
  }

  // ── Public getters (for web server) ──

  getConfig() { return this.config.getAll(); }
  clearLyricsCache(): number {
    const count = this.lyricsCache.size;
    this.lyricsCache.clear();
    log.info(`Lyrics cache cleared (${count} entries)`);
    return count;
  }
  /** Import custom lyrics into the local SQLite database. */
  /** Check whether importing this track would overwrite an existing custom-lyrics entry. */
  checkExistingCustomLyrics(track: string, artist: string, album: string, duration?: number) {
    return findExistingCustomLyrics(track, artist, album, duration);
  }

  /** Free-text search across the local LRCLIB dump, for the dashboard's search UI. */
  searchLrclibDump(query: string, limit?: number) {
    return searchLrclibDumpDb(query, limit);
  }

  /** Fetch full lyrics for one LRCLIB search result, to preview or load into the import form. */
  getLrclibTrackLyrics(trackId: number) {
    return getLrclibTrackLyricsDb(trackId);
  }

  importCustomLyrics(data: { track: string; artist: string; album: string; duration?: number; lrc: string }): number {
    const trackId = insertCustomLyrics(data.track, data.artist, data.album, data.duration, data.lrc);
    // Clear any flags for this track (user is providing correct lyrics)
    clearFlags(data.track, data.artist);
    // Evict cached results so the new lyrics are picked up immediately
    const trackLow = data.track.toLowerCase();
    const artistLow = data.artist.toLowerCase();
    for (const [key] of this.lyricsCache) {
      const keyLow = key.toLowerCase();
      // Cache key format: "id|track_name|artist_name|duration_ms"
      const parts = keyLow.split('|');
      if (parts.length >= 3) {
        const cachedTrack = parts[1];
        const cachedArtist = parts[2];
        // Exact match OR imported name is a substring of the cached name
        // (handles YouTube titles like "Artist - SongName (Official Video)" vs imported "SongName")
        const trackMatch = cachedTrack === trackLow || cachedTrack.includes(trackLow);
        const artistMatch = cachedArtist === artistLow || cachedArtist.includes(artistLow) || artistLow.includes(cachedArtist);
        if (trackMatch && artistMatch) {
          this.lyricsCache.delete(key);
          log.info(`[IMPORT] Evicted cache key: ${key}`);
        }
      }
    }
    // If a track is currently playing and its cache was evicted, re-fetch lyrics
    if (this.currentTrack && !this.lyricsCache.has(this.currentCacheKey)) {
      log.info(`[IMPORT] Current track cache evicted — triggering re-fetch`);
      this.onNewTrack(this.currentTrack).catch(() => {});
    }
    return trackId;
  }

  // ── Custom lyrics DB management ──

  listCustomLyrics(limit: number, offset: number, search?: string) {
    return listCustomLyrics(limit, offset, search);
  }

  getCustomLyricsEntry(trackId: number) {
    return getCustomLyrics(trackId);
  }

  updateCustomLyricsEntry(trackId: number, data: { track_name?: string; artist_name?: string; album_name?: string; duration?: number | null; synced_lyrics?: string }): boolean {
    const ok = updateCustomLyrics(trackId, data);
    if (ok) {
      // Evict any cached lyrics that might be stale
      for (const [key] of this.lyricsCache) {
        const parts = key.toLowerCase().split('|');
        if (parts.length >= 3) {
          const entry = getCustomLyrics(trackId);
          if (entry) {
            const trackLow = entry.track_name.toLowerCase();
            const artistLow = entry.artist_name.toLowerCase();
            if (parts[1].includes(trackLow) || trackLow.includes(parts[1])) {
              if (parts[2].includes(artistLow) || artistLow.includes(parts[2])) {
                this.lyricsCache.delete(key);
              }
            }
          }
        }
      }
    }
    return ok;
  }

  deleteCustomLyricsEntry(trackId: number): boolean {
    const entry = getCustomLyrics(trackId);
    const ok = deleteCustomLyrics(trackId);
    if (ok && entry) {
      // Evict cached lyrics for the deleted track
      const trackLow = entry.track_name.toLowerCase();
      const artistLow = entry.artist_name.toLowerCase();
      for (const [key] of this.lyricsCache) {
        const parts = key.toLowerCase().split('|');
        if (parts.length >= 3 && (parts[1].includes(trackLow) || trackLow.includes(parts[1])) && (parts[2].includes(artistLow) || artistLow.includes(parts[2]))) {
          this.lyricsCache.delete(key);
        }
      }
    }
    return ok;
  }

  // ── Flagged lyrics management ──

  listFlaggedTracks() {
    return listFlaggedTracks();
  }

  clearFlaggedTrack(key: string): boolean {
    return clearFlagsByKey(key);
  }

  /**
   * Flag the currently-playing track's lyrics as wrong.
   * Persists the hash so the same bad match is never reused.
   * Returns true if lyrics were flagged, false if nothing to flag.
   */
  flagCurrentLyrics(): boolean {
    if (!this.currentTrack || !this.currentCacheKey) return false;
    const cached = this.lyricsCache.get(this.currentCacheKey);
    if (!cached || cached.length === 0) return false;

    const t = this.currentTrack;
    flagLyrics(t.track_name, t.artist_name, cached);

    // Remove from cache so next fetch tries again
    this.lyricsCache.delete(this.currentCacheKey);

    // Set flagged status first (clears lyrics internally and sets message)
    this.lyricsEngine.setLyricsFlagged();

    // Restart lyrics engine with no lyrics (preserves the status message)
    const rpcConfig = this.getRpcConfig();
    this.lyricsEngine.startTrack([], t, rpcConfig);
    this.lastLyricsState = null;
    this.emit('lyricsUpdate', { current: '', next: '', prev: '' });

    log.info(`Flagged lyrics for "${t.track_name}" — ${t.artist_name}`);
    return true;
  }

  /** Live-adjust lyrics offset without engine restart. Persists to config. */
  setLyricsOffset(ms: number): void {
    const clamped = Math.max(-2000, Math.min(2000, ms));
    this.config.set('lyrics_offset_ms', clamped);
    this.lyricsEngine.updateOffset(clamped);
  }

  /** Batch-update config keys and emit configUpdate so toggles react immediately. */
  updateConfig(updates: Record<string, unknown>): void {
    // Anything reaching this method comes from an HTTP client — only known keys
    // holding a valid value are written to disk.
    const { accepted, rejected } = sanitizeConfigUpdate(updates);
    if (rejected.length) {
      log.warn(`Ignored ${rejected.length} invalid config key(s): ${rejected.join(', ')}`);
    }
    if (!Object.keys(accepted).length) return;
    this.config.setMany(accepted as Partial<VybecordConfig>);
    this.emit('configUpdate', this.config.getAll());
  }
  getCurrentTrack() { return this.currentTrack; }
  getCurrentLyricsState() { return this.lastLyricsState; }

  /** Return the current track's cached lyrics as LRC text, or null. */
  getCurrentLyricsLrc(): string | null {
    const lyrics = this.lyricsCache.get(this.currentCacheKey);
    if (!lyrics || lyrics.length === 0) return null;
    return lyrics.map(l => {
      const totalSecs = l.time / 1000;
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      return `[${String(mins).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}] ${l.text}`;
    }).join('\n');
  }

  /** Get top 3 tracks and top 3 artists for the current session. Cached until next play. */
  getSessionStats() {
    if (!this.statsDirty && this.cachedStats) return this.cachedStats;
    const topTracks = [...this.sessionTrackPlays.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map(t => ({ name: t.name, artist: t.artist, art: t.art, plays: t.count }));
    const topArtists = [...this.sessionArtistPlays.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map(a => ({ name: a.name, art: a.art, artist_art: a.artist_art, plays: a.count }));
    this.cachedStats = { topTracks, topArtists };
    this.statsDirty = false;
    return this.cachedStats;
  }
  // ── Stats history (persisted across sessions) ──

  private loadStatsHistory(): SessionSnapshot[] {
    try {
      if (fs.existsSync(this.statsHistoryPath)) {
        const raw = fs.readFileSync(this.statsHistoryPath, 'utf-8');
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          log.info(`Loaded ${arr.length} previous session(s) from stats history`);
          return arr.slice(0, MAX_HISTORY_SESSIONS);
        }
      }
    } catch (e) {
      log.warn(`Failed to load stats history: ${e}`);
    }
    return [];
  }

  private saveStatsHistory(): void {
    // Written once per session (during shutdown), so a synchronous atomic write
    // is both safe and more reliable than async I/O racing process.exit():
    // full content lands in a temp file, then a single rename swaps it in.
    const tmpPath = `${this.statsHistoryPath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.statsHistoryPath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(this.statsHistory, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.statsHistoryPath);
    } catch (e) {
      log.warn(`Failed to save stats history: ${e}`);
      try { fs.unlinkSync(tmpPath); } catch { /* nothing to clean up */ }
    }
  }

  /** Persist the current session's top 3 into the history file. */
  private saveCurrentSession(): void {
    const stats = this.getSessionStats();
    if (!stats.topTracks.length && !stats.topArtists.length) return;

    const snapshot: SessionSnapshot = {
      date: new Date().toISOString(),
      topTracks: stats.topTracks,
      topArtists: stats.topArtists,
    };

    this.statsHistory.unshift(snapshot);
    if (this.statsHistory.length > MAX_HISTORY_SESSIONS) {
      this.statsHistory = this.statsHistory.slice(0, MAX_HISTORY_SESSIONS);
    }
    this.saveStatsHistory();
    log.info(`Saved current session to stats history (${this.statsHistory.length} total)`);
  }

  /** Get previous sessions top 3 (excludes current session). */
  getStatsHistory(): SessionSnapshot[] {
    return this.statsHistory;
  }

  /** Get persistent listening history (most recent first). */
  getListeningHistory(limit = 50, offset = 0) { return getRecentHistory(limit, offset); }
  getListeningHistoryCount() { return getHistoryCount(); }
  getListeningWrapped(days?: number) { return getWrappedStats(days); }

  isDiscordConnected() { return this.discord.isConnected; }
  isSpicetifyActive() { return this.spicetify.isActive; }

  /** Push connection status to dashboard via SSE. */
  private emitStatus(): void {
    this.emit('statusUpdate', {
      discordConnected: this.discord.isConnected,
      spicetifyActive: this.spicetify.isActive,
      showLyrics: this.config.get('show_lyrics') !== false,
    });
  }

  /**
   * Wire the lyrics engine callbacks (SSE lyric state + Discord RPC push).
   * Called once at construction and again after every Discord IPC swap, so the
   * emitted payload stays identical in both cases (single source of truth).
   */
  private wireEngineCallbacks(): void {
    this.lyricsEngine.setCallbacks({
      onLyricChange: (current, next, prev) => {
        log.debug(`[LYRIC] ${current} → ${next}`);
        const t = this.currentTrack;
        const lyricsState = {
          current,
          next,
          prev,
          progress_ms: Math.round(this.lyricsEngine.getElapsed()),
          duration_ms: t ? t.duration_ms : 0,
          lyrics: this.lyricsEngine.getLyrics(),
          currentIndex: this.lyricsEngine.getCurrentIndex(),
        };
        this.lastLyricsState = lyricsState;
        this.emit('lyricsUpdate', lyricsState);
        // Return measured IPC pipe write latency for EMA compensation
        return this.discord.lastWriteLatencyMs;
      },
      onRpcUpdate: (activity) => {
        if (this.config.get('rpc_enabled')) {
          this.discord.setActivity(activity);
        }
      },
    });
  }

  /** Wire ready/disconnect handlers on the current Discord IPC instance. */
  private wireDiscordHandlers(): void {
    // Capture the instance: an App ID switch may replace `this.discord` while an
    // in-flight connect() is still running on the old one. Its callbacks must
    // not touch the presence of the new instance.
    const ipc = this.discord;
    ipc.onReady(() => {
      if (this.discord !== ipc) {
        ipc.close(); // stale connection from a previous App ID — drop it
        return;
      }
      log.info('Discord RPC connected ✓');
      this.setIdlePresence();
      this.emitStatus();
    });
    ipc.onDisconnect(() => {
      if (this.discord !== ipc) return;
      log.warn('Discord disconnected — will retry');
      this.emitStatus();
    });
  }

  /**
   * Reconnect Discord with a different App ID based on media source.
   * This changes the application name shown in Discord.
   */
  private async reconnectDiscordForSource(source: string): Promise<void> {
    const platformAppId = PLATFORM_DISCORD_APP_IDS[source];
    const defaultAppId = this.config.get('discord_app_id')
      || process.env.DISCORD_CLIENT_ID
      || DEFAULT_DISCORD_APP_ID;
    // Always prefer platform-specific AppID over default
    const targetAppId = platformAppId || defaultAppId;

    log.debug(`[DISCORD] Source: ${source}, Platform AppID: ${platformAppId || 'none'}, Target AppID: ${targetAppId}, Current AppID: ${this.currentDiscordAppId}`);

    // No change needed
    if (targetAppId === this.currentDiscordAppId) {
      log.debug(`[DISCORD] No AppID change needed for ${source}`);
      return;
    }

    log.info(`[DISCORD] Switching App ID for ${source}: ${this.currentDiscordAppId || 'default'} → ${targetAppId}`);

    // Close current connection
    this.discord.close();

    // Create new DiscordIPC with new App ID
    this.discord = new DiscordIPC(targetAppId);
    this.currentDiscordAppId = targetAppId;

    // Re-wire callbacks (ready/disconnect + engine → new IPC instance)
    this.wireDiscordHandlers();
    this.wireEngineCallbacks();

    // Connect in background — always retry, even if the previous instance was
    // not connected yet (otherwise a source switch during startup or while
    // Discord is closed would leave us permanently without any presence).
    if (this.shuttingDown) return;
    this.discord.connectWithRetry().catch(e => {
      log.error(`Discord reconnection failed: ${e}`);
    });
  }

  /** Record a track play for session stats + scrobbling. */
  private recordPlay(t: TrackData): void {
    this.statsDirty = true;
    historyTrackStart(t.track_name, t.artist_name, t.album_name, t.album_art_url, t.media_source);
    scrobbleTrackStart(t.track_name, t.artist_name, t.album_name, t.duration_ms);
    // Extract primary artist once (used for both track and artist stats)
    const artistDisplay = t.artist_name.split(ARTIST_SPLIT_RE)[0].trim();
    const artistKey = artistDisplay.toLowerCase();

    // Track plays — keyed by normalized name+primary artist (stable before enrichment)
    const trackKey = `${t.track_name.toLowerCase()}|${artistKey}`;
    const existing = this.sessionTrackPlays.get(trackKey);
    if (existing) {
      existing.count++;
      if (t.album_art_url) existing.art = t.album_art_url;
    } else {
      this.sessionTrackPlays.set(trackKey, {
        name: t.track_name,
        artist: t.artist_name,
        art: t.album_art_url || '',
        count: 1,
      });
    }
    const existingArtist = this.sessionArtistPlays.get(artistKey);
    if (existingArtist) {
      existingArtist.count++;
      // Prefer the longer/richer name variant
      if (artistDisplay.length > existingArtist.name.length) existingArtist.name = artistDisplay;
      if (t.album_art_url) existingArtist.art = t.album_art_url;
      if (t.artist_art_url) existingArtist.artist_art = t.artist_art_url;
    } else {
      this.sessionArtistPlays.set(artistKey, { name: artistDisplay, art: t.album_art_url || '', artist_art: t.artist_art_url || '', count: 1 });
    }

    evictOldest(this.sessionTrackPlays, 500);
    evictOldest(this.sessionArtistPlays, 500);

    this.emit('statsUpdate', this.getSessionStats());
  }

  // ── RPC helpers ──

  private getRpcConfig(): Record<string, unknown> {
    const cfg = this.config.getAll();
    return {
      show_lyrics: cfg.show_lyrics,
      rpc_details_url: cfg.rpc_details_url,
      rpc_state_url: cfg.rpc_state_url,
      rpc_large_url: cfg.rpc_large_url,
      rpc_button1_label: cfg.rpc_button1_label,
      rpc_button1_url: cfg.rpc_button1_url,
      rpc_button2_label: '🎵 Listen on {platform}',
      rpc_activity_type: cfg.rpc_activity_type,
      dance_mode: cfg.dance_mode,
      radiate_mode: cfg.radiate_mode,
      purple_rad_mode: cfg.purple_rad_mode,
      rouge_mode: cfg.rouge_mode,
      bleeding_mode: cfg.bleeding_mode,
      blue_rad_mode: cfg.blue_rad_mode,
      lrc_off_mode: cfg.lrc_off_mode,
      random_icon_mode: cfg.random_icon_mode,
      hide_small_icon: cfg.hide_small_icon,
      lyrics_offset_ms: cfg.lyrics_offset_ms,
      romanize_lyrics: cfg.romanize_lyrics,
      rpc_translate_lyrics: cfg.rpc_translate_lyrics,
      translate_target_lang: cfg.translate_target_lang,
    };
  }

  private setIdlePresence(): void {
    if (!this.discord.isConnected) return;
    if (!this.config.get('rpc_enabled')) {
      this.discord.clearActivity().catch(() => {});
      return;
    }

    // rpc_only_when_playing: clear presence when no music
    if (this.config.get('rpc_only_when_playing')) {
      this.discord.clearActivity().catch(() => {});
      return;
    }

    const btn1 = this.config.get('rpc_button1_label');
    const btn1Url = this.config.get('rpc_button1_url');

    const buttons: { label: string; url: string }[] = [];
    if (btn1 && btn1Url) buttons.push({ label: btn1, url: btn1Url });

    this.discord.setActivity({
      type: this.config.get('rpc_activity_type'),
      details: '⏸ Nothing playing',
      state: '  ',
      assets: {
        large_image: 'https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/T13Beb2q34Er50o2JrKn2.gif',
        large_text: '  ',
      },
      buttons: buttons.length > 0 ? buttons : undefined,
    });
  }

  /**
   * Upload the local SMTC thumbnail to a public image host and update Discord RPC.
   * Called async (non-blocking) when a track has album_art_url === '/api/thumbnail'.
   */
  private uploadLocalThumbForRpc(trackData: TrackData, signal?: AbortSignal): void {
    const trackKey = this.currentTrackKey;
    uploadThumbForRpc(trackKey, signal).then(publicUrl => {
      if (!publicUrl) return;
      // Make sure we're still on the same track
      if (this.currentTrackKey !== trackKey) return;
      // Update currentTrack so the Catbox URL survives subsequent polls
      if (this.currentTrack) this.currentTrack.album_art_url = publicUrl;
      // Update RPC with the public URL (use currentTrack for up-to-date data)
      const rpcTrack = { ...(this.currentTrack || trackData), album_art_url: publicUrl };
      this.lyricsEngine.updateTrackData(rpcTrack);
      log.info(`[RPC] Using uploaded local thumb: ${publicUrl}`);
    }).catch(() => { /* upload errors already logged in image-upload */ });
  }

  private evictCache(): void {
    evictUntil(this.lyricsCache, 50);
  }

  // ── Shutdown ──

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log.info('Shutting down...');

    // 1. Abort in-flight fetches (lyrics, album art)
    if (this.fetchAbort) {
      this.fetchAbort.abort();
      this.fetchAbort = null;
    }

    // 2. Stop polling
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // 3. Stop lyrics engine
    this.lyricsEngine.stop();

    // 4. Clear Discord presence and disconnect (waits for Discord ACK before closing pipe)
    await this.discord.gracefulClose();

    // 5. Stop desktop source
    if (this.desktop) {
      this.desktop.stop();
    }

    // 6. Stop config watcher
    this.config.close();

    // 7. Save session stats + listening history + finalize scrobble
    this.saveCurrentSession();
    scrobbleTrackEnd();
    historyTrackEnd();

    // 8. Close local lyrics database
    closeLocalDb();

    log.info('All services stopped cleanly.');
  }
}
