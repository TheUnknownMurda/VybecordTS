/**
 * Getting the Vybecord extension into Spicetify.
 *
 * Spicetify is how Spotify is read: it reports the track the moment it changes,
 * with the album-art CDN URL, every artist, playlist context and exact progress
 * — none of which the Windows media session knows. The install is three steps
 * the app cannot take on the user's behalf (it patches the Spotify client), so
 * this reports where things stand and does the one part it safely can: dropping
 * the extension file where Spicetify looks for it.
 */

import { app, shell, clipboard } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
