/**
 * VybecordBackend — main orchestrator.
 *
 * Supports THREE track sources (priority order):
 *   1. SpicetifySource (push) → Spicetify extension sends real-time data via HTTP POST
 *      - Event-driven (instant), full Spotify metadata, album art CDN, accurate progress
 *      - Eliminates need for Deezer/iTunes/Last.fm metadata enrichment
 *   2. SpotifyClient (API) → Premium users without Spicetify
 *   3. DesktopSource (SMTC) → Free users (no API needed, reads Windows media session)
 *
 * Auto-detection: tries Spotify API first. If it fails (403 / no premium),
 * automatically falls back to SMTC. Spicetify activates on first push.
 *
 * Flow:
 *   1. Detect user tier (auto / premium / free)
 *   2. Connect to Discord IPC
 *   3. Poll active source every N ms for current track
 *   4. On new track → fetch lyrics from LRCLib (async) + album art from Deezer
 *   5. Feed lyrics to LyricsEngine → precise setTimeout scheduling → RPC updates
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { createLogger } from './core/logger.js';
import { ConfigManager } from './core/config.js';
import { SpotifyClient } from './core/spotify.js';
import { DesktopSource } from './core/desktop-source.js';
import { SpicetifySource, type SpicetifyPayload } from './core/spicetify-source.js';
import { YouTubeSource, type YouTubePayload } from './core/youtube-source.js';
import { SoundCloudSource, type SoundCloudPayload } from './core/soundcloud-source.js';
import { BandcampSource, type BandcampPayload } from './core/bandcamp-source.js';
import { KickSource, type KickPayload } from './core/kick-source.js';
import { TwitchSource, type TwitchPayload } from './core/twitch-source.js';
import { DiscordIPC } from './core/discord-ipc.js';
import { LyricsEngine } from './sync/lyrics-engine.js';
import { fetchLyrics, fetchTrackMetadata, fetchPlainLyrics } from './core/provider.js';
import { fetchYouTubeCaptions, clearCCCache, type CCResult } from './core/youtube-captions.js';
import { similarity } from './core/similarity.js';
import { initLocalDb, closeLocalDb, insertCustomLyrics, listCustomLyrics, getCustomLyrics, updateCustomLyrics, deleteCustomLyrics } from './core/local-lyrics-db.js';
import { initLastFm, scrobbleTrackStart, checkAndScrobble, scrobbleTrackEnd, isScrobbleEnabled, getAuthUrl, completeAuth, disconnectScrobble, canAuth } from './core/lastfm.js';
import { uploadThumbForRpc } from './core/image-upload.js';
import { extractLocalArt, extractArtFromPath } from './core/local-art.js';
import { initBlacklist, flagLyrics, isLyricsFlagged, clearFlags, listFlaggedTracks, clearFlagsByKey } from './core/lyrics-blacklist.js';
import { initHistory, historyTrackStart, historyTrackEnd, getRecentHistory, getHistoryCount, getWrappedStats } from './core/listening-history.js';
import { translateBatch } from './core/translate.js';
import { evictOldest, evictUntil } from './core/utils.js';
import type { TrackData, SpotifyPlayback, LyricLine } from './core/types.js';

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

// Platform-specific Discord App IDs (changes the app name shown in Discord)
const PLATFORM_DISCORD_APP_IDS: Record<string, string> = {
  spotify: '1513867708851294299',
  youtube: '1513868157897412759',
  youtube_music: '1513868157897412759',
  soundcloud: '1513868059948093501',
  kick: '1519781115144044636',
  twitch: '1489626057588998164',
  // Default falls back to config discord_app_id or env DISCORD_CLIENT_ID
};

type TrackSourceMode = 'premium' | 'free';

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
  private spotify: SpotifyClient | null = null;
  private desktop: DesktopSource | null = null;
  private spicetify: SpicetifySource;
  private youtubeSource: YouTubeSource;
  private soundcloudSource: SoundCloudSource;
  private bandcampSource: BandcampSource;
  private kickSource: KickSource;
  private twitchSource: TwitchSource;
  private discord: DiscordIPC;
  private lyricsEngine: LyricsEngine;

  private sourceMode: TrackSourceMode = 'free';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private currentTrack: TrackData | null = null;
  private currentTrackKey = '';
  private currentCacheKey = '';
  private lyricsCache = new Map<string, LyricLine[]>();
  private lastLyricsState: { current: string; next: string; prev: string; progress_ms: number; duration_ms: number } | null = null;
  private enrichedMeta = new Map<string, { album_art_url: string; album_name: string; artist_name?: string }>();
  private prefetchedKey = '';  // track key of last prefetched lyrics
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
  private lastStatsKey = '';  // track key used by last recordPlay (for enrichment lookup)
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

    const discordAppId = this.config.get('discord_app_id') || process.env.DISCORD_CLIENT_ID || '';
    if (!discordAppId) {
      throw new Error('Missing DISCORD_CLIENT_ID in config or .env');
    }

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
        this.mergeEnriched(this.currentTrack);
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
        initLocalDb(this.configDir),
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

    // 1. Detect user tier and init track source
    await Promise.race([
      this.initTrackSource(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Track source detection timeout (15s)')), 15000))
    ]).catch(e => {
      log.warn(`Track source detection failed or timed out: ${e}. Falling back to FREE mode (SMTC).`);
      this.startDesktopSource();
    });

    // 2. Discord RPC connect (with retry)
    this.discord.onReady(() => {
      log.info('Discord RPC connected ✓');
      this.setIdlePresence();
      this.emitStatus();
    });
    this.discord.onDisconnect(() => {
      log.warn('Discord disconnected — will retry');
      this.emitStatus();
    });

    // Connect in background (don't block startup)
    this.discord.connectWithRetry().catch(e => {
      log.error(`Discord connection failed: ${e}`);
    });

    // 3. Start polling
    const interval = this.config.get('poll_interval_ms') || 1500;
    log.info(`Starting ${this.sourceMode.toUpperCase()} polling (every ${interval}ms)`);
    this.pollTimer = setInterval(() => this.poll(), interval);

    // Immediate first poll
    this.poll();
  }

  // ── Track source detection ──

  private async initTrackSource(): Promise<void> {
    const userTier = (this.config.get('user_tier') as string) || 'auto';
    const clientId = this.config.get('spotify_client_id') || process.env.SPOTIFY_CLIENT_ID || '';
    const clientSecret = this.config.get('spotify_client_secret') || process.env.SPOTIFY_CLIENT_SECRET || '';

    if (userTier === 'free') {
      // Forced free mode — skip API entirely
      this.startDesktopSource();
      return;
    }

    if (userTier === 'premium' && clientId && clientSecret) {
      // Forced premium mode
      await this.startSpotifySource(clientId, clientSecret);
      return;
    }

    // Auto-detect: try Spotify API first, fall back to SMTC
    if (clientId && clientSecret) {
      try {
        await this.startSpotifySource(clientId, clientSecret);
        // Test if the API actually works (Premium check)
        const test = await this.spotify!.getCurrentPlayback();
        // If no error, API works (even if nothing is playing)
        log.info('Spotify API accessible → PREMIUM mode');
        return;
      } catch (e) {
        log.warn(`Spotify API failed (${e}) → falling back to FREE mode (SMTC)`);
      }
    } else {
      log.info('No Spotify credentials → FREE mode (SMTC)');
    }

    this.startDesktopSource();
  }

  private async startSpotifySource(clientId: string, clientSecret: string): Promise<void> {
    this.spotify = new SpotifyClient({
      clientId,
      clientSecret,
      cacheDir: path.join(this.configDir, 'envs'),
    });
    await this.spotify.authenticate();
    this.sourceMode = 'premium';
    log.info('Spotify authenticated ✓ (PREMIUM source)');
  }

  private startDesktopSource(): void {
    if (process.platform !== 'win32') {
      log.error('SMTC desktop source is only available on Windows.');
      log.error('Set user_tier to "premium" and provide Spotify credentials.');
      throw new Error('SMTC requires Windows — configure Spotify credentials for other platforms');
    }
    this.desktop = new DesktopSource();
    this.desktop.start();
    this.sourceMode = 'free';
    this.spotify = null;
    log.info('Desktop SMTC source started ✓ (FREE mode — no Spotify Premium required)');
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
    this.prefetchedKey = '';
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
    this.prefetchedKey = '';
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
    this.prefetchedKey = '';
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
    this.prefetchedKey = '';
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

    if (this.config.get('detect_other_apps') === false) return;

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
    this.prefetchedKey = '';
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

    if (this.config.get('detect_other_apps') === false) return;

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
    this.prefetchedKey = '';
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

  private async poll(): Promise<void> {
    try {
      // Priority 1: Spicetify extension (push-based, highest quality for Spotify)
      // If active, skip API/SMTC for Spotify — but still run SMTC for non-Spotify media
      if (this.spicetify.isActive) {
        const spTrack = this.spicetify.getCurrentTrack();
        if (spTrack && this.config.get('detect_spotify') !== false) {
          // Spicetify is playing Spotify — it handles everything via push.
          // Only sync progress here as a safety net (push is the primary path).
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
        // Spicetify disabled or paused — check other sources for non-Spotify media
        if (this.youtubeSource.isActive && this.config.get('detect_youtube') !== false) {
          const ytTrack = this.youtubeSource.getCurrentTrack();
          if (ytTrack) {
            const trackKey = this.buildTrackKey(ytTrack);
            if (trackKey === this.currentTrackKey) {
              if (!this.checkRepeatLoop(ytTrack)) {
                this.syncTrackProgress(ytTrack);
              }
            }
            return;
          }
        }
        if (this.soundcloudSource.isActive && this.config.get('detect_soundcloud') !== false) {
          const scTrack = this.soundcloudSource.getCurrentTrack();
          if (scTrack) {
            const trackKey = this.buildTrackKey(scTrack);
            if (trackKey === this.currentTrackKey) {
              if (!this.checkRepeatLoop(scTrack)) {
                this.syncTrackProgress(scTrack);
              }
            }
            return;
          }
          // SoundCloud active but paused — stop if current track is SoundCloud
          if (this.soundcloudSource.isPaused && this.currentTrackKey.startsWith('sc:')) {
            this.onTrackStopped();
            return;
          }
        }
        if (this.bandcampSource.isActive && this.config.get('detect_other_apps') !== false) {
          const bcTrack = this.bandcampSource.getCurrentTrack();
          if (bcTrack) {
            const trackKey = this.buildTrackKey(bcTrack);
            if (trackKey === this.currentTrackKey) {
              if (!this.checkRepeatLoop(bcTrack)) {
                this.syncTrackProgress(bcTrack, true);
              }
            }
            return;
          }
          // Bandcamp active but paused — stop if current track is Bandcamp
          if (this.bandcampSource.isPaused && this.currentTrackKey.startsWith('bc:')) {
            this.onTrackStopped();
            return;
          }
        }
        if (this.kickSource.isActive && this.config.get('detect_other_apps') !== false) {
          const kickTrack = this.kickSource.getCurrentTrack();
          if (kickTrack) {
            const trackKey = this.buildTrackKey(kickTrack);
            if (trackKey === this.currentTrackKey) {
              // Same stream — no progress sync needed for live streams
              return;
            }
            return;
          }
          // Kick active but not live — stop if current track is Kick
          if (this.kickSource.isPaused && this.currentTrackKey.startsWith('kick:')) {
            this.onTrackStopped();
            return;
          }
        }
        if (this.desktop) {
          const desktopTrack = this.desktop.getCurrentTrack();
          const dSrc = desktopTrack?.media_source || '';
          const isBrowserSrc = dSrc.startsWith('browser_') || dSrc === 'unknown';
          // When Spicetify/TM is active but paused: allow SMTC Spotify desktop through
          // (user is listening on the desktop app while browser tab with TM script is open)
          // Only block browser sources (stale duplicates of the paused web player)
          const spicetifyPlaying = !this.spicetify.isPaused;
          const blocked = spicetifyPlaying ? (dSrc === 'spotify' || isBrowserSrc) : isBrowserSrc;
          if (desktopTrack && !blocked) {
            this.handleDesktopTrack(desktopTrack);
            return;
          }
        }
        // Spicetify paused AND no other source found — check if truly idle
        if (this.spicetify.isPaused && !this.currentTrack) {
          this.onTrackStopped();
        }
        return;
      }

      // Priority 2: YouTube userscript (push-based, highest quality for YouTube)
      if (this.youtubeSource.isActive && this.config.get('detect_youtube') !== false) {
        const ytTrack = this.youtubeSource.getCurrentTrack();
        if (ytTrack) {
          // YouTube userscript is playing — handles everything via push.
          // Only sync progress here as a safety net.
          const trackKey = this.buildTrackKey(ytTrack);
          if (trackKey === this.currentTrackKey) {
            if (!this.checkRepeatLoop(ytTrack)) {
              this.syncTrackProgress(ytTrack);
            }
          }
          return;
        }
        // YouTube paused — check SMTC for non-YouTube media
        if (this.desktop) {
          const desktopTrack = this.desktop.getCurrentTrack();
          const src = desktopTrack?.media_source || '';
          const isYtSrc = src === 'youtube' || src === 'youtube_music' || src.startsWith('browser_');
          // Only use SMTC if it's NOT a YouTube source (avoid double-handling)
          if (desktopTrack && !isYtSrc) {
            this.handleDesktopTrack(desktopTrack);
            return;
          }
        }
        // Only stop if no other media source is playing
        if (this.youtubeSource.isPaused && !this.currentTrackKey) {
          this.onTrackStopped();
        }
        return;
      }

      // Priority 3: Spotify API (Premium users without Spicetify)
      if (this.sourceMode === 'premium' && this.spotify) {
        const playback = await this.spotify.getCurrentPlayback();
        this.handleSpotifyPlayback(playback);
      } else {
        // Priority 3b: YouTube userscript (Tampermonkey) — always before SMTC
        if (this.youtubeSource.isActive && this.config.get('detect_youtube') !== false) {
          const ytTrack = this.youtubeSource.getCurrentTrack();
          if (ytTrack) {
            const trackKey = this.buildTrackKey(ytTrack);
            if (trackKey === this.currentTrackKey) {
              if (!this.checkRepeatLoop(ytTrack)) {
                this.syncTrackProgress(ytTrack);
              }
            }
            return;
          }
        }
        // Priority 3c: SoundCloud userscript — before SMTC
        if (this.soundcloudSource.isActive && this.config.get('detect_soundcloud') !== false) {
          const scTrack = this.soundcloudSource.getCurrentTrack();
          if (scTrack) {
            const trackKey = this.buildTrackKey(scTrack);
            if (trackKey === this.currentTrackKey) {
              if (!this.checkRepeatLoop(scTrack)) {
                this.syncTrackProgress(scTrack);
              }
            }
            return;
          }
          // SoundCloud active but paused — stop if current track is SoundCloud
          if (this.soundcloudSource.isPaused && this.currentTrackKey.startsWith('sc:')) {
            this.onTrackStopped();
            return;
          }
          // SoundCloud paused but a non-SC track is playing — fall through to SMTC
        }
        // Priority 3d: Bandcamp userscript — before SMTC
        if (this.bandcampSource.isActive && this.config.get('detect_other_apps') !== false) {
          const bcTrack = this.bandcampSource.getCurrentTrack();
          if (bcTrack) {
            const trackKey = this.buildTrackKey(bcTrack);
            if (trackKey === this.currentTrackKey) {
              if (!this.checkRepeatLoop(bcTrack)) {
                this.syncTrackProgress(bcTrack, true);
              }
            }
            return;
          }
          // Bandcamp active but paused — stop if current track is Bandcamp
          if (this.bandcampSource.isPaused && this.currentTrackKey.startsWith('bc:')) {
            this.onTrackStopped();
            return;
          }
        }
        // Priority 3e: Kick userscript — before SMTC
        if (this.kickSource.isActive && this.config.get('detect_other_apps') !== false) {
          const kickTrack = this.kickSource.getCurrentTrack();
          if (kickTrack) {
            const trackKey = this.buildTrackKey(kickTrack);
            if (trackKey === this.currentTrackKey) {
              // Same stream — no progress sync needed for live streams
              return;
            }
            return;
          }
          // Kick active but not live — stop if current track is Kick
          if (this.kickSource.isPaused && this.currentTrackKey.startsWith('kick:')) {
            this.onTrackStopped();
            return;
          }
        }
        // Priority 3f: Twitch userscript — before SMTC
        if (this.twitchSource.isActive && this.config.get('detect_other_apps') !== false) {
          const twitchTrack = this.twitchSource.getCurrentTrack();
          if (twitchTrack) {
            const trackKey = this.buildTrackKey(twitchTrack);
            if (trackKey === this.currentTrackKey) {
              // Same stream — no progress sync needed for live streams
              return;
            }
            return;
          }
          // Twitch active but not live — stop if current track is Twitch
          if (this.twitchSource.isPaused && this.currentTrackKey.startsWith('twitch:')) {
            this.onTrackStopped();
            return;
          }
        }
        // Priority 4: Desktop SMTC (Free users)
        if (this.desktop) {
          const track = this.desktop.getCurrentTrack();
          this.handleDesktopTrack(track);
        }
      }
    } catch (e) {
      log.error(`Poll error: ${e}`);
    }
  }

  // ── Premium: Spotify API ──

  private handleSpotifyPlayback(playback: SpotifyPlayback | null): void {
    if (!playback || !playback.is_playing || !playback.item) {
      this.onTrackStopped();
      return;
    }

    if (this.config.get('detect_spotify') === false) return;

    this.idleSince = 0; // Reset grace period
    const trackData = this.extractSpotifyTrackData(playback);
    const trackKey = this.buildTrackKey(trackData);

    if (trackKey === this.currentTrackKey) {
      if (this.checkRepeatLoop(trackData)) return;
      this.syncTrackProgress(trackData);

      // Prefetch next track's lyrics when >80% done (fire-and-forget)
      if (trackData.duration_ms > 0 && trackData.progress_ms / trackData.duration_ms > 0.8) {
        this.prefetchNextLyrics();
      }
      return;
    }

    this.prefetchedKey = ''; // Reset on new track
    this.currentTrackKey = trackKey;
    this.currentTrack = trackData;
    this.cachedIsWebSource = false; // Spotify API source is never a web source
    log.info(`[NEW TRACK] ${trackData.track_name} — ${trackData.artist_name}`);
    this.recordPlay(trackData);
    this.emit('trackUpdate', trackData);
    this.onNewTrack(trackData).catch(e => log.error(`[NEW TRACK] Error: ${e}`));
  }

  /** Pre-warm lyrics cache for the next track in the Spotify queue. */
  private prefetchNextLyrics(): void {
    if (!this.spotify || this.prefetchedKey === this.currentTrackKey) return;
    this.prefetchedKey = this.currentTrackKey;

    // Own AbortController — survives track skips so prefetch work isn't wasted
    const prefetchAbort = new AbortController();
    // Auto-abort after 15s to prevent lingering fetches
    const timeout = setTimeout(() => prefetchAbort.abort(), 15_000);

    this.spotify.getNextInQueue().then(async (nextItem) => {
      if (!nextItem) return;
      const cacheKey = `${nextItem.id}|${nextItem.name}|${nextItem.artists.map(a => a.name).join(', ')}|${nextItem.duration_ms}`;
      if (this.lyricsCache.has(cacheKey)) return; // Already cached

      const artist = nextItem.artists.map(a => a.name).join(', ');
      log.debug(`[PREFETCH] Fetching lyrics for next: ${nextItem.name} — ${artist}`);
      const lyrics = await fetchLyrics(nextItem.name, artist, nextItem.album.name, nextItem.duration_ms, prefetchAbort.signal);
      if (lyrics.length > 0) {
        this.lyricsCache.set(cacheKey, lyrics);
        this.evictCache();
        log.info(`[PREFETCH] Cached ${lyrics.length} lines for "${nextItem.name}"`);
      }
    }).catch(() => {}).finally(() => clearTimeout(timeout)); // Silent fail — prefetch is best-effort
  }

  private extractSpotifyTrackData(playback: SpotifyPlayback): TrackData {
    const item = playback.item!;
    const artist = item.artists.map(a => a.name).join(', ');
    const albumImages = item.album.images;
    // Pick largest image directly (O(n)) instead of sorting (O(n log n)) every poll
    let artUrl = '';
    if (albumImages.length > 0) {
      let best = albumImages[0];
      for (let i = 1; i < albumImages.length; i++) {
        if (albumImages[i].width > best.width) best = albumImages[i];
      }
      artUrl = best.url;
    }

    return {
      track_id: item.id,
      track_name: item.name,
      artist_name: artist,
      album_name: item.album.name,
      duration_ms: item.duration_ms,
      progress_ms: playback.progress_ms,
      is_playing: playback.is_playing,
      album_art_url: artUrl,
      spotify_url: item.external_urls?.spotify ?? '',
      artist_url: item.artists[0]?.external_urls?.spotify ?? '',
      album_url: item.album.external_urls?.spotify ?? '',
      context_url: playback.context?.external_urls?.spotify ?? '',
      context_type: playback.context?.type ?? '',
      // context_name not available from Spotify API without an extra /playlists/{id} call
      media_source: 'spotify',
      _received_at: performance.now(),
    };
  }

  // ── Free: Desktop SMTC ──

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

      // Merge enriched metadata from persistent store (survives poll replacement)
      this.mergeEnriched(track);
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

    // Switch Discord App ID based on media source (changes app name in Discord)
    await this.reconnectDiscordForSource(trackData.media_source || '');

    // Abort any in-flight fetches from a previous track
    if (this.fetchAbort) this.fetchAbort.abort();
    this.fetchAbort = new AbortController();
    const { signal } = this.fetchAbort;

    // Phase 0: Extract embedded album art from local files (Apple Music, Spotify local files, etc.)
    // SMTC often doesn't provide thumbnails for local music files.
    // Spotify local files have spotify:localfileimage: URIs that Discord can't access.
    const isLocalMusicApp = trackData.media_source === 'apple_music' || trackData.media_source === 'groove_music';
    const isSpotifyLocalUrl = trackData.album_art_url?.startsWith('spotify:localfileimage:');
    const needsLocalArtExtraction = (isLocalMusicApp && !trackData.album_art_url) || isSpotifyLocalUrl;

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

      // Fallback: search in Music directories
      if (!artFound) {
        artFound = await extractLocalArt(
          trackData.track_name, trackData.artist_name,
          trackData.album_name, this.currentTrackKey,
        );
      }

      if (artFound) {
        trackData.album_art_url = '/api/thumbnail';
        log.info(`[ART] Extracted local art for: ${trackData.track_name}`);
      } else if (isSpotifyLocalUrl) {
        log.debug(`[ART] No local art found for Spotify local file: ${trackData.track_name}`);
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
      this.mergeEnriched(trackData); // Restore enriched art from persistent store
      log.info(`[LYRICS] Cache hit (${lyrics.length} lines)`);
    } else {
      // Show "Fetching Lyrics..." while searching (only when lyrics display is enabled)
      if (this.config.get('show_lyrics') !== false) {
        this.lyricsEngine.setFetchingLyrics(true);
      }

      // Fire metadata fetch independently so album art appears ASAP
      // Also run when album_art_url is /api/thumbnail (local-only SMTC thumb) — Discord RPC needs a public CDN URL
      // Determine source type early (needed by both metadata and lyrics branches)
      const isYouTubeSource = src === 'youtube' || src === 'youtube_music' || src.startsWith('browser_');
      const isVideoSource = VIDEO_SOURCES.some(s => src.startsWith(s));

      // Metadata enrichment disabled per user request
      const metadataPromise = Promise.resolve();

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
                // Persist in enrichedMeta so it survives subsequent poll cycles
                const existing = this.enrichedMeta.get(this.currentTrackKey);
                if (existing) {
                  existing.album_art_url = ccResult.thumbnailUrl;
                } else {
                  this.enrichedMeta.set(this.currentTrackKey, {
                    album_art_url: ccResult.thumbnailUrl,
                    album_name: trackData.album_name,
                    artist_name: trackData.artist_name,
                  });
                }
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

      // Wait for both to complete before starting lyrics engine
      const [, lyricsResult] = await Promise.all([metadataPromise, lyricsPromise]);
      lyrics = lyricsResult;

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
    const uploadedUrl = this.currentTrack?.album_art_url?.startsWith('https://') ? this.currentTrack.album_art_url : null;
    trackData.album_art_url = uploadedUrl || originalAlbumArtUrl;
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
    
    // Clear "Fetching Lyrics..." status message since fetch is complete
    this.lyricsEngine.setFetchingLyrics(false);
    
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
    this.enrichedMeta.clear();
    this.prefetchedKey = '';
    log.info(`Lyrics cache cleared (${count} entries)`);
    return count;
  }
  /** Import custom lyrics into the local SQLite database. */
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
    this.config.setMany(updates as any);
    this.emit('configUpdate', this.config.getAll());
  }
  getCurrentTrack() { return this.currentTrack; }
  getSourceMode() { return this.sourceMode; }
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
    try {
      fs.mkdir(path.dirname(this.statsHistoryPath), { recursive: true }, (err) => {
        if (err) return log.warn(`Failed to create stats history directory: ${err}`);
        fs.writeFile(this.statsHistoryPath, JSON.stringify(this.statsHistory, null, 2), 'utf-8', (writeErr) => {
          if (writeErr) log.warn(`Failed to save stats history: ${writeErr}`);
        });
      });
    } catch (e) {
      log.warn(`Failed to save stats history: ${e}`);
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
  isSpotifyConnected() { return this.spotify?.isAuthenticated ?? false; }
  isSpicetifyActive() { return this.spicetify.isActive; }

  /** Push connection status to dashboard via SSE. */
  private emitStatus(): void {
    this.emit('statusUpdate', {
      discordConnected: this.discord.isConnected,
      spotifyConnected: this.spotify?.isAuthenticated ?? false,
      spicetifyActive: this.spicetify.isActive,
      sourceMode: this.sourceMode,
      showLyrics: this.config.get('show_lyrics') !== false,
    });
  }

  /**
   * Reconnect Discord with a different App ID based on media source.
   * This changes the application name shown in Discord.
   */
  private async reconnectDiscordForSource(source: string): Promise<void> {
    const platformAppId = PLATFORM_DISCORD_APP_IDS[source];
    const defaultAppId = this.config.get('discord_app_id') || process.env.DISCORD_CLIENT_ID || '';
    const targetAppId = platformAppId || defaultAppId;

    // No change needed
    if (targetAppId === this.currentDiscordAppId) return;

    log.info(`[DISCORD] Switching App ID for ${source}: ${this.currentDiscordAppId || 'default'} → ${targetAppId}`);

    // Store current activity to restore after reconnect
    const wasConnected = this.discord.isConnected;

    // Close current connection
    this.discord.close();

    // Create new DiscordIPC with new App ID
    this.discord = new DiscordIPC(targetAppId);
    this.currentDiscordAppId = targetAppId;

    // Re-wire callbacks
    this.discord.onReady(() => {
      log.info('Discord RPC connected ✓');
      this.setIdlePresence();
      this.emitStatus();
    });
    this.discord.onDisconnect(() => {
      log.warn('Discord disconnected — will retry');
      this.emitStatus();
    });

    // Re-wire lyrics engine callback for Discord
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

    // Connect in background
    if (wasConnected) {
      this.discord.connect().catch(() => {});
    }
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
    this.lastStatsKey = trackKey;
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
      rpc_button2_label: cfg.rpc_button2_label,
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

  /** Merge persisted enriched metadata (album art, album name, full artist) into a track object. */
  private mergeEnriched(track: TrackData): void {
    // Metadata enrichment disabled per user request
    return;
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
    evictUntil(this.enrichedMeta, 50);
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
