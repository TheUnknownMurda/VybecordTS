/**
 * Electron main process — owns the window, the tray and the backend.
 *
 * This replaces the old pairing of a console process and a localhost dashboard.
 * The backend now runs inside the main process and talks to the UI over IPC, so
 * there is no HTTP server, no port to collide with, and no way for another page
 * on the machine to reach the app's API.
 */

import { app, BrowserWindow, Tray, Menu, nativeImage, shell, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { initLogFile, createLogger, setLogLevel, flushAndClose } from '../src/core/logger.js';
import { initTranslateCache, flushTranslationCache } from '../src/core/translate.js';
import { initUpdater, stopUpdater, updateState, check as checkForUpdate, installNow, type UpdateState } from './updater.js';
import { setYtDlpSearchDir, setYtDlpBundled } from '../src/core/youtube-captions.js';
import { setKuromojiDicPath } from '../src/core/romanize.js';
import { VybecordBackend } from '../src/backend.js';
import { registerIpc } from './ipc.js';
import { startAwayWatch } from './away-watch.js';
import { WindowState } from './window-state.js';
import { PushServer } from '../src/web/push-server.js';
import type { TrackData } from '../src/core/types.js';

const log = createLogger('Main');
const startTime = Date.now();

// The main process is bundled as ESM (Electron loads it natively), so the
// CommonJS __dirname is not defined — derive it from the module URL instead.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Must run before anything reads a user path: getPath('userData') derives from
// the app name, which otherwise defaults to package.json's "vybecord-desktop".
app.setName('Vybecord');

/**
 * Where config.json, the lyrics DB and the logs live.
 *
 * Packaged, the app sits in Program Files, which is not writable — so user data
 * goes to %APPDATA%. In development the repo directory is used instead, so the
 * existing config.json and custom-lyrics.sqlite3 are picked up as-is.
 */
const baseDir = app.isPackaged ? app.getPath('userData') : process.cwd();

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let backend: VybecordBackend | null = null;
let pushServer: PushServer | null = null;
let stopAwayWatch: (() => void) | null = null;
/** Set once the user really means to exit, so 'close' stops hiding to tray. */
let quitting = false;

/**
 * Started by the login item rather than by someone.
 *
 * applyLaunchOnStartup registers the app with this flag precisely so that
 * signing in does not throw a window in the user's face — but nothing read it,
 * so the window opened at every sign-in unless "Start hidden" was also on.
 */
const launchedHidden = process.argv.includes('--hidden');

// ── Single instance ──
// A second launch should raise the existing window, not start a rival backend
// that would fight the first one over the Discord IPC pipe.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  void start();
}

async function start(): Promise<void> {
  loadEnv({ path: path.join(baseDir, 'envs', '.env') });
  initLogFile(path.join(baseDir, 'logs'));

  const envLogLevel = (process.env.VYBECORD_LOG_LEVEL ?? '').toLowerCase();
  if (envLogLevel === 'debug' || envLogLevel === 'info' || envLogLevel === 'warn' || envLogLevel === 'error') {
    setLogLevel(envLogLevel);
  }
  initTranslateCache(baseDir);
  // Somewhere the user can drop their own yt-dlp without editing their PATH,
  // plus the copy that ships with the app.
  setYtDlpSearchDir(path.join(baseDir, 'bin'));
  // Packaged it sits beside the app; in development it is whatever
  // scripts/fetch-ytdlp.mjs put in vendor/, so both behave identically.
  const ytDlpName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  setYtDlpBundled(app.isPackaged
    ? path.join(process.resourcesPath, ytDlpName)
    : path.join(process.cwd(), 'vendor', ytDlpName));

  /*
   * Where the Japanese dictionary lives, packaged or not.
   *
   * Shipped outside the asar (electron-builder extraResources) because kuromoji
   * opens its .dat.gz files by path, and because it is 17 MB that has no
   * business being read through an archive. Nothing is loaded here — the
   * romaniser builds the tokenizer only when a line of Japanese with kanji in
   * it actually needs one, since it costs 77 MB of heap.
   */
  setKuromojiDicPath(app.isPackaged
    ? path.join(process.resourcesPath, 'kuromoji-dict')
    : path.join(process.cwd(), 'node_modules', 'kuromoji', 'dict'));

  process.on('uncaughtException', (err) => log.error(`Uncaught exception: ${err.stack || err}`));
  process.on('unhandledRejection', (reason) => log.error(`Unhandled rejection: ${reason}`));

  await app.whenReady();

  backend = new VybecordBackend(baseDir, mediaWorkerPath(), lrclibWorkerPath());
  registerIpc(backend, () => win, () => pushServer);

  // Follow the machine's idle clock, so the presence comes down when Discord
  // marks the account away and goes back up on the first keypress — the same
  // manners Discord's own Spotify integration has. The setting is read on every
  // check, so changing it applies immediately.
  stopAwayWatch = startAwayWatch(
    () => Number(backend?.getConfig().away_after_minutes ?? 10),
    (away) => backend?.setUserAway(away),
  );

  // Checks on a delay and again every few hours; installs on the way out, so a
  // long tray session is never interrupted mid-song.
  initUpdater(() => win, refreshTrayMenu);

  // The extension endpoint follows its setting, so an install that does not use
  // the extension never opens a port.
  pushServer = new PushServer(backend);
  const syncPushServer = (enabled: boolean) => {
    if (enabled) pushServer?.start();
    else pushServer?.stop();
  };

  const initialConfig = backend.getConfig();
  syncPushServer(initialConfig.extension_enabled !== false);

  /*
   * Settings that live outside the backend have to be re-applied when they
   * change, not only read once at startup.
   *
   * The push server already was. The tray and the login item were not: flipping
   * either switch wrote config.json and stopped there. For the tray that meant
   * the icon stayed exactly as it was for the rest of the session. For "launch
   * at sign-in" it meant the switch did nothing at all until the app was
   * started again — and starting it again is the one thing someone who wants it
   * to start by itself is not going to do, so the feature simply never engaged.
   */
  let lastTrayEnabled = initialConfig.tray_enabled !== false;
  let lastLaunchOnStartup = initialConfig.launch_on_startup === true;
  backend.on('configUpdate', (cfg: Record<string, unknown>) => {
    syncPushServer(cfg.extension_enabled !== false);
    // The quick switches there show the config, whichever side changed it.
    refreshTrayMenu();

    const trayEnabled = cfg.tray_enabled !== false;
    if (trayEnabled !== lastTrayEnabled) {
      lastTrayEnabled = trayEnabled;
      syncTray(trayEnabled);
    }

    const launchOnStartup = cfg.launch_on_startup === true;
    if (launchOnStartup !== lastLaunchOnStartup) {
      lastLaunchOnStartup = launchOnStartup;
      applyLaunchOnStartup(launchOnStartup);
    }
  });

  createWindow(true);
  syncTray(lastTrayEnabled);
  applyLaunchOnStartup(lastLaunchOnStartup);

  try {
    await backend.start();
    log.info(`Vybecord ready in ${Date.now() - startTime}ms ✓`);
  } catch (e) {
    log.error(`Backend failed to start: ${e}`);
    // The window stays open on purpose: it is the only place the user can be
    // told what went wrong now that there is no console to read.
    win?.webContents.send('backend:fatal', String(e));
  }

  // Keep the tray tooltip in step with what is playing — presence 1, which
  // with two cards is the one that ranks higher.
  backend.on('trackUpdate', () => {
    tray?.setToolTip(trayTooltip(backend?.getCurrentTrack() ?? null));
    refreshTrayMenu();
  });
}

// ── Window ──

/**
 * Default size, for a first launch. Tall enough for the Now playing page with
 * the presence tiles above the cover — a row the page did not have when the
 * old 760 was picked, and which pushed the lyrics past the bottom edge until
 * the window was dragged taller. Later launches open where the user left it.
 */
const DEFAULT_WINDOW = { width: 1180, height: 860 };
const MIN_WINDOW = { width: 880, height: 620 };

/**
 * @param atLaunch  true for the window made at startup, the only one that may
 *   stay hidden. A window recreated later — after it was really closed — is
 *   always made because someone asked for it (the tray, a second launch), and
 *   keeping that one hidden would leave the click doing nothing.
 */
function createWindow(atLaunch = false): void {
  const state = new WindowState(baseDir);
  win = new BrowserWindow({
    ...state.initialBounds(DEFAULT_WINDOW, MIN_WINDOW),
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    frame: false,
    backgroundColor: '#0d0f14',
    icon: resourcePath('assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload needs node built-ins to bridge to the backend; the renderer
      // itself still gets none of them through contextIsolation.
      sandbox: false,
      spellcheck: false,
    },
  });

  win.removeMenu();
  state.apply(win, DEFAULT_WINDOW, MIN_WINDOW);
  state.track(win);
  void win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  win.once('ready-to-show', () => {
    if (atLaunch && (launchedHidden || backend?.getConfig().start_minimized === true)) return;
    win?.show();
  });

  // Closing hides to the tray unless the user asked for a real quit. Without
  // this the app would vanish mid-song with the presence still on screen.
  win.on('close', (e) => {
    if (quitting || backend?.getConfig().minimize_to_tray === false) return;
    e.preventDefault();
    win?.hide();
  });

  win.on('closed', () => { win = null; });

  // Anything that is not the app itself belongs in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });

  // In development the renderer has no visible console, so surface its warnings
  // and errors in the same log as everything else. Packaged builds stay quiet.
  if (!app.isPackaged) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level < 2) return;  // 0 = verbose, 1 = info
      const where = sourceId ? ` (${path.basename(sourceId)}:${line})` : '';
      const write = level === 3 ? log.error : log.warn;
      write(`[renderer] ${message}${where}`);
    });
  }

  // Window state the custom title bar needs to render the right icons.
  const sendState = () => win?.webContents.send('window:state', {
    maximized: win?.isMaximized() ?? false,
  });
  win.on('maximize', sendState);
  win.on('unmaximize', sendState);
}

function showWindow(): void {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ── Tray ──

/**
 * Bring the tray icon into line with the setting, creating or destroying it.
 *
 * Idempotent, because it runs both at startup and on every config change, and
 * most config changes have nothing to do with the tray.
 */
function syncTray(enabled: boolean): void {
  if (enabled === !!tray) return;
  if (!enabled) {
    tray?.destroy();
    tray = null;
    return;
  }
  createTray();
  // The tooltip is set from trackUpdate, which will not fire again until the
  // song changes — so seed it with whatever is playing right now.
  tray?.setToolTip(trayTooltip(backend?.getCurrentTrack() ?? null));
}

function createTray(): void {
  const icon = nativeImage.createFromPath(resourcePath('assets/icon.ico'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Vybecord');
  trayMenuKey = '';
  refreshTrayMenu();
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

/** The per-card lyrics switches, by position; `show_lyrics` is presence 1's. */
const LYRICS_KEYS = ['show_lyrics', 'show_lyrics_2', 'show_lyrics_3', 'show_lyrics_4', 'show_lyrics_5'] as const;
const PRESENCE_COUNTS = ['One', 'Two', 'Three', 'Four', 'Five'];
/** The players Settings → Detection lists, in its order and with its names. */
const DETECT_KEYS: [string, string][] = [
  ['detect_spotify', 'Spotify'], ['detect_apple_music', 'Apple Music'], ['detect_youtube', 'YouTube and YouTube Music'],
  ['detect_soundcloud', 'SoundCloud'], ['detect_browser', 'Other browser tabs'], ['detect_twitch', 'Twitch'],
  ['detect_kick', 'Kick'], ['detect_other_apps', 'Other desktop apps'],
];
/** The sidebar's pages, in its order and with its names. */
const TRAY_PAGES: [string, string][] = [['now', 'Now playing'], ['library', 'Lyrics'], ['activity', 'Activity'], ['settings', 'Settings']];

let trayMenuKey = '';

/*
 * The switches people reach for while the window is closed, in the tray menu:
 * the presence and what it shows, when it hides, which players it detects,
 * how many cards there are, starting with Windows and updates. Same keys as Settings and Now playing,
 * so each place shows what the others changed. Lyrics is one item for every
 * presence in play, since the menu has no room to say which card is which; it
 * reads on while any of them has lyrics, and flips them all together.
 */
function refreshTrayMenu(): void {
  if (!tray || !backend) return;
  const cfg = backend.getConfig() as unknown as Record<string, unknown>;
  const count = Math.min(LYRICS_KEYS.length, Math.max(1, Math.round(Number(cfg.presence_count) || 1)));
  const lyricsKeys = LYRICS_KEYS.slice(0, count);
  const on = (k: string, dflt = true) => (dflt ? cfg[k] !== false : cfg[k] === true);
  const flags = {
    presence: on('rpc_enabled'),
    lyrics: lyricsKeys.some((k) => cfg[k] !== false),
    translate: on('rpc_translate_lyrics', false),
    paused: on('rpc_only_when_playing', false),
    away: on('rpc_hide_when_away'),
    ads: on('filter_spotify_ads'),
    startup: on('launch_on_startup', false),
    detectAll: on('detect_all_media'),
    detect: DETECT_KEYS.map(([k]) => on(k)),
  };
  const playing = trayNowPlaying(backend.getCurrentTrack());
  const update = updateState();
  // Rebuilt only when it would change: configUpdate fires for every setting,
  // and trackUpdate for every play and pause.
  const key = JSON.stringify([flags, count, playing, update.status, 'version' in update ? update.version : '']);
  if (key === trayMenuKey) return;
  trayMenuKey = key;

  // Electron has already flipped `checked` by the time click runs.
  const toggle = (label: string, checked: boolean, write: (v: boolean) => Record<string, unknown>): MenuItemConstructorOptions => ({
    label, type: 'checkbox', checked, click: (item) => backend?.updateConfig(write(item.checked)),
  });

  const template: MenuItemConstructorOptions[] = [
    ...(playing ? [{ label: playing, enabled: false }, { type: 'separator' } as const] : []),
    { label: 'Open Vybecord', click: () => showWindow() },
    { label: 'Go to', submenu: TRAY_PAGES.map(([page, label]) => ({ label, click: () => openPage(page) })) },
    { type: 'separator' },
    toggle('Show on Discord', flags.presence, (v) => ({ rpc_enabled: v })),
    toggle('Lyrics on Discord', flags.lyrics, (v) => Object.fromEntries(lyricsKeys.map((k) => [k, v]))),
    toggle('Translate lyrics on Discord', flags.translate, (v) => ({ rpc_translate_lyrics: v })),
    {
      label: 'Detection',
      submenu: [
        toggle('Detect everything', flags.detectAll, (v) => ({ detect_all_media: v })),
        { type: 'separator' },
        ...DETECT_KEYS.map(([k, label], i) => toggle(label, flags.detect[i], (v) => ({ [k]: v }))),
      ],
    },
    {
      label: 'Presences',
      submenu: PRESENCE_COUNTS.map((label, i) => ({
        label, type: 'radio', checked: count === i + 1,
        click: () => backend?.updateConfig({ presence_count: i + 1 }),
      })),
    },
    { type: 'separator' },
    toggle('Hide when paused', flags.paused, (v) => ({ rpc_only_when_playing: v })),
    toggle('Hide when I’m away', flags.away, (v) => ({ rpc_hide_when_away: v })),
    toggle('Hide during Spotify ads', flags.ads, (v) => ({ filter_spotify_ads: v })),
    { type: 'separator' },
    toggle('Launch at sign-in', flags.startup, (v) => ({ launch_on_startup: v })),
    trayUpdateItem(update),
    { type: 'separator' },
    { label: 'Quit', click: () => void quitApp() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

/** What presence 1 is playing, as a menu heading; '' when nothing plays. */
function trayNowPlaying(track: TrackData | null): string {
  if (!track?.track_name) return '';
  const full = track.artist_name ? `${track.track_name} — ${track.artist_name}` : track.track_name;
  const cut = full.length > 60 ? `${full.slice(0, 59)}…` : full;
  // A single & is a mnemonic marker in a Windows menu label and would vanish.
  return `${track.is_playing ? '♪' : '⏸'} ${cut.replace(/&/g, '&&')}`;
}

/** The update item: a check, the check under way, or the restart that installs it. */
function trayUpdateItem(u: UpdateState): MenuItemConstructorOptions {
  switch (u.status) {
    case 'ready': return { label: `Restart to install ${u.version}`, click: () => installNow() };
    case 'checking': return { label: 'Checking for updates…', enabled: false };
    case 'available':
    case 'downloading': return { label: 'Downloading an update…', enabled: false };
    default: return { label: 'Check for updates', click: () => void checkForUpdate() };
  }
}

/**
 * Open the window on one page. A window that is still loading has not wired
 * its listener yet, so the request waits for it; the renderer holds it until
 * it has booted, then opens there instead of its first page.
 */
function openPage(page: string): void {
  showWindow();
  const contents = win?.webContents;
  if (!contents) return;
  const send = () => contents.send('backend:navigate', page);
  if (contents.isLoading()) contents.once('did-finish-load', send);
  else send();
}

function trayTooltip(track: TrackData | null): string {
  if (!track?.track_name) return 'Vybecord';
  const full = track.artist_name ? `${track.artist_name} — ${track.track_name}` : track.track_name;
  // Windows truncates tray tooltips past 127 chars.
  return full.length > 120 ? `${full.slice(0, 119)}…` : full;
}

// ── Startup registration ──

/** Register or clear the login item. Windows/macOS only; a no-op elsewhere. */
export function applyLaunchOnStartup(enabled: boolean): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      // Launching at login should not throw a window in the user's face.
      args: enabled ? ['--hidden'] : [],
    });
  } catch (e) {
    log.warn(`Could not update the login item: ${(e as Error).message}`);
  }
}

// ── Lifecycle ──

async function quitApp(): Promise<void> {
  if (quitting) return;
  quitting = true;
  log.info('Shutting down...');
  flushTranslationCache();
  stopUpdater();
  stopAwayWatch?.();
  stopAwayWatch = null;
  pushServer?.stop();
  pushServer = null;
  tray?.destroy();
  tray = null;
  try {
    await backend?.shutdown();
  } catch (e) {
    log.error(`Shutdown error: ${e}`);
  }
  // Give the Discord IPC socket a moment to flush clearActivity.
  await new Promise(r => setTimeout(r, 300));
  flushAndClose();
  app.exit(0);
}

app.on('window-all-closed', () => {
  // Deliberately empty on Windows/Linux: the tray keeps the app alive after the
  // window is hidden. Quitting is the tray menu's job.
  if (process.platform === 'darwin') return;
});

app.on('activate', () => showWindow());
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  void quitApp();
});

// Exposed so the IPC layer can trigger a real quit from the renderer.
export { quitApp, showWindow };

// ── Helpers ──

/**
 * Path to the media worker bundle.
 *
 * worker_threads cannot load a script from inside an asar archive, and the
 * native addon it requires cannot be loaded from there either — so the file is
 * listed in electron-builder's asarUnpack and looked up in app.asar.unpacked
 * when packaged.
 */
function mediaWorkerPath(): string {
  return workerPath('media-worker.cjs');
}

/** Where the LRCLIB dump is queried, off the main thread. */
function lrclibWorkerPath(): string {
  return workerPath('lrclib-worker.cjs');
}

/**
 * A bundled worker's path.
 *
 * Packaged, workers live outside the asar: a Worker cannot be started from
 * inside an archive, and both of these load native addons besides.
 */
function workerPath(file: string): string {
  const p = path.join(__dirname, file);
  return app.isPackaged ? p.replace('app.asar', 'app.asar.unpacked') : p;
}

/** Resolve a file that ships with the app, packaged or not. */
function resourcePath(rel: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, rel)
    : path.join(process.cwd(), rel);
}
