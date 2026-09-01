/**
 * VybecordBackend — main orchestrator (desktop edition).
 *
 * One track source: NativeMediaSource, reading Windows media sessions through a
 * NAPI addon. The Spicetify extension, the browser userscripts and the
 * PowerShell SMTC reader are all gone — everything known about playback now
 * comes from the OS, so there is nothing for the user to install into Spotify or
 * their browser for the app to work.
 *
 * What that costs, and why it is still the right trade: push sources supplied
 * metadata the OS does not expose — playlist context, shuffle/repeat state,
 * artist images, canonical track URLs. Those fields are simply absent now.
 * Everything the *lyrics* pipeline needs (title, artist, album, duration,
 * position) the OS does expose, so the core of the app is unaffected.
 *
 * Flow:
 *   1. Start the native media monitor (Windows only)
 *   2. Connect to Discord IPC
 *   3. Poll the source every N ms for the current track
 *   4. On new track → fetch lyrics (local DB → LRCLib/Netease/Musixmatch race)
 *   5. Feed lyrics to LyricsEngine → precise setTimeout scheduling → RPC updates
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createLogger } from './core/logger.js';
import { ConfigManager, sanitizeConfigUpdate, normalizeUserPath } from './core/config.js';
import { NativeMediaSource, looksLikeSpotifyAd, type DetectedPlayer } from './core/native-media-source.js';
import { SpicetifySource } from './core/spicetify-source.js';
import { YouTubeSource } from './core/youtube-source.js';
import { SoundCloudSource } from './core/soundcloud-source.js';
import { BandcampSource } from './core/bandcamp-source.js';
import { KickSource } from './core/kick-source.js';
import { TwitchSource } from './core/twitch-source.js';
import { DiscordIPC } from './core/discord-ipc.js';
import { LyricsEngine } from './sync/lyrics-engine.js';
import { fetchLyrics, fetchPlainLyrics, findCustomLyrics } from './core/provider.js';
import { fetchYouTubeCaptions, clearCCCache, setCcCookiesFile } from './core/youtube-captions.js';
import { initLocalDb, closeLocalDb, insertCustomLyrics, listCustomLyrics, getCustomLyrics, updateCustomLyrics, deleteCustomLyrics, findExistingCustomLyrics, searchLrclibDump as searchLrclibDumpDb, getLrclibTrackLyrics as getLrclibTrackLyricsDb, lrclibDumpStatus } from './core/local-lyrics-db.js';
import { initLastFm, scrobbleTrackStart, checkAndScrobble, scrobblePause, scrobbleTrackEnd } from './core/lastfm.js';
import { lookupCoverArt } from './core/cover-art.js';
import { configureArtUpload, uploadCoverArt, thumbnailSignature } from './core/art-upload.js';
import { extractLocalArt, extractArtFromPath } from './core/local-art.js';
import { initBlacklist, flagLyrics, isLyricsFlagged, clearFlags, listFlaggedTracks, clearFlagsByKey } from './core/lyrics-blacklist.js';
import { initHistory, historyTrackStart, historyTrackPause, historyTrackResume, historyTrackEnd, historyUpdateArt, getHistoryPage, getWrappedStats } from './core/listening-history.js';
import { releaseJapaneseTokenizer } from './core/romanize.js';
import { initLyricsOffsets, getTrackOffset, setTrackOffset } from './core/lyrics-offsets.js';
import { translateBatch, translateText, getCachedTranslation, isTranslationWorthFetching } from './core/translate.js';
import { asNonNegativeInt, asRecord, asText, evictLeast, evictOldest, evictUntil } from './core/utils.js';
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

/**
 * What a browser tab can turn out to be once the extension names it.
 *
 * Consulted only when a pin is placed on a media session Windows could not
 * identify beyond "some tab in Edge" — see mayOwnPresence. Spotify is absent on
 * purpose: its push comes from Spicetify inside the desktop client, never from
 * a browser tab.
 */
const BROWSER_PUSH_SOURCES = new Set(['youtube', 'youtube_music', 'soundcloud', 'bandcamp', 'kick', 'twitch']);
/** Live-stream sources: logged in the history, never counted as music played. */
const STREAM_SOURCES = new Set(['twitch', 'kick']);

const WEB_SOURCES = ['browser_', 'soundcloud', 'bandcamp', 'youtube'];
const VIDEO_SOURCES = ['browser_', 'youtube'];
const ARTIST_SPLIT_RE = /[,]/;  // Precompiled — used in recordPlay + artist key extraction

/**
 * The second presence button, which is not the user's to change.
 *
 * It is the one that points at whatever is playing, and its wording has to
 * agree with where it leads: {platform} becomes the player's name, and the verb
 * follows suit — "Watch on YouTube" for video, "Listen on" for everything else
 * (see platformButtonLabel in the lyrics engine). A label of one's own choosing
 * had no way to keep that agreement, so the setting behind it was overridden
 * here long before it was taken out of the interface. Button 1 remains free.
 */
const PLATFORM_BUTTON_LABEL = '🎵 Listen on {platform}';

/** Ceiling on lyric lines accepted from one push. Longer than any real song. */
const MAX_PUSHED_LYRIC_LINES = 2000;

/**
 * Discord App ID used when the user has not configured one.
 * A distributed .exe ships without an `.env`, so without this fallback the app
 * could not start at all on someone else's machine. An application ID is public
 * information (Discord sends it to every client that sees the presence), unlike
 * a client secret — same reasoning as the platform IDs below.
 * Override it with `discord_app_id` in config.json or DISCORD_CLIENT_ID in .env.
 */
const DEFAULT_DISCORD_APP_ID = '1396531182426128394';

/**
 * How long to wait before acting on an App ID change.
 *
 * Switching App IDs means tearing down the Discord IPC socket and opening a new
 * one, and Discord stops accepting connections for tens of seconds if that
 * happens a few times in quick succession — which is exactly what clicking
 * through the player list does now that pinning drives the presence. Waiting a
 * moment turns a burst of changes into one reconnect. The old socket stays up
 * meanwhile, so the presence keeps flowing under the previous app's name for an
 * instant rather than going blank.
 */
const APP_ID_SWITCH_DEBOUNCE_MS = 1500;

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

/**
 * Whether two titles name the same song.
 *
 * Not an equality test: the OS session and Spotify's own metadata disagree
 * routinely on decoration — " - Remastered 2011", a "(feat. …)" one side spells
 * out and the other does not. Containment in either direction covers that
 * without admitting two different songs, which a similarity score would.
 * Both empty is not a match; that is the "nobody told us" case.
 */
function titlesAgree(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

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

/**
 * What one pushed source needs beyond the shape all six of them share.
 *
 * The handlers used to be six near-copies of the same twenty-line sequence:
 * coerce the payload, gate on the setting, check the pin, stop if paused,
 * compare against the current track, announce. Near-copies, not copies — and
 * the drift between them is what let a real bug live: the guard that stops a
 * paused Spotify taking the presence down for everything else was present in
 * five of the six, and the sixth flickered the presence every two seconds.
 *
 * So the sequence lives in ingestPush() and each source supplies only what
 * genuinely differs. Everything a source can vary is a field here, which also
 * means a new source cannot silently omit a step.
 */
interface PushSpec<T> {
  source: {
    /** Coerce and store the raw payload; hand back the checked object. */
    update(raw: unknown): T;
    getCurrentTrack(): TrackData | null;
  };
  /** The per-platform detection setting. Only an explicit `false` disables. */
  configKey: keyof VybecordConfig;
  /** Whether the payload reports playback, however that source words it. */
  playing(data: T): boolean;
  /** The name a pin is matched against — see mayOwnPresence(). */
  presenceSource(data: T): string;
  /** Whether the presence currently on air belongs to this source. */
  owns(): boolean;
  /** What the [NEW TRACK] line calls this source. */
  label: string;
  /** Counts as web playback — see cachedIsWebSource. */
  web: boolean;
  /** A broadcast: no length to loop against, so no repeat detection. */
  live?: boolean;
  /** Anything extra worth putting on the [NEW TRACK] line. */
  detail?(track: TrackData): string;
  /**
   * Fields worth a debug line that only this source has.
   *
   * Spicetify is the one that carries playlist context, shuffle and repeat, and
   * those are exactly what a "the presence says the wrong playlist" report
   * needs. The others have nothing the shared lines do not already show.
   */
  debug?(data: T): string;
}

export class VybecordBackend extends EventEmitter {
  private config: ConfigManager;
  private media: NativeMediaSource | null = null;
  private mediaWorkerPath: string;
  private lrclibWorkerPath: string;
  /** Pending App ID switch — see APP_ID_SWITCH_DEBOUNCE_MS. */
  private appIdSwitchTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Push sources, fed by the browser extension.
   *
   * These supply what a media session cannot: which site a tab is on, the
   * canonical track URL, the position straight from the page's own audio
   * element, and live-stream start times. They stay dormant until the extension
   * pushes for the first time, so an install without it behaves exactly as if
   * they were absent.
   */
  private spicetify: SpicetifySource;
  private youtubeSource: YouTubeSource;
  private soundcloudSource: SoundCloudSource;
  private bandcampSource: BandcampSource;
  private kickSource: KickSource;
  private twitchSource: TwitchSource;
  /** track_id → synced lyrics pushed from the Spotify web player. */
  private spotifyLyricsStore = new Map<string, LyricLine[]>();
  private discord: DiscordIPC;
  private lyricsEngine: LyricsEngine;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;  // re-entrance guard for the async poll() (see poll())
  private currentTrack: TrackData | null = null;
  private currentTrackKey = '';
  private currentCacheKey = '';
  private lyricsCache = new Map<string, LyricLine[]>();
  private lastLyricsState: { current: string; next: string; prev: string; progress_ms: number; duration_ms: number; translation?: string } | null = null;
  private fetchAbort: AbortController | null = null;  // cancel in-flight fetches on track skip
  /** Thumbnail the last art resolution acted on — see resolveDiscordArt(). */
  private artThumbSig = '';
  private shuttingDown = false;
  /** True while the OS has seen no input for longer than away_after_minutes —
   *  the same window in which Discord flips the account to Idle. Driven from
   *  the main process; see setUserAway(). */
  private userAway = false;
  private idleSince = 0;  // grace period timestamp (prevent SMTC flicker)
  private lastAdState = false;  // so the ad status is pushed on change, not every poll
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
  /** When this session began — the identity of its row in the stats history. */
  private readonly sessionStartedAt = new Date().toISOString();
  /** Whether this session's row is already at the head of statsHistory. */
  private sessionRowSaved = false;
  /** Album of the last play accepted as real — lets recordPlay() tell an
   *  interlude from an advertisement, the same way the media source does. */
  private lastRecordedAlbum = '';

  /**
   * @param configDir  where config.json, the lyrics DB and logs live
   * @param mediaWorkerPath  absolute path to the built media-worker.cjs. The
   *   backend cannot derive it: it is bundled by the Electron build, not by the
   *   backend's own module layout.
   * @param lrclibWorkerPath  absolute path to the built lrclib-worker.cjs, for
   *   the same reason. Empty disables the LRCLIB dump; the app still runs on the
   *   custom store and the online providers.
   */
  constructor(configDir: string, mediaWorkerPath: string, lrclibWorkerPath = '') {
    super();
    this.configDir = configDir;
    this.mediaWorkerPath = mediaWorkerPath;
    this.lrclibWorkerPath = lrclibWorkerPath;
    this.statsHistoryPath = path.join(configDir, 'stats-history.json');
    this.statsHistory = this.loadStatsHistory();
    this.config = new ConfigManager(configDir, (cfg) => {
      log.info('Config changed — will apply on next poll');
      // Reached only when config.json is edited by hand: the app's own writes
      // set skipNextReload, so updateConfig() has to call this too.
      this.syncCcLanguage(cfg.cc_lang);
      this.emit('configUpdate', cfg);
    });
    // Seed before anything can change, so the first change is seen as one.
    this._lastCcLang = this.config.get('cc_lang') as string | undefined;

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
      this.media?.setAdFilter(cfg.filter_spotify_ads !== false);
      // Emit status update for dashboard (showLyrics badge, etc.)
      this.emitStatus();

      if (!this.discord.isConnected) return;

      // Answered first, and without looking at what is playing: turning "hide
      // when away" on while already idle has to take the presence down, and
      // turning it off has to bring it straight back.
      if (this.presenceHidden) {
        this.discord.clearActivity().catch(() => {});
        return;
      }

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
        const rpcConfig = this.rpcConfigForTrack(this.currentTrack);
        const cachedLyrics = this.lyricsCache.get(this.currentCacheKey);
        if (!cachedLyrics) {
          // Lyrics never fetched for this track — trigger a full fetch
          this.onNewTrack(this.currentTrack).catch(() => {});
        } else {
          this.lyricsEngine.startTrack(cachedLyrics, this.currentTrack, rpcConfig);

          // Re-warm for the language that was just picked, or for the toggle
          // that was just switched on.
          this.warmTranslations(cachedLyrics);
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
        initLocalDb(this.configDir, this.config.get('lrclib_dump_path'), this.lrclibWorkerPath),
        new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('Database initialization timeout (30s)')), 30000))
      ]);
    } catch (e) {
      log.error(`Local database initialization failed: ${e}`);
      log.error('Imported lyrics will not be available. Run: npm rebuild better-sqlite3');
    }

    if (localDbInitialized) {
      log.info('Local lyrics database initialized successfully');
    }

    this.applyLastFmConfig();

    this.applyArtUploadConfig();

    this.applyCaptionsConfig();

    const blacklistInitialized = initBlacklist(this.configDir);
    if (blacklistInitialized) {
      log.info('Lyrics blacklist initialized successfully');
    } else {
      log.warn('Lyrics blacklist initialization failed - flagged lyrics will not work');
    }

    initHistory(this.configDir);
    initLyricsOffsets(this.configDir);

    // 1. Start the native media monitor. It is now the only track source, so
    //    its failure leaves nothing to detect — but it must still not abort
    //    startup: the window has to open so it can explain what went wrong.
    try {
      await this.startMediaSource();
    } catch (e) {
      log.error(`Native media source unavailable: ${e}`);
      log.error('No playback can be detected. Windows 10 1809 or later is required.');
    }

    // 2. Discord RPC connect (with retry)
    this.wireDiscordHandlers();

    // Connect in background (don't block startup)
    this.discord.connectWithRetry().catch(e => {
      log.error(`Discord connection failed: ${e}`);
    });

    // 3. Start polling
    // The `||` is for a config that predates the key, not a second default —
    // DEFAULTS in config.ts is the one that decides, and the two have to agree.
    const interval = this.config.get('poll_interval_ms') || 1000;
    log.info(`Starting polling (every ${interval}ms)`);
    this.pollTimer = setInterval(() => this.poll(), interval);

    // Immediate first poll
    this.poll();
  }

  // ── Track source ──

  private async startMediaSource(): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('Windows media sessions require Windows');
    }
    this.media = new NativeMediaSource(this.mediaWorkerPath);
    this.media.setAdFilter(this.config.get('filter_spotify_ads') !== false);
    await this.media.start();
    if (!this.media.isReady) throw new Error('the media session monitor failed to initialise');
    log.info('Native media source started ✓');
  }

  // ── Player picker (surfaced in the window) ──

  /** Every media session Windows currently reports, playing or not. */
  listPlayers(): DetectedPlayer[] {
    return this.media?.listPlayers() ?? [];
  }

  /** Pin the presence to one player; null restores automatic priority. */
  setPreferredPlayer(appId: string | null): void {
    this.media?.setPreferredSource(appId);
    this.emitStatus();
    // Re-decide now rather than at the next tick. Whoever holds the presence
    // may be exactly the player just excluded, and a second of the old one
    // still showing reads as the click not having worked.
    void this.poll();
  }

  getPreferredPlayer(): string | null {
    return this.media?.getPreferredSource() ?? null;
  }

  /**
   * Whether a source may own the presence right now.
   *
   * With no pin, anything may — the usual priority order decides. With a pin,
   * only the pinned player, and nothing else for as long as it stands. The
   * media source already enforces that among Windows' own sessions; this is the
   * same rule extended to the browser extension, which the pick inside
   * NativeMediaSource never sees.
   *
   * A pin is on a player, not on a transport. The extension pushing for the
   * same service the pinned session is announced as counts as that player
   * rather than as a rival — pinning the YouTube tab must not then reject the
   * extension's much better data about that very tab.
   *
   * A pin whose player is not running blocks everything, which is what makes it
   * a pin rather than a preference: the window says "waiting for it to play"
   * instead of quietly handing the presence to whatever else is open.
   */
  /**
   * Whether to leave this platform to the browser extension instead of
   * announcing the OS media session ourselves.
   *
   * Standing aside is right while the extension is reporting the same playback:
   * it reads the page directly, so its position, artist and URLs beat anything
   * the OS session can offer, and without this the two fight over the presence
   * on every poll.
   *
   * It is wrong whenever the extension is not going to report anything, because
   * then nobody announces and the presence sits on whatever it happened to hold.
   * Two ways that happens, both of which need a pin to be set:
   *
   *   - the pin excludes that source outright, so it will never publish;
   *   - it is sitting paused while Windows says the pinned player is playing,
   *     which means the two are describing different playback.
   *
   * @param reporting  the source's own "I am the one covering this" test, kept
   *   verbatim per platform so behaviour with no pin is exactly as before.
   */
  private deferToPush(pushSource: string, reporting: boolean, paused: boolean): boolean {
    if (!reporting || !this.mayOwnPresence(pushSource)) return false;
    return !(paused && this.media?.getPreferredSource());
  }

  private mayOwnPresence(mediaSource: string): boolean {
    if (!this.media?.getPreferredSource()) return true;
    const pinned = this.media.pinnedSourceName();
    if (pinned === null) return false;  // pinned to a player that is not running
    if (pinned === mediaSource) return true;
    /*
     * A pin on a browser session Windows could not name.
     *
     * `browser_edge` is not a service, it is an admission: the media session
     * says a tab is playing and nothing more. The extension saying that tab is
     * YouTube is better information about the same playback, not a rival — so a
     * pin placed on the anonymous session has to accept it, or pinning a
     * browser tab would announce nothing at all.
     *
     * Spotify is not in that set: its push comes from Spicetify, inside the
     * desktop client, so it is never what an unnamed browser tab turned out to
     * be.
     */
    return pinned.startsWith('browser_') && BROWSER_PUSH_SOURCES.has(mediaSource);
  }

  /**
   * Whether a pin names this source — somebody asking for this player by hand.
   *
   * Distinct from mayOwnPresence, which answers "may this go on air" and is
   * true for everything while nothing is pinned. This one is true only when a
   * pin exists and points here, which is what makes it a reason to override a
   * setting rather than merely permission to proceed.
   *
   * A pin outranks the detection switches. Picking a player off the Players
   * page is the most explicit statement of intent the app has, and it used to
   * lose in silence to a toggle set weeks earlier and long forgotten: the
   * switch was read first, so pinning a player whose platform was off announced
   * nothing, gave no reason, and looked like pinning was broken. Nothing else
   * moves — the pin still cannot conjure a player that is not running, and an
   * unpinned platform that is switched off stays off.
   */
  private isPinnedSource(mediaSource: string): boolean {
    if (!this.media?.getPreferredSource()) return false;
    const pinned = this.media.pinnedSourceName();
    if (pinned === null) return false;
    if (pinned === mediaSource) return true;
    return pinned.startsWith('browser_') && BROWSER_PUSH_SOURCES.has(mediaSource);
  }

  // ── Browser-extension push handlers ──────────────────────────────────────

  /**
   * Take one push from a browser-extension or Spicetify source.
   *
   * The whole sequence, once, for all six. See PushSpec for why.
   *
   * Two things here are not what the six copies did, and both are corrections
   * rather than tidying:
   *
   *   - The detection gate is `=== false` everywhere. Three of the handlers
   *     spelled it `!config.get(key)`, which also refuses a key that is simply
   *     absent — a config written before that platform existed would have
   *     switched it off rather than defaulted it on. The poll path already
   *     read it as `!== false`.
   *   - A track that reaches its end and starts again is picked up for every
   *     source, not only Spotify. See resumeSameTrack().
   */
  private ingestPush<T>(raw: unknown, spec: PushSpec<T>): void {
    // The source coerces the push and hands back the checked object; everything
    // below reads that rather than whatever arrived on the socket.
    const data = spec.source.update(raw);
    if (spec.debug) log.debug(`[${spec.label}] ${spec.debug(data)}`);

    // The pin is read first: it outranks the detection switch. See
    // isPinnedSource for why an explicit choice should not lose to a stale one.
    const pushSrc = spec.presenceSource(data);
    if (!this.isPinnedSource(pushSrc) && this.config.get(spec.configKey) === false) return;
    if (!this.mayOwnPresence(pushSrc)) return;

    if (!spec.playing(data)) {
      /*
       * Paused, and the push is authoritative — no grace period needed.
       *
       * Only when the presence is actually this source's, though. The
       * extensions push on a timer whether or not anything is playing, so a
       * paused player in the background would otherwise take down whatever
       * else is on air, every couple of seconds, for as long as it sat there.
       */
      if (spec.owns()) this.onTrackStopped();
      return;
    }

    const track = spec.source.getCurrentTrack();
    if (!track) return;

    this.idleSince = 0;
    const trackKey = this.buildTrackKey(track);

    if (trackKey === this.currentTrackKey) {
      log.debug(`[${spec.label}] Same track: ${track.track_name} — ${track.artist_name} (${trackKey})`);
      // Per track, not per source: Kick and Twitch are always a broadcast, but
      // YouTube is one only when the video is, and a premiere sitting in the
      // same tab as ordinary videos has to be read from the track itself.
      this.resumeSameTrack(track, !!spec.live || track.is_live === true);
      return;
    }

    this.currentTrackKey = trackKey;
    this.currentTrack = track;
    this.cachedIsWebSource = spec.web;
    log.info(`[NEW TRACK] ${track.track_name} — ${track.artist_name} (${spec.label})${spec.detail?.(track) ?? ''}`);
    this.recordPlay(track);
    this.emit('trackUpdate', track);
    this.onNewTrack(track).catch(e => log.error(`[NEW TRACK] Error: ${e}`));
  }

  /**
   * The same track pushed again — keep the engine's clock on the player's.
   *
   * A live stream takes the short path: it has no length, so there is no repeat
   * to detect, and what the engine needs from the fresh object is
   * stream_start_time_ms rather than a position to compare against.
   *
   * The restart branch used to exist for Spotify alone, and its absence
   * elsewhere was a real gap. When a track reaches its end the engine stops; if
   * the player then loops the same song, checkRepeatLoop cannot see it — a
   * stopped engine reports zero elapsed, so nothing exceeds the duration — and
   * syncTrackProgress's end-detection does not fire either. The lyrics simply
   * stayed dead for the whole of the repeat. It now applies to every source
   * that reports a duration.
   */
  private resumeSameTrack(track: TrackData, live: boolean): void {
    this.currentTrack = track;

    if (live) {
      this.lyricsEngine.syncProgress(track.progress_ms, track);
      return;
    }

    if (this.checkRepeatLoop(track)) return;

    if (!this.lyricsEngine.isRunning() && track.duration_ms > 0 && track.progress_ms < 5000) {
      log.info(`[REPEAT] Engine stopped but track restarted (progress=${track.progress_ms}ms) — re-starting`);
      this.recordPlay(track);
      this.emit('trackUpdate', track);
      this.onNewTrack(track).catch(e => log.error(`[REPEAT] Error: ${e}`));
      return;
    }

    this.syncTrackProgress(track);

    /*
     * The artist image arrives late when it arrives at all — the extension
     * fetches it after its first push — so the stats row created at track start
     * has none. Backfill it rather than leaving that artist blank for the rest
     * of the session. Only Spicetify supplies one today; the test costs nothing
     * for the sources that never will.
     */
    if (track.artist_art_url) {
      const primaryArtist = track.artist_name.split(ARTIST_SPLIT_RE)[0].trim().toLowerCase();
      const entry = this.sessionArtistPlays.get(primaryArtist);
      if (entry && !entry.artist_art) {
        entry.artist_art = track.artist_art_url;
        this.statsDirty = true;
        this.emit('statsUpdate', this.getSessionStats());
      }
    }
  }

  handleSpicetifyPush(raw: unknown): void {
    this.ingestPush(raw, {
      source: this.spicetify,
      configKey: 'detect_spotify',
      playing: d => d.is_playing,
      presenceSource: () => 'spotify',
      owns: () => this.currentTrack?.media_source === 'spotify',
      label: 'spicetify',
      web: false,   // Spicetify runs inside the Spotify client, not a browser tab
      detail: t => `${t.is_local ? ' [local]' : ''}${t.context_name ? ` [${t.context_name}]` : ''}`,
      debug: d => `track="${d.track_name}" album="${d.album_name}" context="${d.context_name}"`
        + ` ctx_type="${d.context_type}" shuffle=${d.is_shuffle} repeat=${d.repeat_mode}`,
    });
  }

  handleYouTubePush(raw: unknown): void {
    this.ingestPush(raw, {
      source: this.youtubeSource,
      configKey: 'detect_youtube',
      playing: d => d.is_playing,
      // YouTube Music announces itself separately, and a pin must be able to
      // tell the two apart.
      presenceSource: d => d.source || 'youtube',
      owns: () => this.currentTrack?.media_source === 'youtube'
        || this.currentTrack?.media_source === 'youtube_music',
      label: 'youtube-userscript',
      web: true,
    });
  }

  isYouTubeSourceActive(): boolean { return this.youtubeSource.isActive; }

  handleSoundCloudPush(raw: unknown): void {
    this.ingestPush(raw, {
      source: this.soundcloudSource,
      configKey: 'detect_soundcloud',
      playing: d => d.is_playing,
      presenceSource: () => 'soundcloud',
      owns: () => this.currentTrackKey.startsWith('sc:'),
      label: 'soundcloud-userscript',
      web: true,
    });
  }

  isSoundCloudSourceActive(): boolean { return this.soundcloudSource.isActive; }

  handleBandcampPush(raw: unknown): void {
    this.ingestPush(raw, {
      source: this.bandcampSource,
      // Bandcamp has no switch of its own; it rides the "other apps" one.
      configKey: 'detect_other_apps',
      playing: d => d.is_playing,
      presenceSource: () => 'bandcamp',
      owns: () => this.currentTrackKey.startsWith('bc:'),
      label: 'bandcamp-userscript',
      web: true,
    });
  }

  isBandcampSourceActive(): boolean { return this.bandcampSource.isActive; }

  handleKickPush(raw: unknown): void {
    this.ingestPush(raw, {
      source: this.kickSource,
      configKey: 'detect_kick',
      // A stream is live or it is not; there is no pause to report.
      playing: d => d.is_live,
      presenceSource: () => 'kick',
      owns: () => this.currentTrackKey.startsWith('kick:'),
      label: 'kick-userscript',
      web: true,
      live: true,
    });
  }

  isKickSourceActive(): boolean { return this.kickSource.isActive; }

  handleTwitchPush(raw: unknown): void {
    this.ingestPush(raw, {
      source: this.twitchSource,
      configKey: 'detect_twitch',
      playing: d => d.is_live,
      presenceSource: () => 'twitch',
      owns: () => this.currentTrackKey.startsWith('twitch:'),
      label: 'twitch-userscript',
      web: true,
      live: true,
    });
  }

  isTwitchSourceActive(): boolean { return this.twitchSource.isActive; }

  // ── Spotify Web lyrics handler (event-driven, called by web server) ──

  /**
   * The title Spotify is playing under this track id, as the extension reports
   * it — or '' when the extension is not reporting, or has moved on.
   *
   * A Spotify track id means nothing to the rest of the app: the OS media
   * session names a track by its title, never by an id. This is the only place
   * the two can be reconciled, because the extension is the one side that holds
   * both.
   */
  private spotifyPushedTitle(trackId: string): string {
    const latest = this.spicetify.latest;
    return latest && latest.track_id === trackId ? latest.track_name : '';
  }

  handleSpotifyLyrics(raw: unknown): void {
    /*
     * Coerced the same way the six track sources are, and for the same reason:
     * this array comes off the socket, and a line whose `text` is a number
     * reaches `.trim()` one step later. Lines are also capped — a push claiming
     * a hundred thousand of them would otherwise be kept in memory whole, and
     * no song has more lines than a long audiobook chapter.
     */
    const d = asRecord(raw);
    const trackId = asText(d.track_id, 200);
    if (!trackId || !Array.isArray(d.lines)) return;

    const lines: LyricLine[] = [];
    for (const entry of d.lines.slice(0, MAX_PUSHED_LYRIC_LINES)) {
      const l = asRecord(entry);
      const text = asText(l.text, 400);
      if (!text) continue;
      lines.push({ time: asNonNegativeInt(l.time), text });
    }
    // Timestamps are what the engine binary-searches; an out-of-order push
    // would make findLyricIndex return nonsense for the whole song.
    lines.sort((a, b) => a.time - b.time);

    // Store for later lookup (onNewTrack will check this)
    this.spotifyLyricsStore.set(trackId, lines);
    evictOldest(this.spotifyLyricsStore, 10);

    log.info(`[SPOTIFY-LYRICS] Received ${lines.length} lines for track ${trackId}`);

    // Hot-inject if this is the currently playing track
    if (this.currentTrack && lines.length > 0) {
      const currentId = this.currentTrack.track_id;
      const spotifyId = trackId;
      // Direct match (track_id identical) or Spicetify key starts with the Spotify ID
      const directMatch = currentId === spotifyId || this.currentTrackKey.startsWith(spotifyId + '|');
      /*
       * Fallback: the presence is on the OS media session (`desktop:` prefix)
       * while Spicetify is the one that can read the lyrics. The two describe
       * the same playback, so the push still applies — but only if they really
       * are the same song, and only the extension can say which song this id
       * belongs to.
       *
       * This used to test `currentId.includes(currentTrack.track_name)`, which
       * is true by construction: the id *is* `desktop:<title>:<artist>`. So the
       * test always passed, and any lyrics Spotify pushed were injected over
       * whatever happened to be playing — a YouTube tab included.
       */
      const nameMatch = !directMatch
        && currentId.startsWith('desktop:')
        && titlesAgree(this.spotifyPushedTitle(spotifyId), this.currentTrack.track_name);
      if (directMatch || nameMatch) {
        // Not over the user's own copy. This push arrives for every track
        // Spotify has lyrics for, including the ones that were imported
        // precisely because Spotify's version is the wrong one.
        if (this.findImportedLyrics(this.currentTrack)) {
          log.info('[SPOTIFY-LYRICS] Imported lyrics in use for this track — push ignored');
          return;
        }
        const cacheKey = this.currentCacheKey;
        this.lyricsCache.set(cacheKey, lines);
        this.lyricsEngine.injectLyrics(lines, this.currentTrack);
        // These arrive after the track's own warm-up has already run over
        // whatever lyrics were found first, so they need one of their own.
        this.warmTranslations(lines);
        log.info(`[SPOTIFY-LYRICS] Hot-injected ${lines.length} official lyrics for current track (${directMatch ? 'id' : 'name'} match)`);
      }
    }
  }

  // ── Polling ──

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
  }[] = [];

  /** Initialised lazily because the sources are set in the constructor body. */
  private ensurePollSources(): void {
    if (this.pollSources.length) return;
    this.pollSources.push(
      { source: this.youtubeSource,    configKey: 'detect_youtube',     keyPrefix: 'yt:' },
      { source: this.soundcloudSource, configKey: 'detect_soundcloud',  keyPrefix: 'sc:' },
      { source: this.bandcampSource,   configKey: 'detect_other_apps',  keyPrefix: 'bc:' },
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
    for (const { source, configKey, keyPrefix, isLive } of this.pollSources) {
      if (!source.isActive || this.config.get(configKey) === false) continue;
      const track = source.getCurrentTrack();
      if (track) {
        // `continue`, not `return`: a source the pin excludes must not claim the
        // tick either, or the pinned player — reached further down, in the OS
        // media session — would never get one.
        if (!this.mayOwnPresence(track.media_source)) continue;
        const trackKey = this.buildTrackKey(track);
        // Same decision as a push arriving for the track already on air, so it
        // is the same code. The poll used to carry its own shorter copy, which
        // is why a looping track never restarted the lyrics when the poll was
        // the one to notice rather than a push.
        if (trackKey === this.currentTrackKey) {
          this.resumeSameTrack(track, !!isLive || track.is_live === true);
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


  /**
   * Poll tick: pick whichever source should own the presence right now.
   *
   * Push sources (the browser extension) outrank the OS media session, because
   * they know things it cannot: which site a tab is on, the canonical URL, the
   * position read from the page's own audio element. They are dormant until the
   * extension pushes, so with no extension installed this collapses to the
   * native path alone.
   *
   * For the native source this is not what discovers a track — media-changed
   * events beat it there. It keeps the lyrics engine's clock tied to the
   * player's and notices the transition to nothing-playing, which produces no
   * event of its own.
   */
  private async poll(): Promise<void> {
    // Re-entrance guard: onNewTrack() awaits the lyric-provider race, and a slow
    // one must not let the next tick start a competing fetch for the same track.
    if (this.polling) return;
    this.polling = true;
    try {
      this.ensurePollSources();

      // Priority 1: the Spotify web player — richest metadata of any source.
      if (this.spicetify.isActive && this.mayOwnPresence('spotify')) {
        const spTrack = this.spicetify.getCurrentTrack();
        if (spTrack && this.config.get('detect_spotify') !== false) {
          const trackKey = this.buildTrackKey(spTrack);
          // The third copy of the same decision, now the same code as the other
          // two. Spotify never reports a broadcast, so this one is never live.
          if (trackKey === this.currentTrackKey) this.resumeSameTrack(spTrack, false);
          return;
        }
        // Paused or disabled — fall through, and let the table walk below hand
        // the tick to the other web sources. It used to call pollWebSources()
        // here as well, which walked every source twice per poll to reach the
        // same answer.
      }

      // Priority 2: every other push source, in table order.
      if (this.pollWebSources()) return;

      // Priority 3: the OS media session.
      if (!this.media) return;

      // An ad break produces no track, so without this the window would just say
      // "nothing playing" for 30 seconds and look broken. Only pushed on change.
      const ad = this.media.isAdPlaying();
      if (ad !== this.lastAdState) {
        this.lastAdState = ad;
        log.info(ad ? '[AD] Spotify advertisement — presence hidden' : '[AD] Advertisement over');
        this.emitStatus();
      }

      this.handleMediaTrack(this.media.getCurrentTrack(), ad);
    } catch (e) {
      log.error(`Poll error: ${e}`);
    } finally {
      this.polling = false;
    }
  }

  // ── Windows media session ──

  /**
   * @param adPlaying skips the idle grace period. An advertisement is a positive
   *   identification, not a gap in detection, so there is nothing to debounce —
   *   waiting the grace out would leave the previous song on the user's profile
   *   for the first seconds of every ad break.
   */
  private handleMediaTrack(track: TrackData | null, adPlaying = false): void {
    if (!track) {
      // Grace period: wait 1.5s before treating as truly idle (prevents SMTC flicker)
      if (this.currentTrack && !adPlaying) {
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

    // Per-platform detection gate — waived for the player the user pinned.
    const src = track.media_source || '';
    const pinnedHere = this.isPinnedSource(src);
    if (!pinnedHere && !this.config.get('detect_all_media') && !MUSIC_APPS.has(src)) {
      return;
    }
    const pKey = platformConfigKey(src);
    if (!pinnedHere && pKey && this.config.get(pKey) === false) {
      // Platform explicitly disabled — if it was the active track, stop it
      if (this.currentTrack && this.currentTrack.media_source === src) {
        this.onTrackStopped();
      }
      return;
    }

    /*
     * Stand aside when a push source owns this platform.
     *
     * The extension reads the page directly, so its position, artist and URLs
     * beat anything the OS session can offer for the same playback. Without
     * these guards the two would fight over the presence on every poll.
     *
     * When to stand aside and when not to is deferToPush's judgement — see
     * there for why a pin changes the answer.
     */
    if (src === 'spotify' && this.deferToPush('spotify',
      this.spicetify.isActive && !this.spicetify.isPaused, this.spicetify.isPaused)) return;

    // Browser tabs included: a media session cannot say which site a tab is on,
    // so any browser playback might be what the YouTube script is reporting.
    // wasRecentlyActive covers the gap after a tab closes, before it ages out.
    const isYtLike = src === 'youtube' || src === 'youtube_music' || src.startsWith('browser_');
    if (isYtLike && this.deferToPush('youtube',
      this.youtubeSource.isActive || this.youtubeSource.wasRecentlyActive
        || this.currentTrackKey.startsWith('yt:'),
      this.youtubeSource.isPaused)) return;

    if (src === 'soundcloud' && this.deferToPush('soundcloud',
      this.soundcloudSource.isActive || this.currentTrackKey.startsWith('sc:'),
      this.soundcloudSource.isPaused)) return;
    if (src === 'bandcamp' && this.deferToPush('bandcamp',
      this.bandcampSource.isActive || this.currentTrackKey.startsWith('bc:'),
      this.bandcampSource.isPaused)) return;

    const trackKey = this.buildTrackKey(track);

    if (trackKey === this.currentTrackKey) {
      // NOTE: Do NOT use checkRepeatLoop here — browser sessions report
      // progress_ms clamped to duration_ms, which reads as a repeat and drives an
      // endless REPEAT→DRIFT→REPEAT cycle. syncProgress's own isRepeatJump
      // handles genuine repeats.

      // Cover art can appear a beat after the track does: SMTC publishes the
      // metadata and the artwork as separate events, and the catalogue lookup
      // lands later still. The window only repaints its art on trackUpdate, so
      // without this it would keep the empty cover it was given at track start
      // for the whole song.
      const prevArt = this.currentTrack?.album_art_url ?? '';
      // What the OS itself reported, before the preservation below rewrites it.
      const osArt = track.album_art_url;
      // Never let a bare OS snapshot overwrite art the backend already resolved
      // to a real URL — snapshot() only ever reports the local placeholder.
      if (prevArt && prevArt !== '/api/thumbnail' && osArt === '/api/thumbnail') {
        track.album_art_url = prevArt;
      }
      this.currentTrack = track;
      if (track.album_art_url !== prevArt) {
        this.emit('trackUpdate', track);
      }

      /*
       * The artwork on disk is not final when the track starts.
       *
       * Windows publishes metadata and artwork as separate events, and a player
       * that has not loaded the cover yet fills the gap with its own logo —
       * Spotify does this for local files. Resolving once at track start
       * therefore published that logo, and the preservation above then pinned it
       * for the rest of the song while the real cover sat unused on disk.
       *
       * So resolution follows the file rather than the track. A changed
       * thumbnail is a different content hash, which is a different URL, and the
       * catalogue lookup behind it is cached per track — so this costs a stat
       * per poll and nothing else until the bytes actually change.
       *
       * Gated on what the OS reported rather than on what we resolved: a track
       * whose art already came from a provider as a real URL does not depend on
       * this file, and must not be re-pointed at a catalogue guess because some
       * other player rewrote the thumbnail.
       */
      if (osArt === '/api/thumbnail') {
        const sig = thumbnailSignature();
        if (sig && sig !== this.artThumbSig) {
          this.resolveDiscordArt(track, this.fetchAbort?.signal);
        }
      }

      /*
       * Whose clock to trust.
       *
       * The extension reads currentTime off the page's own audio element, which
       * is exact; a browser's media session publishes a position only every few
       * seconds. So when a push source is live for this playback, hand the
       * engine metadata only (-1) and let its own interpolation carry the time.
       */
      const pushOwnsProgress = this.cachedIsWebSource
        && (this.youtubeSource.isActive || this.soundcloudSource.isActive || this.bandcampSource.isActive);
      this.lyricsEngine.syncProgress(pushOwnsProgress ? -1 : track.progress_ms, track);

      // Browser sessions publish a position only every few seconds; the engine
      // interpolates between those, so its elapsed is the smoother of the two.
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
      // Parked, not ended: the play stays open so resuming this same song keeps
      // the listening time it already earned instead of starting the Last.fm
      // clock over — a song paused past halfway would otherwise never scrobble.
      scrobblePause();
      // Stop the history clock rather than letting it run until the next track
      // starts — otherwise a pause banks its whole length as listening. The
      // entry stays open so resuming this same track continues it.
      historyTrackPause();
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
  private syncTrackProgress(track: TrackData): void {
    this.currentTrack = track;
    this.lyricsEngine.syncProgress(track.progress_ms, track);
    // Every source, not a chosen few: the position reported here is how the
    // scrobbler tells listening apart from a player sitting on a paused song,
    // and a source that never reaches it can only ever scrobble at track end.
    checkAndScrobble(track.progress_ms);
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

  /**
   * Lyrics the user imported for this track, including under the song title a
   * YouTube-style "Artist - Song (Official Video)" buries.
   *
   * The stripped form is tried here, and not only in the captions branch, for
   * the same reason the import is consulted before the Spotify push: by the
   * time that branch runs, fetchLyrics has already returned whatever an online
   * provider had for the full title, and that would outrank an import filed
   * under the song's real name.
   */
  private findImportedLyrics(t: TrackData): LyricLine[] | null {
    const direct = findCustomLyrics(t.track_name, t.artist_name);
    if (direct) return direct;
    const dashIdx = t.track_name.indexOf(' - ');
    if (dashIdx <= 0) return null;
    return findCustomLyrics(t.track_name.slice(dashIdx + 3).trim(), t.track_name.slice(0, dashIdx).trim());
  }

  // ── New track handler ──

  private async onNewTrack(trackData: TrackData): Promise<void> {
    const rpcConfig = this.rpcConfigForTrack(trackData);

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
      this.resolveDiscordArt(trackData, signal);
    }

    // Phase 2: ASYNC — fetch lyrics in background
    const cacheKey = `${trackData.track_id}|${trackData.track_name}|${trackData.artist_name}|${trackData.duration_ms}`;
    this.currentCacheKey = cacheKey;

    // Preserve original album_art_url to prevent losing local art during lyrics search
    const originalAlbumArtUrl = trackData.album_art_url;

    /*
     * Lyrics the Spicetify extension pushed for this track.
     *
     * It fetches on songchange, so they routinely land before the track is set
     * up here — the hot-inject path in handleSpotifyLyrics only covers the
     * opposite order. Folding them into the cache now is what makes an early
     * push count instead of being stored and forgotten.
     */
    /*
     * Lyrics the user imported for this track, ahead of everything else.
     *
     * They used to be reachable only through fetchLyrics, which the two paths
     * below skip entirely whenever they have something: a Spotify track with an
     * official synced version never reached the custom store at all, so an
     * import made specifically to replace those lyrics did nothing. Asked here,
     * the import wins the same way for every source.
     */
    const imported = this.findImportedLyrics(trackData);
    if (imported) {
      this.lyricsCache.set(cacheKey, imported);
      log.info(`[LYRICS] Using ${imported.length} imported lines for this track`);
    }

    const pushed = this.spotifyLyricsStore.get(trackData.track_id);
    if (pushed?.length && !this.lyricsCache.get(cacheKey)?.length) {
      this.lyricsCache.set(cacheKey, pushed);
      log.info(`[SPOTIFY-LYRICS] Using ${pushed.length} lines pushed for this track`);
    }

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
            // Spotify's own lyrics do not come through here: the Spicetify
            // extension pushes them, and they are picked up from the cache above.
            // This chain is what runs when it has nothing — which is most of the
            // catalogue, and everything not playing through Spotify.
            //
            // Browser tabs count as YouTube here. The userscripts used to declare
            // `media_source: 'youtube'`; the OS session says only "MSEdge" and
            // publishes the video title as the track and the channel as the
            // artist, with nothing naming the site. Requiring a literal 'youtube'
            // meant captions never ran for browser playback at all — which is
            // where nearly all of it happens. Guessing wrong is cheap: captions
            // are only reached after the local database and every lyrics
            // provider have missed, and a search that finds nothing just returns
            // empty.
            const isYouTubeSource = trackData.media_source === 'youtube'
              || trackData.media_source === 'youtube_music'
              || trackData.media_source.startsWith('browser_');

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

              /*
               * Use the exact video when we have it.
               *
               * The extension reports the id and the source keys its track_id as
               * `yt:<id>`, which lets the captions be fetched from that video
               * rather than searched for. Without the extension the OS session
               * exposes only the tab's media metadata — no URL — so the fetcher
               * falls back to a title/artist search, which is right far more
               * often than not but can land on a different upload.
               */
              const ytVideoId = trackData.track_id.startsWith('yt:')
                ? trackData.track_id.slice(3)
                : undefined;
              log.info(`[CC] Trying captions for a ${trackData.media_source} session`);
              const ccLang = this.config.get('cc_lang') || 'auto';
              
              log.info(`[CC] Fetching captions for "${trackData.track_name}" (videoId: ${ytVideoId || 'search'}, lang: ${ccLang})`);
              
              const ccResult = await fetchYouTubeCaptions(trackData.track_name, trackData.artist_name, signal, ytVideoId, ccLang);
              
              log.info(`[CC] Result: ${ccResult.lines.length} lines, thumbnail: ${ccResult.thumbnailUrl ? 'yes' : 'no'}`);
              
              // The search resolved the actual video, which the OS session could
              // not name. Turning that into a direct link restores the "watch
              // this exact video" button the userscript used to provide; without
              // it the button falls back to a YouTube search.
              if (ccResult.videoId) {
                trackData.video_url = `https://www.youtube.com/watch?v=${ccResult.videoId}`;
              }

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
              
              // Captions the user has already rejected fall through to the
              // providers below rather than being returned and discarded by the
              // caller. Discarding them is what left a flagged video with no
              // lyrics at all, every time it was played again -- the same dead
              // end the provider phases now avoid for everything else.
              if (ccResult.lines.length > 0
                && isLyricsFlagged(trackData.track_name, trackData.artist_name, ccResult.lines)) {
                log.info(`[CC] Captions for "${trackData.track_name}" were flagged — asking the providers instead`);
              } else if (ccResult.lines.length > 0) {
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

    /*
     * Has the song moved on while the providers were being asked?
     *
     * Answered *before* anything is published, not after. The staleness check
     * used to sit below the two lines that follow it, so a skip mid-fetch had
     * the losing track assign itself back over `currentTrack` and emit a
     * trackUpdate for itself — the window snapped back to the previous song,
     * and everything reading `currentTrack` (the art resolver among them) saw
     * the wrong track until the next poll corrected it.
     */
    const expectedKey = this.buildTrackKey(trackData);
    if (this.currentTrackKey !== expectedKey) {
      log.debug(`[LYRICS] Track changed while fetching — abort (expected=${expectedKey}, current=${this.currentTrackKey})`);
      return;
    }

    // Persist enriched track + re-emit to dashboard
    // Restore original album_art_url to prevent losing local art during lyrics search
    // But preserve the public URL if resolveDiscordArt completed during lyrics search
    // Also preserve /api/thumbnail (local art extracted by local-art.ts)
    const uploadedUrl = this.currentTrack?.album_art_url?.startsWith('https://') ? this.currentTrack.album_art_url : null;
    const localArtUrl = this.currentTrack?.album_art_url === '/api/thumbnail' ? '/api/thumbnail' : null;
    trackData.album_art_url = uploadedUrl || localArtUrl || originalAlbumArtUrl;
    this.currentTrack = trackData;
    this.emit('trackUpdate', trackData);

    // Phase 3: Inject lyrics into the running engine (no restart = no gap)
    if (lyrics.length > 0) {
      this.lyricsEngine.injectLyrics(lyrics, trackData);
      log.info(`[LYRICS] Injected ${lyrics.length} lines into running engine`);
      this.warmTranslations(lyrics, signal);
    } else {
      // No lyrics found
      const isYt = trackData.media_source === 'youtube' || trackData.media_source === 'youtube_music'
        || trackData.media_source.startsWith('browser_');
      // A live stream never reached a provider -- the fetch above is gated on
      // is_live -- so reporting that the lookup failed puts a fault in the log
      // that never happened, 41 times in one real session.
      const noLyricsSource = trackData.is_live
        ? 'live stream, not looked up'
        : isYt ? 'CC fetch failed or empty' : 'LRCLib/Netease fetch failed';
      log.info(`[LYRICS] No lyrics found for "${trackData.track_name}" — ${noLyricsSource}`);
      this.lyricsEngine.updateTrackData(trackData);

      /*
       * Async: plain (unsynced) lyrics for the dashboard only, never the RPC.
       *
       * Gated on is_live for the same reason the synced fetch above is: a
       * stream's title is a channel banner and its artist a streamer, so the
       * lookup is an LRCLib round-trip followed by a Genius search and a page
       * scrape that cannot match anything. The synced path already knew that;
       * this one was still asking, once per stream event.
       */
      if (!signal.aborted && !trackData.is_live) {
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

  /**
   * Build a consistent track key from TrackData.
   *
   * Every track now originates from the OS session, whose track_id is already
   * `desktop:<title>:<artist>` — unique enough to key on directly. The fallback
   * covers anything that reaches here without that shape.
   */
  private buildTrackKey(t: TrackData): string {
    if (t.track_id.startsWith('desktop:')) return t.track_id;
    const artist = t.artist_name;
    const commaIdx = artist.indexOf(', ');
    return `${t.track_id}|${t.track_name}|${commaIdx >= 0 ? artist.slice(0, commaIdx) : artist}`;
  }

  // ── Public getters (for the window) ──

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

  /** Whether an LRCLIB dump is loaded, and the folder one can be dropped into. */
  getLrclibDumpStatus() {
    // Normalised on the way out as well as in: a config written before paths
    // were cleaned up can still hold the quoted form Explorer hands out, and
    // echoing that back would show the user a path they cannot match.
    const configured = normalizeUserPath(String(this.config.get('lrclib_dump_path') || ''));
    return { ...lrclibDumpStatus(this.configDir), configured };
  }

  /** Free-text search across the local LRCLIB dump, for the dashboard's search UI. */
  searchLrclibDump(query: string, limit?: number) {
    return searchLrclibDumpDb(query, limit);  // resolves on the dump worker
  }

  /** Fetch full lyrics for one LRCLIB search result, to preview or load into the import form. */
  getLrclibTrackLyrics(trackId: number) {
    return getLrclibTrackLyricsDb(trackId);
  }

  /**
   * Drop cached lyrics that a change to this custom entry could affect.
   *
   * Matching is a substring test in both directions on both fields, because a
   * cache key holds the *player's* names while the argument holds the imported
   * ones — a YouTube title like "Artist - Song (Official Video)" against an
   * imported "Song" — and neither side is reliably the longer one.
   *
   * Import, edit and delete all want exactly this, and used to carry three
   * near-copies that had drifted apart: the import copy matched in only one
   * direction on the title, so importing an entry invalidated less than editing
   * the very same entry did.
   */
  private evictCacheFor(track: string, artist: string): number {
    const trackLow = track.trim().toLowerCase();
    const artistLow = artist.trim().toLowerCase();
    // An empty side substring-matches everything and would clear the whole cache.
    if (!trackLow || !artistLow) return 0;
    let dropped = 0;
    for (const key of this.lyricsCache.keys()) {
      // Cache key format: "id|track_name|artist_name|duration_ms"
      const parts = key.toLowerCase().split('|');
      if (parts.length < 3) continue;
      const cachedTrack = parts[1];
      const cachedArtist = parts[2];
      if (!cachedTrack.includes(trackLow) && !trackLow.includes(cachedTrack)) continue;
      if (!cachedArtist.includes(artistLow) && !artistLow.includes(cachedArtist)) continue;
      this.lyricsCache.delete(key);
      dropped++;
    }
    return dropped;
  }

  importCustomLyrics(data: { track: string; artist: string; album: string; duration?: number; lrc: string }): number {
    const trackId = insertCustomLyrics(data.track, data.artist, data.album, data.duration, data.lrc);
    // Clear any flags for this track (user is providing correct lyrics)
    clearFlags(data.track, data.artist);
    // Evict cached results so the new lyrics are picked up immediately
    const dropped = this.evictCacheFor(data.track, data.artist);
    if (dropped > 0) log.info(`[IMPORT] Evicted ${dropped} stale cache entries`);
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
    if (!ok) return false;
    // Read the saved names once. This lookup used to sit inside the cache loop,
    // so a full cache meant fifty identical SQL round-trips to answer one
    // question that could not change between iterations.
    const entry = getCustomLyrics(trackId);
    if (entry) this.evictCacheFor(entry.track_name, entry.artist_name);
    return true;
  }

  deleteCustomLyricsEntry(trackId: number): boolean {
    // Read before deleting — afterwards there is nothing left to name.
    const entry = getCustomLyrics(trackId);
    const ok = deleteCustomLyrics(trackId);
    if (ok && entry) this.evictCacheFor(entry.track_name, entry.artist_name);
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
    const rpcConfig = this.rpcConfigForTrack(t);
    this.lyricsEngine.startTrack([], t, rpcConfig);
    this.lastLyricsState = null;
    this.emit('lyricsUpdate', { current: '', next: '', prev: '' });

    log.info(`Flagged lyrics for "${t.track_name}" — ${t.artist_name}`);

    // Look again straight away. The providers now skip what was just rejected,
    // so what comes back is the next best rather than the same match discarded
    // a second time -- which is what used to leave the song with nothing for
    // the rest of its length.
    void this.findReplacementLyrics(t);
    return true;
  }

  /**
   * Fetch whatever the providers offer once a match has been rejected.
   *
   * Deliberately not awaited by the caller: flagging should feel instant, and
   * the empty state is published before this starts. What this adds is the
   * replacement arriving a few hundred milliseconds later, in place of a song
   * that stayed silent until it was played again.
   *
   * Everything is re-checked after the await. A lookup takes long enough for
   * the song to change underneath it, and injecting the previous track's
   * replacement into the current one is worse than injecting nothing.
   */
  private async findReplacementLyrics(t: TrackData): Promise<void> {
    const key = this.buildTrackKey(t);
    const cacheKey = this.currentCacheKey;
    try {
      const lines = await fetchLyrics(
        t.track_name, t.artist_name, t.album_name, t.duration_ms, this.fetchAbort?.signal);

      if (this.currentTrackKey !== key) return;   // the song moved on

      if (!lines.length) {
        log.info(`[LYRICS] Nothing else on offer for "${t.track_name}" after the flag`);
        return;
      }

      if (cacheKey) {
        this.lyricsCache.set(cacheKey, lines);
        this.evictCache();
      }
      this.lyricsEngine.injectLyrics(lines, t);
      this.warmTranslations(lines, this.fetchAbort?.signal);
      log.info(`[LYRICS] Replaced the flagged match with ${lines.length} lines`);
    } catch (e) {
      // A failed replacement leaves the song where the flag already put it,
      // which is the old behaviour rather than a regression.
      log.warn(`[LYRICS] Could not find a replacement after the flag: ${e}`);
    }
  }

  /**
   * Adjust the lyric offset for whatever is playing, without restarting the
   * engine.
   *
   * The correction is stored against the track rather than globally: the drift
   * belongs to the recording, so a live take and a studio single want different
   * numbers and one setting cannot hold both. What was a single global value is
   * now the default for every track nobody has corrected -- which is nearly all
   * of them.
   *
   * With nothing playing there is no track to attribute a correction to, so it
   * moves that default instead, which is what the Settings control does.
   */
  setLyricsOffset(ms: number): { offsetMs: number; perTrack: boolean } {
    // A minute either way, matching the window and the config schema. This used
    // to clamp to two seconds while both of those allowed sixty, so a nudge past
    // two was written to config, shown back to the user, and never reached the
    // engine.
    const clamped = Math.max(-60_000, Math.min(60_000, Math.round(ms)));
    const t = this.currentTrack;
    const perTrack = !!t?.track_name;
    if (perTrack) setTrackOffset(t!.track_name, t!.artist_name, clamped);
    else this.config.set('lyrics_offset_ms', clamped);
    this.lyricsEngine.updateOffset(clamped);
    return { offsetMs: clamped, perTrack };
  }

  /** The offset in force right now: the playing track's own, or the default. */
  effectiveLyricsOffset(): { offsetMs: number; perTrack: boolean } {
    const t = this.currentTrack;
    const own = t?.track_name ? getTrackOffset(t.track_name, t.artist_name) : null;
    if (own !== null) return { offsetMs: own, perTrack: true };
    return { offsetMs: Number(this.config.get('lyrics_offset_ms')) || 0, perTrack: false };
  }

  /**
   * Drop cached captions when the caption language changes.
   *
   * Two caches hold them, not one: the fetcher's own — which does key on
   * language, so it would eventually be right — and this class's lyricsCache,
   * which is keyed by track and knows nothing about language. The second is why
   * switching language did nothing for anything already playing or already
   * seen: the old lines were handed straight back.
   *
   * Clearing all of lyricsCache rather than just the current track is
   * deliberate. Any track cached this session holds captions in the old
   * language too and would replay them on the way back, everything else in
   * there is cheap to fetch again, and changing language is a rare, deliberate
   * act. The configUpdate listener then re-fetches the playing track precisely
   * because it finds nothing cached.
   *
   * Must be called from every path that can change the config. It used to live
   * only in the ConfigManager's change callback, which fires from the file
   * watcher — and the app suppresses that for its own writes, so a language
   * picked in the window never reached it at all.
   */
  private syncCcLanguage(lang: string | undefined): void {
    if (this._lastCcLang === lang) return;
    const previous = this._lastCcLang;
    this._lastCcLang = lang;
    clearCCCache();
    this.lyricsCache.clear();
    log.info(`[CC] Language changed: ${previous ?? '(unset)'} → ${lang ?? '(unset)'} — cleared both lyric caches`);
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
    if ('art_upload_enabled' in accepted || 'art_upload_url' in accepted) {
      this.applyArtUploadConfig();
    }
    // Picked up live, so pasting the credentials in and connecting Last.fm is
    // one visit to the page rather than a save, a restart, and a second visit.
    if ('lastfm_api_key' in accepted || 'lastfm_api_secret' in accepted) {
      this.applyLastFmConfig();
    }
    // Same reasoning: a cookies file pasted in should work on the next track,
    // not after a restart.
    if ('cc_cookies_file' in accepted) {
      this.applyCaptionsConfig();
      // The cached results were fetched signed-out; an age-gated video that
      // failed before can succeed now, and the cache would hand back the
      // failure. Same argument as syncCcLanguage().
      clearCCCache();
      this.lyricsCache.clear();
    }
    // Before the emit: the listener re-fetches the playing track only when it
    // finds nothing cached, which is what this clears.
    // Turning romanisation off is the clearest statement anyone can make that
    // the Japanese dictionary will not be needed. It is 150 MB; waiting out
    // the idle timer after that would just be holding it for nothing.
    if ('romanize_lyrics' in accepted && accepted.romanize_lyrics === false) {
      releaseJapaneseTokenizer();
    }
    if ('cc_lang' in accepted) this.syncCcLanguage(accepted.cc_lang as string | undefined);
    this.emit('configUpdate', this.config.getAll());
  }

  /**
   * Point the cover uploader at the configured store, or at nothing.
   *
   * Both settings have to agree: a store with the toggle off publishes nothing,
   * and the toggle on with no store has nowhere to publish. Turning it off mid
   * session takes effect immediately — the uploader stops reading the local
   * thumbnail at all.
   */
  /**
   * Point the captions fetcher at the cookies file, or at nothing.
   *
   * yt-dlp cannot sign in to YouTube on its own, so an age-gated video has no
   * captions to give a signed-out client. This is the one setting that changes
   * that, and it went unread until 2.0.21.
   */
  private applyCaptionsConfig(): void {
    setCcCookiesFile(String(this.config.get('cc_cookies_file') || ''));
  }

  private applyArtUploadConfig(): void {
    const cfg = this.config.getAll();
    configureArtUpload(cfg.art_upload_enabled ? String(cfg.art_upload_url || '') : '');
  }

  /** Point Last.fm at the configured credentials, falling back to the env vars. */
  private applyLastFmConfig(): void {
    const cfg = this.config.getAll();
    initLastFm(
      (cfg.lastfm_api_key as string | undefined) || process.env.LASTFM_API_KEY,
      (cfg.lastfm_api_secret as string | undefined) || process.env.LASTFM_API_SECRET,
      this.configDir,
    );
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

  /**
   * Persist this session's top 3 into the history file.
   *
   * Called on every play now, not only on the way out. It used to run from
   * shutdown() alone, so a crash, a power cut or an End Task took the whole
   * session's listening with it — while the listening *history* next door had
   * been saving continuously all along, which left the two views of the same
   * afternoon disagreeing with each other.
   *
   * The session owns one row and rewrites it, rather than adding one per call:
   * the file holds the last ten *sessions*, and it would otherwise hold the
   * last ten songs of this one. `sessionStartedAt` is fixed at the first save
   * so the row keeps saying when the session began rather than when it was last
   * touched.
   */
  private saveCurrentSession(): void {
    const stats = this.getSessionStats();
    if (!stats.topTracks.length && !stats.topArtists.length) return;

    const snapshot: SessionSnapshot = {
      date: this.sessionStartedAt,
      topTracks: stats.topTracks,
      topArtists: stats.topArtists,
    };

    if (this.sessionRowSaved && this.statsHistory[0]?.date === this.sessionStartedAt) {
      this.statsHistory[0] = snapshot;
    } else {
      this.statsHistory.unshift(snapshot);
      this.sessionRowSaved = true;
      if (this.statsHistory.length > MAX_HISTORY_SESSIONS) {
        this.statsHistory = this.statsHistory.slice(0, MAX_HISTORY_SESSIONS);
      }
      log.info(`Saved current session to stats history (${this.statsHistory.length} total)`);
    }
    this.saveStatsHistory();
  }

  /**
   * Previous sessions — genuinely previous ones.
   *
   * This used to be able to return the list as-is, because the running session
   * was only written on the way out. It saves on every play now (so a crash
   * cannot take the afternoon with it), which put the live session at the head
   * of the list — and the Stats page shows "This session" above "Past
   * sessions", so it would have appeared twice, with the same numbers.
   *
   * Filtered on the session's own start time rather than by dropping the first
   * row: the row only exists once something has played, so index 0 is not
   * reliably ours.
   */
  getStatsHistory(): SessionSnapshot[] {
    return this.statsHistory.filter(s => s.date !== this.sessionStartedAt);
  }

  /** Get a page of the persistent listening history (most recent first). */
  getListeningHistory(limit = 50, offset = 0, anchor?: number) { return getHistoryPage(limit, offset, anchor); }
  getListeningWrapped(days?: number) { return getWrappedStats(days); }

  isDiscordConnected() { return this.discord.isConnected; }
  isMediaSourceReady() { return this.media?.isReady ?? false; }

  /**
   * Whether the browser extension has pushed recently.
   *
   * Each source ages out on its own after ~10s of silence, so this reflects an
   * extension that is actually reporting, not merely one that was installed
   * once. It is what lets the install page say "connected" rather than making
   * the user guess.
   */
  /** Whether the Spicetify extension is reporting right now. */
  isSpicetifyActive(): boolean { return this.spicetify.isActive; }

  isExtensionConnected(): boolean {
    return this.spicetify.isActive || this.youtubeSource.isActive
      || this.soundcloudSource.isActive || this.bandcampSource.isActive
      || this.twitchSource.isActive || this.kickSource.isActive;
  }
  isAdPlaying() { return this.media?.isAdPlaying() ?? false; }

  /**
   * The translation to show under a lyric line, when the window asks for one.
   *
   * Reads the cache only: this runs on the lyric tick, and awaiting a network
   * round trip here would hold the line itself back. A miss starts one fetch and
   * re-emits when it lands, so the translation appears a beat later rather than
   * never — which is what happened before, since nothing read `translate_lyrics`
   * at all and the window's translation line was always empty.
   */
  private translationFor(line: string): string {
    if (this.config.get('translate_lyrics') !== true) return '';
    const trimmed = (line || '').trim();
    if (trimmed.length < 2) return '';

    const lang = this.config.get('translate_target_lang') || 'en';
    const hit = getCachedTranslation(trimmed, lang);
    if (hit) return hit;

    // Nothing to gain from asking: already on the wire, already declined, or
    // not something a translator can work with. The de-duplication that used to
    // live here as a single "pending line" slot now sits in the translate
    // module, where the presence path shares it — the two were opening separate
    // requests for the same line, every line.
    if (!isTranslationWorthFetching(trimmed, lang)) return '';

    translateText(trimmed, lang)
      .then(res => {
        // The song moves on while this is in flight; a late answer must not be
        // pinned under whatever line is showing by then.
        if (!res || this.lastLyricsState?.current?.trim() !== trimmed) return;
        const merged = { ...this.lastLyricsState, translation: res.translation };
        this.lastLyricsState = merged;
        this.emit('lyricsUpdate', merged);
      })
      .catch(() => {});
    return '';
  }

  /**
   * Warm the whole song's translations in one go.
   *
   * Called wherever lyrics reach the engine, so the window and the presence
   * both read a cache hit on the tick instead of waiting on a request per line.
   * Either destination being switched on is reason enough — the cache is shared.
   */
  private warmTranslations(lyrics: LyricLine[], signal?: AbortSignal): void {
    if (lyrics.length === 0 || signal?.aborted) return;
    if (!this.config.get('rpc_translate_lyrics') && !this.config.get('translate_lyrics')) return;
    const tgtLang = this.config.get('translate_target_lang') || 'en';
    translateBatch(lyrics.map(l => l.text), tgtLang, signal).catch(() => {});
  }

  /** Push connection status to the window. */
  private emitStatus(): void {
    this.emit('statusUpdate', {
      discordConnected: this.discord.isConnected,
      mediaSourceReady: this.media?.isReady ?? false,
      preferredPlayer: this.media?.getPreferredSource() ?? null,
      adPlaying: this.media?.isAdPlaying() ?? false,
      showLyrics: this.config.get('show_lyrics') !== false,
      userAway: this.userAway,
      hideWhenAway: this.config.get('rpc_hide_when_away') !== false,
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
          translation: this.translationFor(current),
        };
        this.lastLyricsState = lyricsState;
        this.emit('lyricsUpdate', lyricsState);
        // Return measured IPC pipe write latency for EMA compensation
        return this.discord.lastWriteLatencyMs;
      },
      onRpcUpdate: (activity) => {
        // The engine keeps running while the user is away — it owns the lyric
        // clock, and stopping it would mean re-seeking on every return. Only
        // the publish is dropped.
        if (this.config.get('rpc_enabled') && !this.presenceHidden) {
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
      /*
       * Republish before falling back to the idle presence.
       *
       * Most reconnects are an App ID switch, and the app only switches App IDs
       * because the announced player changed — so there is virtually always a
       * track already playing that the fresh socket knows nothing about. Sending
       * the idle presence here instead left the profile empty until the next
       * heartbeat, which is exactly long enough for pinning a player to look
       * like it did nothing at all.
       */
      const republished = this.config.get('rpc_enabled') !== false
        && this.currentTrack !== null
        && this.lyricsEngine.pushRpcNow();
      if (!republished) this.setIdlePresence();
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

    if (this.appIdSwitchTimer) {
      clearTimeout(this.appIdSwitchTimer);
      this.appIdSwitchTimer = null;
    }

    // No change needed
    if (targetAppId === this.currentDiscordAppId) {
      log.debug(`[DISCORD] No AppID change needed for ${source}`);
      return;
    }

    // Only the last change in a burst is acted on — see APP_ID_SWITCH_DEBOUNCE_MS.
    this.appIdSwitchTimer = setTimeout(() => {
      this.appIdSwitchTimer = null;
      if (targetAppId === this.currentDiscordAppId || this.shuttingDown) return;
      this.applyDiscordAppId(targetAppId, source);
    }, APP_ID_SWITCH_DEBOUNCE_MS);
    this.appIdSwitchTimer.unref?.();
  }

  /** Tear down the Discord connection and rebuild it under a different App ID. */
  private applyDiscordAppId(targetAppId: string, source: string): void {
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
    // An advertisement is not a play. The presence filter is a user preference,
    // so it cannot be relied on here: with it off, every ad break used to land
    // in the history as a track by a brand. The heuristic is the same one.
    if (looksLikeSpotifyAd(
      t.media_source,
      { title: t.track_name, artist: t.artist_name, albumTitle: t.album_name },
      t.duration_ms,
      this.lastRecordedAlbum,
    )) {
      log.info(`[STATS] Ignoring advertisement: ${t.track_name}`);
      // Hold the interrupted song's clock for the length of the break; leaving
      // it running would bank the whole ad against it.
      historyTrackPause();
      return;
    }
    this.lastRecordedAlbum = t.album_name;

    // Pausing clears currentTrackKey, so resuming arrives here looking exactly
    // like a new track. It is not: it is the same listen continued, and counting
    // it again is what put 122 consecutive duplicate rows in the log. The
    // history module owns the decision — it is the side holding the open entry.
    const resumed = historyTrackResume(t.track_name, t.artist_name, t.media_source);
    if (!resumed) {
      historyTrackStart({
        track: t.track_name,
        artist: t.artist_name,
        album: t.album_name,
        art: t.album_art_url,
        source: t.media_source,
        durationMs: t.duration_ms,
      });
    }

    // A stream is kept in the log but never counted: its title is a banner and
    // its "artist" is a streamer, so one afternoon would own every top list.
    // The same reasoning keeps it off Last.fm, where the damage is permanent —
    // a scrobbled stream title is a play on the user's public profile.
    const isStream = STREAM_SOURCES.has(t.media_source);

    // Last.fm is told either way: scrobblePause() stopped its clock when
    // playback stopped, so a resumed track needs the now-playing set again.
    if (!isStream) {
      scrobbleTrackStart(t.track_name, t.artist_name, t.album_name, t.duration_ms);
    }

    // The session counters already have this play.
    if (resumed) return;

    if (isStream) return;

    this.statsDirty = true;
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

    // Bounded by plays, not by arrival. These two feed the "top 3" lists, and
    // evicting by insertion order dropped the session's first track — which is
    // disproportionately the one on repeat.
    evictLeast(this.sessionTrackPlays, 500, t => t.count);
    evictLeast(this.sessionArtistPlays, 500, a => a.count);

    this.emit('statsUpdate', this.getSessionStats());
    // Banked now rather than at shutdown alone — see saveCurrentSession().
    this.saveCurrentSession();
  }

  // ── Away (Discord auto-idle parity) ──

  /**
   * Report whether the machine has been idle long enough for Discord to show
   * the account as away.
   *
   * Discord's own Spotify integration drops the "Listening to" card when that
   * happens, and this is what gives our presence the same manners. The signal
   * has to be pushed in: it comes from Electron's powerMonitor, and this class
   * is plain Node on purpose. Note the presence is hidden on the *machine's*
   * idle clock, which is what Discord reads too — the account's actual status
   * is not something a third-party app can ask the IPC socket for.
   */
  setUserAway(away: boolean): void {
    if (away === this.userAway) return;
    this.userAway = away;
    this.emitStatus();
    if (this.config.get('rpc_hide_when_away') === false) return;
    log.info(away ? '[AWAY] Idle — presence hidden' : '[AWAY] Back — presence restored');
    this.refreshPresence();
  }

  isUserAway(): boolean { return this.userAway; }

  /** Whether the presence must stay off the profile whatever is playing. */
  private get presenceHidden(): boolean {
    return this.userAway && this.config.get('rpc_hide_when_away') !== false;
  }

  /**
   * Publish whatever the presence should be right now.
   *
   * For when something other than playback changed the answer — coming back
   * from idle, mainly. Republishing a live track goes through the engine rather
   * than being rebuilt here: the engine owns which lyric line is on screen, and
   * anything built from the track alone would snap the presence back to the
   * first line of the song.
   */
  private refreshPresence(): void {
    if (!this.discord.isConnected) return;
    if (this.presenceHidden || !this.config.get('rpc_enabled')) {
      this.discord.clearActivity().catch(() => {});
      return;
    }
    if (this.currentTrack && this.lyricsEngine.pushRpcNow()) return;
    this.setIdlePresence();
  }

  // ── RPC helpers ──

  /**
   * The RPC config a particular track should run under.
   *
   * Identical to getRpcConfig() except for the lyric offset, which belongs to
   * the recording rather than to the app: a live take, a remaster and a
   * YouTube upload with a long intro do not drift by the same amount, so one
   * global number cannot be right for two of them at once. A track that has
   * been corrected runs under its own; everything else runs under the setting,
   * which is what that setting now is -- the default, not the only answer.
   */
  private rpcConfigForTrack(track: TrackData): Record<string, unknown> {
    const cfg = this.getRpcConfig();
    const own = getTrackOffset(track.track_name, track.artist_name);
    if (own !== null) cfg.lyrics_offset_ms = own;
    return cfg;
  }
  private getRpcConfig(): Record<string, unknown> {
    const cfg = this.config.getAll();
    return {
      show_lyrics: cfg.show_lyrics,
      rpc_button1_label: cfg.rpc_button1_label,
      rpc_button1_url: cfg.rpc_button1_url,
      rpc_button2_label: PLATFORM_BUTTON_LABEL,
      rpc_activity_type: cfg.rpc_activity_type,
      rpc_status_display: cfg.rpc_status_display,
      rpc_status_template: cfg.rpc_status_template,
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
    if (this.presenceHidden) {
      this.discord.clearActivity().catch(() => {});
      return;
    }
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

    // No track to name here, so 'title' falls back to the app name like 'app'.
    const statusDisplay = this.config.get('rpc_status_display');
    const sdt = statusDisplay === 'details' ? 2 : statusDisplay === 'state' ? 1 : undefined;

    this.discord.setActivity({
      type: this.config.get('rpc_activity_type'),
      status_display_type: sdt,
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
   * Give Discord a URL for the cover art.
   *
   * Discord needs a URL and Windows gives us a file, so something has to bridge
   * the two, and it is tried in that order for a reason:
   *
   * 1. Look the album up on a music CDN (cover-art.ts). Discord's proxy loads
   *    those without argument, it costs one small request, nothing leaves the
   *    machine, and it answers for 42 of 44 tracks measured against real
   *    listening — everything that was ever released.
   * 2. Only for what is left — rips, demos, DJ sets, whose artwork exists
   *    nowhere but this machine — publish the file itself (art-upload.ts), if
   *    the user turned that on. Uploading to a free anonymous host is what this
   *    used to do and it failed twice over: Discord's proxy would not fetch
   *    from those hosts, and antivirus vendors blocklist them. Our own endpoint
   *    has neither problem.
   *
   * Anything still unresolved gets the default placeholder, which at least
   * renders. None of this affects the window, which reads the artwork straight
   * from the player and is therefore always right.
   */
  private resolveDiscordArt(trackData: TrackData, signal?: AbortSignal): void {
    const trackKey = this.currentTrackKey;
    // Claimed before the await, so a poll landing mid-resolve does not start a
    // second one for the same bytes.
    this.artThumbSig = thumbnailSignature();

    void (async () => {
      const catalogue = await lookupCoverArt(trackKey, trackData.artist_name, trackData.track_name, signal);
      const url = catalogue ?? await uploadCoverArt(signal);
      if (!url) {
        log.debug(`[RPC] No cover for "${trackData.artist_name} - ${trackData.track_name}"`);
        return;
      }
      // The track may have moved on while the lookup was in flight.
      if (this.currentTrackKey !== trackKey) return;
      if (this.currentTrack) this.currentTrack.album_art_url = url;
      const rpcTrack = { ...(this.currentTrack || trackData), album_art_url: url };
      this.lyricsEngine.updateTrackData(rpcTrack);
      // Stats and history captured this track's art when it started, which for
      // OS-detected covers is the local '/api/thumbnail' placeholder — a path
      // that means nothing outside the running app, so those lists rendered
      // with no cover at all. Backfill them now that a URL exists.
      this.backfillArt(this.currentTrack || trackData, url);
      log.info(`[RPC] Cover: ${url}`);
    })().catch(e => log.debug(`[RPC] Cover resolution failed: ${e}`));
  }

  /**
   * Point the current track's stats and history rows at a real cover URL, and
   * tell the window so it repaints without waiting for the next track.
   */
  private backfillArt(t: TrackData, url: string): void {
    historyUpdateArt(url);

    // Same keys recordPlay() derives, so the rows it created are the rows updated.
    const artistDisplay = t.artist_name.split(ARTIST_SPLIT_RE)[0].trim();
    const artistKey = artistDisplay.toLowerCase();
    const trackEntry = this.sessionTrackPlays.get(`${t.track_name.toLowerCase()}|${artistKey}`);
    if (trackEntry) trackEntry.art = url;
    const artistEntry = this.sessionArtistPlays.get(artistKey);
    if (artistEntry) artistEntry.art = url;

    this.statsDirty = true;
    this.emit('statsUpdate', this.getSessionStats());
    if (this.currentTrack) this.emit('trackUpdate', this.currentTrack);
  }

  private evictCache(): void {
    evictUntil(this.lyricsCache, 50);
  }

  // ── Shutdown ──

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log.info('Shutting down...');

    // 0. Drop any queued App ID switch — reconnecting on the way out would only
    // race the graceful close.
    if (this.appIdSwitchTimer) {
      clearTimeout(this.appIdSwitchTimer);
      this.appIdSwitchTimer = null;
    }

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

    // 5. Stop the media source
    this.media?.stop();

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
