/**
 * Automatic updates, served from the project's GitHub releases.
 *
 * The installer is published as a release asset; electron-builder writes the
 * latest.yml alongside it that this reads. Nothing here talks to the website —
 * the site is a front door for humans, the updater goes straight to the source.
 *
 * Deliberately quiet: the download happens in the background and the new version
 * is installed when the app is next closed. An app whose whole job is to sit in
 * the tray while music plays should not interrupt to ask about updates.
 *
 * Quiet is not the same as silent, though. Once the download is finished there
 * is something worth offering, and a tray app can go weeks without the quit
 * that would install it — so the window shows a strip proposing a restart (see
 * ui/src/update-banner.js). Nothing is forced and nothing steals focus: the
 * offer waits in the window until someone looks at it.
 */

import { app, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { createLogger } from '../src/core/logger.js';

const log = createLogger('Updater');

// electron-updater is CommonJS; the named export is not reachable from an ESM
// bundle, so it comes off the default object.
const { autoUpdater } = electronUpdater;

/**
 * First check after startup.
 *
 * Long enough to be out of the way of the work that matters at launch — the
 * media monitor, the lyrics database, the Discord socket — and short enough
 * that the answer arrives while the window someone just opened is still in
 * front of them. Thirty seconds was neither: the check landed long after they
 * had gone back to their music.
 */
const FIRST_CHECK_DELAY_MS = 5_000;
/** And again on a long cycle, for the tray copy that runs for days. */
const RECHECK_INTERVAL_MS = 6 * 60 * 60_000;

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'none'; version: string }
  | { status: 'error'; message: string };

let state: UpdateState = { status: 'idle' };
let timer: ReturnType<typeof setInterval> | null = null;
/** The one-shot first check — cancellable, so stopUpdater() really stops it. */
let firstCheck: ReturnType<typeof setTimeout> | null = null;
let notify: ((s: UpdateState) => void) | null = null;

export function updateState(): UpdateState {
  return state;
}

function setState(next: UpdateState): void {
  state = next;
  notify?.(next);
}

/**
 * Wire the updater up.
 *
 * @param getWindow  used to push state to the window when it exists
 */
export function initUpdater(getWindow: () => BrowserWindow | null): void {
  notify = (s) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('backend:updateStatus', s);
  };

  // In development there is no packaged app to replace, and electron-updater
  // throws rather than no-ops. Checking would only produce noise in the log.
  if (!app.isPackaged) {
    log.debug('Not packaged — automatic updates are off in development');
    setState({ status: 'none', version: app.getVersion() });
    return;
  }

  autoUpdater.autoDownload = true;
  // Swapping the app out from under a running player would be rude; the
  // installer runs on the way out instead.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => log.info(String(m)),
    warn: (m: unknown) => log.warn(String(m)),
    error: (m: unknown) => log.error(String(m)),
    debug: (m: unknown) => log.debug(String(m)),
  };

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    log.info(`Update available: ${info.version}`);
    setState({ status: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', () => {
    setState({ status: 'none', version: app.getVersion() });
  });
  autoUpdater.on('download-progress', (p) => {
    setState({ status: 'downloading', version: state.status === 'available' ? state.version : '', percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    log.info(`Update ${info.version} ready — it will install when the app closes`);
    setState({ status: 'ready', version: info.version });
  });
  autoUpdater.on('error', (e) => {
    // A failed check is not worth bothering anyone about: no network, GitHub
    // rate limiting, or simply no release published yet all land here.
    log.warn(`Update check failed: ${e?.message ?? e}`);
    setState({ status: 'error', message: e?.message ?? 'Update check failed' });
  });

  firstCheck = setTimeout(() => { firstCheck = null; void check(); }, FIRST_CHECK_DELAY_MS);
  timer = setInterval(() => void check(), RECHECK_INTERVAL_MS);
}

/** Ask now. Safe to call from a button; failures land in the state, not a throw. */
export async function check(): Promise<UpdateState> {
  if (!app.isPackaged) return state;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    log.warn(`Update check failed: ${e}`);
    setState({ status: 'error', message: (e as Error).message });
  }
  return state;
}

/** Close and install the downloaded update right now. */
export function installNow(): void {
  if (state.status !== 'ready') return;
  log.info('Restarting to install the update');
  // isSilent false so the user sees the installer; isForceRunAfter so the app
  // comes back rather than leaving them staring at a closed window.
  autoUpdater.quitAndInstall(false, true);
}

export function stopUpdater(): void {
  if (timer) { clearInterval(timer); timer = null; }
  // The recurring check was cancelled and the first one was not, so quitting
  // inside the startup window still fired a network request on the way out.
  if (firstCheck) { clearTimeout(firstCheck); firstCheck = null; }
  notify = null;
}
