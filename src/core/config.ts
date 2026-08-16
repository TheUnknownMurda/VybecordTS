import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';
import type { VybecordConfig } from './types.js';

const log = createLogger('Config');

const DEFAULTS: VybecordConfig = {
  rpc_enabled: true,
  show_lyrics: true,
  rpc_only_when_playing: false,
  detect_all_media: true,
  detect_spotify: true,
  detect_youtube: true,
  detect_soundcloud: true,
  detect_apple_music: true,
  detect_kick: true,
  detect_twitch: true,
  detect_browser: true,
  detect_other_apps: true,
  user_tier: 'auto',
  discord_app_id: '',
  spotify_client_id: '',
  spotify_client_secret: '',
  rpc_details_url: 'auto',
  rpc_state_url: 'auto',
  rpc_large_url: 'auto',
  rpc_button1_label: '',
  rpc_button1_url: '',
  rpc_button2_label: '🎵 Listen on {platform}',
  rpc_activity_type: 2, // LISTENING
  dance_mode: false,
  radiate_mode: false,
  purple_rad_mode: false,
  rouge_mode: false,
  bleeding_mode: false,
  blue_rad_mode: false,
  random_icon_mode: false,
  hide_small_icon: false,
  cc_enabled: true,
  cc_lang: 'auto',
  cc_cookies_file: '', // Path to cookies.txt for age-restricted videos
  lyrics_offset_ms: 0,
  romanize_lyrics: false,
  translate_lyrics: false,
  rpc_translate_lyrics: false,
  translate_target_lang: 'en',
  poll_interval_ms: 3000,
  lrclib_dump_path: '',
  first_run_completed: false,
  tray_enabled: true,
};

// ── Config validation schema ──
// Every key the API is allowed to write, with the accepted value shape.
// Anything not listed here is rejected: `/api/config` is reachable by any page
// the user has open, so an unvalidated write would let it inject arbitrary keys
// (or wrong types, which would crash the RPC builders downstream).
type FieldSpec =
  | { type: 'boolean' }
  | { type: 'string'; maxLength?: number; values?: readonly string[] }
  | { type: 'number'; min: number; max: number };

const URL_CHOICES = ['auto', 'track', 'artist', 'album', 'context'] as const;

export const CONFIG_SCHEMA: Record<string, FieldSpec> = {
  rpc_enabled: { type: 'boolean' },
  show_lyrics: { type: 'boolean' },
  rpc_only_when_playing: { type: 'boolean' },
  detect_all_media: { type: 'boolean' },
  detect_spotify: { type: 'boolean' },
  detect_youtube: { type: 'boolean' },
  detect_soundcloud: { type: 'boolean' },
  detect_apple_music: { type: 'boolean' },
  detect_kick: { type: 'boolean' },
  detect_twitch: { type: 'boolean' },
  detect_browser: { type: 'boolean' },
  detect_other_apps: { type: 'boolean' },
  user_tier: { type: 'string', values: ['auto', 'premium', 'free'] },
  discord_app_id: { type: 'string', maxLength: 32 },
  spotify_client_id: { type: 'string', maxLength: 128 },
  spotify_client_secret: { type: 'string', maxLength: 128 },
  rpc_details_url: { type: 'string', values: URL_CHOICES },
  rpc_state_url: { type: 'string', values: URL_CHOICES },
  rpc_large_url: { type: 'string', values: URL_CHOICES },
  // Labels are truncated to 32 chars when the activity is built; the generous
  // limit here only guards against absurd payloads (emojis cost 2 UTF-16 units).
  rpc_button1_label: { type: 'string', maxLength: 128 },
  rpc_button1_url: { type: 'string', maxLength: 512 },
  rpc_button2_label: { type: 'string', maxLength: 128 },
  // Discord only accepts Playing(0) / Listening(2) / Watching(3) / Competing(5)
  rpc_activity_type: { type: 'number', min: 0, max: 5 },
  dance_mode: { type: 'boolean' },
  radiate_mode: { type: 'boolean' },
  purple_rad_mode: { type: 'boolean' },
  rouge_mode: { type: 'boolean' },
  bleeding_mode: { type: 'boolean' },
  blue_rad_mode: { type: 'boolean' },
  lrc_off_mode: { type: 'boolean' },
  random_icon_mode: { type: 'boolean' },
  hide_small_icon: { type: 'boolean' },
  cc_enabled: { type: 'boolean' },
  cc_lang: { type: 'string', maxLength: 16 },
  cc_cookies_file: { type: 'string', maxLength: 512 },
  lyrics_offset_ms: { type: 'number', min: -60_000, max: 60_000 },
  romanize_lyrics: { type: 'boolean' },
  translate_lyrics: { type: 'boolean' },
  rpc_translate_lyrics: { type: 'boolean' },
  translate_target_lang: { type: 'string', maxLength: 8 },
  poll_interval_ms: { type: 'number', min: 400, max: 60_000 },
  lrclib_dump_path: { type: 'string', maxLength: 1024 },
  lastfm_api_key: { type: 'string', maxLength: 128 },
  lastfm_api_secret: { type: 'string', maxLength: 128 },
  bug_report_webhook: { type: 'string', maxLength: 512 },
  first_run_completed: { type: 'boolean' },
  tray_enabled: { type: 'boolean' },
};

/** Keys never sent back to a client in clear text. */
export const CONFIG_SECRET_KEYS: readonly string[] = [
  'spotify_client_secret',
  'lastfm_api_secret',
  'bug_report_webhook',
];

/** Placeholder returned in place of a configured secret. */
export const CONFIG_SECRET_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

/** Copy of the config with secrets replaced by a mask (empty ones stay empty). */
export function redactConfig(config: VybecordConfig): VybecordConfig {
  const out = { ...config };
  for (const key of CONFIG_SECRET_KEYS) {
    if (out[key]) out[key] = CONFIG_SECRET_MASK;
  }
  return out;
}

/**
 * Keep only known keys holding a valid value.
 * Returns the accepted subset plus the names that were dropped (for logging).
 * A masked secret echoed back by a client is skipped, so re-saving the settings
 * form can never overwrite a real secret with the placeholder.
 */
export function sanitizeConfigUpdate(
  updates: Record<string, unknown>,
): { accepted: Record<string, unknown>; rejected: string[] } {
  const accepted: Record<string, unknown> = {};
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    const spec = CONFIG_SCHEMA[key];
    if (!spec) { rejected.push(key); continue; }
    if (CONFIG_SECRET_KEYS.includes(key) && value === CONFIG_SECRET_MASK) continue; // untouched secret

    switch (spec.type) {
      case 'boolean':
        if (typeof value !== 'boolean') { rejected.push(key); continue; }
        accepted[key] = value;
        break;
      case 'string': {
        if (typeof value !== 'string') { rejected.push(key); continue; }
        if (spec.values && !spec.values.includes(value)) { rejected.push(key); continue; }
        if (spec.maxLength !== undefined && value.length > spec.maxLength) { rejected.push(key); continue; }
        accepted[key] = value;
        break;
      }
      case 'number': {
        if (typeof value !== 'number' || !Number.isFinite(value)) { rejected.push(key); continue; }
        const rounded = Math.round(value);
        if (rounded < spec.min || rounded > spec.max) { rejected.push(key); continue; }
        accepted[key] = rounded;
        break;
      }
    }
  }

  return { accepted, rejected };
}

export class ConfigManager {
  private configPath: string;
  private config: VybecordConfig;
  private watcher: fs.FSWatcher | null = null;
  private closed = false;
  private skipNextReload = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onChange?: (config: VybecordConfig) => void;

  constructor(configDir: string, onChange?: (config: VybecordConfig) => void) {
    this.configPath = path.join(configDir, 'config.json');
    this.onChange = onChange;
    this.config = this.loadOrCreate();
    this.startWatcher();
    log.info(`Loaded config from ${this.configPath}`);
  }

  private loadOrCreate(): VybecordConfig {
    if (!fs.existsSync(this.configPath)) {
      const cfg = { ...DEFAULTS };
      this.save(cfg);
      log.info('config.json created with defaults');
      return cfg;
    }
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<VybecordConfig>;
      // Merge with defaults (add missing keys)
      let dirty = false;
      const merged = { ...DEFAULTS };
      for (const [key, val] of Object.entries(parsed)) {
        (merged as Record<string, unknown>)[key] = val;
      }
      for (const key of Object.keys(DEFAULTS)) {
        if (!(key in parsed)) {
          dirty = true;
        }
      }
      if (dirty) this.save(merged);
      return merged;
    } catch (e) {
      log.warn(`Failed to read config, using defaults: ${e}`);
      return { ...DEFAULTS };
    }
  }

  /**
   * Persist the config atomically: the full JSON is written to a temp file first,
   * then renamed over config.json. A crash mid-write can no longer leave a
   * truncated file behind (which would silently reset every setting to defaults).
   */
  private save(config: VybecordConfig): void {
    this.skipNextReload = true;
    const tmpPath = `${this.configPath}.${process.pid}.tmp`;
    const fail = (msg: string) => {
      log.error(msg);
      this.skipNextReload = false; // no rename happened — don't swallow a real edit
      fs.unlink(tmpPath, () => { /* best-effort cleanup */ });
    };
    fs.mkdir(path.dirname(this.configPath), { recursive: true }, (err) => {
      if (err) return fail(`Failed to create config directory: ${err}`);
      fs.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8', (writeErr) => {
        if (writeErr) return fail(`Failed to save config: ${writeErr}`);
        fs.rename(tmpPath, this.configPath, (renameErr) => {
          if (renameErr) return fail(`Failed to save config: ${renameErr}`);
          this.rearmWatcher();
        });
      });
    });
  }

  /**
   * (Re)attach the file watcher after an atomic save.
   * The rename replaces the watched file, so on some platforms the old watch
   * handle would stop reporting changes. Recreating it also drops the event our
   * own write just queued, which makes `skipNextReload` reliable again.
   * On first run this is also what finally attaches the watcher: the constructor
   * runs before the freshly created config.json exists on disk.
   */
  private rearmWatcher(): void {
    this.skipNextReload = false;
    if (this.closed) return; // shut down while a save was in flight
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.startWatcher();
  }

  get<K extends keyof VybecordConfig>(key: K): VybecordConfig[K] {
    return this.config[key];
  }

  getAll(): VybecordConfig {
    return { ...this.config };
  }

  set<K extends keyof VybecordConfig>(key: K, value: VybecordConfig[K]): void {
    if (this.config[key] !== value) {
      this.config[key] = value;
      this.save(this.config);
      log.info(`set() → ${String(key)} = ${JSON.stringify(value)}`);
    }
  }

  /** Batch-set multiple keys with a single disk write. */
  setMany(updates: Partial<VybecordConfig>): void {
    let changed = false;
    for (const [key, value] of Object.entries(updates)) {
      if (this.config[key as keyof VybecordConfig] !== value) {
        (this.config as Record<string, unknown>)[key] = value;
        changed = true;
      }
    }
    if (changed) {
      this.save(this.config);
      log.info(`setMany() → ${Object.keys(updates).length} keys updated`);
    }
  }

  private startWatcher(): void {
    try {
      this.watcher = fs.watch(this.configPath, () => {
        // Debounce: editors often fire multiple events per save
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          if (this.skipNextReload) {
            this.skipNextReload = false;
          } else {
            this.reload();
          }
        }, 200);
      });
    } catch { /* ignore — file might not exist yet */ }
  }

  private reload(): void {
    this.config = this.loadOrCreate();
    log.info('Config reloaded from disk');
    if (this.onChange) {
      this.onChange(this.config);
    }
  }

  close(): void {
    this.closed = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
