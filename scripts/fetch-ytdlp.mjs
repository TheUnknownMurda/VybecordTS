/**
 * Download yt-dlp for bundling into the installer.
 *
 * YouTube captions cannot be fetched without it. Every alternative was measured
 * and none works: the public timedtext endpoint, the InnerTube player API, and
 * scraping the watch page all return the track *list* happily and then zero
 * bytes for the track itself — including from inside a real YouTube page, with
 * the right origin and cookies. YouTube requires a proof-of-origin token its own
 * player generates, and re-implementing that is precisely what yt-dlp does.
 *
 * So it ships with the app rather than being asked of the user. Downloaded at
 * build time rather than committed: a 17MB binary does not belong in git, and
 * pinning one forever would mean shipping a stale copy — yt-dlp needs regular
 * updates to keep working against YouTube.
 *
 * The download is verified against the release's own SHA2-256SUMS. A binary
 * fetched over the network and shipped to users is worth checking.
 *
 * Uses node:https rather than fetch(): undici keeps its connection pool alive,
 * and tearing that down on Windows trips a libuv assertion often enough to fail
 * the whole `npm run dist` chain after this script has already succeeded.
 */

import https from 'node:https';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'vendor');
const target = path.join(vendorDir, 'yt-dlp.exe');
const stamp = path.join(vendorDir, 'yt-dlp.version');

const RELEASES = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const ASSET = 'yt-dlp.exe';
const SUMS = 'SHA2-256SUMS';

/** GET a URL, following the redirects GitHub uses for release assets. */
function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Vybecord-build' } }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (!redirects) { reject(new Error('too many redirects')); return; }
        get(headers.location, redirects - 1).then(resolve, reject);
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function fail(message, keepExisting = false) {
  console.error(message);
  process.exit(keepExisting && fs.existsSync(target) ? 0 : 1);
}

let release;
try {
  release = JSON.parse((await get(RELEASES)).toString('utf8'));
} catch (e) {
  // Offline builds are fine as long as a copy is already vendored.
  fail(`Could not reach the yt-dlp release feed: ${e.message}`, true);
}

const tag = release.tag_name;
const have = fs.existsSync(target) && fs.existsSync(stamp)
  ? fs.readFileSync(stamp, 'utf8').trim()
  : null;

if (have === tag) {
  console.log(`yt-dlp ${tag} already vendored ✓`);
  process.exit(0);
}

const exeAsset = release.assets.find(a => a.name === ASSET);
const sumsAsset = release.assets.find(a => a.name === SUMS);
if (!exeAsset || !sumsAsset) fail(`Release ${tag} does not carry ${ASSET} and ${SUMS}.`);

console.log(`Downloading yt-dlp ${tag} (${(exeAsset.size / 1048576).toFixed(1)} MB)...`);

let bytes;
let sumsText;
try {
  [bytes, sumsText] = await Promise.all([
    get(exeAsset.browser_download_url),
    get(sumsAsset.browser_download_url).then(b => b.toString('utf8')),
  ]);
} catch (e) {
  fail(`Download failed: ${e.message}`, true);
}

// Lines are "<sha256>  <filename>".
const expected = sumsText.split('\n')
  .map(l => l.trim().split(/\s+/))
  .find(parts => parts[1] === ASSET)?.[0];
if (!expected) fail(`${SUMS} has no entry for ${ASSET}.`);

const actual = createHash('sha256').update(bytes).digest('hex');
if (actual !== expected) {
  console.error('Checksum mismatch — refusing to ship this binary.');
  console.error(`  expected ${expected}`);
  console.error(`  got      ${actual}`);
  process.exit(1);
}

fs.mkdirSync(vendorDir, { recursive: true });
fs.writeFileSync(target, bytes);
fs.writeFileSync(stamp, tag);

console.log(`yt-dlp ${tag} verified and vendored ✓`);
console.log(`  sha256 ${actual}`);
