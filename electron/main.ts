/**
 * Electron main process — owns the window, the tray and the backend.
 *
 * This replaces the old pairing of a console process and a localhost dashboard.
 * The backend now runs inside the main process and talks to the UI over IPC, so
 * there is no HTTP server, no port to collide with, and no way for another page
 * on the machine to reach the app's API.
 */

import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { initLogFile, createLogger, setLogLevel, flushAndClose } from '../src/core/logger.js';
import { initTranslateCache, flushTranslationCache } from '../src/core/translate.js';
import { initUpdater, stopUpdater } from './updater.js';
import { setYtDlpSearchDir, setYtDlpBundled } from '../src/core/youtube-captions.js';
import { setKuromojiDicPath } from '../src/core/romanize.js';
import { VybecordBackend } from '../src/backend.js';
import { registerIpc } from './ipc.js';
import { startAwayWatch } from './away-watch.js';
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
  initUpdater(() => win);

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

  createWindow();
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

  // Keep the tray tooltip in step with what is playing.
  backend.on('trackUpdate', (track: TrackData | null) => {
    tray?.setToolTip(trayTooltip(track));
  });
}

// ── Window ──

function createWindow(): void {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 880,
    minHeight: 580,
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
  void win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  win.once('ready-to-show', () => {
    if (backend?.getConfig().start_minimized === true) return;
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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Vybecord', click: () => showWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => void quitApp() },
  ]));
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
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
