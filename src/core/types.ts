// ── Normalized track data (source-agnostic) ──
export interface TrackData {
  track_id: string;
  track_name: string;
  artist_name: string;
  album_name: string;
  duration_ms: number;
  progress_ms: number;
  is_playing: boolean;
  album_art_url: string;
  spotify_url: string;
  artist_url: string;
  media_source: string;
  /** Direct link to the album page */
  album_url?: string;
  /** Name of the current playback context (playlist, album, artist radio, etc.) */
  context_name?: string;
  /** Direct link to the playback context (playlist/album/artist page) */
  context_url?: string;
  /** Context type: 'playlist' | 'album' | 'artist' | 'collection' | etc. */
  context_type?: string;
  /** Artist profile image URL. The OS media session does not expose one, so
   *  this is only ever set when a lyrics provider supplies it. */
  artist_art_url?: string;
  /** True if this is a live stream (YouTube live, radio, etc.) */
  is_live?: boolean;
  /** Stream start time in Unix timestamp (seconds) for live streams - used to show total stream time instead of resetting to 0 */
  stream_start_time_ms?: number;
  /** True if playback is in shuffle mode */
  is_shuffle?: boolean;
  /** Repeat mode: 'off' | 'context' (playlist/album repeat) | 'track' (single track repeat) */
  repeat_mode?: 'off' | 'context' | 'track';
  /** True if this is a local file (not on Spotify streaming service) */
  is_local?: boolean;
  /** High-res timestamp (performance.now()) when this data was received */
  _received_at: number;
  /** True if this track came from a push source. No source sets it since the
   *  userscripts were removed; kept so the engine's recalibration branch stays
   *  intact for any future push source. */
  _from_push?: boolean;
  /** Direct URL to the video (YouTube, etc.) */
  video_url?: string;
}

// ── Parsed lyric line ──
export interface LyricLine {
  /** Timestamp in milliseconds */
  time: number;
  /** Lyric text */
  text: string;
  /** Source hint: 'cc' = auto-generated CC, 'sub' = manual subtitles, undefined = LRC */
  source?: 'cc' | 'sub';
}

// ── LRCLib API response ──
export interface LrcLibResult {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
}

// ── Discord RPC activity ──
export interface DiscordActivity {
  type?: number;
  /** Overrides the Discord application name in the presence header + status line. */
  name?: string;
  /** Which field feeds the "Listening to …" status line: 0 = name, 1 = state, 2 = details. */
  status_display_type?: number;
  details?: string;
  state?: string;
  timestamps?: { start?: number; end?: number };
  assets?: {
    large_image?: string;
    large_text?: string;
    small_image?: string;
    small_text?: string;
  };
  buttons?: { label: string; url: string }[];
  details_url?: string;
  state_url?: string;
  large_url?: string;
}

// ── Config schema ──
export interface VybecordConfig {
  rpc_enabled: boolean;
  show_lyrics: boolean;
  /** When true, Discord status disappears as soon as music stops */
  rpc_only_when_playing: boolean;
  /** Master toggle: detect non-Spotify media sources (YouTube, SoundCloud, etc.) */
  detect_all_media: boolean;
  /** Per-platform detection toggles (only apply when detect_all_media is true) */
  detect_spotify: boolean;
  detect_youtube: boolean;
  detect_soundcloud: boolean;
  detect_apple_music: boolean;
  detect_kick: boolean;
  detect_twitch: boolean;
  detect_browser: boolean;
  detect_other_apps: boolean;
  /** Hide the presence while Spotify plays an advertisement. Heuristic — see
   *  looksLikeSpotifyAd() in native-media-source.ts. */
  filter_spotify_ads: boolean;
  /** Accept playback pushes from the browser extension. When false no port is
   *  opened at all. */
  extension_enabled: boolean;
  discord_app_id: string;
  // RPC customization
  /** Which URL each clickable RPC field links to: 'track' | 'artist' | 'album' | 'context' | 'auto' */
  rpc_details_url: string;
  rpc_state_url: string;
  rpc_large_url: string;
  rpc_button1_label: string;
  rpc_button1_url: string;
  rpc_button2_label: string;
  rpc_activity_type: number;
  /**
   * What the "Listening to …" status line shows (member list / profile), independent
   * of the presence card: 'app' = application name, 'title' = current track title,
   * 'details' = the details field, 'state' = the state field.
   */
  rpc_status_display: string;
  /** Free-form status-line template used when rpc_status_display is 'custom'. */
  rpc_status_template: string;
  /** Dance mode: animated small icon for Spotify */
  dance_mode: boolean;
  /** Radiate mode: custom animated GIF as small icon (all platforms) */
  radiate_mode: boolean;
  /** Purple Rad mode: purple animated GIF as small icon (all platforms) */
  purple_rad_mode: boolean;
  /** Rouge mode: red animated GIF as small icon (all platforms) */
  rouge_mode: boolean;
  /** Bleeding mode: bleeding animated GIF as small icon (all platforms) */
  bleeding_mode: boolean;
  /** Blue Rad mode: blue animated GIF as small icon (all platforms) */
  blue_rad_mode: boolean;
  /** Random icon mode: pick a random small icon each track */
  random_icon_mode: boolean;
  /** Hide small icon: remove the small image entirely */
  hide_small_icon: boolean;
  /** Enable/disable YouTube CC (closed captions) as lyrics source */
  cc_enabled: boolean;
  /** Preferred YouTube CC/subtitle language: 'auto', 'fr', 'en', etc. */
  cc_lang: string;
  /** Manual lyrics timing offset in ms (negative = earlier, positive = later) */
  lyrics_offset_ms: number;
  /** Auto-romanize Japanese/Korean lyrics (Kana→romaji, Hangul→romanization) */
  romanize_lyrics: boolean;
  /** Enable real-time lyric translation in the window */
  translate_lyrics: boolean;
  /** Enable translated lyrics on Discord RPC */
  rpc_translate_lyrics: boolean;
  /** Target language for lyric translation (ISO 639-1 code) */
  translate_target_lang: string;
  // Polling
  poll_interval_ms: number;
  /** Absolute path to a local LRCLIB dump .sqlite3 file (too large to bundle
   *  with the app). If set and the file exists, it's used instead of the
   *  default "<app dir>/LRCLIB Dump/lrclib-dump.sqlite3" auto-detection. */
  lrclib_dump_path: string;
  /** Discord webhook URL for bug reports (optional) */
  bug_report_webhook?: string;
  /**
   * Publish cover art that exists only on this machine, so Discord can show it.
   *
   * On by default. Music that was ever released is found on a public catalogue
   * without anything leaving the machine (see cover-art.ts), so this only ever
   * applies to local rips and recordings, whose artwork Discord could otherwise
   * never show. Identifying metadata is stripped first. See art-upload.ts.
   */
  art_upload_enabled: boolean;
  /** Base URL of the cover store to publish to. Empty means no store. */
  art_upload_url: string;
  /** False until the user has been through the /setup onboarding page once.
   *  Drives whether startup opens /setup or the dashboard. */
  first_run_completed: boolean;
  /** Show a Windows notification-area icon (show / quit).
   *  Windows-only; ignored elsewhere. */
  tray_enabled: boolean;
  /** Closing the window hides it to the tray instead of quitting. */
  minimize_to_tray: boolean;
  /** Start hidden in the tray rather than showing the window. */
  start_minimized: boolean;
  /** Register the app to launch when the user signs in. */
  launch_on_startup: boolean;
  /** Window colour scheme: 'dark' | 'light'. */
  theme: string;
  [key: string]: unknown;
}


