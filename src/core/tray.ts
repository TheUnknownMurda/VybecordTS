/**
 * System tray icon — a WinForms NotifyIcon driven by a long-running PowerShell
 * helper, mirroring how DesktopSource drives smtc-reader.ps1.
 *
 * A plain .ps1 next to the exe is deliberate: the npm tray packages all ship an
 * unsigned helper binary that gets extracted and executed at runtime, which is
 * exactly the shape antivirus heuristics flag on an already-unsigned build.
 *
 * Windows only — a no-op elsewhere.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createLogger } from './logger.js';

const log = createLogger('Tray');

export type TrayCommand = 'dashboard' | 'setup' | 'quit';

interface TrayMessage {
  ready?: boolean;
  cmd?: TrayCommand;
}

/** Grace period for the helper to dispose its icon before we kill it. */
const SHUTDOWN_GRACE_MS = 800;

export class TrayIcon {
  private psProcess: ChildProcess | null = null;
  private lineBuffer = '';
  private stopped = false;
  private lastTooltip = '';
  private readonly onCommand: (cmd: TrayCommand) => void;

  constructor(onCommand: (cmd: TrayCommand) => void) {
    this.onCommand = onCommand;
  }

  start(): void {
    if (process.platform !== 'win32') {
      log.debug('Tray icon is Windows-only — skipped');
      return;
    }
    if (this.psProcess) return;

    const IS_PKG = !!(process as unknown as { pkg?: unknown }).pkg;
    // Packaged: everything sits next to the exe. Dev: the .ps1 lives beside
    // this module, the icon in assets/.
    const scriptDir = IS_PKG
      ? path.dirname(process.execPath)
      : path.dirname(fileURLToPath(import.meta.url));
    const scriptPath = path.join(scriptDir, 'tray.ps1');

    if (!existsSync(scriptPath)) {
      log.warn(`tray.ps1 not found at ${scriptPath} — no tray icon`);
      return;
    }

    const iconPath = IS_PKG
      ? path.join(scriptDir, 'icon.ico')
      : path.join(process.cwd(), 'assets', 'icon.ico');

    // powershell.exe (5.1), not pwsh: it runs STA by default, which WinForms
    // requires. pwsh 7 defaults to MTA and the context menu misbehaves there.
    this.psProcess = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-IconPath', iconPath,
      '-FallbackExe', process.execPath,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.psProcess.stdout!.on('data', (chunk: Buffer) => {
      this.lineBuffer += chunk.toString('utf8');
      const lines = this.lineBuffer.split('\n');
      this.lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as TrayMessage;
          if (msg.ready) {
            log.info('Tray icon ready ✓');
            continue;
          }
          if (msg.cmd) this.onCommand(msg.cmd);
        } catch {
          log.debug(`Tray parse error: ${trimmed.slice(0, 100)}`);
        }
      }
    });

    this.psProcess.stderr!.on('data', (chunk: Buffer) => {
      const msg = chunk.toString('utf8').trim();
      if (msg) log.debug(`Tray stderr: ${msg.slice(0, 200)}`);
    });

    this.psProcess.on('exit', (code) => {
      this.psProcess = null;
      // No auto-restart: the tray is cosmetic, and respawning powershell.exe in
      // a crash loop would look far worse to an antivirus than a missing icon.
      if (!this.stopped) log.warn(`Tray helper exited (code=${code}) — no tray icon`);
    });
  }

  /** Update the hover tooltip. Silently ignored when the helper isn't running. */
  setTooltip(text: string): void {
    if (!this.psProcess?.stdin?.writable) return;
    if (text === this.lastTooltip) return;
    this.lastTooltip = text;
    this.psProcess.stdin.write(`${JSON.stringify({ tooltip: text })}\n`);
  }

  stop(): void {
    this.stopped = true;
    const proc = this.psProcess;
    if (!proc) return;
    this.psProcess = null;

    // Closing stdin lets the helper dispose the icon itself — killing it
    // outright leaves a ghost in the notification area until the user hovers.
    proc.stdin?.end();
    const kill = setTimeout(() => proc.kill(), SHUTDOWN_GRACE_MS);
    proc.once('exit', () => clearTimeout(kill));
  }
}
