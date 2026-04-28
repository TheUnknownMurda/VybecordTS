/**
 * Upload local SMTC thumbnails to a public image host for Discord RPC.
 *
 * Discord RPC large_image requires a publicly accessible HTTPS URL.
 * When album art comes from a local source (Apple Music via SMTC), we
 * upload the thumbnail to catbox.moe (free, no API key, no auth).
 *
 * Results are cached per track key within the session to avoid re-uploads.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from './logger.js';

const log = createLogger('ImageUpload');

const THUMB_PATH = path.join(process.env.TEMP || os.tmpdir(), 'vybecord_thumb.jpg');
const CATBOX_API = 'https://catbox.moe/user/api.php';

// Per-session cache: trackKey → public URL
const cache = new Map<string, string>();

/**
 * Upload the local SMTC thumbnail to catbox.moe for use in Discord RPC.
 * Returns the public HTTPS URL, or null on failure.
 * Cached per track key (same track won't be re-uploaded).
 */
export async function uploadThumbForRpc(trackKey: string, signal?: AbortSignal): Promise<string | null> {
  const cached = cache.get(trackKey);
  if (cached) return cached;

  try {
    const buf = await fs.readFile(THUMB_PATH);
    if (!buf.length) return null;

    // Detect MIME from magic bytes
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const mime = isPng ? 'image/png' : 'image/jpeg';
    const ext = isPng ? 'png' : 'jpg';

    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', new Blob([buf], { type: mime }), `thumb.${ext}`);

    const res = await fetch(CATBOX_API, {
      method: 'POST',
      body: form,
      signal,
    });

    if (!res.ok) {
      log.warn(`Catbox upload failed: HTTP ${res.status}`);
      return null;
    }

    const url = (await res.text()).trim();
    if (url.startsWith('https://')) {
      cache.set(trackKey, url);
      log.info(`Local thumb uploaded → ${url}`);
      return url;
    }

    log.warn(`Unexpected catbox response: ${url.slice(0, 120)}`);
    return null;
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    log.warn(`Thumb upload error: ${e}`);
    return null;
  }
}

/** Clear the upload cache. */
export function clearUploadCache(): void {
  cache.clear();
}
