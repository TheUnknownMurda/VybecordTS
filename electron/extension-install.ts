/**
 * Helping the user install the browser extension.
 *
 * A desktop app cannot install a browser extension. Browsers block it on
 * purpose, and every workaround is worse than the problem:
 *
 *   - `chrome://extensions` passed on the command line is refused; Chrome opens
 *     its home page instead. Verified, not assumed.
 *   - `--load-extension` is ignored when the browser is already running, nags on
 *     every start, and does not survive a restart.
 *   - The enterprise force-install policy needs admin rights and a store listing
 *     anyway.
 *
 * Genuine one-click installation requires publishing to the Chrome Web Store,
 * Edge Add-ons and Firefox AMO — after which the app can simply open the
 * listing. Until then the honest thing is to make the manual path short and
 * unambiguous: say which browsers are installed, put the folder one click away,
 * and put the address on the clipboard so it need not be typed.
 */

import { app, shell, clipboard } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createLogger } from '../src/core/logger.js';

const log = createLogger('Extension');

export interface BrowserInfo {
  id: string;
  name: string;
  /** The page that hosts "Load unpacked", for the user to paste. */
  extensionsUrl: string;
  family: 'chromium' | 'firefox';
}

/**
 * Browsers worth naming, keyed by the registry entry Windows lists them under.
 *
 * Detection is by registry rather than by guessing install paths: a browser
 * installed per-user lives under AppData with a username in the path, and
 * hardcoding Program Files would miss it.
 */
const KNOWN_BROWSERS: { match: RegExp; info: BrowserInfo }[] = [
  { match: /chrome/i, info: { id: 'chrome', name: 'Google Chrome', extensionsUrl: 'chrome://extensions', family: 'chromium' } },
  { match: /edge/i, info: { id: 'edge', name: 'Microsoft Edge', extensionsUrl: 'edge://extensions', family: 'chromium' } },
  { match: /brave/i, info: { id: 'brave', name: 'Brave', extensionsUrl: 'brave://extensions', family: 'chromium' } },
  { match: /vivaldi/i, info: { id: 'vivaldi', name: 'Vivaldi', extensionsUrl: 'vivaldi://extensions', family: 'chromium' } },
  { match: /opera/i, info: { id: 'opera', name: 'Opera', extensionsUrl: 'opera://extensions', family: 'chromium' } },
  { match: /firefox/i, info: { id: 'firefox', name: 'Firefox', extensionsUrl: 'about:debugging#/runtime/this-firefox', family: 'firefox' } },
];

/** Where the extension folder lives, packaged or not. */
export function extensionPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.join(process.cwd(), 'extension');
}

export function extensionExists(): boolean {
  try {
    return fs.existsSync(path.join(extensionPath(), 'manifest.json'));
  } catch {
    return false;
  }
}

/**
 * Browsers installed on this machine.
 *
 * Reads the Start Menu internet clients key, which every mainstream browser
 * registers itself under. Failure is not an error — the UI simply lists the
 * usual suspects instead.
 */
export function detectBrowsers(): Promise<BrowserInfo[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);

  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKLM\\SOFTWARE\\Clients\\StartMenuInternet'], { timeout: 4000 },
      (err, stdout) => {
        if (err) {
          log.debug(`Browser detection failed: ${err.message}`);
          resolve([]);
          return;
        }
        const found: BrowserInfo[] = [];
        for (const line of stdout.split('\n')) {
          for (const { match, info } of KNOWN_BROWSERS) {
            if (match.test(line) && !found.some(b => b.id === info.id)) found.push(info);
          }
        }
        resolve(found);
      });
  });
}

/** Reveal the extension folder so "Load unpacked" is one browse away. */
export function revealExtensionFolder(): void {
  const dir = extensionPath();
  if (!extensionExists()) {
    log.warn(`Extension folder missing at ${dir}`);
    return;
  }
  // showItemInFolder on the manifest, so the folder opens with the file that
  // Firefox's "Load Temporary Add-on" asks for already selected.
  shell.showItemInFolder(path.join(dir, 'manifest.json'));
}

/** Put a browser's extensions page on the clipboard — it cannot be opened for them. */
export function copyExtensionsUrl(url: string): void {
  clipboard.writeText(url);
}

/** Put the folder path on the clipboard, for pasting into the file picker. */
export function copyExtensionPath(): void {
  clipboard.writeText(extensionPath());
}
