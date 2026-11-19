/**
 * primevideo — playback reporter for Prime Video in the browser.
 *
 * Reads the player Amazon draws on primevideo.com and on its own sites
 * (amazon.com/gp/video, a title's own page, and the same on the other
 * countries' Amazon sites): what plays, the episode, where it is, and the
 * subtitles the viewer has on, the moment they show. The app puts the
 * subtitles on the card the way it puts Kick's captions there.
 *
 * Nothing is fetched
 * ------------------
 * The subtitle files could be had: the player asks Amazon for a list of them
 * (TTML, one per language) before it starts, and a script in the page could
 * catch that answer or ask again. That would mean running inside the page's own
 * JavaScript, calling an undocumented Amazon API with the viewer's session, and
 * a privacy policy that names Amazon as a host this extension contacts. It
 * would also hand over subtitles the viewer has switched off. Reading what the
 * player draws needs none of that: it is in step with the picture by
 * construction, it is exactly what the viewer chose to see, and with subtitles
 * off there is nothing to read and nothing is sent. Kick's captions are read
 * the same way, for the same reasons (see sites/kick.js).
 *
 * The player's markup
 * -------------------
 * Amazon's web player is the "atvwebplayersdk" one; its class names are what
 * other extensions read too (checked in their sources and notes, 2025-2026):
 *   .atvwebplayersdk-player-container    the player, around everything below
 *   .atvwebplayersdk-title-text          the show or film
 *   .atvwebplayersdk-subtitle-text       the episode ("Season 1, Ep. 3 Name")
 *   .atvwebplayersdk-timeindicator-text  "elapsed / time left"
 *   .atvwebplayersdk-captions-overlay    the subtitles, one
 *   .atvwebplayersdk-captions-text       element per line, rebuilt per cue
 * The player holds more than one <video> (a placeholder beside the real one);
 * the real one is the largest with media loaded. Pages also play muted trailers
 * in their banner, outside the player: nothing outside the player is read.
 */

(function () {
  'use strict';

  // ── Config ──
  const VYBECORD_URL = 'http://127.0.0.1:8888/api/primevideo';
  const BASE_INTERVAL_MS = 2500;
  const MAX_INTERVAL_MS = 15000;
  /** How often the player is looked at: subtitles change several times a second in dialogue. */
  const WATCH_MS = 250;
  /**
   * How often a page with no player open is looked at for one. Most pages this
   * runs on never open one: it runs on Amazon's title pages, which are product
   * pages, because a title found through Amazon's search plays on its page.
   */
  const IDLE_WATCH_MS = 1000;
  /** Fastest a subtitle change is reported. A cue lasts a second or more. */
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
  /** Whether the last push said something plays, so closing the player is said once. */
  let reported = false;

  // ── The player ──

  /*
   * The player's outermost element, newest markup first. `#dv-web-player` is
   * the container older pages kept in the document at all times, hidden while
   * nothing plays, hence the check that it is drawn at all.
   */
  const PLAYER_SELECTORS = ['.atvwebplayersdk-player-container', '#dv-web-player'];

  /**
   * Drawn on the page, with an area. A player the page has hidden, or emptied
   * and left in place, is a box with no height, which a test for display:none
   * alone takes for an open player: a paused one, pushed forever.
   */
  function shown(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /**
   * Drawn on the page, whatever its size: the subtitle overlay can be a box
   * with no height of its own, its rows placed over the picture.
   */
  function drawn(el) {
    return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function playerRoot() {
    for (const sel of PLAYER_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (shown(el)) return el;
      }
    }
    return null;
  }

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

  /** One line of text: runs of whitespace, newlines included, become one space. */
  function flat(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  /** Text of the first match inside the player, else anywhere in the page. */
  function textIn(root, sel) {
    const el = root.querySelector(sel) || document.querySelector(sel);
    return el ? flat(el.textContent) : '';
  }

  /**
   * The title when the player does not name it: the page's own, which reads
   * "Prime Video: The Boys - Season 1" on a title's page. Only used with a
   * player that fills the window (see describe), so a banner trailer on some
   * other page cannot pass for what is being watched.
   */
  function pageTitle() {
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (md && md.title) return flat(md.title);
    } catch (e) { /* not readable here */ }
    return flat(document.title.replace(/^\s*(?:Amazon\.[a-z.]+|Prime Video)\s*:\s*/i, '').replace(/\s*[|–-]\s*Prime Video\s*$/i, ''));
  }

  /** Whether the page says it is about this title: its link and poster are then this title's. */
  function pageNames(title) {
    const t = title.toLowerCase();
    if (!t) return false;
    const meta = document.querySelector('meta[name="title"]');
    return document.title.toLowerCase().includes(t)
      || (!!meta && (meta.getAttribute('content') || '').toLowerCase().includes(t));
  }

  /**
   * The title's page, for the card's links: the page's canonical address when
   * it is a title's page, else the address up to the title's id. Nothing when
   * the page is about something else, which is what a film the player moved on
   * to by itself leaves behind: the app then links a search for the title.
   */
  function titlePage(title) {
    if (!pageNames(title)) return '';
    const canon = document.querySelector('link[rel="canonical"]');
    const href = canon ? canon.getAttribute('href') || '' : '';
    if (/^https:\/\/[^/]+\/(?:.*\/)?(?:detail|dp)\/[A-Za-z0-9]{10,40}\/?$/.test(href)) return href;
    const m = /^(.*?\/(?:detail|dp)\/[A-Za-z0-9]{10,40})/.exec(location.pathname);
    // Without the shop's language segment ("/-/fr/"), which a friend clicking
    // through has no use for.
    return m ? location.origin + m[1].replace(/\/-\/[a-z]{2}(?:_[a-z]{2})?(?=\/)/i, '') : '';
  }

  /**
   * The title's poster: the one the player announces to the system when it
   * does, else the page's own (a 3:4 poster on a title's page, checked 2026-11),
   * provided the page is this title's. Not the site-wide logo every other page
   * carries in the same tag.
   */
  function artwork(title) {
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (md && md.artwork && md.artwork.length && flat(md.title).toLowerCase() === title.toLowerCase()) {
        const size = (a) => Math.max(0, ...String(a.sizes || '').split(/\s+/).map((s) => parseInt(s, 10) || 0));
        const best = Array.from(md.artwork).filter((a) => /^https:\/\//.test(String(a.src || '')))
          .sort((a, b) => size(b) - size(a))[0];
        if (best) return String(best.src);
      }
    } catch (e) { /* not readable here */ }
    if (!pageNames(title)) return '';
    const og = document.querySelector('meta[property="og:image"]');
    const src = og ? og.getAttribute('content') || '' : '';
    return /^https:\/\//.test(src) && !/seo-logo|\/seo\//i.test(src) ? src : '';
  }

  // ── Where the video is ──

  /** "1:02:03", "52:10" or "-52:10" as seconds, or null. */
  function clock(s) {
    const m = /^(-|−)?\s*(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(String(s).trim());
    if (!m) return null;
    return { secs: (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4]), left: !!m[1] };
  }

  /** The player's time display, read: { raw, elapsed, other, otherIsLeft } or null. */
  function readTimeDisplay(root) {
    const raw = textIn(root, '.atvwebplayersdk-timeindicator-text');
    if (!raw) return null;
    const parts = raw.split('/');
    const a = clock(parts[0] || '');
    if (!a || a.left) return null;
    const b = parts.length > 1 ? clock(parts[1]) : null;
    return { raw, elapsed: a.secs, other: b ? b.secs : null, otherIsLeft: !!(b && b.left) };
  }

  /*
   * What the number after the slash is: the time left or the length.
   *
   * Others' code reads it as the time left (it waits for it to reach zero to
   * catch the end of an episode), which is what is assumed until the display
   * itself settles it: elapsed plus time left stays put as the video plays, a
   * length does not move at all. A length the video element knows settles it
   * sooner.
   */
  let slashMeans = '';
  let lastDisplay = null;

  function judgeSlash(d, video) {
    if (d.otherIsLeft) return 'left';
    if (slashMeans) return slashMeans;
    if (lastDisplay && d.elapsed !== lastDisplay.elapsed) {
      if (d.other === lastDisplay.other) slashMeans = 'length';
      else if (Math.abs(d.elapsed + d.other - lastDisplay.elapsed - lastDisplay.other) <= 1) slashMeans = 'left';
    }
    lastDisplay = { elapsed: d.elapsed, other: d.other };
    if (slashMeans) return slashMeans;
    const len = isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (len && Math.abs(d.other - len) <= 3) return 'length';
    return 'left';
  }

  /*
   * Where the video is, in the film's own time.
   *
   * The time display is the film's clock as the viewer sees it, ads and all
   * left out, but it is only good to the second and the player may stop
   * redrawing it while its controls are hidden. The video element's clock is
   * smooth and always running, but nothing promises it counts from the film's
   * start, and others found the placeholder and ad videos beside it hard to
   * tell from the film. So the display sets the difference between the two
   * each time it changes, and the video's clock runs on from there.
   */
  let offset = null;
  let offsetVideo = null;
  let lastDisplayRaw = '';

  /** Note the display's latest reading against the video's clock. Run on every look. */
  function trackDisplay(root, video) {
    const d = readTimeDisplay(root);
    if (!d || d.raw === lastDisplayRaw) return;
    lastDisplayRaw = d.raw;
    if (isFinite(video.currentTime)) {
      offset = d.elapsed - video.currentTime;
      offsetVideo = video;
    }
  }

  function position(root, video) {
    const d = readTimeDisplay(root);
    let posSec;
    if (offsetVideo === video && offset !== null && isFinite(video.currentTime)) posSec = video.currentTime + offset;
    else if (d) posSec = d.elapsed;
    else posSec = isFinite(video.currentTime) ? video.currentTime : 0;
    let lenSec = 0;
    if (d && d.other !== null) lenSec = judgeSlash(d, video) === 'length' ? d.other : d.elapsed + d.other;
    if (!lenSec && isFinite(video.duration) && video.duration > 0) lenSec = video.duration;
    return {
      position_ms: Math.max(0, Math.round(posSec * 1000)),
      duration_ms: Math.max(0, Math.round(lenSec * 1000)),
    };
  }

  // ── Subtitles ──

  let subtitleText = '';
  let subtitleAt = 0;

  /** A line's text, a <br> inside it kept as a break. */
  function lineText(el) {
    const raw = typeof el.innerText === 'string' ? el.innerText : el.textContent;
    return String(raw || '').split(/\n+/).map(flat).filter(Boolean).join('\n');
  }

  /** What the subtitles say right now, one line per row; '' with none on screen. */
  function readSubtitle(root) {
    const overlay = root.querySelector('.atvwebplayersdk-captions-overlay');
    if (!drawn(overlay)) return '';
    const rows = Array.from(overlay.querySelectorAll('.atvwebplayersdk-captions-text'))
      // A line styled in parts can nest the class; the outermost one is the line.
      .filter((el) => !el.parentElement || !el.parentElement.closest('.atvwebplayersdk-captions-text'));
    const text = (rows.length ? rows.map(lineText) : [lineText(overlay)]).filter(Boolean).join('\n');
    return text.slice(0, 400);
  }

  // ── What plays ──

  let titleKey = '';
  let titleSince = 0;

  /**
   * What the tab shows, or null when no player is open.
   *
   * A title and an episode from the player's own header. Without that header a
   * player is only believed when it fills the window: a page's banner trailer
   * plays in a video too, and would otherwise be announced as watched.
   */
  function describe() {
    const root = playerRoot();
    if (!root) return null;
    const video = playerVideo(root);
    if (!video) return null;
    let title = textIn(root, '.atvwebplayersdk-title-text');
    const episode = title ? textIn(root, '.atvwebplayersdk-subtitle-text') : '';
    if (!title) {
      const r = root.getBoundingClientRect();
      const fills = r.width >= window.innerWidth * 0.8 && r.height >= window.innerHeight * 0.8;
      if (!fills) return null;
      title = pageTitle();
    }
    if (!title) return null;
    const key = `${title}\n${episode}`;
    if (key !== titleKey) {
      titleKey = key;
      titleSince = Date.now();
      lastDisplay = null;
    }
    return { root, video, title, episode };
  }

  /**
   * The subtitle fields of a push. Nothing from before this title showed: the
   * player can keep the last episode's final line up while the next one starts.
   */
  function subtitleFields() {
    const current = subtitleAt > 0 && subtitleAt >= titleSince;
    return {
      caption: current ? subtitleText : '',
      caption_at: current ? subtitleAt : 0,
    };
  }

  function getPlaybackInfo() {
    const p = describe();
    if (!p) return null;
    return Object.assign({
      tab_id: TAB_ID,
      title: p.title.slice(0, 200),
      episode: p.episode.slice(0, 200),
      paused: p.video.paused || p.video.ended,
      page_url: titlePage(p.title),
      art_url: artwork(p.title),
    }, position(p.root, p.video), subtitleFields());
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
   * tell a pause from a closed tab. Once the player closes, one last push says
   * nothing plays any more, and the tab goes quiet: the app lets it age out.
   */
  function periodicPush() {
    const data = getPlaybackInfo();
    if (data) {
      reported = true;
      pushToVybecord(data);
    } else if (reported) {
      reported = false;
      pushToVybecord(Object.assign({ tab_id: TAB_ID, title: titleKey.split('\n')[0], episode: titleKey.split('\n')[1] || '', paused: true, position_ms: 0, duration_ms: 0 }, subtitleFields()));
    }
  }

  let watchedVideo = null;

  /** Play, pause and seek reported at once rather than at the next beat. */
  function attachVideoListeners(video) {
    if (video === watchedVideo) return;
    watchedVideo = video;
    for (const type of ['play', 'pause', 'seeked', 'ended']) video.addEventListener(type, pushSoon);
  }

  /*
   * One look at the player per WATCH_MS while one is open: subtitles that
   * changed, a time display that ticked. A few lookups, none of them over the
   * whole document; once a second while there is no player.
   */
  function watch() {
    let root = null;
    try {
      root = playerRoot();
      const video = root && playerVideo(root);
      if (video) {
        attachVideoListeners(video);
        trackDisplay(root, video);
      }
      const text = root ? readSubtitle(root) : '';
      if (text !== subtitleText) {
        subtitleText = text;
        subtitleAt = Date.now();
        pushSoon();
      }
    } catch (e) {
      // A page halfway through redrawing its player: look again next time.
    } finally {
      setTimeout(watch, root ? WATCH_MS : IDLE_WATCH_MS);
    }
  }

  function init() {
    reschedule(BASE_INTERVAL_MS);
    watch();
    console.log('[VybecordTS] Prime Video integration initialized ✓');
    setTimeout(periodicPush, 500);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
