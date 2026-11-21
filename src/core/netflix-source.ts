/**
 * Netflix push-based track source (via the browser extension).
 *
 * Receives what a Netflix tab is playing on the watch page (see
 * sites/netflix.js) and turns it into a card with the subtitles as its
 * lyrics, the same way as Prime Video's: the machinery is in film-source.ts.
 *
 * One thing differs. Netflix's watch page names the film or the episode by an
 * id in its address (/watch/<id>), which the tab sends, and the card is keyed
 * by it. The title line only shows with the player's controls, so a tab can
 * report subtitles before it knows the title, and a series' name before the
 * episode's: keyed by the id, the card that comes up once the title is known
 * already has those subtitles, and gaining the episode's name does not start
 * its lines over.
 */

import { FilmSource, normalizeFilmPayload, type FilmPayload, type FilmSite } from './film-source.js';
import { episodeLabel as primeEpisodeLabel } from './prime-video-source.js';

/** Shape of JSON pushed by the extension (sites/netflix.js). */
export type NetflixPayload = FilmPayload;

/**
 * A title on Netflix: the watch page the tab is on, or a title's page.
 * It becomes a button and a link on the card, so anything else is no link at
 * all.
 */
const RE_NETFLIX_PAGE = /^https:\/\/www\.netflix\.com\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?(?:watch|title)\/\d{1,12}\/?$/i;

/**
 * The episode line as the card shows it: "E3 · Name", or "S1 E3 · Name".
 *
 * Others describe Netflix's title line as the episode's number in a piece of
 * its own ("E3"; an older player wrote "S1:E3") and then its name, which the
 * extension joins with a space. A season before it, with a colon or a space
 * ("S1:E3", "S1 E3"), is kept. How it reads in other languages is not
 * known, so a short word (up to three letters, a dot or not) or the word for
 * an episode before the number is taken the same way. Prime Video's wording
 * ("Season 1, Ep. 3 Name"), should Netflix write it so somewhere, is read too.
 * Anything else is kept as written.
 */
const RE_EPISODE = /^(?:\p{L}{1,2}\s*(\d{1,3})\s*(?:[:.]\s*|\s+(?=\p{L}{1,3}\.?\d)))?(?:\p{L}{1,3}\.?|[EÉ]pisod[eio]|Folge)\s*(\d{1,4})(?:\s*[:.\-–—]\s*|\s+|$)(.*)$/iu;

export function netflixEpisodeLabel(raw: string): string {
  const prime = primeEpisodeLabel(raw);
  if (prime !== raw) return prime;
  const m = RE_EPISODE.exec(raw);
  if (!m) return raw;
  const name = m[3].trim();
  return `${m[1] ? `S${Number(m[1])} ` : ''}E${Number(m[2])}${name ? ` · ${name}` : ''}`;
}

export const NETFLIX: FilmSite = {
  source: 'netflix',
  name: 'Netflix',
  idPrefix: 'nf',
  titlePage: RE_NETFLIX_PAGE,
  episodeLabel: netflixEpisodeLabel,
};

/** Coerce a push into the shape above, whatever actually arrived. */
export function normalizeNetflixPayload(raw: unknown): NetflixPayload {
  return normalizeFilmPayload(raw, NETFLIX);
}

/** One entry per tab, one card per film or episode, keyed by Netflix's own id for it. */
export class NetflixSource extends FilmSource {
  constructor() {
    super(NETFLIX);
  }
}
