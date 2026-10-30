/**
 * The dominant colour of a cover, as one of the small icon's colours.
 *
 * Behind the "Match the cover" small-icon style: the badge on the corner of
 * the cover takes whichever of the coloured icons (red, dark red, blue,
 * purple, green) sits closest to the cover's own colour, and the platform's
 * logo when the cover has no colour to speak of — black, white, grey, or a
 * colour none of the icons is near: yellow, orange, brown, skin.
 *
 * "Dominant" is the hue covering the most of the picture, weighted by how
 * saturated and bright each pixel is. An average would be wrong in the way
 * that matters: a red-and-blue cover averages to a purple neither colour is,
 * and a mostly grey cover with a red logo averages to grey.
 *
 * Tuned on fourteen covers from real listening and on the five GIFs, each of
 * which comes out as its own colour.
 *
 * Decoding is not done here. Node has no image decoder and this app does not
 * take a dependency for one; Electron's main process does, so electron/main.ts
 * hands one in with setCoverDecoder(). Without it every answer is "no tone",
 * which leaves the platform icon on — the same card as before the setting.
 */

import { createLogger } from './logger.js';
import { evictOldest } from './utils.js';

const log = createLogger('CoverTone');

/** Which coloured icon a cover reads as. */
export type CoverTone = 'red' | 'dark_red' | 'blue' | 'purple' | 'green';

/** Raw pixels of a small copy of the image, four bytes each. */
export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array;
  /** Byte order of each pixel. Electron's toBitmap() is BGRA on Windows. */
  order: 'rgba' | 'bgra';
}

/** Decode image bytes into a small bitmap, or null when they are not an image. */
export type CoverDecoder = (bytes: Buffer) => DecodedImage | null;

let decoder: CoverDecoder | null = null;

export function setCoverDecoder(fn: CoverDecoder | null): void {
  decoder = fn;
}

/**
 * Hue, in degrees, of each icon's colour — measured off the GIFs themselves
 * (median hue of their saturated pixels), not guessed from their names.
 */
const ICON_HUES: [CoverTone, number, number][] = [
  // [tone, hue, how far from it still counts]. Red is held tight: orange,
  // brown and skin sit just past it (20° to 40°), and calling a sepia photo
  // or a face "red" was the commonest wrong answer on real covers.
  ['red', 0, 15],
  ['green', 130, 45],
  ['blue', 210, 45],
  ['purple', 280, 45],
];
/** Below this share of coloured pixels the cover is black, white or grey. */
const MIN_COLOURED_SHARE = 0.12;
/**
 * A red this dark reads as the Bleeding icon rather than Rouge: halfway
 * between the two GIFs' own brightness (0.51 and 0.65, measured like a cover).
 */
const DARK_RED_VALUE = 0.58;

const FETCH_TIMEOUT_MS = 6_000;
/** A cover is a few hundred KB at most; anything bigger is not one. */
const MAX_BYTES = 4 * 1024 * 1024;

/** url → tone, or null for a cover that matched no icon (so it is not fetched again). */
const cache = new Map<string, CoverTone | null>();
const CACHE_MAX = 300;
const inFlight = new Set<string>();

/**
 * The tone of the cover at `url`, if it is already known.
 *
 * Never waits: this is asked on the presence's emit path. On a miss the cover
 * is fetched once in the background and `onReady` is called when the answer
 * lands, so the card can be republished with the right icon a moment later.
 */
export function coverTone(url: string, onReady: () => void): CoverTone | null {
  if (!decoder || !/^https:\/\//.test(url)) return null;
  const hit = cache.get(url);
  if (hit !== undefined) return hit;
  if (inFlight.has(url)) return null;
  inFlight.add(url);
  void resolveTone(url)
    .then((tone) => {
      cache.set(url, tone);
      evictOldest(cache, CACHE_MAX);
      if (tone) onReady();
    })
    .catch((e) => log.debug(`Could not read the cover's colour: ${(e as Error).message}`))
    .finally(() => inFlight.delete(url));
  return null;
}

async function resolveTone(url: string): Promise<CoverTone | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES) return null;
  const img = decoder?.(bytes);
  if (!img) return null;
  const tone = toneOf(img);
  log.debug(`Cover tone ${tone ?? 'none'}: ${url}`);
  return tone;
}

/** Exported for the harness: the whole decision, from pixels to icon. */
export function toneOf(img: DecodedImage): CoverTone | null {
  const { data } = img;
  const [ri, bi] = img.order === 'bgra' ? [2, 0] : [0, 2];
  // 24 buckets of 15°, each holding its weight, a hue sum for a mean inside
  // it, and the brightness of what fell in it.
  const BUCKETS = 24;
  const weight = new Float64Array(BUCKETS);
  const sinSum = new Float64Array(BUCKETS);
  const cosSum = new Float64Array(BUCKETS);
  const valueSum = new Float64Array(BUCKETS);
  let pixels = 0;
  let coloured = 0;

  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue;  // transparent
    pixels++;
    const r = data[i + ri] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + bi] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const v = max;
    const s = max === 0 ? 0 : (max - min) / max;
    if (s < 0.25 || v < 0.2) continue;  // grey, white or near black
    coloured++;
    let h: number;
    if (max === r) h = ((g - b) / (max - min)) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
    h = (h * 60 + 360) % 360;
    const k = Math.floor(h / (360 / BUCKETS)) % BUCKETS;
    const w = s * v;
    weight[k] += w;
    sinSum[k] += Math.sin((h * Math.PI) / 180) * w;
    cosSum[k] += Math.cos((h * Math.PI) / 180) * w;
    valueSum[k] += v * w;
  }

  if (!pixels || coloured / pixels < MIN_COLOURED_SHARE) return null;

  // The heaviest run of three neighbouring buckets, so a colour that happens
  // to straddle a bucket edge is not split in two and outvoted.
  let best = -1;
  let bestWeight = 0;
  for (let k = 0; k < BUCKETS; k++) {
    const w = weight[(k + BUCKETS - 1) % BUCKETS] + weight[k] + weight[(k + 1) % BUCKETS];
    if (w > bestWeight) { bestWeight = w; best = k; }
  }
  if (best < 0) return null;

  let sin = 0, cos = 0, value = 0, w = 0;
  for (const k of [(best + BUCKETS - 1) % BUCKETS, best, (best + 1) % BUCKETS]) {
    sin += sinSum[k]; cos += cosSum[k]; value += valueSum[k]; w += weight[k];
  }
  const hue = ((Math.atan2(sin, cos) * 180) / Math.PI + 360) % 360;
  const meanValue = w ? value / w : 0;

  let tone: CoverTone | null = null;
  let nearest = Infinity;
  for (const [t, h, reach] of ICON_HUES) {
    const d = Math.min(Math.abs(hue - h), 360 - Math.abs(hue - h));
    if (d <= reach && d < nearest) { nearest = d; tone = t; }
  }
  if (tone === 'red' && meanValue < DARK_RED_VALUE) return 'dark_red';
  return tone;
}
