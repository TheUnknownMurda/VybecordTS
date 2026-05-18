import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';
import { atomicWriteFileSync } from './utils.js';
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
  lrc_off_mode: false,
  random_icon_mode: false,
  hide_small_icon: false,
  cc_enabled: true,
  cc_lang: 'auto',
  lyrics_offset_ms: 0,
  romanize_lyrics: false,
  translate_lyrics: false,
  translate_target_lang: 'en',
  poll_interval_ms: 3000,
};

export class ConfigManager {
  private configPath: string;
  private config: VybecordConfig;
  private watcher: fs.FSWatcher | null = null;
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

  private save(config: VybecordConfig): void {
    this.skipNextReload = true;
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    // Atomic write — prevents the fs.watch handler (or any external editor)
    // from reading a half-written JSON file.
    atomicWriteFileSync(this.configPath, JSON.stringify(config, null, 2));
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
    try {
      // loadOrCreate handles its own errors by returning DEFAULTS — but that
      // would silently wipe a user's customizations on a transient read error
      // (editor mid-save, antivirus lock, etc.). Try a single retry before
      // falling back to the *previous* in-memory config.
      const fresh = this.loadOrCreateStrict();
      this.config = fresh;
      log.info('Config reloaded from disk');
      if (this.onChange) {
        this.onChange(this.config);
      }
    } catch (e) {
      log.warn(`Config reload failed, keeping previous in-memory config: ${e}`);
    }
  }

  /**
   * Strict variant of loadOrCreate: throws on parse error instead of returning
   * DEFAULTS. Used by reload() so a corrupt half-written file doesn't wipe
   * user config — caller falls back to the previous in-memory state.
   */
  private loadOrCreateStrict(): VybecordConfig {
    if (!fs.existsSync(this.configPath)) {
      const cfg = { ...DEFAULTS };
      this.save(cfg);
      log.info('config.json created with defaults');
      return cfg;
    }
    const raw = fs.readFileSync(this.configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<VybecordConfig>;
    let dirty = false;
    const merged = { ...DEFAULTS };
    for (const [key, val] of Object.entries(parsed)) {
      (merged as Record<string, unknown>)[key] = val;
    }
    for (const key of Object.keys(DEFAULTS)) {
      if (!(key in parsed)) dirty = true;
    }
    if (dirty) this.save(merged);
    return merged;
  }

  close(): void {
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
