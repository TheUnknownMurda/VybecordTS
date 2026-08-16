#!/usr/bin/env node
/**
 * VybecordTS — Compile the Inno Setup installer.
 *
 * Usage:  npm run build:installer   (expects build/VybecordTS/ to exist)
 *         npm run build:exe         (runs this as its last step)
 *
 * Set ISCC_PATH if Inno Setup lives somewhere unusual.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const ISS = path.join(ROOT, 'installer', 'VybecordTS.iss');
const DIST = path.join(ROOT, 'build', 'VybecordTS');

/** Locate ISCC.exe, or null if Inno Setup isn't installed. */
export function findIscc() {
  if (process.env.ISCC_PATH && fs.existsSync(process.env.ISCC_PATH)) return process.env.ISCC_PATH;
  // Program Files when installed elevated, user profile when winget runs
  // without elevation.
  const candidates = [
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  ];
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

/**
 * Compile the installer. Never throws: a missing Inno Setup or a script error
 * must not invalidate an otherwise good .exe build.
 * Returns the path to the generated setup, or null.
 */
export function buildInstaller() {
  if (!fs.existsSync(ISS)) {
    console.warn(`  ⚠ Skipped: ${path.relative(ROOT, ISS)} not found`);
    return null;
  }
  if (!fs.existsSync(path.join(DIST, 'VybecordTS.exe'))) {
    console.warn('  ⚠ Skipped: build/VybecordTS/VybecordTS.exe missing — run "npm run build:exe" first');
    return null;
  }

  const iscc = findIscc();
  if (!iscc) {
    console.warn('  ⚠ Skipped: Inno Setup not installed.');
    console.warn('    Install it with:  winget install JRSoftware.InnoSetup');
    console.warn('    (or set ISCC_PATH to your ISCC.exe)');
    return null;
  }

  try {
    const cmd = `"${iscc}" /Q "${ISS}"`;
    console.log(`  > ${cmd}`);
    execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    console.warn(`  ⚠ Inno Setup failed: ${e.message}`);
    return null;
  }

  const setupExe = path.join(ROOT, 'build', 'VybecordTS-Setup.exe');
  if (!fs.existsSync(setupExe)) {
    console.warn('  ⚠ Inno Setup reported success but no installer was produced');
    return null;
  }

  const mb = (fs.statSync(setupExe).size / 1_048_576).toFixed(1);
  console.log(`  ✓ VybecordTS-Setup.exe (${mb} MB)`);
  return setupExe;
}

// Standalone invocation. pathToFileURL handles the Windows drive letter and
// separators — a hand-built "file://" + argv[1] never matches import.meta.url.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('Building the installer...');
  process.exitCode = buildInstaller() ? 0 : 1;
}
