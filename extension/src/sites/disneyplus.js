/**
 * disneyplus — playback reporter for Disney+ in the browser.
 *
 * Reads the player Disney+ draws on its play page (www.disneyplus.com/play/<id>):
 * the film or the show, the episode, and the subtitles the viewer has on. The
 * rest (where the video is, the pushes, the next episode) is film-page.js,
 * which every film site shares.
 *
 * Never seen against the real player
 * ----------------------------------
 * Written without a Disney+ account. What follows comes from others' code and
 * notes, 2024 to 2026: Firefox's picture-in-picture wrapper for Disney+, and
 * the authors of subtitle, profanity-filter and theater-mode extensions who
 * read the player in their browser's developer tools. They disagree in places,
 * the player having been redrawn more than once, so every lookup has a
 * fallback, and what each one expects is written next to it.
 *
 *   /play/<id>                          the play page, one id (a UUID) per
 *                                       film or episode, a language before it
 *                                       or not ("/fr-ca/play/…"); "/video/<id>"
 *                                       on the older site
 *   <disney-web-player>                 the player, its <video> inside it
 *   video#hivePlayer                    the video ("Hive" is the player's name)
 *   [data-qa="title-bug.title"]         the title line, in the player's closed
 *   [data-qa="title-bug.subtitle"]      shadow root: the film or the show, then
 *                                       the episode ("S1:E3 Name"; the word
 *                                       for episode is the viewer's language's,
 *                                       "S1:O1 …" in Polish)
 *   .title-field, .subtitle-field       the same, on the older player
 *   <timed-text-override-region>        the subtitles, in its open shadow root:
 *     .hive-subtitle-renderer-cue-window  one per place on screen,
 *     .hive-subtitle-renderer-line        one per row
 *   .TimedTextOverlay                   where they were before, and
 *   .shaka-text-container               outside the US (Firefox reads both)
 *
 * A closed shadow root is hidden from the page's other scripts, not from an
 * extension: the browser opens it to a content script (see shadowOf in
 * film-page.js). Nothing is known of how an ad shows on the plan with ads: the
 * card stays up through one, as the film.
 */

(function () {
  'use strict';

  const { flat, shown, drawn, lineText, loaded, playerVideo, shadowOf, deepQueryAll, rowsOf } = vybecordFilmPage.util;

  const RE_PLAY = /^\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?(?:play|video)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

  /**
   * The UUID in the play page's address, without its dashes, which is what
   * the app keys a card by (32 letters and digits); null off the play page.
   * Browsing pages play trailers in videos of their own: nothing outside the
   * play page is read.
   */
  function watchId() {
    const m = RE_PLAY.exec(location.pathname);
    return m ? m[1].replace(/-/g, '').toLowerCase() : null;
  }

  /** The id with its dashes back, for the address. */
  function uuid(id) {
    return id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  }

  const VIDEO = 'video#hivePlayer, video[id^="hivePlayer"]';

  /** The player's video: Hive's by its name, else the largest with media, in the light or in its shadow root. */
  function videoIn(root) {
    if (!root) return null;
    const named = root.querySelector(VIDEO);
    if (loaded(named)) return named;
    return playerVideo(root) || playerVideo(shadowOf(root));
  }

  /**
   * The open player and its video, or null. Should the player have been
   * renamed, the largest video on the play page, which is the title's:
   * nothing else plays there.
   */
  function findPlayer() {
    for (const el of document.querySelectorAll('disney-web-player')) {
      if (!shown(el)) continue;
      const video = videoIn(el);
      if (video) return { root: el, video };
    }
    const named = document.querySelector(VIDEO);
    const video = loaded(named) ? named : playerVideo(document);
    return video ? { root: document.body, video } : null;
  }

  // ── The title line ──

  /** The first match's text in any of the player's roots, open or closed. */
  function deepText(hosts, sel) {
    for (const host of hosts) {
      for (const el of deepQueryAll(host, sel)) {
        const t = flat(el.textContent);
        if (t) return t;
      }
    }
    return '';
  }

  /**
   * The title line as one of the players draws it: { title, episode }, or
   * null with none. Others found it under <disney-web-player>'s closed root,
   * and earlier beside it under <disney-web-player-ui>; the older player
   * drew it in the page itself.
   */
  function titleLine() {
    const hosts = Array.from(document.querySelectorAll('disney-web-player, disney-web-player-ui'));
    const title = deepText(hosts, '[data-qa="title-bug.title"]');
    if (title) return { title, episode: deepText(hosts, '[data-qa="title-bug.subtitle"]') };
    // In the page itself, should the player have stopped hiding it.
    const bug = document.querySelector('[data-qa="title-bug.title"]');
    if (bug && flat(bug.textContent)) {
      const sub = document.querySelector('[data-qa="title-bug.subtitle"]');
      return { title: flat(bug.textContent), episode: sub ? flat(sub.textContent) : '' };
    }
    const old = document.querySelector('.title-field');
    if (old && flat(old.textContent)) {
      const sub = document.querySelector('.subtitle-field');
      return { title: flat(old.textContent), episode: sub ? flat(sub.textContent) : '' };
    }
    return null;
  }

  /*
   * The title line sits a shadow root or two down, and finding it means
   * opening every custom element on the way: looked for once a second rather
   * than on every look, and again at once on another page.
   */
  let lineAt = 0;
  let lineFor = null;
  let line = null;

  function readHeader(_player, id) {
    const now = Date.now();
    if (lineFor !== id || now - lineAt >= 1000) {
      lineFor = id;
      lineAt = now;
      line = titleLine();
    }
    return line;
  }

  // ── Subtitles ──

  /**
   * The subtitles in a root's cue windows, top to bottom, a row per line;
   * null when the root has no cue window and no line at all, so the next
   * place is tried.
   */
  function cueWindows(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;
    const windows = Array.from(root.querySelectorAll('.hive-subtitle-renderer-cue-window'));
    if (!windows.length) {
      const lines = Array.from(root.querySelectorAll('.hive-subtitle-renderer-line'));
      return lines.length ? rowsOf(lines, '.hive-subtitle-renderer-line') : null;
    }
    return windows
      .filter(drawn)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .map((w) => {
        const lines = Array.from(w.querySelectorAll('.hive-subtitle-renderer-line')).filter(drawn);
        return lines.length ? lines.map(lineText).filter(Boolean).join('\n') : lineText(w);
      })
      .filter(Boolean)
      .join('\n');
  }

  /**
   * What the subtitles say right now. Where others last found them first, in
   * the open root of <timed-text-override-region>; then under the player, in
   * its root or not; then the overlay Firefox reads. Shaka's layer, outside
   * the US, is among the common players' that film-page.js reads after this.
   */
  function readSubtitle(p) {
    for (const region of document.querySelectorAll('timed-text-override-region')) {
      const text = cueWindows(shadowOf(region)) ?? cueWindows(region);
      if (text !== null) return text;
    }
    for (const root of [shadowOf(p.root), p.root]) {
      const text = cueWindows(root);
      if (text !== null) return text;
    }
    const overlay = document.querySelector('.TimedTextOverlay');
    return overlay && drawn(overlay) ? cueWindows(overlay) || lineText(overlay) : '';
  }

  vybecordFilmPage.start({
    name: 'Disney+',
    endpoint: 'http://127.0.0.1:8888/api/disneyplus',
    watchId,
    findPlayer,
    readHeader,
    readSubtitle,
    // The play page itself, without the viewer's language: Disney+ sends a
    // friend to their own.
    pageUrl: (id) => (id ? `https://www.disneyplus.com/play/${uuid(id)}` : ''),
  });
})();
