/**
 * The channel page of a YouTube video, for the second line of a Short's card.
 *
 * The extension reads the link off the Short's panel, and only once that
 * panel shows the Short being played: right after a swipe it still shows the
 * previous one, and a link taken then would send the card to the wrong
 * channel. The Short is named by then (the player's media session is quicker
 * than the panel), so the panel had often not caught up yet, and the line
 * opened a YouTube search for the channel's name instead of the channel.
 *
 * YouTube's oEmbed endpoint names the uploader of any public video from its
 * id, keyless, in one small request: `author_url` is the channel's page
 * (https://www.youtube.com/@handle). So a Short that arrives without a link is
 * asked about once, and the card takes the link up when the answer comes (see
 * LyricsEngine.syncProgress). A private or deleted video answers 404, one
 * that cannot be embedded 401: those keep the search.
 */

import { createLogger } from './logger.js';
import { asUrl, evictOldest } from './utils.js';

const log = createLogger('YouTubeChannel');

const OEMBED = 'https://www.youtube.com/oembed';
const LOOKUP_TIMEOUT_MS = 5_000;
/** A Short lasts seconds: the ones a session gets through, and then some. */
const CACHE_MAX = 300;

/**
 * A channel page on youtube.com, or ''. The link becomes the target of the
 * card's second line, so nothing else is let through.
 */
export function asChannelUrl(value: unknown): string {
  const s = asUrl(value);
  return /^https:\/\/www\.youtube\.com\/(@[^/?#\s]+|channel\/[\w-]+|c\/[^/?#\s]+|user\/[^/?#\s]+)$/.test(s) ? s : '';
}

/** Video id → its channel page, or '' for a video YouTube would not name one for. */
const found = new Map<string, string>();
/** Ids with a request on its way. */
const asking = new Set<string>();

/**
 * Pause after repeated failures, as cover-art.ts does. A failure is not kept
 * as an answer, so offline every push of the Short would otherwise ask again.
 */
let failures = 0;
let cooldownUntil = 0;
const COOLDOWN_MS = 5 * 60_000;

/**
 * The channel page of `videoId` when it is known, else '' — and then it is
 * asked for, once at a time, so that a later call has it. Never throws.
 */
export function channelPageOf(videoId: string): string {
  const known = found.get(videoId);
  if (known !== undefined) return known;
  if (!videoId || asking.has(videoId) || Date.now() < cooldownUntil) return '';
  asking.add(videoId);
  lookUp(videoId)
    .then(
      (url) => {
        failures = 0;
        found.set(videoId, url);
        evictOldest(found, CACHE_MAX);
        if (url) log.debug(`Channel of ${videoId}: ${url}`);
      },
      (e: unknown) => {
        if (++failures >= 3) {
          cooldownUntil = Date.now() + COOLDOWN_MS;
          failures = 0;
          log.warn(`Channel lookup unavailable — pausing for ${COOLDOWN_MS / 60_000} minutes`);
        }
        log.debug(`Channel lookup failed for ${videoId}: ${(e as Error).message}`);
      },
    )
    .finally(() => asking.delete(videoId));
  return '';
}

async function lookUp(videoId: string): Promise<string> {
  const page = `https://www.youtube.com/shorts/${videoId}`;
  const res = await fetch(`${OEMBED}?url=${encodeURIComponent(page)}&format=json`, {
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  // An answer, kept as one: asking again would get the same.
  if (res.status === 401 || res.status === 403 || res.status === 404) return '';
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { author_url?: unknown } | null;
  return asChannelUrl(body?.author_url);
}
