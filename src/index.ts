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

const log = createLogger('Main');
const startTime = Date.now();

// ── System Tray Setup ──
async function setupTray(): Promise<void> {
  try {
    // Only hide console if VYBECORD_TRAY_MODE is set (for start-hidden mode)
    // The tray icon is now launched by run.bat separately
    if (process.platform === 'win32' && process.env.VYBECORD_TRAY_MODE === '1') {
      try {
        const psScript = `
          Add-Type -Name Window -Namespace Console -MemberDefinition '
            [DllImport("user32.dll")]
            public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
            [DllImport("kernel32.dll")]
            public static extern IntPtr GetConsoleWindow();
          '
          $consoleWindow = [Console.Window]::GetConsoleWindow()
          if ($consoleWindow -ne [IntPtr]::Zero) {
            [Console.Window]::ShowWindow($consoleWindow, 0) # 0 = SW_HIDE
          }
        `;
        exec(`powershell.exe -WindowStyle Hidden -Command "${psScript.replace(/\n/g, ' ')}"`, (err) => {
          if (err) log.debug(`Could not hide console: ${err.message}`);
        });
        log.info('Console hidden - app running in background ✓');
      } catch (e) {
        log.debug(`Could not hide console: ${e}`);
      }
    }
  } catch (e) {
    log.warn(`Could not setup system tray: ${e}`);
  }
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

  // Graceful shutdown
  let shuttingDown = false;
  const onExit = async () => {
    if (shuttingDown) return; // Prevent double-shutdown
    shuttingDown = true;
    writeSection('Shutting down', logoWidth);
    log.info('Stopping background services...');
    flushTranslationCache();
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
    // Setup system tray/console hiding before starting backend
    await setupTray();
    
    await backend.start();
    web.start();
    log.info(`VybecordTS ready in ${Date.now() - startTime}ms ✓ — press Ctrl+C to stop`);

    // Auto-open dashboard in default browser
    const url = 'http://127.0.0.1:8888';
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, (err) => { if (err) log.debug(`Could not open browser: ${err.message}`); });
  } catch (e) {
    log.error(`Fatal: ${e}`);
    flushAndClose();
    process.exit(1);
  }
}

main();
