/**
 * The Apple Music page of the album a track is on, for the link on its cover.
 *
 * Spotify's card links its cover to the album, which Spicetify and the Web API
 * both name. Apple Music for Windows names nothing: its media session carries
 * a title, an "Artist — Album" line and a thumbnail, so its cover opened a
 * search for the song on music.apple.com. The iTunes Search API, the keyless
 * one cover-art.ts already asks for covers, answers a song search with the
 * album each hit is on.
 *
 * Its free-text search wanders (cover-art.ts has the measurements). Asked for
 * "Lil Uzi Vert Buy It", it put somebody else's "BUY IT" first and Lil Uzi
 * Vert's other songs after it. So a hit has to agree on the artist and on the
 * title, and among those the album the player named beats the deluxe edition
 * and the remix single. The titles are compared whole but for a featuring
 * credit, which one side can carry in the title and the other in the artist
 * ("Get Lucky (feat. Pharrell Williams & Nile Rodgers)" is "Get Lucky" by
 * "Daft Punk, Pharrell Williams & Nile Rodgers" in the catalogue). They are
 * not cleaned of "(Live)" or "- Remastered" the way cover-art.ts cleans
 * Spotify's: Apple Music reports Apple's own catalogue titles, so the right
 * hit carries the same one, and a live version cleaned down to the studio
 * title would link the studio album.
 * With no hit that agrees there is no link and the cover keeps opening the
 * search: a weaker link than the album, where another album would be a wrong
 * one.
 *
 * The link names no country (music.apple.com/album/<id>). Apple sends each
 * visitor to that album in their own store, where the /us/ link the API
 * returns would open the US store for everyone who clicks it.
 */

import { createLogger } from './logger.js';
import { evictOldest } from './utils.js';
import { artistMatches, normalise } from './cover-art.js';

const log = createLogger('AppleMusic');

const ITUNES_SEARCH = 'https://itunes.apple.com/search';
const LOOKUP_TIMEOUT_MS = 6_000;
/**
 * Hits to look through. For "The Weeknd Blinding Lights" the album the song
 * is from came fourth, behind a remix single and a live album.
 */
const RESULTS = 10;

export interface AppleAlbum {
  /** The album's page, https://music.apple.com/album/<id>. */
  url: string;
  /** Its cover at 500x500, the size cover-art.ts takes from iTunes, or ''. */
  artUrl: string;
}

interface ItunesSong {
  artistName?: string;
  trackName?: string;
  collectionName?: string;
  collectionId?: number;
  artworkUrl100?: string;
}

/**
 * trackKey → the lookup, finished or on its way. A miss is kept as null so it
 * is not asked again; a failure is dropped so it is.
 */
const cache = new Map<string, Promise<AppleAlbum | null>>();
const CACHE_MAX = 300;

/** Pause lookups after repeated failures, as cover-art.ts does. */
let failures = 0;
let cooldownUntil = 0;
const COOLDOWN_MS = 5 * 60_000;

/**
 * The album `track` is on, or null. Never rejects.
 *
 * Callers asking about the same track share one request: the cover and the
 * link are asked for at the same moment (see backend.ts).
 */
export function lookupAppleMusicAlbum(trackKey: string, artist: string, track: string, album: string): Promise<AppleAlbum | null> {
  if (!artist || !track) return Promise.resolve(null);
  const cached = cache.get(trackKey);
  if (cached) return cached;
  if (Date.now() < cooldownUntil) return Promise.resolve(null);

  const pending = search(artist, track, album).then(
    (hit) => {
      failures = 0;
      return hit;
    },
    (e: unknown) => {
      cache.delete(trackKey);
      if (++failures >= 3) {
        cooldownUntil = Date.now() + COOLDOWN_MS;
        failures = 0;
        log.warn(`Album lookup unavailable — pausing for ${COOLDOWN_MS / 60_000} minutes`);
      }
      log.debug(`Album lookup failed for "${track}": ${(e as Error).message}`);
      return null;
    },
  );
  cache.set(trackKey, pending);
  evictOldest(cache, CACHE_MAX);
  return pending;
}

async function search(artist: string, track: string, album: string): Promise<AppleAlbum | null> {
  const term = `${artist} ${track}`.replace(/\s+/g, ' ').trim().slice(0, 200);
  const res = await fetch(`${ITUNES_SEARCH}?term=${encodeURIComponent(term)}&entity=song&limit=${RESULTS}`, {
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    headers: { 'User-Agent': 'Vybecord/2.0' },
  });
  if (!res.ok) throw new Error(`iTunes HTTP ${res.status}`);
  const results = ((await res.json()) as { results?: ItunesSong[] }).results ?? [];

  const title = titleKey(track);
  const songs = results.filter(r =>
    Number.isSafeInteger(r.collectionId) && (r.collectionId as number) > 0
    && titleKey(r.trackName ?? '') === title
    && artistMatches(artist, r.artistName ?? ''));
  if (!songs.length) {
    log.debug(`No album found for "${artist} - ${track}"`);
    return null;
  }

  const wanted = albumKey(album);
  const hit = (wanted && songs.find(r => albumKey(r.collectionName ?? '') === wanted)) || songs[0];
  const art = hit.artworkUrl100 && /^https:\/\//.test(hit.artworkUrl100)
    ? hit.artworkUrl100.replace(/\/\d+x\d+bb\./, '/500x500bb.')
    : '';
  return { url: `https://music.apple.com/album/${hit.collectionId}`, artUrl: art };
}

/** "(feat. …)", "[with …]" and the like, wherever in the title they sit. */
const RE_FEATURING = /\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi;

/** A song's title, as two spellings of it compare. */
function titleKey(title: string): string {
  return normalise(title.replace(RE_FEATURING, ''));
}

/**
 * An album's name, as two spellings of it compare. The catalogue calls a
 * single "Buy It - Single" and an EP "… - EP"; the player may or may not.
 */
function albumKey(name: string): string {
  return normalise(name.replace(/\s+-\s+(single|ep)\s*$/i, ''));
}
