/**
 * crunchyroll — playback reporter for Crunchyroll in the browser.
 *
 * Reads the watch page (www.crunchyroll.com/watch/<id>/<name>): the series,
 * the episode, and the subtitles the viewer has on when the player draws them
 * as text. The rest is film-page.js, which every film site shares.
 *
 * Never seen against the real player
 * ----------------------------------
 * Written without a Crunchyroll account, from others' published code
 * (2024-2026):
 *
 *   /watch/<id>/<name>          the watch page, one id per episode, a
 *                               language before it or not ("/fr/watch/…")
 *   #player-container video     the video, in the page itself
 *   static.crunchyroll.com      or in a frame from there (the older player),
 *                               which the page cannot look into: a script of
 *                               this extension in the frame reports what it
 *                               plays (sites/crunchyroll-player.js)
 *   .show-title-link            the series' name, linked to its page
 *   h1.title                    the episode's name ("E3 - Name")
 *   <script type="application/ld+json">
 *                               the episode: its number, its season's, the
 *                               series'
 *   og:image                    the episode's picture
 *   .bmpui-ui-subtitle-label    the subtitles, as Bitmovin's player draws them
 *                               (read in film-page.js)
 *
 * Most of Crunchyroll's subtitles are not text on the page at all: styled
 * subtitles are painted onto a canvas over the video, and many episodes carry
 * them burnt into the picture. Those have nothing to read, and the card shows
 * the series and the episode alone. Nothing is known of how an ad shows: the
 * card stays up through one.
 */

(function () {
  'use strict';

  const { flat, playerVideo, jsonLd, ldText, ldImage } = vybecordFilmPage.util;

  const RE_WATCH = /^\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?watch\/([A-Z0-9]{6,16})(?:\/([a-z0-9-]{1,200}))?\/?$/i;

  /** The watch page's id for the episode; null anywhere else, whose videos are previews. */
  function watchId() {
    const m = RE_WATCH.exec(location.pathname);
    return m ? m[1].toUpperCase() : null;
  }

  // ── The player in a frame ──

  /** Where the player frame's reports come from, and how long one counts. */
  const FRAME_ORIGIN = 'https://static.crunchyroll.com';
  const FRAME_FRESH_MS = 2000;

  /*
   * What the frame last said, as a stand-in for its video: the same fields
   * film-page.js reads off a <video>, and no events. One object, updated in
   * place, so it stays the same video to film-page.js from report to report.
   */
  const frameVideo = { paused: true, ended: false, currentTime: 0, duration: 0, subtitle: '', at: 0 };
  let reporter = null;

  window.addEventListener('message', (e) => {
    if (e.origin !== FRAME_ORIGIN) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.type !== 'vybecord-crunchyroll-player') return;
    const paused = d.paused === true;
    const moved = paused !== frameVideo.paused || d.ended === true
      || Math.abs(Number(d.currentTime) - frameVideo.currentTime - (Date.now() - frameVideo.at) / 1000) > 4;
    frameVideo.paused = paused;
    frameVideo.ended = d.ended === true;
    frameVideo.currentTime = Number.isFinite(d.currentTime) ? d.currentTime : 0;
    frameVideo.duration = Number.isFinite(d.duration) ? d.duration : 0;
    frameVideo.subtitle = typeof d.subtitle === 'string' ? d.subtitle.slice(0, 400) : '';
    frameVideo.at = Date.now();
    // A pause, a play or a seek in the frame, said at once as it would be off
    // a video in the page.
    if (moved && reporter) reporter.pushSoon();
  });

  /** The player's video in the page itself, else the frame's while it keeps reporting. */
  function findPlayer() {
    const container = document.querySelector('#player-container');
    const video = playerVideo(container || document);
    if (video) return { root: container || document.body, video };
    if (Date.now() - frameVideo.at > FRAME_FRESH_MS) return null;
    const frame = document.querySelector(`iframe[src^="${FRAME_ORIGIN}/"]`);
    return { root: frame || document.body, video: frameVideo };
  }

  // ── What plays ──

  /** The page's description of this episode, when it has one and it is this one's. */
  function episodeLd(id) {
    for (const o of jsonLd()) {
      const type = [].concat(o['@type'] || []).join(' ');
      if (!/Episode/i.test(type) && o.episodeNumber === undefined) continue;
      const url = String(o.url || o['@id'] || '');
      // The site is a single page: a description left from the episode before is not this one's.
      if (/\/watch\//.test(url) && !url.toUpperCase().includes(`/WATCH/${id}`)) continue;
      return o;
    }
    return null;
  }

  /** A number from JSON-LD, which may write it as a string. */
  function num(v) {
    const n = parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  /** The episode's picture, when the page's own picture is this episode's. */
  function picture(id) {
    const og = document.querySelector('meta[property="og:image"]');
    const src = og ? og.getAttribute('content') || '' : '';
    if (!/^https:\/\//.test(src)) return '';
    const ogUrl = document.querySelector('meta[property="og:url"]');
    const named = ogUrl ? ogUrl.getAttribute('content') || '' : '';
    return !named || named.toUpperCase().includes(`/WATCH/${id}`) ? src : '';
  }

  /**
   * The series and the episode: { title, episode, art }, or null.
   *
   * The series' name from its link above the episode, else from the JSON-LD;
   * the episode from the JSON-LD's numbers and name ("S1:E3 Name", the way the
   * app reads others'), else the page's heading as written ("E3 - Name").
   * Without a series, the heading alone, as a film's title.
   */
  function readHeader(_player, id) {
    const ld = episodeLd(id);
    const link = document.querySelector('.show-title-link h4, .show-title-link, [data-t="show-title-link"]');
    const series = (link && flat(link.textContent)) || (ld ? ldText(ld.partOfSeries) : '');
    const heading = document.querySelector('h1.title');
    const h1 = heading ? flat(heading.textContent) : '';
    const art = picture(id) || (ld ? ldImage(ld.image) || ldImage(ld.thumbnailUrl) : '');
    let episode = h1;
    if (ld) {
      const ep = num(ld.episodeNumber);
      const season = num(ld.partOfSeason && typeof ld.partOfSeason === 'object' ? ld.partOfSeason.seasonNumber : null);
      // The heading carries the number too ("E3 - Name"): the name alone is kept after the numbers.
      const name = ldText(ld.name) || h1.replace(/^E\d+\s*[-–—:]\s*/i, '');
      if (ep !== null) episode = `${season === null ? '' : `S${season}:`}E${ep}${name ? ` ${name}` : ''}`;
    }
    if (series) return { title: series, episode, art };
    return h1 ? { title: h1, episode: '', art } : null;
  }

  /** The frame's subtitles, when the video is the frame's; the page's own are read in film-page.js. */
  function readSubtitle(p) {
    return p.video === frameVideo ? frameVideo.subtitle : '';
  }

  reporter = vybecordFilmPage.start({
    name: 'Crunchyroll',
    endpoint: 'http://127.0.0.1:8888/api/crunchyroll',
    watchId,
    findPlayer,
    readHeader,
    readSubtitle,
    pageUrl: (id) => {
      const m = RE_WATCH.exec(location.pathname);
      return id && m ? `https://www.crunchyroll.com/watch/${id}${m[2] ? `/${m[2]}` : ''}` : '';
    },
  });
})();
