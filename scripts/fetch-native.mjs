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
import { createRequire } from 'node:module';
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

/*
 * prebuild-install's own bin, run with this Node, not `npx.cmd`. Since the
 * April 2024 security fix (CVE-2024-27980), Node refuses to spawn a .cmd
 * without a shell (EINVAL), and the catch below reported that as a missing
 * prebuild: `npm ci` failed on any current Node with a message blaming the
 * Electron pin. A shell would bring back the unescaped arguments that fix is
 * about. better-sqlite3 depends on prebuild-install, so this is the same copy
 * npx was resolving.
 */
const prebuildInstall = createRequire(path.join(moduleDir, 'package.json')).resolve('prebuild-install/bin.js');

console.log(`Fetching better-sqlite3 prebuild for Electron ${electronVersion}...`);
try {
  execFileSync(
    process.execPath,
    [prebuildInstall, '-r', 'electron', '-t', electronVersion, '--arch', process.arch],
    { cwd: moduleDir, stdio: 'inherit' },
  );
} catch (err) {
  console.error('');
  // No exit status means prebuild-install never ran, which says nothing about prebuilds.
  if (typeof err.status !== 'number') {
    console.error(`Could not run prebuild-install: ${err.message}`);
    process.exit(1);
  }
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
