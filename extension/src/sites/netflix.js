/**
 * netflix — playback reporter for Netflix in the browser.
 *
 * Reads the player Netflix draws on its watch page (www.netflix.com/watch/<id>):
 * what plays, the episode, where it is, and the subtitles the viewer has on,
 * the moment they show. The app puts the subtitles on the card the way it puts
 * Prime Video's there (see sites/primevideo.js), and for the same reasons
 * reads them off the screen rather than fetching anything.
 *
 * Nothing is fetched, and the page's own scripts are left alone
 * --------------------------------------------------------------
 * Netflix's player keeps the title, the season, the episode and the exact
 * position in an object of its own (window.netflix), which Firefox's
 * picture-in-picture and other extensions call into. A content script cannot
 * reach it: that would take a second script running inside the page's own
 * JavaScript, against an undocumented API. The subtitle files themselves come
 * the same way as Prime Video's, and are left alone for the same reasons
 * (subtitles the viewer switched off, an undocumented API, the viewer's
 * session). What the player draws is enough for a card, and it is exactly
 * what the viewer sees.
 *
 * Never seen against the real player
 * ----------------------------------
 * Written without a Netflix account, so none of this has been checked on
 * netflix.com itself. The names come from others' code and notes, 2026:
 * Firefox's own picture-in-picture wrapper for Netflix (.watch-video and
 * .player-timedtext), and extension authors' published findings (the watch
 * page's address, the title line, the ad markers, a new <video> per episode).
 * Prime Video's script went out the same way, and the real player turned out
 * to differ from what others had written down; so every lookup here has a
 * fallback, and what each one expects is written next to it.
 *
 *   /watch/<id>                       the watch page, one id per film or
 *                                     episode. Netflix is a single page:
 *                                     going from browsing to a title changes
 *                                     the address without loading a page, so
 *                                     the address is read on every look
 *   .watch-video                      the player, the <video> inside it; a new
 *                                     <video> for each episode
 *   .player-timedtext                 the subtitles on screen (Firefox reads
 *                                     its innerText for its own window)
 *   .player-timedtext-text-container  one block per place on screen, a <br>
 *                                     between its rows
 *   [data-uia="video-title"]          the title line, while the controls
 *                                     show: the show in a heading, then the
 *                                     episode's number and its name; a film's
 *                                     title alone
 *   [data-uia="ads-info-container"]   present while an ad plays, with
 *   [data-uia="ads-info-time"]        its countdown; the title line then says
 *                                     the show "resumes after ads"
 * Some subtitles (Japanese, Chinese, Arabic and others) are drawn as images:
 * there is no text to read, and nothing is sent.
 */

(function () {
  'use strict';

  // ── Config ──
  const VYBECORD_URL = 'http://127.0.0.1:8888/api/netflix';
  const BASE_INTERVAL_MS = 2500;
  const MAX_INTERVAL_MS = 15000;
  /** How often the player is looked at: subtitles change several times a second in dialogue. */
  const WATCH_MS = 250;
  /** How often a page with no player open is looked at for one: most of Netflix is browsing. */
  const IDLE_WATCH_MS = 1000;
  /** Fastest a subtitle change is reported. A subtitle stays a second or more. */
  const SUBTITLE_PUSH_MIN_MS = 500;

  /*
   * Which tab this is, so the desktop app keeps one entry per tab: two tabs on
   * two films are two cards, and a tab moving to the next episode replaces its
   * own. sessionStorage is per tab and survives a reload. Same as kick.js.
   */
  const TAB_ID_KEY = 'vybecord_tab_id';
  let TAB_ID = '';
  try {
    TAB_ID = sessionStorage.getItem(TAB_ID_KEY) || '';
    if (!TAB_ID) {
      TAB_ID = Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(TAB_ID_KEY, TAB_ID);
    }
  } catch (e) {
    TAB_ID = Math.random().toString(36).slice(2, 10);
  }

  // ── State ──
  let pushTimer = null;
  let currentInterval = BASE_INTERVAL_MS;
  let consecutiveFails = 0;
  let lastPushAt = 0;
  let soonTimer = null;
  /** The last push said something plays, so the player closing is said once. */
  let reported = false;
  /** What the last push said plays: its watch page, title and episode. */
  let lastReport = null;

  // ── The page ──

  /**
   * The id in the watch page's address, or '' anywhere else. Browsing pages
   * play trailers in videos of their own (the banner, a hovered title, a
   * title's preview): nothing outside the watch page is read.
   */
  function watchId() {
    const m = /^\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?watch\/(\d{1,12})(?:\/|$)/i.exec(location.pathname);
    return m ? m[1] : '';
  }

  /** Drawn on the page, with an area. A player emptied and left in place is a box with no height. */
  function shown(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** Drawn on the page, whatever its size: a subtitle layer can be a box with no height of its own. */
  function drawn(el) {
    return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  /** One line of text: runs of whitespace, newlines included, become one space. */
  function flat(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  // ── The player ──

  /*
   * The player's outermost element, under the name Firefox uses, else under
   * the test hooks others name. A container only counts with the playing
   * video inside it: Prime Video's script first took a layer drawn over the
   * whole player for the player, with no video in it, and sent nothing.
   */
  const PLAYER_SELECTORS = ['.watch-video', '[data-uia="watch-video"]', '[data-uia="player"]'];

  /** The player's real video: the largest one drawn with media loaded. */
  function playerVideo(root) {
    let best = null;
    let bestArea = 0;
    for (const v of root.querySelectorAll('video')) {
      if (v.readyState === 0 || !(v.currentSrc || v.src)) continue;
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  /**
   * The open player and its video, or null. On the watch page only; and on
   * it, should the containers have been renamed, the largest video there,
   * which on that page is the title's: nothing else plays on it.
   */
  function findPlayer() {
    if (!watchId()) return null;
    for (const sel of PLAYER_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (!shown(el)) continue;
        const video = playerVideo(el);
        if (video) return { root: el, video };
      }
    }
    const video = playerVideo(document);
    return video ? { root: document.body, video } : null;
  }

  /**
   * An ad is playing. Netflix plays ads in the title's own video, so the
   * video alone cannot tell; the ad's label and countdown can. The ad shown
   * over a paused title ("pause-ad") is no ad playing, and is not looked for.
   */
  function adShowing() {
    const box = document.querySelector('[data-uia="ads-info-container"]');
    if (box && drawn(box)) return true;
    const time = document.querySelector('[data-uia="ads-info-time"]');
    return !!time && drawn(time) && /\d/.test(time.textContent || '');
  }

  // ── What plays ──

  /**
   * The title line, split: { title, episode } or null when it is not shown.
   *
   * Others describe it as the show in a heading, then a piece for the
   * episode's number ("E3") and one for its name, and a film's title alone;
   * read as one text, the pieces ran together ("StrangerThingsE3Chapter
   * Three"). So the heading is the title and every other piece, in order, is
   * the episode line; with no heading, the first piece is the title.
   */
  function readHeader() {
    const el = document.querySelector('[data-uia="video-title"]');
    if (!el || !drawn(el)) return null;
    let title = '';
    let episode = '';
    const heading = el.querySelector('h1, h2, h3, h4, h5, h6');
    if (heading) {
      title = flat(heading.textContent);
      const rest = [];
      for (const piece of el.querySelectorAll('*')) {
        if (piece === heading || heading.contains(piece) || piece.children.length) continue;
        const t = flat(piece.textContent);
        if (t) rest.push(t);
      }
      episode = rest.length ? rest.join(' ') : flat(el.textContent.replace(heading.textContent, ''));
    } else {
      const parts = Array.from(el.children).map((c) => flat(c.textContent)).filter(Boolean);
      title = parts.length ? parts[0] : flat(el.textContent);
      episode = parts.slice(1).join(' ');
    }
    // During an ad the line says when the show is back ("resumes after ads"),
    // which is no title. adShowing() is the test; this is the same in English,
    // should its markers have been renamed.
    if (!title || /\bafter (?:the )?ads?\b/i.test(`${title} ${episode}`)) return null;
    return { title, episode };
  }

  /*
   * What the title line last said, and on which watch page. It leaves with
   * the controls a few seconds after the mouse stops, so it is read on every
   * look and remembered for as long as the tab stays on that page (that is,
   * on that film or episode): read only when a push goes out, it would mostly
   * be missed. Prime Video's player does the same (see primevideo.js).
   */
  let header = null;
  /**
   * The series' name for a watch page the player went to from another one
   * without leaving the player, which is the next episode, played by itself
   * at the end of one or picked in the player: its title line has not shown
   * yet, the series' has. Until it shows, the card names the series alone.
   */
  let carried = null;
  /** The watch page seen on the last look, '' off it. */
  let lastId = '';
  /** When the tab moved to the watch page it is on: subtitles from before belong to another title. */
  let pageSince = 0;
  /**
   * What the title line said on the watch page before, when the tab went
   * straight from it to this one, the controls showing (the "Next episode"
   * button): the player can keep it up for a moment while the next one
   * loads, and it is not this one's. Passed over for STALE_HEADER_MS at
   * most, should two pages really read the same.
   */
  let before = null;
  const STALE_HEADER_MS = 5000;

  /**
   * Note a move to another watch page, or off it: what the subtitles said
   * before belongs to the last one. Run on every look and before every push,
   * whichever sees the move first. Returns whether the tab moved.
   */
  function noteWatchPage(id) {
    if (id === lastId) return false;
    const fromTitle = !!(lastId && id && header && header.id === lastId);
    // The series' name goes on from episode to episode, the title line seen
    // or not: three played on by themselves are still the same show.
    const series = fromTitle && header.episode ? header.title
      : lastId && id && carried && carried.id === lastId ? carried.title : '';
    carried = series ? { id, title: series } : null;
    before = fromTitle ? { title: header.title, episode: header.episode, until: Date.now() + STALE_HEADER_MS } : null;
    lastId = id;
    pageSince = Date.now();
    return true;
  }

  /** Note what the title line says, while it shows. Run on every look; returns whether it said something new. */
  function trackHeader(id) {
    if (!id || adShowing()) return false;
    const h = readHeader();
    if (!h || (header && header.id === id && header.title === h.title && header.episode === h.episode)) return false;
    if (before && Date.now() < before.until && h.title === before.title && h.episode === before.episode) return false;
    header = { id, title: h.title, episode: h.episode };
    return true;
  }

  /**
   * The title the page announces to the system, when it does: used only while
   * the title line has not shown on this watch page. Netflix may well announce
   * none (Prime Video does not); what it would put in which field is not known.
   */
  function sessionTitle() {
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (md && md.title) return flat(md.title);
    } catch (e) { /* not readable here */ }
    return '';
  }

  /**
   * A poster the page announces to the system with the title, when it does
   * and names this title or episode in it. The watch page has no other: there
   * is no title page behind it the way Prime Video's has.
   */
  function artwork(title, episode) {
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (!md || !md.artwork || !md.artwork.length) return '';
      const named = [md.title, md.artist, md.album].map((s) => flat(s).toLowerCase()).filter(Boolean);
      const ours = [title, episode].map((s) => flat(s).toLowerCase()).filter(Boolean);
      // One name inside the other only when both are of some length: "Up" is inside many a title.
      const same = (n, o) => n === o || (Math.min(n.length, o.length) >= 4 && (n.includes(o) || o.includes(n)));
      if (!named.some((n) => ours.some((o) => same(n, o)))) return '';
      const size = (a) => Math.max(0, ...String(a.sizes || '').split(/\s+/).map((s) => parseInt(s, 10) || 0));
      const best = Array.from(md.artwork).filter((a) => /^https:\/\//.test(String(a.src || '')))
        .sort((a, b) => size(b) - size(a))[0];
      return best ? String(best.src) : '';
    } catch (e) {
      return '';
    }
  }

  // ── Subtitles ──

  let subtitleText = '';
  let subtitleAt = 0;

  /** A block's text, a <br> inside it kept as a break. */
  function lineText(el) {
    const raw = typeof el.innerText === 'string' ? el.innerText : el.textContent;
    return String(raw || '').split(/\n+/).map(flat).filter(Boolean).join('\n');
  }

  /**
   * What the subtitles say right now, one line per row; '' with none on screen.
   *
   * Each block is one place on screen, the dialogue at the bottom and now and
   * then a sign or a song at the top, read top to bottom as the eye reads
   * them. Without the blocks, the layer's own text, which is what Firefox
   * reads.
   */
  function readSubtitle(root) {
    const layer = root.querySelector('.player-timedtext') || document.querySelector('.player-timedtext');
    if (!layer || !drawn(layer)) return '';
    const blocks = Array.from(layer.querySelectorAll('.player-timedtext-text-container'))
      .filter(drawn)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const text = (blocks.length ? blocks.map(lineText) : [lineText(layer)]).filter(Boolean).join('\n');
    return text.slice(0, 400);
  }

  // ── Where the video is ──

  /*
   * The video element's own clock and length. Others note that Netflix's
   * player keeps a clock of its own, which a content script cannot reach, and
   * that the two can differ a little; and the time the controls show is the
   * time left alone, gone with the controls. A card's bar needs no better.
   */
  function position(video) {
    const pos = isFinite(video.currentTime) ? video.currentTime : 0;
    const len = isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    return {
      position_ms: Math.max(0, Math.round(pos * 1000)),
      duration_ms: Math.round(len * 1000),
    };
  }

  // ── The report ──

  /**
   * What the tab shows, or null when no player is open.
   *
   * The title from the title line seen on this watch page, else the series'
   * name carried from the episode before, else whatever the page announces to
   * the system. With none of those yet, the tab still reports, with no title:
   * the app shows no card for it, but keeps its subtitles under its watch page
   * for when the title line shows.
   */
  function describe() {
    const id = watchId();
    noteWatchPage(id);
    const p = findPlayer();
    if (!p) return null;
    trackHeader(id);
    let title = '';
    let episode = '';
    if (header && header.id === id) {
      title = header.title;
      episode = header.episode;
    } else if (carried && carried.id === id) {
      title = carried.title;
    } else {
      title = sessionTitle();
    }
    return { id, video: p.video, title, episode };
  }

  /**
   * The subtitle fields of a push. Nothing from before this watch page: the
   * player can keep the last episode's final line up while the next one
   * starts. Nothing during an ad either, whatever an ad draws there.
   */
  function subtitleFields(ad) {
    const current = !ad && subtitleAt > 0 && subtitleAt >= pageSince;
    return {
      caption: current ? subtitleText : '',
      caption_at: current ? subtitleAt : 0,
    };
  }

  function getPlaybackInfo() {
    const p = describe();
    if (!p) return null;
    const ad = adShowing();
    lastReport = { video_id: p.id, title: p.title, episode: p.episode };
    return Object.assign({
      tab_id: TAB_ID,
      video_id: p.id,
      title: p.title.slice(0, 200),
      episode: p.episode.slice(0, 200),
      // An ad is not the film playing: the card goes, the way it goes for a
      // pause, and comes back with the film. What the video's clock does
      // through an ad is not known, so nothing is read from it meanwhile.
      paused: p.video.paused || p.video.ended || ad,
      page_url: `https://www.netflix.com/watch/${p.id}`,
      art_url: artwork(p.title, p.episode),
    }, position(p.video), subtitleFields(ad));
  }

  // ── Pushing ──

  function pushToVybecord(data) {
    if (!data) return;
    lastPushAt = Date.now();
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: VYBECORD_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(data),
        timeout: 1500,
        onload: function () {
          if (consecutiveFails > 0) { consecutiveFails = 0; reschedule(BASE_INTERVAL_MS); }
        },
        onerror: function () { backoff(); },
        ontimeout: function () { backoff(); },
      });
    } catch (e) {
      backoff();
    }
  }

  function backoff() {
    consecutiveFails++;
    const next = Math.min(BASE_INTERVAL_MS * Math.pow(1.5, consecutiveFails), MAX_INTERVAL_MS);
    if (next !== currentInterval) reschedule(next);
  }

  function reschedule(ms) {
    currentInterval = ms;
    if (pushTimer) clearInterval(pushTimer);
    pushTimer = setInterval(periodicPush, currentInterval);
  }

  /** Report soon, but never more often than SUBTITLE_PUSH_MIN_MS. */
  function pushSoon() {
    // While the app is not answering, the regular beat is enough.
    if (soonTimer || consecutiveFails > 0) return;
    const wait = Math.max(0, lastPushAt + SUBTITLE_PUSH_MIN_MS - Date.now());
    soonTimer = setTimeout(() => { soonTimer = null; periodicPush(); }, wait);
  }

  /*
   * One push per beat while a player is open, paused or not, so the app can
   * tell a pause from a closed tab. Once the player closes (back to browsing),
   * one last push says nothing plays any more, and the tab goes quiet: the app
   * lets it age out.
   */
  function periodicPush() {
    const data = getPlaybackInfo();
    if (data) {
      reported = true;
      pushToVybecord(data);
    } else if (reported) {
      reported = false;
      const last = lastReport || { video_id: '', title: '', episode: '' };
      pushToVybecord(Object.assign({ tab_id: TAB_ID, paused: true, position_ms: 0, duration_ms: 0 }, last, subtitleFields(true)));
    }
  }

  let watchedVideo = null;

  /**
   * Play, pause and seek reported at once rather than at the next beat; and a
   * video found, which is the player opening or the next episode's coming.
   */
  function attachVideoListeners(video) {
    if (video === watchedVideo) return;
    watchedVideo = video;
    for (const type of ['play', 'pause', 'seeked', 'ended']) video.addEventListener(type, pushSoon);
    pushSoon();
  }

  /** Whether an ad played on the last look: one starting or ending is said at once, as a pause is. */
  let adWas = false;

  /*
   * One look at the player per WATCH_MS while one is open: subtitles that
   * changed, a title line that showed, another watch page. A few lookups, none
   * of them over the whole document; once a second while there is no player.
   */
  function watch() {
    let open = false;
    try {
      const id = watchId();
      // Another film or episode, or off the watch page: said at once.
      if (noteWatchPage(id)) pushSoon();
      const p = findPlayer();
      if (p) {
        open = true;
        attachVideoListeners(p.video);
        // The title line showing the names for the first time, or new ones.
        if (trackHeader(id)) pushSoon();
        const ad = adShowing();
        if (ad !== adWas) { adWas = ad; pushSoon(); }
        /*
         * Only with a player in view, and no ad: the next episode loading
         * takes the player away for a moment, and counted as the subtitles
         * going blank, the last episode's final line, still up when it came
         * back, would read as said again.
         */
        const text = ad ? '' : readSubtitle(p.root);
        if (text !== subtitleText) {
          subtitleText = text;
          subtitleAt = Date.now();
          pushSoon();
        }
      }
    } catch (e) {
      // A page halfway through redrawing its player: look again next time.
    } finally {
      setTimeout(watch, open ? WATCH_MS : IDLE_WATCH_MS);
    }
  }

  function init() {
    reschedule(BASE_INTERVAL_MS);
    watch();
    console.log('[VybecordTS] Netflix integration initialized ✓');
    setTimeout(periodicPush, 500);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
