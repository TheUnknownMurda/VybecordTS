#!/usr/bin/env node
/**
 * VybecordTS — Build pipeline: TypeScript → CJS bundle → Windows .exe
 *
 * Usage:  npm run build:exe
 * Output: build/VybecordTS/  (ready-to-distribute folder)
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildInstaller } from './build-installer.mjs';

const ROOT = process.cwd();
const BUILD = path.join(ROOT, 'build');
const BUNDLE = path.join(BUILD, 'bundle');
const DIST = path.join(BUILD, 'VybecordTS');

// ── Helpers ──

function run(cmd) {
  console.log(`  > ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

function copy(src, dest) {
  const srcPath = path.join(ROOT, src);
  if (!fs.existsSync(srcPath)) {
    console.warn(`  ⚠ Skip (not found): ${src}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(srcPath, dest);
  const kb = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`  ✓ ${path.basename(dest)} (${kb} KB)`);
}

// ── Pipeline ──

console.log('╔══════════════════════════════════════╗');
console.log('║   VybecordTS — EXE Build Pipeline    ║');
console.log('╚══════════════════════════════════════╝\n');

// 1. Clean
console.log('[1/5] Cleaning build directory...');
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1b. Download the correct better-sqlite3 prebuild for Node 20 (pkg target)
// The dev machine may run Node 24+, but the packaged exe embeds Node 20.
// NODE_MODULE_VERSION must match (115 for Node 20) or the native addon won't load.
// We download the official prebuild from GitHub rather than requiring Visual Studio.
const BETTER_SQLITE3_VER = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'node_modules', 'better-sqlite3', 'package.json'), 'utf8')
).version;
const PREBUILD_TAG = `v${BETTER_SQLITE3_VER}`;
const PREBUILD_NAME = `better-sqlite3-v${BETTER_SQLITE3_VER}-node-v115-win32-x64.tar.gz`;
const PREBUILD_URL = `https://github.com/WiseLibs/better-sqlite3/releases/download/${PREBUILD_TAG}/${PREBUILD_NAME}`;
const PREBUILD_DEST = path.join(DIST, 'build', 'Release');

console.log(`\n[1b] Downloading better-sqlite3 prebuild for Node 20 (v${BETTER_SQLITE3_VER})...`);
console.log(`  URL: ${PREBUILD_URL}`);
const PREBUILD_TGZ = path.join(BUILD, 'better_sqlite3_prebuild.tar.gz');
try {
  fs.mkdirSync(PREBUILD_DEST, { recursive: true });
  // Download then extract (two steps — Windows cmd doesn't pipe like bash)
  run(`curl.exe -sL "${PREBUILD_URL}" -o "${PREBUILD_TGZ}"`);
  run(`tar xzf "${PREBUILD_TGZ}" -C "${PREBUILD_DEST}"`);
  // The tarball extracts as build/Release/better_sqlite3.node inside PREBUILD_DEST
  // Move it to the right place if nested
  const nested = path.join(PREBUILD_DEST, 'build', 'Release', 'better_sqlite3.node');
  const flat = path.join(PREBUILD_DEST, 'better_sqlite3.node');
  if (fs.existsSync(nested) && !fs.existsSync(flat)) {
    fs.renameSync(nested, flat);
    fs.rmSync(path.join(PREBUILD_DEST, 'build'), { recursive: true, force: true });
  }
  if (fs.existsSync(flat)) {
    const kb = (fs.statSync(flat).size / 1024).toFixed(0);
    console.log(`  ✓ better_sqlite3.node (${kb} KB) — Node 20 prebuild`);
  } else {
    throw new Error('Extraction succeeded but better_sqlite3.node not found');
  }
  // Clean up temp archive
  fs.unlinkSync(PREBUILD_TGZ);
} catch (e) {
  console.warn(`  ⚠ Prebuild download failed: ${e.message}`);
  console.warn('    Falling back to local .node (may have version mismatch)');
  const localNode = path.join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  if (fs.existsSync(localNode)) {
    fs.mkdirSync(PREBUILD_DEST, { recursive: true });
    fs.copyFileSync(localNode, path.join(PREBUILD_DEST, 'better_sqlite3.node'));
    console.log('  ✓ Copied local better_sqlite3.node as fallback');
  }
}

// 2. Bundle TS → CJS (better-sqlite3 stays external — native module)
console.log('\n[2/5] Bundling TypeScript → CJS...');
run([
  'npx tsup src/index.ts',
  '--format cjs',
  `--out-dir "${BUNDLE}"`,
  '--external better-sqlite3',
  '--no-splitting',
  '--clean',
  '--silent',
].join(' '));
console.log('  ✓ Bundle ready');

// 3. Package CJS → .exe with pkg
console.log('\n[3/5] Packaging into Windows .exe...');
const exePath = path.join(DIST, 'VybecordTS.exe');
run([
  `npx pkg "${path.join(BUNDLE, 'index.cjs')}"`,
  '--target node20-win-x64',
  `--output "${exePath}"`,
  '--config package.json',
  // No --compress: a compressed pkg payload looks like a packed binary to
  // antivirus heuristics and is a common false-positive trigger. The ~15 MB
  // saved is not worth users being told the exe is a trojan.
].join(' '));
console.log('  ✓ VybecordTS.exe created');

// 4. Copy runtime assets that must live on the real filesystem
console.log('\n[4/5] Copying runtime assets...');


// PowerShell SMTC reader (needed for free/desktop mode)
copy('src/core/smtc-reader.ps1', path.join(DIST, 'smtc-reader.ps1'));

// PowerShell tray icon helper
copy('src/core/tray.ps1', path.join(DIST, 'tray.ps1'));

// App icon — used by the Start Menu / Desktop shortcuts the installer creates
copy('assets/icon.ico', path.join(DIST, 'icon.ico'));

// Web dashboard HTML
copy('src/web/dashboard-v2.html', path.join(DIST, 'dashboard-v2.html'));
copy('src/web/setup.html', path.join(DIST, 'setup.html'));

// Tampermonkey userscripts — enumerate the folder so a newly added script is
// never silently left out of the distribution.
const tmDir = path.join(DIST, 'tampermonkey');
fs.mkdirSync(tmDir, { recursive: true });
const userscripts = fs.readdirSync(path.join(ROOT, 'tampermonkey'))
  .filter(f => f.endsWith('.user.js'));
if (userscripts.length === 0) {
  console.warn('  ⚠ No userscript found in tampermonkey/ — the setup page will have nothing to offer');
}
for (const f of userscripts) {
  copy(`tampermonkey/${f}`, path.join(tmDir, f));
}

// Spicetify extension
const spDir = path.join(DIST, 'spicetify-extension');
fs.mkdirSync(spDir, { recursive: true });
copy('spicetify-extension/vybecord.js', path.join(spDir, 'vybecord.js'));

// .env template
const envsDir = path.join(DIST, 'envs');
fs.mkdirSync(envsDir, { recursive: true });
copy('.env.example', path.join(envsDir, '.env.example'));

// Note: no config.json is generated here — VybecordTS's own ConfigManager
// auto-creates one with current defaults on first run (confirmed by
// actually running the packaged exe with no config present). A
// hand-duplicated default config here would silently drift out of sync
// every time a new setting is added to core/config.ts.

// README for end users
const readmePath = path.join(DIST, 'README.txt');
fs.writeFileSync(readmePath, [
  '═══════════════════════════════════',
  '  VybecordTS v1.0.0',
  '  Discord Rich Presence + Synced Lyrics',
  '═══════════════════════════════════',
  '',
  'HOW TO USE:',
  '  1. Double-click VybecordTS.exe',
  '  2. Your browser opens on the setup page the first time',
  '  3. Install Tampermonkey, then click "Install" for each platform you use',
  '  4. Play music — your Discord status updates with lyrics!',
  '',
  '  Setup page: http://127.0.0.1:8888/setup',
  '  Dashboard:  http://127.0.0.1:8888',
  '',
  'MODES:',
  '  FREE  — Works with any music player (Spotify Free, YouTube, etc.)',
  '  PREMIUM — Uses Spotify API for richer data (needs Spotify Developer App)',
  '',
  'FOLDERS:',
  '  • tampermonkey/ — Browser userscripts (installed from the setup page)',
  '  • spicetify-extension/ — Spicetify extension for the Spotify desktop app',
  '  • Download .sqlite3 from https://lrclib.net/db-dumps for offline lyrics',
  '',
  'IMPORTANT:',
  '  Keep this folder somewhere you can write to. VybecordTS stores its',
  '  config, logs and lyrics database right next to the .exe, so read-only',
  '  locations such as C:\\Program Files will not work.',
  '',
  'TROUBLESHOOTING:',
  '  • "VybecordTS.exe won\'t start" / a DLL-related error appears:',
  '    Install the Microsoft Visual C++ Redistributable (x64) — most',
  '    Windows 10/11 PCs already have it, but a few don\'t:',
  '    https://aka.ms/vs/17/release/vc_redist.x64.exe',
  '  • Antivirus flags the .exe: this is a known false positive with',
  '    packaged Node.js apps (pkg) — the source is fully open on GitHub.',
  '',
].join('\r\n'));
console.log('  ✓ README.txt');

// 5. Compile the Inno Setup installer (optional — skipped if ISCC is absent)
console.log('\n[5/5] Building the installer...');

const setupExe = buildInstaller();

// ── Summary ──

console.log('\n═══════════════════════════════════');
console.log('  BUILD COMPLETE');
console.log('═══════════════════════════════════');
console.log(`  Output: ${DIST}\n`);

const files = fs.readdirSync(DIST, { withFileTypes: true });
for (const f of files) {
  if (f.isDirectory()) {
    console.log(`  📁 ${f.name}/`);
  } else {
    const size = fs.statSync(path.join(DIST, f.name)).size;
    const label = size > 1_048_576
      ? `${(size / 1_048_576).toFixed(1)} MB`
      : `${(size / 1024).toFixed(0)} KB`;
    console.log(`  📄 ${f.name}  (${label})`);
  }
}
if (setupExe) {
  const mb = (fs.statSync(setupExe).size / 1_048_576).toFixed(1);
  console.log(`\n  📦 ${path.relative(ROOT, setupExe)}  (${mb} MB)`);
  console.log('\n  → Ship VybecordTS-Setup.exe — it installs everything for the user.');
} else {
  console.log('\n  → Distribute the entire VybecordTS folder to users.');
  console.log('  → Users just double-click VybecordTS.exe to start.');
}
console.log('');
