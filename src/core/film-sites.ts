/**
 * Every site that plays films and episodes, and what is its own on each.
 *
 * Prime Video and Netflix have files of their own (prime-video-source.ts,
 * netflix-source.ts), having come first. Disney+, Paramount+, Apple TV, Crave
 * and Crunchyroll are here: the extension reads them all with one script
 * (extension/src/film-page.js), so they send the same payload, and they
 * differ only in their pages and the ids in them.
 *
 * Their episode lines are read the way Netflix's are (netflixEpisodeLabel),
 * which already reads Prime Video's too: Disney+ writes "S1:E3 Name" as
 * Netflix's older player did, Apple TV "S1, E3 · Name" as Prime Video does
 * with a dot, and the extension writes the others' that way from their
 * pages' own numbers.
 *
 * The backend makes a FilmSource of each, with its push path, its detection
 * switch and its verb, so a film site is one entry here and one in the
 * extension rather than a dozen places in the backend.
 */

import type { FilmSite } from './film-source.js';
import { PRIME_VIDEO } from './prime-video-source.js';
import { NETFLIX, netflixEpisodeLabel } from './netflix-source.js';

/**
 * The pages a card may link to, one per site. A link becomes a button and a
 * link on the card, so anything off the site is no link at all; the card then
 * links a search for the title instead.
 */

/** The play page, as the extension writes it: a UUID, with a language before it or not. */
const RE_DISNEY_PAGE = /^https:\/\/www\.disneyplus\.com\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?(?:play|video)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;
/** The watch page of an episode or a film, whatever stands between the kind and the id. */
const RE_PARAMOUNT_PAGE = /^https:\/\/www\.paramountplus\.com\/(?:[a-z]{2}\/)?(?:shows|movies)\/(?:[\w-]{1,200}\/){0,3}video\/[\w-]{4,64}(?:\/[\w-]{1,200})?\/?$/i;
/** An episode's or a film's page; the name in it may be left out. */
const RE_APPLE_TV_PAGE = /^https:\/\/tv\.apple\.com\/(?:[a-z]{2}\/)?(?:episode|movie)\/(?:[^\s/?#]{1,200}\/)?umc\.cmc\.[a-z0-9]{1,40}\/?$/i;
/** Any page of the site: nobody describes Crave's addresses, and the player may be on any of them. */
const RE_CRAVE_PAGE = /^https:\/\/www\.crave\.ca\/[\w\-./%~]{1,300}$/i;
/** The watch page: an id, the episode's name after it or not, a language before it or not. */
const RE_CRUNCHYROLL_PAGE = /^https:\/\/www\.crunchyroll\.com\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?watch\/[A-Z0-9]{6,16}(?:\/[a-z0-9-]{1,200})?\/?$/i;

export const DISNEY_PLUS: FilmSite = {
  source: 'disney_plus',
  name: 'Disney+',
  idPrefix: 'dp',
  path: '/api/disneyplus',
  configKey: 'detect_disney_plus',
  activityKey: 'rpc_disney_plus_activity_type',
  titlePage: RE_DISNEY_PAGE,
  episodeLabel: netflixEpisodeLabel,
};

export const PARAMOUNT_PLUS: FilmSite = {
  source: 'paramount_plus',
  name: 'Paramount+',
  idPrefix: 'pp',
  path: '/api/paramountplus',
  configKey: 'detect_paramount_plus',
  activityKey: 'rpc_paramount_plus_activity_type',
  titlePage: RE_PARAMOUNT_PAGE,
  episodeLabel: netflixEpisodeLabel,
};

export const APPLE_TV: FilmSite = {
  source: 'apple_tv',
  name: 'Apple TV',
  idPrefix: 'atv',
  path: '/api/appletv',
  configKey: 'detect_apple_tv',
  activityKey: 'rpc_apple_tv_activity_type',
  titlePage: RE_APPLE_TV_PAGE,
  episodeLabel: netflixEpisodeLabel,
};

export const CRAVE: FilmSite = {
  source: 'crave',
  name: 'Crave',
  idPrefix: 'crave',
  path: '/api/crave',
  configKey: 'detect_crave',
  activityKey: 'rpc_crave_activity_type',
  titlePage: RE_CRAVE_PAGE,
  episodeLabel: netflixEpisodeLabel,
};

export const CRUNCHYROLL: FilmSite = {
  source: 'crunchyroll',
  name: 'Crunchyroll',
  idPrefix: 'cr',
  path: '/api/crunchyroll',
  configKey: 'detect_crunchyroll',
  activityKey: 'rpc_crunchyroll_activity_type',
  titlePage: RE_CRUNCHYROLL_PAGE,
  episodeLabel: netflixEpisodeLabel,
};

/** Every film site, in the order the app lists them. */
export const FILM_SITES: readonly FilmSite[] = [PRIME_VIDEO, NETFLIX, DISNEY_PLUS, PARAMOUNT_PLUS, APPLE_TV, CRAVE, CRUNCHYROLL];

/** A film site by its media_source, or undefined. */
export function filmSite(source: string | undefined): FilmSite | undefined {
  return source ? FILM_SITES.find((s) => s.source === source) : undefined;
}
