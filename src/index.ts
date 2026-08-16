/**
 * VybecordTS — Entry point.
 *
 * Discord Rich Presence with real-time synced lyrics.
 * TypeScript edition — zero bloat, maximum performance.
 */

import path from 'node:path';
import { exec } from 'node:child_process';
import { config as loadEnv } from 'dotenv';
import { initLogFile, setLogLevel, createLogger, flushAndClose, writeRainbow, writeBigRainbow, renderBigText, centerText, writeSection } from './core/logger.js';
import { flushTranslationCache, initTranslateCache } from './core/translate.js';
import { VybecordBackend } from './backend.js';
import { WebServer } from './web/server.js';
import { TrayIcon } from './core/tray.js';
import type { TrackData } from './core/types.js';

const log = createLogger('Main');
const startTime = Date.now();

const BASE_URL = 'http://127.0.0.1:8888';

/** Open a URL in the user's default browser. Failure is never fatal. */
function openInBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) log.debug(`Could not open browser: ${err.message}`); });
}

/** Tray tooltip for the current track — "VybecordTS" when nothing is playing. */
function trayTooltip(track: TrackData | null): string {
  if (!track?.track_name) return 'VybecordTS';
  return track.artist_name
    ? `${track.artist_name} — ${track.track_name}`
    : track.track_name;
}

// ── Resolve working directory ──
// When packaged with pkg, use the exe's directory so config/db are found next to it
const IS_PKG = !!(process as unknown as { pkg?: unknown }).pkg;
const baseDir = IS_PKG ? path.dirname(process.execPath) : process.cwd();
const envsDir = path.join(baseDir, 'envs');

// ── Load .env ──
loadEnv({ path: path.join(envsDir, '.env') });

// ── Init logging ──
initLogFile(path.join(baseDir, 'logs'));

// ── Banner ──
const logoWidth = Math.max(...renderBigText('VYBECORD').map(l => l.length));
writeBigRainbow('VYBECORD');
writeRainbow('');
writeRainbow(centerText('Discord Rich Presence  •  Synced Lyrics', logoWidth));
writeRainbow(centerText('v1.0.0 — starting up, please wait...', logoWidth));
writeRainbow('');
writeSection('Startup', logoWidth);

// Deferred to here (was module-import side effect before) so its log line
// can't ever print above the banner.
initTranslateCache();

// ── Global error safety net ──
process.on('uncaughtException', (err) => {
  log.error(`Uncaught exception: ${err.stack || err}`);
  flushAndClose();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled rejection: ${reason}`);
});

// ── Start ──
async function main() {
  const backend = new VybecordBackend(baseDir);
  const web = new WebServer(backend, 8888);

  let tray: TrayIcon | null = null;

  // Graceful shutdown
  let shuttingDown = false;
  const onExit = async () => {
    if (shuttingDown) return; // Prevent double-shutdown
    shuttingDown = true;
    writeSection('Shutting down', logoWidth);
    log.info('Stopping background services...');
    flushTranslationCache();
    tray?.stop();
    web.stop();
    await backend.shutdown();
    // Brief delay to let the IPC socket flush clearActivity before exit
    await new Promise(r => setTimeout(r, 300));
    writeRainbow(centerText('VybecordTS stopped — see you next time', logoWidth));
    flushAndClose();
    process.exit(0);
  };
  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);
  backend.on('shutdownRequested', onExit);

  try {
    await backend.start();
    web.start();
    log.info(`VybecordTS ready in ${Date.now() - startTime}ms ✓ — press Ctrl+C to stop`);

    // System tray icon — opt-out via "tray_enabled": false in config.json.
    if (backend.getConfig().tray_enabled !== false) {
      tray = new TrayIcon((cmd) => {
        switch (cmd) {
          case 'quit': void onExit(); break;
          case 'setup': openInBrowser(`${BASE_URL}/setup`); break;
          case 'dashboard': openInBrowser(BASE_URL); break;
        }
      });
      tray.start();
      // Hovering the icon shows what's playing.
      backend.on('trackUpdate', (track: TrackData | null) => {
        tray?.setTooltip(trayTooltip(track));
      });
    }

    // Auto-open in default browser: the onboarding page until it has been
    // completed once, the dashboard afterwards.
    const firstRun = backend.getConfig().first_run_completed !== true;
    openInBrowser(firstRun ? `${BASE_URL}/setup` : BASE_URL);
  } catch (e) {
    log.error(`Fatal: ${e}`);
    flushAndClose();
    process.exit(1);
  }
}

main();
