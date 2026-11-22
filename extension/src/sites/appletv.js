/**
 * appletv — playback reporter for Apple TV in the browser (tv.apple.com).
 *
 * Reads Apple's web player: the film or the show, the episode, and the
 * subtitles the viewer has on. The rest is film-page.js, which every film
 * site shares.
 *
 * Never seen against the real player
 * ----------------------------------
 * Written without an Apple TV account, from others' published code (2025-2026):
 *
 *   /<country>/episode/<name>/umc.cmc.<id>   an episode's page, a film's at
 *   /<country>/movie/<name>/umc.cmc.<id>     /movie/ (the name may be left
 *                                            out); the player opens over it
 *   .video-player__tabs              drawn with the player, and not with a
 *                                    trailer playing on a page, which is how
 *                                    others tell the two apart
 *   .video-metadata .title           the film or the show
 *   .video-metadata .subtitle-text   the episode ("S1, E3 · Name")
 *   the media session                the title and its picture, which the
 *                                    page announces to the system
 *
 * Nobody describes the subtitles: they are read from the browser's own text
 * tracks or the common players' layers (film-page.js), should Apple's player
 * draw them either way. The player may also open on pages whose address
 * names no episode (a show's page), so any page can hold it; it is only
 * believed with its tabs drawn, or in fullscreen.
 */

(function () {
  'use strict';

  const { flat, drawn, playerVideo, fillsWindow } = vybecordFilmPage.util;

  const RE_TITLE_PAGE = /^\/(?:[a-z]{2}\/)?(?:episode|movie)\/(?:[^/]+\/)?umc\.cmc\.([a-z0-9]{1,40})\/?$/i;

  /**
   * The id in an episode's or a film's address, without Apple's "umc.cmc."
   * before it; '' on any other page, which the player may still open on.
   */
  function watchId() {
    const m = RE_TITLE_PAGE.exec(location.pathname);
    return m ? m[1].toLowerCase() : '';
  }

  /** The open player: its video, believed with the player's tabs drawn, or filling the screen. */
  function findPlayer() {
    const tabs = document.querySelector('.video-player__tabs');
    const root = (tabs && tabs.closest('[class*="video-player"]:not(.video-player__tabs)')) || document.body;
    const video = playerVideo(root) || playerVideo(document);
    if (!video) return null;
    if (!(tabs && drawn(tabs)) && !fillsWindow(video)) return null;
    return { root, video };
  }

  /** The text of the first match inside the player, else anywhere in the page. */
  function textIn(root, sel) {
    const el = root.querySelector(sel) || document.querySelector(sel);
    return el ? flat(el.textContent) : '';
  }

  function readHeader(p) {
    const title = textIn(p.root, '.video-metadata .title');
    return title ? { title, episode: textIn(p.root, '.video-metadata .subtitle-text') } : null;
  }

  vybecordFilmPage.start({
    name: 'Apple TV',
    endpoint: 'http://127.0.0.1:8888/api/appletv',
    watchId,
    findPlayer,
    readHeader,
    // The episode's or the film's own page; nothing on a page about something else.
    pageUrl: (id) => (id ? `${location.origin}${location.pathname}` : ''),
  });
})();
