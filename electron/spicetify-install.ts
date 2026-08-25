/**
 * Getting the Vybecord extension into Spicetify.
 *
 * Spicetify is how Spotify is read: it reports the track the moment it changes,
 * with the album-art CDN URL, every artist, playlist context and exact progress
 * — none of which the Windows media session knows.
 *
 * Setting it up is three steps, and the usual failure is stopping after one of
 * them: the file copied but never enabled, or enabled but never applied, both of
 * which look exactly like "it does not work". So the app runs all three itself.
 * The last one patches the Spotify client and restarts it, which is why it is a
 * button the user presses rather than something that happens quietly — but it is
 * `spicetify apply`, an ordinary CLI call, not something only a human can do.
 *
 * Installing Spicetify itself is still left to the user: the official installer
 * is a script downloaded and executed from the internet, and an app should not
 * do that on someone's behalf without them reading it first.
 */

import { app, shell, clipboard } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createLogger } from '../src/core/logger.js';

const log = createLogger('Spicetify');

/** The file Spicetify loads, and the name `spicetify config extensions` expects. */
const EXTENSION_FILE = 'vybecord.js';

/** Official one-liner from spicetify.app/docs/getting-started. */
export const SPICETIFY_INSTALL_CMD =
  'iwr -useb https://raw.githubusercontent.com/spicetify/cli/main/install.ps1 | iex';

/** Enable the extension and rebuild the client. */
export const SPICETIFY_ENABLE_CMD = 'spicetify config extensions vybecord.js';
export const SPICETIFY_APPLY_CMD = 'spicetify apply';

/**
 * How long `spicetify apply` may take.
 *
 * It rebuilds the client's bundle and restarts Spotify, which on a cold disk is
 * comfortably tens of seconds. Generous because the cost of cutting it short is
 * a half-patched client, and the cost of waiting is a spinner.
 */
const APPLY_TIMEOUT_MS = 180_000;

/** Anything else finishes fast or is broken. */
const CLI_TIMEOUT_MS = 20_000;

export interface SpicetifyInfo {
  /** Spicetify's own folder exists — it has been installed at least once. */
  installed: boolean;
  /** vybecord.js is sitting in the Extensions folder. */
  extensionCopied: boolean;
  /** config-xpui.ini lists it, so `spicetify apply` will include it. */
  extensionEnabled: boolean;
  /** The app has a copy to install from. */
  bundled: boolean;
  extensionsDir: string;
}

/** Spicetify keeps everything under %APPDATA%\spicetify on Windows. */
function spicetifyRoot(): string {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'spicetify');
}

export function spicetifyExtensionsDir(): string {
  return path.join(spicetifyRoot(), 'Extensions');
}

/** The copy shipped with the app, packaged or not. */
function bundledExtension(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'spicetify-extension', EXTENSION_FILE)
    : path.join(process.cwd(), 'spicetify-extension', EXTENSION_FILE);
}

/**
 * Whether config-xpui.ini has the extension in its list.
 *
 * The file is INI-shaped with an `extensions = a.js|b.js` line. Copying the file
 * in is not enough on its own — Spicetify only injects what that line names,
 * which is the step people miss and then wonder why nothing happens.
 */
function isEnabledInConfig(): boolean {
  try {
    const ini = fs.readFileSync(path.join(spicetifyRoot(), 'config-xpui.ini'), 'utf-8');
    const line = ini.split(/\r?\n/).find(l => /^\s*extensions\s*=/.test(l));
    return !!line && line.split('=').slice(1).join('=').split('|').some(e => e.trim() === EXTENSION_FILE);
  } catch {
    return false;
  }
}

export function spicetifyInfo(): SpicetifyInfo {
  const extensionsDir = spicetifyExtensionsDir();
  let installed = false;
  let extensionCopied = false;
  try {
    installed = fs.existsSync(spicetifyRoot());
    extensionCopied = fs.existsSync(path.join(extensionsDir, EXTENSION_FILE));
  } catch { /* treated as not installed */ }

  return {
    installed,
    extensionCopied,
    extensionEnabled: isEnabledInConfig(),
    bundled: fs.existsSync(bundledExtension()),
    extensionsDir,
  };
}

/**
 * Copy the bundled extension into Spicetify's Extensions folder.
 *
 * Overwrites deliberately: the usual reason to press this twice is that the app
 * updated and the copy on disk is the old one.
 */
export function installSpicetifyExtension(): { ok: true; path: string } {
  const source = bundledExtension();
  if (!fs.existsSync(source)) throw new Error('The extension file is missing from this install');

  const dir = spicetifyExtensionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, EXTENSION_FILE);
  fs.copyFileSync(source, target);
  log.info(`Copied the Spicetify extension to ${target}`);
  return { ok: true, path: target };
}

export function revealSpicetifyExtensions(): { ok: true; dir: string } {
  const dir = spicetifyExtensionsDir();
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return { ok: true, dir };
}

export function copyToClipboard(text: string): void {
  clipboard.writeText(text);
}

// ── Running the CLI ──────────────────────────────────────────────────────────

/**
 * The spicetify executable.
 *
 * PATH first, because that is where its own installer puts it. The explicit
 * locations cover the case where it was installed in this session and the shell
 * environment this process inherited predates it — a fresh install then looks
 * missing until the user logs out, which is a confusing thing to be told.
 */
function spicetifyExe(): string {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  for (const candidate of [
    path.join(local, 'spicetify', 'spicetify.exe'),
    path.join(spicetifyRoot(), 'spicetify.exe'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'spicetify';  // let PATH resolve it
}

function runSpicetify(args: string[], timeout: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(spicetifyExe(), args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      if (!err) {
        resolve({ ok: true, output });
        return;
      }
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      resolve({
        ok: false,
        output: missing
          ? 'The spicetify command was not found. Install Spicetify first.'
          : output || err.message,
      });
    });
  });
}

export interface SetupStep {
  id: 'copy' | 'enable' | 'apply';
  label: string;
  ok: boolean;
  detail: string;
}

/**
 * Do the whole setup: copy the extension, enable it, rebuild the client.
 *
 * Runs to the first failure and reports which step it was, because "it did not
 * work" is unactionable and "apply failed, Spotify is from the Microsoft Store"
 * is not. Steps already done are skipped rather than repeated — enabling twice
 * appends the extension to Spicetify's list a second time.
 */
export async function setupSpicetify(): Promise<{ ok: boolean; steps: SetupStep[] }> {
  const steps: SetupStep[] = [];
  const fail = (id: SetupStep['id'], label: string, detail: string) => {
    steps.push({ id, label, ok: false, detail });
    return { ok: false, steps };
  };

  // 1. The file itself.
  try {
    const { path: target } = installSpicetifyExtension();
    steps.push({ id: 'copy', label: 'Extension file', ok: true, detail: `Copied to ${target}` });
  } catch (e) {
    return fail('copy', 'Extension file', `${(e as Error).message}`);
  }

  // 2. Name it in config-xpui.ini, unless it is already there.
  if (isEnabledInConfig()) {
    steps.push({ id: 'enable', label: 'Enabled in Spicetify', ok: true, detail: 'Already listed in the config' });
  } else {
    const res = await runSpicetify(['config', 'extensions', EXTENSION_FILE], CLI_TIMEOUT_MS);
    if (!res.ok) return fail('enable', 'Enabled in Spicetify', res.output);
    steps.push({ id: 'enable', label: 'Enabled in Spicetify', ok: true, detail: 'Added to the extensions list' });
  }

  // 3. Rebuild the client. This restarts Spotify.
  const applied = await runSpicetify(['apply'], APPLY_TIMEOUT_MS);
  if (!applied.ok) {
    return fail('apply', 'Spotify rebuilt', applied.output
      + '\n\nIf this is the Microsoft Store build of Spotify, Spicetify cannot patch it — '
      + 'install Spotify from spotify.com instead.');
  }
  steps.push({ id: 'apply', label: 'Spotify rebuilt', ok: true, detail: 'Spicetify applied and Spotify restarted' });

  log.info('Spicetify setup completed from the app');
  return { ok: true, steps };
}
