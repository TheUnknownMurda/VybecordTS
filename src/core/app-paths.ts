/**
 * Resolve install directory (read-only assets) vs user data directory (writable config).
 * Packaged app stores user data in %APPDATA%\VybecordTS (not next to the .exe).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getInstallDir, isPackaged } from './runtime-paths.js';

export interface AppPaths {
  /** Folder containing VybecordTS.exe and bundled assets */
  installDir: string;
  /** Writable folder for config.json, logs, databases */
  dataDir: string;
}

const MIGRATE_FILES = [
  'config.json',
  'stats-history.json',
  'listening-history.json',
  'flagged-lyrics.json',
  'lrclib-custom.sqlite3',
  'translate-cache.json',
];

const DATA_MARKERS = ['config.json', 'flagged-lyrics.json', 'listening-history.json', 'stats-history.json'];

export function resolveAppPaths(): AppPaths {
  const installDir = getInstallDir();
  const dataDir = process.env.VYBECORD_DATA_DIR?.trim() || getDefaultDataDir(installDir);
  ensureDataDirs(dataDir);
  if (!isPackaged() && !process.env.VYBECORD_DATA_DIR) {
    rememberDevDataLocation(process.cwd());
  }
  migrateLegacyData(discoverLegacyDataDirs(installDir, dataDir), dataDir);
  return { installDir, dataDir };
}

/** Remember dev project folder so the installed .exe can find your data later. */
function rememberDevDataLocation(cwd: string): void {
  if (!looksLikeDataDir(cwd)) return;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const pointer = path.join(appData, 'VybecordTS', 'data-location.txt');
  try {
    fs.mkdirSync(path.dirname(pointer), { recursive: true });
    fs.writeFileSync(pointer, path.resolve(cwd) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/** Writable data folder — Roaming AppData when installed, else install dir or cwd. */
function getDefaultDataDir(installDir: string): string {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const pointerPath = path.join(appData, 'VybecordTS', 'data-location.txt');
  if (fs.existsSync(pointerPath)) {
    try {
      const target = fs.readFileSync(pointerPath, 'utf8').trim().split(/\r?\n/)[0]?.trim();
      if (target && looksLikeDataDir(target)) return path.resolve(target);
    } catch { /* ignore */ }
  }
  if (isPackaged()) {
    return path.join(appData, 'VybecordTS');
  }
  return resolveWritableDataDir(installDir);
}

function resolveWritableDataDir(installDir: string): string {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const fallback = path.join(appData, 'VybecordTS');
  try {
    fs.mkdirSync(installDir, { recursive: true });
    const probe = path.join(installDir, `.write-${process.pid}`);
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return installDir;
  } catch {
    return fallback;
  }
}

function ensureDataDirs(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'envs'), { recursive: true });
}

function looksLikeDataDir(dir: string): boolean {
  if (!dir) return false;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    return DATA_MARKERS.some((name) => fs.existsSync(path.join(dir, name)));
  } catch {
    return false;
  }
}

/** Collect folders that may hold an older VybecordTS data set. */
function discoverLegacyDataDirs(installDir: string, dataDir: string): string[] {
  const dirs = new Set<string>();
  const add = (d: string | undefined) => {
    if (!d) return;
    const resolved = path.resolve(d);
    if (looksLikeDataDir(resolved)) dirs.add(resolved);
  };

  add(installDir);
  add(dataDir);

  const localInstall = path.join(process.env.LOCALAPPDATA || '', 'VybecordTS');
  add(localInstall);

  // Optional pointer: one line = absolute path to previous data folder (e.g. dev clone)
  for (const base of [installDir, localInstall, dataDir]) {
    const pointer = path.join(base, 'data-location.txt');
    if (!fs.existsSync(pointer)) continue;
    try {
      const target = fs.readFileSync(pointer, 'utf8').trim().split(/\r?\n/)[0]?.trim();
      add(target);
    } catch { /* ignore */ }
  }

  add(process.cwd());
  for (const root of [installDir, process.cwd()]) {
    let dir = path.resolve(root);
    for (let depth = 0; depth < 4; depth++) {
      add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return [...dirs];
}

/**
 * Merge legacy data into dataDir (newest file wins per asset).
 * Does not delete sources.
 */
function migrateLegacyData(sources: string[], dataDir: string): void {
  const target = path.resolve(dataDir);
  for (const name of MIGRATE_FILES) {
    let best: { from: string; mtime: number; size: number } | null = null;

    for (const dir of sources) {
      if (path.resolve(dir) === target) continue;
      const from = path.join(dir, name);
      if (!fs.existsSync(from)) continue;
      try {
        const st = fs.statSync(from);
        if (!best || st.mtimeMs > best.mtime || (st.mtimeMs === best.mtime && st.size > best.size)) {
          best = { from, mtime: st.mtimeMs, size: st.size };
        }
      } catch { /* skip */ }
    }

    if (!best) continue;

    const to = path.join(dataDir, name);
    try {
      if (!fs.existsSync(to)) {
        fs.copyFileSync(best.from, to);
        continue;
      }
      const destSt = fs.statSync(to);
      if (destSt.size === 0 || best.mtime > destSt.mtimeMs || best.size > destSt.size) {
        fs.copyFileSync(best.from, to);
      }
    } catch { /* ignore */ }
  }
}
