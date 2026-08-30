import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';
import type { VybecordConfig } from './types.js';

const log = createLogger('Config');

const DEFAULTS: VybecordConfig = {
  rpc_enabled: true,
  show_lyrics: true,
  rpc_only_when_playing: false,
  rpc_hide_when_away: true,
  away_after_minutes: 10,
  detect_all_media: true,
  detect_spotify: true,
  detect_youtube: true,
  detect_soundcloud: true,
  detect_apple_music: true,
  detect_kick: true,
  detect_twitch: true,
  detect_browser: true,
  detect_other_apps: true,
  filter_spotify_ads: true,
  /** Listen for pushes from the browser extension (opens 127.0.0.1:8888). */
  extension_enabled: true,
  discord_app_id: '',
  rpc_details_url: 'auto',
  rpc_state_url: 'auto',
  rpc_large_url: 'auto',
  rpc_button1_label: '',
  rpc_button1_url: '',
  rpc_activity_type: 2, // LISTENING
  rpc_status_display: 'app', // status line keeps showing the app name by default
  rpc_status_template: '{title} - {artist}',
  dance_mode: false,
  radiate_mode: false,
  purple_rad_mode: false,
  rouge_mode: false,
  bleeding_mode: false,
  blue_rad_mode: false,
  random_icon_mode: false,
  hide_small_icon: false,
  // Accepted by CONFIG_SCHEMA and read by getRpcConfig()/the icon-mode ladder,
  // so it belongs here too — without it the key was simply absent from a fresh
  // config.json and the settings form had nothing to bind to.
  lrc_off_mode: false,
  cc_enabled: true,
  cc_lang: 'auto',
  cc_cookies_file: '', // Path to cookies.txt for age-restricted videos
  lyrics_offset_ms: 0,
  romanize_lyrics: false,
  translate_lyrics: false,
  rpc_translate_lyrics: false,
  translate_target_lang: 'en',
  // The native source pushes track changes by event, so this interval only
  // drives progress sync and idle detection. It is pure arithmetic now (no
  // subprocess, no native call), which is why it can afford to be this tight.
  poll_interval_ms: 1000,
  lrclib_dump_path: '',
  // ── Cover art for local-only music ──
  // On, so a local rip shows its artwork rather than a placeholder. Released
  // music never reaches this: cover-art.ts resolves that from a public
  // catalogue with nothing leaving the machine. Only artwork that exists
  // nowhere else is published, and only after its EXIF is stripped. Disclosed
  // in website/privacy/ and switchable in Settings → Cover images.
  art_upload_enabled: true,
  // The store Vybecord ships with — see worker/. On workers.dev rather than a
  // domain of our own, which is fine here: what got the old file host blocked
  // was being listed as malware, and this is neither that nor rate limited the
  // way r2.dev is. Moving to a custom domain later costs nothing, because a
  // cover's address is its hash: point this elsewhere and clients re-publish on
  // their next miss, with no migration and no broken URLs.
  art_upload_url: 'https://vybecord-art.vybecord.workers.dev',
  first_run_completed: false,
  tray_enabled: true,
  // ── Window behaviour ──
  minimize_to_tray: true,
  start_minimized: false,
  launch_on_startup: false,
  theme: 'dark',
};

// ── Config validation schema ──
// Every key the API is allowed to write, with the accepted value shape.
// Anything not listed here is rejected: `/api/config` is reachable by any page
// the user has open, so an unvalidated write would let it inject arbitrary keys
// (or wrong types, which would crash the RPC builders downstream).
type FieldSpec =
  | { type: 'boolean' }
  | { type: 'string'; maxLength?: number; values?: readonly string[]; path?: true }
  | { type: 'number'; min: number; max: number };

/**
 * Clean up a filesystem path a person pasted in.
 *
 * Windows Explorer's "Copy as path" wraps the path in double quotes, and a
 * quoted path is not a path any filesystem call will find — the setting then
 * looks correct in the form while the app silently behaves as if it were empty.
 * Stripping one matching pair of quotes costs nothing and is never wrong: no
 * real path is quoted at both ends.
 */
export function normalizeUserPath(value: string): string {
  const trimmed = value.trim();
  const quoted = trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")));
  return (quoted ? trimmed.slice(1, -1) : trimmed).trim();
}

const URL_CHOICES = ['auto', 'track', 'artist', 'album', 'context'] as const;
const STATUS_DISPLAY_CHOICES = [
  'app', 'title', 'title_artist', 'artist_title', 'artist', 'album', 'playlist',
  'custom', 'details', 'state',
] as const;

export const CONFIG_SCHEMA: Record<string, FieldSpec> = {
  rpc_enabled: { type: 'boolean' },
  show_lyrics: { type: 'boolean' },
  rpc_only_when_playing: { type: 'boolean' },
  rpc_hide_when_away: { type: 'boolean' },
  // Under a minute the presence would blink off between two sentences; over two
  // hours it is indistinguishable from having the setting off.
  away_after_minutes: { type: 'number', min: 1, max: 120 },
  detect_all_media: { type: 'boolean' },
  detect_spotify: { type: 'boolean' },
  detect_youtube: { type: 'boolean' },
  detect_soundcloud: { type: 'boolean' },
  detect_apple_music: { type: 'boolean' },
  detect_kick: { type: 'boolean' },
  detect_twitch: { type: 'boolean' },
  detect_browser: { type: 'boolean' },
  detect_other_apps: { type: 'boolean' },
  filter_spotify_ads: { type: 'boolean' },
  extension_enabled: { type: 'boolean' },
  discord_app_id: { type: 'string', maxLength: 32 },
  rpc_details_url: { type: 'string', values: URL_CHOICES },
  rpc_state_url: { type: 'string', values: URL_CHOICES },
  rpc_large_url: { type: 'string', values: URL_CHOICES },
  // Labels are truncated to 32 chars when the activity is built; the generous
  // limit here only guards against absurd payloads (emojis cost 2 UTF-16 units).
  rpc_button1_label: { type: 'string', maxLength: 128 },
  rpc_button1_url: { type: 'string', maxLength: 512 },
  // Discord only accepts Playing(0) / Listening(2) / Watching(3) / Competing(5)
  rpc_activity_type: { type: 'number', min: 0, max: 5 },
  rpc_status_display: { type: 'string', values: STATUS_DISPLAY_CHOICES },
  rpc_status_template: { type: 'string', maxLength: 128 },
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
  cc_cookies_file: { type: 'string', maxLength: 512, path: true },
  lyrics_offset_ms: { type: 'number', min: -60_000, max: 60_000 },
  romanize_lyrics: { type: 'boolean' },
  translate_lyrics: { type: 'boolean' },
  rpc_translate_lyrics: { type: 'boolean' },
  translate_target_lang: { type: 'string', maxLength: 8 },
  poll_interval_ms: { type: 'number', min: 400, max: 60_000 },
  lrclib_dump_path: { type: 'string', maxLength: 1024, path: true },
  lastfm_api_key: { type: 'string', maxLength: 128 },
  lastfm_api_secret: { type: 'string', maxLength: 128 },
  bug_report_webhook: { type: 'string', maxLength: 512 },
  art_upload_enabled: { type: 'boolean' },
  art_upload_url: { type: 'string', maxLength: 256 },
  first_run_completed: { type: 'boolean' },
  tray_enabled: { type: 'boolean' },
  minimize_to_tray: { type: 'boolean' },
  start_minimized: { type: 'boolean' },
  launch_on_startup: { type: 'boolean' },
  theme: { type: 'string', values: ['dark', 'light'] as const },
};

/** Keys never sent back to a client in clear text. */
export const CONFIG_SECRET_KEYS: readonly string[] = [
  'lastfm_api_secret',
  'bug_report_webhook',
];

/*
 * There used to be an OBSOLETE_KEYS list here, naming the settings left behind
 * by removed features — the Spotify Web API credentials, the cover-art webhook,
 * the fixed platform-button label, the private-session gate. loadOrCreate now
 * keeps only what DEFAULTS or CONFIG_SCHEMA still describes, which covers all
 * of them and everything nobody thought to add to the list.
 */

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
        const str = spec.path ? normalizeUserPath(value) : value;
        if (spec.values && !spec.values.includes(str)) { rejected.push(key); continue; }
        if (spec.maxLength !== undefined && str.length > spec.maxLength) { rejected.push(key); continue; }
        accepted[key] = str;
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
  /** Increments per save; the newest issued is the only one allowed to land. */
  private saveSeq = 0;
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
      /*
       * Only keys the app still has a use for.
       *
       * The merge used to copy everything the file held, so a setting belonging
       * to a removed feature stayed in config.json for good — and every one of
       * them had to be named in a hand-kept list to be cleared. Two problems
       * with that: the list is one more thing to remember, and a key nobody
       * remembered to list sat there looking like a setting that still did
       * something. `spotify_client_secret` was exactly that, and it was a
       * secret.
       *
       * Known means "in DEFAULTS or in the schema". The schema is the wider of
       * the two on purpose: the credentials have no default worth shipping but
       * are perfectly legitimate keys.
       */
      /*
       * Values are checked, not only keys.
       *
       * config.json is a supported way in -- the app watches it and reloads on
       * change -- but only the window ever validated what it carried. Straight
       * off disk a value was taken at whatever type it happened to be, so
       * `"poll_interval_ms": "fast"` reached setInterval as a string: NaN,
       * clamped to 1ms, and the poll ran about 130 times a second instead of
       * once. A boolean or a negative number got there the same way.
       *
       * sanitizeConfigUpdate is the check the window already applies, and the
       * schema describes every key DEFAULTS has, so both doors now agree. What
       * it turns down keeps its default instead of the file winning.
       */
      const { accepted, rejected } = sanitizeConfigUpdate(parsed as Record<string, unknown>);
      for (const key of rejected) {
        dirty = true;
        if (key in DEFAULTS || key in CONFIG_SCHEMA) {
          log.warn(`Ignoring a config value the app cannot use: ${key} -- keeping the default`);
        } else {
          log.info(`Dropping config key the app no longer has: ${key}`);
        }
      }
      Object.assign(merged, accepted);
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
   *
   * Two things make that hold when saves overlap, which they do — dragging the
   * lyrics-offset slider while the settings form posts, say.
   *
   *   - The temp file is named per save. Sharing one path meant two async writes
   *     truncating and filling the *same* file, then both renaming it: the file
   *     that landed could be a splice of two snapshots rather than either one.
   *   - Only the newest save issued is allowed to rename. The JSON is captured
   *     synchronously here, so a later call always carries the newer state;
   *     without this guard the two renames could land in either order and an
   *     older snapshot could win the race and quietly undo the newer setting.
   */
  private save(config: VybecordConfig): void {
    this.skipNextReload = true;
    const seq = ++this.saveSeq;
    const tmpPath = `${this.configPath}.${process.pid}.${seq}.tmp`;
    const cleanup = () => fs.unlink(tmpPath, () => { /* best-effort */ });
    const fail = (msg: string) => {
      log.error(msg);
      this.skipNextReload = false; // no rename happened — don't swallow a real edit
      cleanup();
    };
    const json = JSON.stringify(config, null, 2);
    fs.mkdir(path.dirname(this.configPath), { recursive: true }, (err) => {
      if (err) return fail(`Failed to create config directory: ${err}`);
      if (seq !== this.saveSeq) return cleanup();  // superseded before we wrote
      fs.writeFile(tmpPath, json, 'utf-8', (writeErr) => {
        if (writeErr) return fail(`Failed to save config: ${writeErr}`);
        // A newer save is already carrying this change and more besides —
        // let it be the one that lands, and leave skipNextReload set for it.
        if (seq !== this.saveSeq) return cleanup();
        fs.rename(tmpPath, this.configPath, (renameErr) => {
          if (renameErr) return fail(`Failed to save config: ${renameErr}`);
          if (seq !== this.saveSeq) return;  // a newer save will rearm instead
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
      const watcher = fs.watch(this.configPath, () => {
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
      /*
       * An FSWatcher that fails *after* it was created emits 'error', and an
       * 'error' with no listener is rethrown by EventEmitter as an uncaught
       * exception — the try/catch above only covers the call that made it. It
       * happens for ordinary reasons: the folder goes away, a network or
       * synced drive drops, permissions change under it.
       *
       * The app survives that (the main process logs uncaught exceptions), but
       * the watcher is dead either way, so hot-reloading config.json quietly
       * stopped working for the rest of the session with nothing said. Handle
       * it, and say so.
       */
      watcher.on('error', (err) => {
        log.warn(`Config watcher stopped (${(err as Error).message}) — edits to config.json `
          + 'made outside the app will not be picked up until it restarts.');
        watcher.close();
        if (this.watcher === watcher) this.watcher = null;
      });
      this.watcher = watcher;
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
