/**
 * paramountplus — playback reporter for Paramount+ in the browser.
 *
 * Reads what plays on Paramount+'s watch page (www.paramountplus.com/shows/video/<id>/
 * for an episode, /movies/video/<id>/ for a film): the film or the show and
 * the episode, from what the page says about itself, and the subtitles the
 * viewer has on. The rest is film-page.js, which every film site shares.
 *
 * Never seen against the real player
 * ----------------------------------
 * Written without a Paramount+ account, from others' published code (2025-2026):
 *
 *   /shows/video/<id>/          the watch page, one id per episode, and
 *   /movies/video/<id>/         per film
 *   .video__player-area         the player, its <video> inside it
 *   <script type="application/ld+json">
 *                               the page's description of what plays: a
 *                               TVEpisode (partOfSeries, partOfSeason,
 *                               episodeNumber, name) or a Movie (name)
 *
 * Nobody describes the player's own title line or its subtitles. The title
 * comes from the page's JSON-LD, and the subtitles from the browser's own
 * text tracks or the common players' layers (film-page.js), should Paramount+
 * draw them either way; if it draws them its own way, the card shows the
 * title and the episode without them. Nor is anything known of how an ad
 * shows: the card stays up through one. Live TV (/live/) is a channel rather
 * than a film, and is not reported.
 */

(function () {
  'use strict';

  const { shown, playerVideo, jsonLd, ldText, ldImage } = vybecordFilmPage.util;

  const RE_WATCH = /^\/(?:[a-z]{2}\/)?(?:shows|movies)\/(?:[^/]+\/)*?video\/([A-Za-z0-9_-]{4,64})(?:\/|$)/;

  /** The watch page's id for the episode or film; null anywhere else, whose videos are previews. */
  function watchId() {
    const m = RE_WATCH.exec(location.pathname);
    return m ? m[1] : null;
  }

  /** The player and its video; on the watch page, should the player have been renamed, its largest video. */
  function findPlayer() {
    for (const el of document.querySelectorAll('.video__player-area')) {
      if (!shown(el)) continue;
      const video = playerVideo(el);
      if (video) return { root: el, video };
    }
    const video = playerVideo(document);
    return video ? { root: document.body, video } : null;
  }

  /** A number from JSON-LD, which may write it as a string. */
  function num(v) {
    const n = parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  /**
   * What the page's JSON-LD says plays: { title, episode, art }, or null.
   *
   * The site is a single page, and a page that moved on to the next episode
   * without being loaded again may keep describing the last one: a
   * description that names a watch page names this one, or is passed over.
   * The episode line is written the way the app reads others' ("S1:E3 Name").
   */
  function readHeader(_player, id) {
    for (const o of jsonLd()) {
      const type = [].concat(o['@type'] || []).join(' ');
      if (!/Episode|Movie/i.test(type) && !o.partOfSeries) continue;
      const url = String(o.url || o['@id'] || '');
      if (/\/video\//.test(url) && id && !url.includes(id)) continue;
      const name = ldText(o.name);
      const series = ldText(o.partOfSeries);
      const art = ldImage(o.image) || ldImage(o.thumbnailUrl);
      if (series) {
        const season = num(o.partOfSeason && typeof o.partOfSeason === 'object' ? o.partOfSeason.seasonNumber : null);
        const ep = num(o.episodeNumber);
        const number = ep === null ? '' : season === null ? `E${ep}` : `S${season}:E${ep}`;
        return { title: series, episode: [number, name].filter(Boolean).join(' '), art };
      }
      if (name) return { title: name, episode: '', art };
    }
    return null;
  }

  vybecordFilmPage.start({
    name: 'Paramount+',
    endpoint: 'http://127.0.0.1:8888/api/paramountplus',
    watchId,
    findPlayer,
    readHeader,
    // The watch page itself, from the address it is read off.
    pageUrl: (id) => (id ? `${location.origin}${location.pathname}` : ''),
  });
})();
