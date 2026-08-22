/**
 * Fetch the native binaries this app needs, built for Electron's ABI.
 *
 * better-sqlite3's own install step builds against *Node's* ABI, which Electron
 * then refuses to load ("was compiled against a different Node.js version").
 * The usual fix is @electron/rebuild, but that compiles from source and so
 * demands Visual Studio Build Tools on Windows. Upstream publishes prebuilt
 * binaries per Electron ABI, so this pulls the matching one instead — no
 * compiler required.
 *
 * That is also why the Electron version is pinned in package.json rather than
 * floating: better-sqlite3 only publishes prebuilds up to a given ABI, and
 * moving past it would silently put everyone back on the source-build path.
 *
 * @coooookies/windows-smtc-monitor needs nothing here: it is a NAPI-RS addon,
 * and Node-API is ABI-stable across runtimes by design.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const electronRange = pkg.devDependencies?.electron ?? '';
const electronVersion = electronRange.replace(/^[\^~]/, '');
if (!electronVersion) {
  console.error('No electron version found in devDependencies — cannot pick a prebuild.');
  process.exit(1);
}

const moduleDir = path.join(root, 'node_modules', 'better-sqlite3');
if (!existsSync(moduleDir)) {
  console.error('better-sqlite3 is not installed. Run `npm install` first.');
  process.exit(1);
}

const binary = path.join(moduleDir, 'build', 'Release', 'better_sqlite3.node');

console.log(`Fetching better-sqlite3 prebuild for Electron ${electronVersion}...`);
try {
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['prebuild-install', '-r', 'electron', '-t', electronVersion, '--arch', process.arch],
    { cwd: moduleDir, stdio: 'inherit' },
  );
} catch {
  console.error('');
  console.error(`No prebuild published for Electron ${electronVersion}.`);
  console.error('Either pin an Electron version that has one, or install Visual Studio');
  console.error('Build Tools and run: npx @electron/rebuild -f -w better-sqlite3');
  process.exit(1);
}

if (!existsSync(binary)) {
  console.error(`prebuild-install reported success but ${binary} is missing.`);
  process.exit(1);
}
console.log('Native binaries ready ✓');
