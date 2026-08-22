/**
 * Find a track's cover art on a public music CDN.
 *
 * The problem this solves: Discord's Rich Presence needs a URL for the artwork,
 * and the artwork Windows gives us is a file on disk. Uploading it to a free
 * file host worked, and then stopped — Discord accepts the activity but its
 * image proxy will not fetch from those hosts, so the profile shows a "?" while
 * the image itself is perfectly reachable from a browser. Anonymous file hosts
 * are also what antivirus vendors block, for the same underlying reason: they
 * carry everyone's uploads, malware included.
 *
 * Looking the cover up on a music CDN sidesteps all of it. Nothing is uploaded,
 * the URL belongs to a service whose entire business is serving album art, and
 * it costs one small request instead of a few hundred kilobytes.
 *
 * Deezer's public search API needs no key, no account and no OAuth. It was
 * picked over the iTunes Search API on measured coverage, not preference —
 * against 44 tracks taken from real listening:
 *
 *     Deezer   41/44 found, 41 the right artist
 *     iTunes   24/44 found, 20 the right artist
 *
 * The gap is mostly the query: Deezer accepts a structured `artist:"…"
 * track:"…"` search, while iTunes only takes free text and drifts onto karaoke
 * and tribute records — it answered "Oh Dear" by 808Cash with Johnny Cash, and
 * "First 48" by Migos with Niykee Heaton. A confidently wrong cover is worse
 * than none, so the artist is checked against the result before it is accepted.
 */

import { createLogger } from './logger.js';
import { evictOldest } from './utils.js';

const log = createLogger('CoverArt');

const DEEZER_SEARCH = 'https://api.deezer.com/search';
const ITUNES_SEARCH = 'https://itunes.apple.com/search';
const LOOKUP_TIMEOUT_MS = 6_000;

/**
 * Version markers Spotify appends to a title that catalogues do not carry.
 *
 * "Lovesick - Bonus" found nothing anywhere; "Lovesick" was the first hit. The
 * same applies to the far more common "- Remastered 2011", "- Radio Edit" and
 * "(Deluxe)", so this is worth more than the one track that exposed it.
 */
const RE_VERSION_SUFFIX = /\s*[-–]\s*(bonus|remaster(?:ed)?(?:\s*\d{4})?|radio edit|single version|album version|deluxe|extended(?: mix)?|live|instrumental|mono|stereo)\b.*$/i;
const RE_VERSION_PAREN = /\s*\((bonus[^)]*|remaster(?:ed)?[^)]*|deluxe[^)]*|extended[^)]*|live|instrumental|mono|stereo)\)\s*$/i;

/** trackKey → resolved URL, or '' for a miss (so a miss is not retried). */
const cache = new Map<string, string>();
const CACHE_MAX = 300;

/** Pause lookups after repeated failures, so an API outage is not hammered. */
let failures = 0;
let cooldownUntil = 0;
const COOLDOWN_MS = 5 * 60_000;

interface ItunesTrack {
  artistName?: string;
  trackName?: string;
  artworkUrl100?: string;
}

interface DeezerTrack {
  title?: string;
  artist?: { name?: string };
  album?: { cover_big?: string; cover_xl?: string; title?: string };
}

/**
 * Look up cover art for a track. Returns an https URL, or null.
 *
 * @param trackKey stable key for caching, so a repeat of the same track costs
 *   nothing and a known miss is not looked up again.
 */
export async function lookupCoverArt(
  trackKey: string,
  artist: string,
  track: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!artist || !track) return null;

  const cached = cache.get(trackKey);
  if (cached !== undefined) return cached || null;

  if (Date.now() < cooldownUntil) return null;

  const cleaned = stripVersionSuffix(track);
  // The exact title first, then without Spotify's version marker. Trying the
  // clean form second means an album that genuinely is called "… - Live" still
  // matches itself before the fallback loosens the query.
  const titles = cleaned !== track ? [track, cleaned] : [track];

  const timeout = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    for (const title of titles) {
      const art = await searchDeezer(artist, title, combined);
      if (art) return remember(trackKey, art);
    }
    // Deezer's catalogue is the broader of the two here, but not a superset —
    // iTunes carries releases it lacks. Verified the same way, since free-text
    // search is exactly what makes iTunes wander onto tribute albums.
    for (const title of titles) {
      const art = await searchItunes(artist, title, combined);
      if (art) return remember(trackKey, art);
    }
    failures = 0;
  } catch (e) {
    if (signal?.aborted) return null;  // track changed; not a failure
    failures++;
    if (failures >= 3) {
      cooldownUntil = Date.now() + COOLDOWN_MS;
      failures = 0;
      log.warn(`Cover lookup unavailable — pausing for ${COOLDOWN_MS / 60_000} minutes`);
    }
    log.debug(`Cover lookup failed for "${track}": ${(e as Error).message}`);
    return null;
  }

  // Genuinely not in either catalogue — remember that, so it is not retried.
  cache.set(trackKey, '');
  evictOldest(cache, CACHE_MAX);
  return null;
}

function remember(trackKey: string, art: string): string {
  cache.set(trackKey, art);
  evictOldest(cache, CACHE_MAX);
  return art;
}

/** Drop "- Remastered 2011", "- Radio Edit", "(Deluxe)" and friends. */
function stripVersionSuffix(title: string): string {
  return title.replace(RE_VERSION_SUFFIX, '').replace(RE_VERSION_PAREN, '').replace(/[.\s]+$/, '').trim() || title;
}

async function searchDeezer(artist: string, track: string, signal: AbortSignal): Promise<string | null> {
  // The structured query is what makes this accurate; the same terms as free
  // text drift onto covers and karaoke versions.
  const query = `artist:"${sanitise(artist)}" track:"${sanitise(track)}"`;
  const res = await fetch(`${DEEZER_SEARCH}?q=${encodeURIComponent(query)}&limit=1`, {
    signal, headers: { 'User-Agent': 'Vybecord/2.0' },
  });
  if (!res.ok) throw new Error(`Deezer HTTP ${res.status}`);
  const hit = ((await res.json()) as { data?: DeezerTrack[] }).data?.[0];
  if (!hit) return null;

  // cover_big is 500x500 at ~70KB. cover_xl is 1000x1000 at ~270KB, which is
  // more than Discord shows and more for its proxy to pull.
  const art = hit.album?.cover_big || hit.album?.cover_xl;
  if (!art) return null;
  if (!artistMatches(artist, hit.artist?.name ?? '')) {
    log.debug(`Deezer rejected for "${artist} - ${track}": got "${hit.artist?.name}"`);
    return null;
  }
  return art;
}

async function searchItunes(artist: string, track: string, signal: AbortSignal): Promise<string | null> {
  const term = `${sanitise(artist)} ${sanitise(track)}`;
  const res = await fetch(`${ITUNES_SEARCH}?term=${encodeURIComponent(term)}&entity=song&limit=1`, {
    signal, headers: { 'User-Agent': 'Vybecord/2.0' },
  });
  if (!res.ok) throw new Error(`iTunes HTTP ${res.status}`);
  const hit = ((await res.json()) as { results?: ItunesTrack[] }).results?.[0];
  if (!hit?.artworkUrl100) return null;
  if (!artistMatches(artist, hit.artistName ?? '')) {
    log.debug(`iTunes rejected for "${artist} - ${track}": got "${hit.artistName}"`);
    return null;
  }
  // The 100x100 thumbnail URL resizes by substitution.
  return hit.artworkUrl100.replace(/\/\d+x\d+bb\./, '/500x500bb.');
}

/** Strip the quotes and colons that would break out of the structured query. */
function sanitise(value: string): string {
  return value.replace(/["':]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Is the returned artist plausibly the one asked for?
 *
 * Loose about credit lists, because they are not disagreements: a track the OS
 * reports as "Juicy J" comes back from the catalogue as "Juicy J, Hanumankind",
 * and a featured name on one side only is the same record either way. So both
 * sides are read as a set of credited artists, and sharing one is enough.
 *
 * Strict about everything else, because it used to be the opposite and that was
 * wrong. Matching accepted a name appearing *anywhere* inside the other, so
 * "Bones" matched "The Zephyr Bones" — a different band — and every Bones track
 * was announced with someone else's artwork. A name now has to be one of the
 * credited artists, not a fragment inside one. The rule at the top of this file
 * decides the trade: a confidently wrong cover is worse than none.
 */
export function artistMatches(wanted: string, got: string): boolean {
  const a = credits(wanted);
  const b = credits(got);
  if (!a.length || !b.length) return false;
  return a.some(name => b.includes(name));
}

/**
 * The individual artists named in a credit.
 *
 * Split before normalising: normalise() turns punctuation into spaces, so a
 * comma or an ampersand has to be read while it is still there.
 *
 * Both sides go through this, which is what makes the aggressive separators
 * safe. "AC/DC" becomes two names — but it does so identically wherever it
 * appears, so it still matches itself, while "Azizi Gibson/Kamandi" against
 * "Azizi Gibson" resolves the way it should.
 */
const RE_CREDIT_SPLIT = /\s*(?:,|&|\/|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b|\bvs\.?\b)\s*/i;

function credits(value: string): string[] {
  return (value ?? '').split(RE_CREDIT_SPLIT).map(normalise).filter(Boolean);
}

function normalise(value: string): string {
  return (value ?? '')
    // Separate accented letters from their marks, then drop the marks, so
    // "Beyoncé" and "Beyonce" are one name. Names now have to match exactly
    // once split, and an accent one catalogue writes and another does not
    // would otherwise be a mismatch.
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Catalogues disagree about a leading "The" — "The Weeknd" and "Weeknd" are
    // one act. Safe alongside exact matching: dropping it from "The Zephyr
    // Bones" leaves "zephyr bones", which still is not "bones".
    .replace(/^the /, '');
}

/** Drop every cached lookup. */
export function clearCoverCache(): void {
  cache.clear();
  cooldownUntil = 0;
  failures = 0;
}
