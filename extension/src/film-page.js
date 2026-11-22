/**
 * film-page — the reporter the film sites' scripts share.
 *
 * Disney+, Paramount+, Apple TV, Crave and Crunchyroll (sites/disneyplus.js
 * and the others) each say how their own player is drawn, and this does the
 * rest. What it reports, and why it reads it off the screen, are Netflix's
 * and Prime Video's (see sites/netflix.js and sites/primevideo.js), whose code
 * this is drawn from: the film or the show, the episode, where the video is,
 * whether an ad is playing, and the subtitles the viewer has on, the moment
 * they show. The app turns that into a card with the subtitles as its lyrics
 * (src/core/film-source.ts).
 *
 * Netflix's and Prime Video's scripts keep their own copies of all this. Each
 * was corrected against its real site, and folding them in here would change
 * two scripts that work, with neither site at hand to check the change on.
 *
 * Nothing is fetched, and the pages' own scripts are left alone
 * -------------------------------------------------------------
 * Every one of these players keeps its title and its exact position in an
 * object of its own, and others reach for it (Disney+'s through the
 * <disney-web-player> element, from a script put into the page). A content
 * script can only get there the same way: a script in the page's world,
 * against undocumented APIs, which Netflix's and Prime Video's scripts
 * rejected for that reason. The document is enough: what the player draws,
 * what the page says about itself (its address, its JSON-LD, its media
 * session), and the video element.
 *
 * A site's script
 * ---------------
 * vybecordFilmPage.start(site) runs the reporter; vybecordFilmPage.util holds
 * the lookups the sites share. `site` has:
 *
 *   name          its name, for the log, and so a page naming only itself in
 *                 its media session is not taken for a title
 *   endpoint      the app's push path for it
 *   watchId()     the film or episode the address names: its id; '' on a page
 *                 that can hold the player but names none; null on a page that
 *                 cannot, whose videos (trailers, previews) are never read
 *   findPlayer()  the open player, { root, video }, the video with media in
 *                 it; or null
 *   readHeader(player, id)  what the player or the page names right now:
 *                 { title, episode, art, page }, all but title optional; null
 *                 when nothing names it
 *   adShowing(player)       optional: an ad is playing
 *   readSubtitle(player)    optional: the subtitles on screen, one row per
 *                 line, '' with none. When it has none, the browser's own
 *                 subtitles and the common players' layers are read
 *   pageUrl(id, shown)      optional: the page the card links to
 *
 * Content scripts listed together in the manifest share one world, which is
 * how a site's script finds vybecordFilmPage: this file is listed before it.
 */

(() => {
  'use strict';

  // ── For the sites' scripts ──

  /** One line of text: runs of whitespace, newlines included, become one space. */
  function flat(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  /** Drawn on the page, with an area. A player emptied and left in place is a box with no height. */
  function shown(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** Drawn on the page, whatever its size: a subtitle layer can be a box with no height of its own. */
  function drawn(el) {
    return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  /** A block's text, a <br> inside it kept as a break. */
  function lineText(el) {
    const raw = typeof el.innerText === 'string' ? el.innerText : el.textContent;
    return String(raw || '').split(/\n+/).map(flat).filter(Boolean).join('\n');
  }

  /** A video with media in it, rather than a placeholder waiting for some. */
  function loaded(v) {
    return !!v && v.readyState > 0 && !!(v.currentSrc || v.src);
  }

  /** The largest video drawn under root with media loaded: the player's own, not a placeholder beside it. */
  function playerVideo(root) {
    let best = null;
    let bestArea = 0;
    if (!root) return null;
    for (const v of root.querySelectorAll('video')) {
      if (!loaded(v)) continue;
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  /** Whether an element covers most of the window, or is in fullscreen. A trailer on a page does neither. */
  function fillsWindow(el) {
    if (!el) return false;
    const full = document.fullscreenElement;
    if (full && (full === el || full.contains(el))) return true;
    const r = el.getBoundingClientRect();
    return r.width >= window.innerWidth * 0.8 && r.height >= window.innerHeight * 0.8;
  }

  /**
   * An element's shadow root, a closed one included.
   *
   * A closed shadow root hides its insides from the page's other scripts, and
   * players use them for exactly the title line a card needs (Disney+'s, as
   * others found it). An extension is not the page: the browser opens a
   * closed root to a content script, through chrome.dom in Chrome and Edge
   * (88 and later) and through the element itself in Firefox (63 and later).
   */
  function shadowOf(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.shadowRoot) return el.shadowRoot;
    try {
      if (typeof chrome !== 'undefined' && chrome.dom && typeof chrome.dom.openOrClosedShadowRoot === 'function') {
        const root = chrome.dom.openOrClosedShadowRoot(el);
        if (root) return root;
      }
    } catch (e) { /* not an element the browser will open */ }
    try {
      return el.openOrClosedShadowRoot || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Every element matching sel under root, inside the shadow roots under it
   * too, `depth` roots down at most. Only a custom element (a '-' in its name)
   * can carry a shadow root a player draws in, so only those are opened.
   */
  function deepQueryAll(root, sel, depth) {
    const out = [];
    const walk = (r, d) => {
      out.push(...r.querySelectorAll(sel));
      if (d <= 0) return;
      for (const el of r.querySelectorAll('*')) {
        if (!el.tagName.includes('-')) continue;
        const inner = shadowOf(el);
        if (inner) walk(inner, d - 1);
      }
    };
    if (!root) return out;
    const max = depth === undefined ? 4 : depth;
    walk(root, max);
    const own = root.nodeType === 1 ? shadowOf(root) : null;
    if (own) walk(own, max - 1);
    return out;
  }

  /** Rows of subtitle elements, top to bottom as the eye reads them; one nested in another of its kind is part of it. */
  function rowsOf(els, sel) {
    return els
      .filter((el) => drawn(el) && (!sel || !el.parentElement || !el.parentElement.closest(sel)))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .map(lineText)
      .filter(Boolean)
      .join('\n');
  }

  /** Every object in the page's JSON-LD, @graph lists flattened. A block that does not parse is passed over. */
  function jsonLd(root) {
    const out = [];
    const add = (v) => {
      if (Array.isArray(v)) { v.forEach(add); return; }
      if (!v || typeof v !== 'object') return;
      out.push(v);
      if (v['@graph']) add(v['@graph']);
    };
    for (const s of (root || document).querySelectorAll('script[type="application/ld+json"]')) {
      try { add(JSON.parse(s.textContent || '')); } catch (e) { /* the page's to fix, not ours */ }
    }
    return out;
  }

  /** A JSON-LD name: a string, or an object's name. */
  function ldText(v) {
    if (typeof v === 'string') return flat(v);
    if (v && typeof v === 'object') return flat(v.name);
    return '';
  }

  /** A JSON-LD picture's https address: a string, an ImageObject's url, or the first of a list. */
  function ldImage(v) {
    const first = Array.isArray(v) ? v[0] : v;
    const src = typeof first === 'string' ? first : first && typeof first === 'object' ? first.url || first.contentUrl : '';
    return /^https:\/\//.test(String(src || '')) ? String(src) : '';
  }

  /** What the page announces to the system about what plays, or null. */
  function sessionMetadata() {
    try {
      return (navigator.mediaSession && navigator.mediaSession.metadata) || null;
    } catch (e) {
      return null;
    }
  }

  /** The largest https picture a media session names, or ''. */
  function sessionArtwork(md) {
    try {
      const size = (a) => Math.max(0, ...String(a.sizes || '').split(/\s+/).map((s) => parseInt(s, 10) || 0));
      const best = Array.from(md.artwork || []).filter((a) => /^https:\/\//.test(String(a.src || '')))
        .sort((a, b) => size(b) - size(a))[0];
      return best ? String(best.src) : '';
    } catch (e) {
      return '';
    }
  }

  // ── Subtitles any player may draw ──

  /** A cue's text without its markup: WebVTT's <i>, <c.yellow>, <v Name> and their kind. */
  function cueText(text) {
    return String(text || '')
      .replace(/<[^>]*>/g, '')
      .replace(/&lrm;|&rlm;/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .split(/\n+/).map(flat).filter(Boolean).join('\n');
  }

  /**
   * The subtitles the browser draws itself: the cues of a track it is
   * showing. Only those. A player that draws its own keeps its track hidden,
   * and a hidden track can carry subtitles the viewer has switched off
   * (Shaka Player keeps them loaded that way), which are not ours to send.
   */
  function nativeSubtitles(video) {
    const rows = [];
    try {
      for (const track of Array.from(video.textTracks || [])) {
        if (track.mode !== 'showing' || (track.kind !== 'subtitles' && track.kind !== 'captions')) continue;
        for (const cue of Array.from(track.activeCues || [])) {
          const text = cueText(cue.text);
          if (text) rows.push(text);
        }
      }
    } catch (e) { /* a track the page is replacing as we read */ }
    return rows.join('\n');
  }

  /*
   * The subtitles the common web players draw over the video, under the class
   * names each gives them, which their authors document for restyling:
   * Bitmovin's (the player others' code finds on Crunchyroll), JW Player's
   * (Crave's), Shaka Player's (Disney+'s, outside the US, as Firefox found it)
   * and video.js's. A layer that is not drawn is subtitles switched off.
   */
  const PLAYER_SUBTITLES = [
    { layer: '.bmpui-ui-subtitle-overlay', cue: '.bmpui-ui-subtitle-label' },
    { layer: '.jw-captions', cue: '.jw-text-track-cue' },
    { layer: '.shaka-text-container', cue: '' },
    { layer: '.vjs-text-track-display', cue: '.vjs-text-track-cue' },
  ];

  function playerSubtitles(root) {
    for (const p of PLAYER_SUBTITLES) {
      const layer = (root && root.querySelector && root.querySelector(p.layer)) || document.querySelector(p.layer);
      if (!layer || !drawn(layer)) continue;
      const cues = p.cue ? Array.from(layer.querySelectorAll(p.cue)) : [];
      const text = cues.length ? rowsOf(cues, p.cue) : lineText(layer);
      if (text) return text;
    }
    return '';
  }

  // ── The reporter ──

  function start(site) {
    const VYBECORD_URL = site.endpoint;
    const BASE_INTERVAL_MS = 2500;
    const MAX_INTERVAL_MS = 15000;
    /** How often the player is looked at: subtitles change several times a second in dialogue. */
    const WATCH_MS = 250;
    /** How often a page with no player open is looked at for one: most of a site is browsing. */
    const IDLE_WATCH_MS = 1000;
    /** Fastest a subtitle change is reported. A subtitle stays a second or more. */
    const SUBTITLE_PUSH_MIN_MS = 500;
    /** How long the last title's line may linger on the next one's page before it is believed (see notePage). */
    const STALE_HEADER_MS = 5000;

    /*
     * Which tab this is, so the desktop app keeps one entry per tab: two tabs
     * on two films are two cards, and a tab moving to the next episode
     * replaces its own. sessionStorage is per tab and survives a reload. Same
     * as kick.js and netflix.js.
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
    /** What the last push said plays. */
    let lastReport = null;

    /** A site's lookup that throws (a page halfway through redrawing) answers nothing rather than stopping the reporter. */
    function ask(fn, fallback) {
      try {
        const v = fn();
        return v === undefined ? fallback : v;
      } catch (e) {
        return fallback;
      }
    }

    function currentId() {
      const id = ask(() => site.watchId(), null);
      return id === null ? null : String(id);
    }

    /**
     * Where the tab is, as one key: the address's id for the film or episode,
     * or, on a site whose addresses name none, the page's path. null off any
     * page that can hold the player.
     */
    function pageKey(id) {
      if (id === null) return null;
      return id ? `#${id}` : `/${location.pathname}`;
    }

    function findPlayer() {
      const p = ask(() => site.findPlayer(), null);
      return p && p.video ? p : null;
    }

    function adShowing(p) {
      return !!(site.adShowing && ask(() => site.adShowing(p), false));
    }

    // ── What plays ──

    /*
     * What the player or the page last said plays, and on which page. A
     * player's title line comes and goes with its controls, so it is read on
     * every look and remembered for as long as the tab stays on that film or
     * episode; read only when a push goes out, it would mostly be missed (see
     * netflix.js and primevideo.js, whose players both do this). On a page
     * whose address names no id, it is also bound to the video it was read
     * beside: a player loading the next episode in place empties that video.
     */
    let header = null;
    /**
     * The series' name for a page the player went to from another one without
     * leaving the player, which is the next episode, played by itself or
     * picked in the player: its own title line has not shown yet, the
     * series' has. Until it shows, the card names the series alone.
     */
    let carried = null;
    /** The page seen on the last look; null off any page that can hold a player. */
    let lastKey = null;
    /**
     * When a look last found the player open. A move carries the title line
     * over only from a page the player was open on a moment ago: on a site
     * whose addresses name no id, every page has a key, and going from one
     * show's player to browsing and on to another show's would otherwise hand
     * the first show's name to the second. A moment, not the last look: the
     * next episode loading can take the player away just before the address
     * moves on.
     */
    let openAt = 0;
    const OPEN_GRACE_MS = 5000;
    /** When the tab came to the page it is on: subtitles from before belong to another title. */
    let pageSince = 0;
    /**
     * What the title line said on the page before, when the tab went straight
     * from it to this one: the player can keep it up for a moment while the
     * next one loads, and it is not this one's. Passed over for
     * STALE_HEADER_MS at most, should two pages really read the same.
     */
    let before = null;

    /**
     * Note a move to another page, or off it: what the subtitles said before
     * belongs to the last one. Run on every look and before every push,
     * whichever sees the move first. Returns whether the tab moved.
     */
    function notePage(key) {
      if (key === lastKey) return false;
      const wasOpen = Date.now() - openAt < OPEN_GRACE_MS;
      const fromTitle = !!(wasOpen && lastKey && key && header && header.key === lastKey);
      // The series' name goes on from episode to episode, the title line seen
      // or not: three played on by themselves are still the same show.
      const series = fromTitle && header.episode ? header.title
        : wasOpen && lastKey && key && carried && carried.key === lastKey ? carried.title : '';
      carried = series ? { key, title: series } : null;
      before = fromTitle ? { title: header.title, episode: header.episode, until: Date.now() + STALE_HEADER_MS } : null;
      lastKey = key;
      pageSince = Date.now();
      return true;
    }

    /** Note what the player or the page names, when it does. Run on every look; returns whether it said something new. */
    function trackHeader(key, id, p) {
      if (key === null) return false;
      const h = ask(() => site.readHeader(p, id), null);
      const title = h ? flat(h.title).slice(0, 200) : '';
      if (!title) return false;
      const episode = flat(h.episode).slice(0, 200);
      const art = /^https:\/\//.test(String(h.art || '')) ? String(h.art) : '';
      const page = /^https:\/\//.test(String(h.page || '')) ? String(h.page) : '';
      if (header && header.key === key && header.video === p.video && header.title === title
        && header.episode === episode && header.art === art && header.page === page) return false;
      if (before && Date.now() < before.until && title === before.title && episode === before.episode) return false;
      header = { key, byId: !!id, video: p.video, title, episode, art, page };
      return true;
    }

    /** The video the header was read beside loads something else: until it names it, nothing is known of it. */
    function forgetHeader(video) {
      if (header && !header.byId && header.video === video) header = null;
    }

    /** The title the page announces to the system, when it names something other than the site. */
    function sessionTitle() {
      const md = sessionMetadata();
      const t = md ? flat(md.title) : '';
      return t && t.toLowerCase() !== site.name.toLowerCase() ? t.slice(0, 200) : '';
    }

    /**
     * A poster the page announces to the system with the title, when it
     * names this title or episode with it. Nothing else's: a page announcing
     * the trailer beside the film would put the wrong picture on the card.
     */
    function artwork(title, episode) {
      const md = sessionMetadata();
      if (!md || !md.artwork || !md.artwork.length) return '';
      const named = [md.title, md.artist, md.album].map((s) => flat(s).toLowerCase()).filter(Boolean);
      const ours = [title, episode].map((s) => flat(s).toLowerCase()).filter(Boolean);
      // One name inside the other only when both are of some length: "Up" is inside many a title.
      const same = (n, o) => n === o || (Math.min(n.length, o.length) >= 4 && (n.includes(o) || o.includes(n)));
      if (!named.some((n) => ours.some((o) => same(n, o)))) return '';
      return sessionArtwork(md);
    }

    /**
     * What the tab shows, or null when no player is open.
     *
     * The title from what the player or the page named on this page, else the
     * series' name carried from the episode before, else whatever the page
     * announces to the system. With none of those yet, the tab still reports,
     * with no title: the app shows no card for it, but keeps its subtitles
     * under its id for when the title shows.
     */
    function describe() {
      const id = currentId();
      const key = pageKey(id);
      notePage(key);
      if (key === null) return null;
      const p = findPlayer();
      if (!p) return null;
      if (!adShowing(p)) trackHeader(key, id, p);
      let title = '';
      let episode = '';
      let art = '';
      let page = '';
      if (header && header.key === key && (header.byId || header.video === p.video)) {
        ({ title, episode, art, page } = header);
      } else if (carried && carried.key === key) {
        title = carried.title;
      } else {
        title = sessionTitle();
      }
      return { id: id || '', p, title, episode, art, page };
    }

    // ── Subtitles ──

    let subtitleText = '';
    let subtitleAt = 0;

    /** What the subtitles say right now, one line per row: the site's own lookup, else what any player draws. */
    function readSubtitle(p) {
      let text = site.readSubtitle ? ask(() => site.readSubtitle(p), '') : '';
      if (!text) text = ask(() => playerSubtitles(p.root), '');
      if (!text && p.video.textTracks) text = nativeSubtitles(p.video);
      return String(text || '').slice(0, 400);
    }

    /**
     * The subtitle fields of a push. Nothing from before this page: the player
     * can keep the last episode's final line up while the next one starts.
     * Nothing during an ad either, whatever an ad draws there.
     */
    function subtitleFields(ad) {
      const current = !ad && subtitleAt > 0 && subtitleAt >= pageSince;
      return {
        caption: current ? subtitleText : '',
        caption_at: current ? subtitleAt : 0,
      };
    }

    // ── Where the video is ──

    /*
     * The video element's own clock and length. Each of these players keeps
     * a clock of its own, which a content script cannot reach, and an ad
     * stitched into the stream may move the video's clock away from the
     * film's; a card's bar needs no better, and the app takes a jump as a
     * seek.
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

    function getPlaybackInfo() {
      const d = describe();
      if (!d) return null;
      const ad = adShowing(d.p);
      lastReport = { video_id: d.id, title: d.title, episode: d.episode };
      const page = d.page || (site.pageUrl ? ask(() => site.pageUrl(d.id, { title: d.title, episode: d.episode }), '') : '');
      return Object.assign({
        tab_id: TAB_ID,
        video_id: d.id,
        title: d.title.slice(0, 200),
        episode: d.episode.slice(0, 200),
        // An ad is not the film playing: the card goes, the way it goes for a
        // pause, and comes back with the film.
        paused: !!(d.p.video.paused || d.p.video.ended || ad),
        page_url: /^https:\/\//.test(String(page || '')) ? String(page) : '',
        art_url: d.art || artwork(d.title, d.episode),
      }, position(d.p.video), subtitleFields(ad));
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
     * tell a pause from a closed tab. Once the player closes (back to
     * browsing), one last push says nothing plays any more, and the tab goes
     * quiet: the app lets it age out.
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
     * Play, pause and seek reported at once rather than at the next beat; and
     * a video found, which is the player opening or the next episode coming.
     * A site that reads its video from elsewhere (Crunchyroll's player frame)
     * hands over an object without events, and calls pushSoon itself.
     */
    function attachVideoListeners(video) {
      if (video === watchedVideo) return;
      watchedVideo = video;
      if (typeof video.addEventListener === 'function') {
        for (const type of ['play', 'pause', 'seeked', 'ended']) video.addEventListener(type, pushSoon);
        video.addEventListener('emptied', () => forgetHeader(video));
      }
      pushSoon();
    }

    /** Whether an ad played on the last look: one starting or ending is said at once, as a pause is. */
    let adWas = false;

    /*
     * One look at the player per WATCH_MS while one is open: subtitles that
     * changed, a title that showed, another page. Once a second while there
     * is no player.
     */
    function watch() {
      let open = false;
      try {
        const id = currentId();
        const key = pageKey(id);
        // Another film or episode, or off the page that plays them: said at once.
        if (notePage(key)) pushSoon();
        const p = key === null ? null : findPlayer();
        if (p) {
          open = true;
          attachVideoListeners(p.video);
          const ad = adShowing(p);
          if (ad !== adWas) { adWas = ad; pushSoon(); }
          // The title showing for the first time, or new names.
          if (!ad && trackHeader(key, id, p)) pushSoon();
          /*
           * Only with a player in view, and no ad: the next episode loading
           * takes the player away for a moment, and counted as the subtitles
           * going blank, the last episode's final line, still up when it came
           * back, would read as said again.
           */
          const text = ad ? '' : readSubtitle(p);
          if (text !== subtitleText) {
            subtitleText = text;
            subtitleAt = Date.now();
            pushSoon();
          }
        }
      } catch (e) {
        // A page halfway through redrawing its player: look again next time.
      } finally {
        if (open) openAt = Date.now();
        setTimeout(watch, open ? WATCH_MS : IDLE_WATCH_MS);
      }
    }

    function init() {
      reschedule(BASE_INTERVAL_MS);
      watch();
      console.log(`[VybecordTS] ${site.name} integration initialized ✓`);
      setTimeout(periodicPush, 500);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      init();
    } else {
      document.addEventListener('DOMContentLoaded', init);
    }

    return { pushSoon };
  }

  globalThis.vybecordFilmPage = {
    start,
    util: {
      flat, shown, drawn, lineText, loaded, playerVideo, fillsWindow, shadowOf, deepQueryAll,
      rowsOf, jsonLd, ldText, ldImage, sessionMetadata, playerSubtitles, nativeSubtitles,
    },
  };
})();
