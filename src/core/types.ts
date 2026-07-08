// ── Track data from Spotify API ──
export interface SpotifyPlayback {
  is_playing: boolean;
  progress_ms: number;
  item: {
    id: string;
    name: string;
    duration_ms: number;
    artists: { name: string; external_urls?: { spotify?: string } }[];
    album: {
      name: string;
      images: { url: string; width: number; height: number }[];
      external_urls?: { spotify?: string };
    };
    external_urls?: { spotify?: string };
  } | null;
  context?: {
    type: string;
    uri: string;
    external_urls?: { spotify?: string };
  } | null;
}

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
  /** Artist profile image URL (from Spicetify/Tampermonkey) */
  artist_art_url?: string;
  /** True if this is a live stream (YouTube live, radio, etc.) */
  is_live?: boolean;
  /** True if playback is in shuffle mode */
  is_shuffle?: boolean;
  /** Repeat mode: 'off' | 'context' (playlist/album repeat) | 'track' (single track repeat) */
  repeat_mode?: 'off' | 'context' | 'track';
  /** True if this is a local file (not on Spotify streaming service) */
  is_local?: boolean;
  /** High-res timestamp (performance.now()) when this data was received */
  _received_at: number;
  /** True if this track came from a push source (Spicetify, YouTube/SC/BC userscript) */
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
  /** 'auto' = try API then SMTC, 'premium' = force API, 'free' = force SMTC */
  user_tier: 'auto' | 'premium' | 'free';
  discord_app_id: string;
  spotify_client_id: string;
  spotify_client_secret: string;
  // RPC customization
  /** Which URL each clickable RPC field links to: 'track' | 'artist' | 'album' | 'context' | 'auto' */
  rpc_details_url: string;
  rpc_state_url: string;
  rpc_large_url: string;
  rpc_button1_label: string;
  rpc_button1_url: string;
  rpc_button2_label: string;
  rpc_activity_type: number;
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
  /** Enable real-time lyric translation (dashboard only) */
  translate_lyrics: boolean;
  /** Enable translated lyrics on Discord RPC */
  rpc_translate_lyrics: boolean;
  /** Target language for lyric translation (ISO 639-1 code) */
  translate_target_lang: string;
  // Polling
  poll_interval_ms: number;
  /** Discord webhook URL for bug reports (optional) */
  bug_report_webhook?: string;
  [key: string]: unknown;
}

// ── Spotify token cache ──
export interface TokenCache {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
}

