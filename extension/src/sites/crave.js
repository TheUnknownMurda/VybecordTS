/**
 * crave — playback reporter for Crave in the browser (www.crave.ca).
 *
 * Reads Crave's player: the film or the show, the episode, whether an ad is
 * playing, and the subtitles the viewer has on. The rest is film-page.js,
 * which every film site shares.
 *
 * Never seen against the real player
 * ----------------------------------
 * Written without a Crave account. Others' published code (2025-2026) reads
 * Crave's player by JW Player's class names, which JW Player documents for
 * restyling its player:
 *
 *   .jwplayer                  the player; .jw-flag-ads on it while an ad
 *                              plays
 *   video.jw-video             the video
 *   .jw-title-primary          the title line: a film's title, or the show
 *                              and the episode together, which others split
 *                              at the "S1:E3" between them
 *   .jw-title-secondary        the line under it
 *   .jw-preview                the poster, as its background picture
 *   .jw-captions               the subtitles (read in film-page.js)
 *
 * Nobody describes Crave's addresses, so the card is keyed by the title rather
 * than an id, and links the page the player is on. Any page may hold the
 * player; it is only believed filling the window or in fullscreen, which a
 * preview playing on a browsing page does not.
 */

(function () {
  'use strict';

  const { flat, shown, loaded, playerVideo, fillsWindow } = vybecordFilmPage.util;

  /** Any page of the site may hold the player, and none names an id the card could be keyed by. */
  function watchId() {
    return '';
  }

  /** The open player: a JW Player filling the window, with its video. */
  function findPlayer() {
    for (const el of document.querySelectorAll('.jwplayer')) {
      if (!shown(el) || !fillsWindow(el)) continue;
      const named = el.querySelector('video.jw-video');
      const video = loaded(named) ? named : playerVideo(el);
      if (video) return { root: el, video };
    }
    return null;
  }

  /*
   * The season and the episode between the show's name and the episode's,
   * as others found them ("S1:E3"), in French or in English: "S1 É3", "S1E3"
   * and the like are read the same way.
   */
  const RE_EPISODE = /\b[ST]\s?(\d{1,3})\s?[:.]?\s?[EÉ]\s?(\d{1,4})\b/iu;

  /** Separators left around a piece once the episode's number is cut out of the line. */
  const trim = (s) => flat(s).replace(/^[\s:–—\-|·•,]+|[\s:–—\-|·•,]+$/g, '');

  /**
   * The title line, split: { title, episode, art }, or null with none.
   *
   * "Show S1:E3 Name" is the show, then "S1:E3 Name" for the episode, which is
   * how the app reads others'. Without the numbers, the line is a film's
   * title, and the line under it is kept as its episode only when it reads
   * like one.
   */
  function readHeader(p) {
    const primary = p.root.querySelector('.jw-title-primary');
    const line = primary ? flat(primary.textContent) : '';
    if (!line) return null;
    const art = poster(p.root);
    const m = RE_EPISODE.exec(line);
    if (m) {
      const show = trim(line.slice(0, m.index));
      const name = trim(line.slice(m.index + m[0].length));
      const episode = `S${Number(m[1])}:E${Number(m[2])}${name ? ` ${name}` : ''}`;
      return show ? { title: show, episode, art } : { title: line, episode: '', art };
    }
    const secondary = p.root.querySelector('.jw-title-secondary');
    const under = secondary ? flat(secondary.textContent) : '';
    return { title: line, episode: RE_EPISODE.test(under) ? under : '', art };
  }

  /** The poster JW Player shows before playing, as its preview's background picture. */
  function poster(root) {
    const preview = root.querySelector('.jw-preview');
    const bg = preview ? preview.style.backgroundImage || getComputedStyle(preview).backgroundImage : '';
    const m = /url\(["']?(https:\/\/[^"')]+)["']?\)/.exec(bg || '');
    return m ? m[1] : '';
  }

  vybecordFilmPage.start({
    name: 'Crave',
    endpoint: 'http://127.0.0.1:8888/api/crave',
    watchId,
    findPlayer,
    readHeader,
    // JW Player marks the whole player while an ad runs in it.
    adShowing: (p) => p.root.classList.contains('jw-flag-ads'),
    pageUrl: () => `${location.origin}${location.pathname}`,
  });
})();
