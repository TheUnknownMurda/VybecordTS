/**
 * Rewrites release/latest.yml from the installer that is actually on disk.
 *
 * electron-builder writes latest.yml during `npm run dist`, but a rebuild that
 * stops short of a full pack — or an installer copied in from elsewhere — leaves
 * the two out of step. electron-updater then downloads the new version, finds a
 * sha512 that does not match, and refuses it: the update silently never lands.
 *
 * Run this before uploading a release when you are not sure the pair is fresh.
 *   node scripts/make-latest-yml.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDir = join(root, 'release');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const installers = readdirSync(releaseDir).filter((f) => /-setup\.exe$/i.test(f));
if (installers.length !== 1) {
  console.error(
    installers.length === 0
      ? 'No *-setup.exe in release/ — run `npm run dist` first.'
      : `Expected one installer in release/, found ${installers.length}: ${installers.join(', ')}`,
  );
  process.exit(1);
}

const [name] = installers;
const bytes = readFileSync(join(releaseDir, name));
const sha512 = createHash('sha512').update(bytes).digest('base64');
const { size } = statSync(join(releaseDir, name));

const yml = `version: ${version}
files:
  - url: ${name}
    sha512: ${sha512}
    size: ${size}
path: ${name}
sha512: ${sha512}
releaseDate: '${new Date().toISOString()}'
`;

writeFileSync(join(releaseDir, 'latest.yml'), yml);
console.log(`latest.yml regenerated for ${name} (${(size / 1048576).toFixed(1)} MB)`);
