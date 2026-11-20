/**
 * Prime Video push-based track source (via the browser extension).
 *
 * Receives what a Prime Video tab is playing, on primevideo.com or on an
 * Amazon site (see sites/primevideo.js), and turns it into a card with the
 * subtitles as its lyrics. Everything a film site shares with the others
 * (tabs, cards, subtitles, seeks) is in film-source.ts; what is Prime Video's
 * own is here: the pages a card may link to, and how its episode line reads.
 */

import { FilmSource, normalizeFilmPayload, type FilmPayload, type FilmSite } from './film-source.js';

/** Shape of JSON pushed by the extension (sites/primevideo.js); it sends no video_id. */
export type PrimeVideoPayload = FilmPayload;

/**
 * A title's page: Prime Video's own site or one of the Amazon sites the
 * extension runs on. It becomes a button and a link on the card, so anything
 * else is no link at all.
 */
const RE_TITLE_PAGE = /^https:\/\/(?:[a-z0-9-]+\.)*(?:primevideo\.com|amazon\.(?:com|ca|co\.uk|de|fr|it|es|co\.jp|com\.br|com\.mx|com\.au|in))\/\S*$/i;

/**
 * The episode line as the card shows it: "S1 E3 · Name".
 *
 * The player writes it in the viewer's language, "Season 1, Ep. 3 Name",
 * "Saison 1, ép. 3 Name", "Staffel 1, Folge 3 Name", with nothing between the
 * episode's number and its name, which on the card ran the two together.
 * Whatever the words, the shape is the same: a word and a number, a comma, a
 * word and a number, then the name. Anything else is kept as written.
 */
const RE_EPISODE = /^\p{L}+\.?\s*(\d{1,3})\s*[,،、]\s*\p{L}+\.?\s*(\d{1,4})(?:\s*[:.\-–—]\s*|\s+|$)(.*)$/u;

export function episodeLabel(raw: string): string {
  const m = RE_EPISODE.exec(raw);
  if (!m) return raw;
  const name = m[3].trim();
  return `S${Number(m[1])} E${Number(m[2])}${name ? ` · ${name}` : ''}`;
}

export const PRIME_VIDEO: FilmSite = {
  source: 'prime_video',
  name: 'Prime Video',
  idPrefix: 'pv',
  titlePage: RE_TITLE_PAGE,
  episodeLabel,
};

/** Coerce a push into the shape above, whatever actually arrived. */
export function normalizePrimeVideoPayload(raw: unknown): PrimeVideoPayload {
  return normalizeFilmPayload(raw, PRIME_VIDEO);
}

/** One entry per tab, one card per title and episode (Prime Video's pushes carry no id). */
export class PrimeVideoSource extends FilmSource {
  constructor() {
    super(PRIME_VIDEO);
  }
}
