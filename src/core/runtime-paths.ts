/**
 * Resolve install directory and bundled asset paths (exe folder, dev, pkg snapshot).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_PKG = !!(process as NodeJS.Process & { pkg?: unknown }).pkg;

/** True when running as packaged VybecordTS.exe (pkg). */
export function isPackaged(): boolean {
  if (IS_PKG) return true;
  return path.basename(process.execPath).toLowerCase() === 'vybecordts.exe';
}

/** Folder containing VybecordTS.exe and sidecar assets (dashboard HTML, ps1, …). */
export function getInstallDir(): string {
  if (isPackaged()) {
    return path.dirname(process.execPath);
  }

  const candidates = [
    path.join(process.cwd(), 'dist'),
    path.join(process.cwd(), 'src', 'web'),
    path.join(process.cwd(), 'build', 'VybecordTS'),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'dashboard.html'))) return dir;
  }

  return process.cwd();
}

/** First existing path for a bundled file, or best-guess path for error messages. */
export function resolveAssetPath(filename: string, installDir?: string): string {
  const bases = [
    installDir,
    getInstallDir(),
    isPackaged() ? path.dirname(process.execPath) : null,
    path.join(process.cwd(), 'dist'),
    path.join(process.cwd(), 'src', 'web'),
    path.join(process.cwd(), 'build', 'VybecordTS'),
  ].filter((d): d is string => !!d);

  const seen = new Set<string>();
  for (const base of bases) {
    const resolved = path.resolve(base);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const filePath = path.join(resolved, filename);
    if (fs.existsSync(filePath)) return filePath;
  }

  return path.join(installDir ?? getInstallDir(), filename);
}
