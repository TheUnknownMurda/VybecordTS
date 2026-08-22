/**
 * Publish a locally-extracted cover so Discord can display it.
 *
 * This is the fallback behind cover-art.ts, not a replacement for it. Anything
 * that was ever released is found on a music CDN for the cost of one small
 * request and nothing leaves the machine. What reaches this module is the
 * remainder: rips, demos, DJ sets, bootlegs — music that exists in no
 * catalogue, whose artwork lives only inside the user's own file.
 *
 * Uploading that to a free anonymous file host is what the app used to do, and
 * it failed twice over: Discord's image proxy would not fetch from those hosts,
 * so the profile showed a "?" while the URL opened fine in a browser, and the
 * hosts sit on malware blocklists — litterbox.catbox.moe is listed by IPFire
 * among others — so an antivirus blocked the request before it left the
 * machine. Neither problem was about uploading; both were about where. This
 * sends the bytes to our own endpoint instead (see worker/), which has neither.
 *
 * Two properties are worth knowing about the shape of it:
 *
 *   - The address of a cover is the SHA-256 of the cover. So the same artwork
 *     is the same URL for every user who ever plays that file, and a HEAD is
 *     enough to discover it is already there. In steady state the app uploads
 *     nothing and only asks — which is also why its outbound traffic reads like
 *     an update check rather than a file drop.
 *   - Identifying metadata is stripped before hashing. Album art is usually
 *     just album art, but a home recording can carry a photo complete with the
 *     GPS tag from the camera, and this store is shared and public.
 */

import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createLogger } from './logger.js';
import { evictOldest } from './utils.js';

const log = createLogger('ArtUpload');

/**
 * Where the native source leaves the current thumbnail. The same path backs the
 * '/api/thumbnail' sentinel, so this is the file the app is already showing in
 * its own window when it asks us to publish one.
 */
const THUMB_PATH = path.join(process.env.TEMP || os.tmpdir(), 'vybecord_thumb.jpg');

/** Matches the Worker's cap. Larger than any cover worth a 300px card. */
const MAX_BYTES = 512 * 1024;

const UPLOAD_TIMEOUT_MS = 10_000;

/** Empty until configureArtUpload() is called; empty means the feature is off. */
let endpoint = '';

/**
 * content hash → resolved URL. Keyed on the bytes, deliberately.
 *
 * Keying on the track instead was a bug: Windows publishes a track's metadata
 * and its artwork as separate events, and a player with nothing to show yet
 * fills the gap with its own logo. Resolve once per track and that logo is what
 * gets published — the real cover lands on disk a moment later and is never
 * looked at again. Keyed on content, a changed thumbnail is simply a different
 * key, so the caller can ask as often as it likes and always gets an answer
 * about the file as it stands now.
 *
 * It also means an album is twelve tracks behind one cover: the eleven repeats
 * cost nothing, not even a HEAD.
 */
const known = new Map<string, string>();
const KNOWN_MAX = 300;

/** Pause after repeated failures, so an outage is not hammered. */
let failures = 0;
let cooldownUntil = 0;
const COOLDOWN_MS = 5 * 60_000;

/**
 * Point the uploader at a store, or at nothing.
 *
 * @param url base URL of a deployed worker/, e.g. https://art.example.com.
 *   Empty disables uploading entirely — no file is read and no request is made.
 */
export function configureArtUpload(url: string): void {
  const next = (url || '').trim().replace(/\/+$/, '');
  if (next === endpoint) return;
  endpoint = next;
  known.clear();
  log.info(next ? `Cover uploads enabled -> ${next}` : 'Cover uploads disabled');
}

/** Is there somewhere to upload to? */
export function artUploadEnabled(): boolean {
  return !!endpoint;
}

/**
 * Identity of the local thumbnail as it stands: its size and modification time.
 *
 * Windows publishes a track's metadata and its artwork as separate events, so
 * the file backing a track is not always the file that track ends up with — a
 * player with nothing to show yet fills the gap with its own logo, and the real
 * cover replaces it a moment later. A caller that resolved art once has no way
 * to notice that on its own. Comparing this between updates is how it does.
 *
 * A stat, so it costs nothing to check on every poll. Empty when there is no
 * thumbnail at all.
 */
export function thumbnailSignature(): string {
  try {
    const s = statSync(THUMB_PATH);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return '';
  }
}

/**
 * Publish the local thumbnail as it stands right now, and return its public
 * https URL, or null.
 *
 * Safe to call repeatedly for the same track: the answer is derived from the
 * file's current bytes, and an unchanged file is answered from memory without
 * touching the network. Callers should call it again whenever the thumbnail
 * changes, which is how a player's placeholder logo stops being the published
 * cover the moment the real artwork arrives.
 */
export async function uploadCoverArt(signal?: AbortSignal): Promise<string | null> {
  if (!endpoint) return null;
  if (Date.now() < cooldownUntil) return null;

  try {
    const raw = await fs.readFile(THUMB_PATH);
    if (!raw.length) return null;

    const bytes = strip(raw);
    const kind = sniff(bytes);
    if (!kind) {
      log.debug('Local thumbnail is neither JPEG nor PNG — not uploading');
      return null;
    }
    if (bytes.length > MAX_BYTES) {
      log.debug(`Local thumbnail is ${Math.round(bytes.length / 1024)}KB — over the ${MAX_BYTES / 1024}KB cap`);
      return null;
    }

    const key = `${createHash('sha256').update(bytes).digest('hex')}.${kind}`;

    const seen = known.get(key);
    if (seen) return seen;

    const url = `${endpoint}/c/${key}`;
    const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    if (!(await exists(url, combined))) {
      const res = await fetch(url, {
        method: 'PUT',
        body: bytes,
        signal: combined,
        headers: { 'Content-Type': kind === 'jpg' ? 'image/jpeg' : 'image/png' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      log.info(`Cover published (${Math.round(bytes.length / 1024)}KB) -> ${url}`);
    }

    known.set(key, url);
    evictOldest(known, KNOWN_MAX);
    failures = 0;
    return url;
  } catch (e) {
    if (signal?.aborted) return null;  // track changed; not a failure
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;  // no thumbnail yet
    failures++;
    if (failures >= 3) {
      cooldownUntil = Date.now() + COOLDOWN_MS;
      failures = 0;
      log.warn(`Cover store unreachable — pausing for ${COOLDOWN_MS / 60_000} minutes`);
    }
    log.debug(`Cover upload failed: ${(e as Error).message}`);
    return null;
  }
}

/** Is this cover already stored? A miss is the only thing that costs an upload. */
async function exists(url: string, signal: AbortSignal): Promise<boolean> {
  const res = await fetch(url, { method: 'HEAD', signal });
  if (res.ok) return true;
  if (res.status === 404) return false;
  throw new Error(`HTTP ${res.status}`);
}

/** Forget every resolved cover, and what the server was known to hold. */
export function clearArtUploadCache(): void {
  known.clear();
  cooldownUntil = 0;
  failures = 0;
}

// ── Image handling ──

/** Identify an image from its leading bytes. Returns 'jpg', 'png' or null. */
function sniff(b: Buffer): 'jpg' | 'png' | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (
    b.length > 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return 'png';
  return null;
}

/**
 * Remove metadata that identifies something other than the album.
 *
 * Both strippers bail out and return the input untouched at the first thing
 * they do not understand. Keeping a stray EXIF block is the status quo; handing
 * a corrupted image to the store would be permanent, since the store is keyed
 * by content and never overwrites.
 */
function strip(buf: Buffer): Buffer {
  const kind = sniff(buf);
  if (kind === 'jpg') return stripJpeg(buf);
  if (kind === 'png') return stripPng(buf);
  return buf;
}

/**
 * Drop JPEG APP1 (EXIF and XMP — camera, timestamps, GPS) and COM comments.
 *
 * APP0 (JFIF) and APP2 (ICC colour profile) are kept: they describe how to
 * render the image, not where it was taken.
 */
function stripJpeg(buf: Buffer): Buffer {
  const segments: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  let dropped = false;

  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }          // fill byte
    if (marker === 0xda || marker === 0xd9) break;   // scan data begins / image ends

    const length = buf.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > buf.length) return buf;   // malformed

    if (marker === 0xe1 || marker === 0xfe) dropped = true;
    else segments.push(buf.subarray(i, i + 2 + length));
    i += 2 + length;
  }

  if (!dropped) return buf;
  segments.push(buf.subarray(i));   // the scan, and everything after it
  return Buffer.concat(segments);
}

/** Drop PNG text and EXIF chunks, keeping everything that affects the pixels. */
function stripPng(buf: Buffer): Buffer {
  const DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
  const chunks: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  let dropped = false;

  while (i + 12 <= buf.length) {
    const length = buf.readUInt32BE(i);
    const end = i + 12 + length;
    if (length > buf.length || end > buf.length) return buf;   // malformed

    const type = buf.toString('latin1', i + 4, i + 8);
    if (DROP.has(type)) dropped = true;
    else chunks.push(buf.subarray(i, end));

    i = end;
    if (type === 'IEND') break;
  }

  if (!dropped) return buf;
  return Buffer.concat(chunks);
}
