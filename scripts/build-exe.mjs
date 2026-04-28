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
console.log('[1/4] Cleaning build directory...');
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 2. Bundle TS → CJS (better-sqlite3 stays external — native module)
console.log('\n[2/4] Bundling TypeScript → CJS...');
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
console.log('\n[3/4] Packaging into Windows .exe...');
const exePath = path.join(DIST, 'VybecordTS.exe');
run([
  `npx pkg "${path.join(BUNDLE, 'index.cjs')}"`,
  '--target node20-win-x64',
  `--output "${exePath}"`,
  '--config package.json',
  '--compress GZip',
].join(' '));
console.log('  ✓ VybecordTS.exe created');

// 4. Copy runtime assets that must live on the real filesystem
console.log('\n[4/4] Copying runtime assets...');

// PowerShell SMTC reader (needed for free/desktop mode)
copy('src/core/smtc-reader.ps1', path.join(DIST, 'smtc-reader.ps1'));

// Web dashboard HTML
copy('src/web/dashboard.html', path.join(DIST, 'dashboard.html'));
copy('src/web/dashboard-v2.html', path.join(DIST, 'dashboard-v2.html'));

// Tampermonkey userscripts
const tmDir = path.join(DIST, 'tampermonkey');
fs.mkdirSync(tmDir, { recursive: true });
copy('tampermonkey/vybecord-youtube.user.js', path.join(tmDir, 'vybecord-youtube.user.js'));
copy('tampermonkey/vybecord-spotify.user.js', path.join(tmDir, 'vybecord-spotify.user.js'));
copy('tampermonkey/vybecord-soundcloud.user.js', path.join(tmDir, 'vybecord-soundcloud.user.js'));

// Spicetify extension
const spDir = path.join(DIST, 'spicetify-extension');
fs.mkdirSync(spDir, { recursive: true });
copy('spicetify-extension/vybecord.js', path.join(spDir, 'vybecord.js'));

// .env template
const envsDir = path.join(DIST, 'envs');
fs.mkdirSync(envsDir, { recursive: true });
copy('.env.example', path.join(envsDir, '.env.example'));

// Default config (only if the user doesn't have one yet — first run)
const defaultConfig = {
  rpc_enabled: true,
  show_lyrics: true,
  rpc_only_when_playing: false,
  detect_all_media: true,
  user_tier: 'auto',
  discord_app_id: '',
  spotify_client_id: '',
  spotify_client_secret: '',
  rpc_details_template: '{track}',
  rpc_state_template: '{artist}',
  rpc_button1_label: '',
  rpc_button1_url: '',
  rpc_button2_label: 'Listen on {platform}',
  rpc_activity_type: 2,
  poll_interval_ms: 3000,
};
const cfgPath = path.join(DIST, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify(defaultConfig, null, 2) + '\n');
console.log('  ✓ config.json (default)');

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
  '  2. Your browser opens automatically with a setup wizard',
  '  3. Follow the steps (takes 30 seconds)',
  '  4. Play music — your Discord status updates with lyrics!',
  '',
  '  Dashboard: http://127.0.0.1:8888',
  '',
  'MODES:',
  '  FREE  — Works with any music player (Spotify Free, YouTube, etc.)',
  '  PREMIUM — Uses Spotify API for richer data (needs Spotify Developer App)',
  '',
  'OPTIONAL:',
  '  • tampermonkey/ — Browser userscripts for YouTube, Spotify, SoundCloud',
  '  • spicetify-extension/ — Spicetify extension for instant Spotify sync',
  '  • Download .sqlite3 from https://lrclib.net/db-dumps for offline lyrics',
  '',
].join('\r\n'));
console.log('  ✓ README.txt');

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
console.log('\n  → Distribute the entire VybecordTS folder to users.');
console.log('  → Users just double-click VybecordTS.exe to start.\n');
