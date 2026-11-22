/**
 * amazonmusic — playback reporter for Amazon Music in the browser.
 *
 * Reads the web player on music.amazon.com and on the other countries' Amazon
 * Music sites: the song, the artist, the album and its cover, where the song
 * is, and whether it plays. Without it, Windows sees the tab as an unnamed
 * browser, and the app guessed it was Spotify, which publishes the same
 * fields (see detectWebService in native-media-source.ts).
 *
 * Never seen against the real player
 * ----------------------------------
 * Written without an Amazon Music account, from others' published code
 * (2025-2026):
 *
 *   the media session        the song, the artist, the album and the cover,
 *                            which the page announces to the system: what
 *                            the browser shows in its own media controls
 *   <video>                  what plays: the web player plays music through
 *                            video elements, so their clock and length are
 *                            the song's
 *   music-horizontal-item    the player bar's song, whose links (in its
 *                            shadow root) lead to the artist and to the album
 *                            or playlist
 *
 * The links are a bonus: without them the card's buttons search for the song.
 */

(function () {
  'use strict';

  // ── Config ──
  const VYBECORD_URL = 'http://127.0.0.1:8888/api/amazonmusic';
  const BASE_INTERVAL_MS = 2500;
  const MAX_INTERVAL_MS = 15000;
  /** How often the player is looked at for a new song or a pause the media elements did not announce. */
  const LOOK_MS = 1000;

  // ── State ──
  let lastStateKey = '';
  let pushTimer = null;
  let currentInterval = BASE_INTERVAL_MS;
  let consecutiveFails = 0;

  // ── The player ──

  function flat(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * The element playing the song: of the media elements with a length, the
   * first one playing, else the first one. The player keeps more than one
   * (the next song loads beside the current one).
   */
  function media() {
    const all = Array.from(document.querySelectorAll('video, audio'))
      .filter((m) => isFinite(m.duration) && m.duration > 0);
    return all.find((m) => !m.paused && !m.ended) || all[0] || null;
  }

  /** What the page announces to the system, or null. */
  function sessionMetadata() {
    try {
      return (navigator.mediaSession && navigator.mediaSession.metadata) || null;
    } catch (e) {
      return null;
    }
  }

  /** The largest https cover the media session names, or ''. */
  function cover(md) {
    try {
      const size = (a) => Math.max(0, ...String(a.sizes || '').split(/\s+/).map((s) => parseInt(s, 10) || 0));
      const best = Array.from(md.artwork || []).filter((a) => /^https:\/\//.test(String(a.src || '')))
        .sort((a, b) => size(b) - size(a))[0];
      return best ? String(best.src) : '';
    } catch (e) {
      return '';
    }
  }

  /** A shadow root, a closed one included: the browser opens it to an extension (see shadowOf in film-page.js). */
  function shadowOf(el) {
    if (!el) return null;
    if (el.shadowRoot) return el.shadowRoot;
    try {
      if (typeof chrome !== 'undefined' && chrome.dom && typeof chrome.dom.openOrClosedShadowRoot === 'function') {
        return chrome.dom.openOrClosedShadowRoot(el) || null;
      }
    } catch (e) { /* not one the browser will open */ }
    try {
      return el.openOrClosedShadowRoot || null;
    } catch (e) {
      return null;
    }
  }

  /** An address on this Amazon Music site, or ''. */
  function ownLink(href) {
    try {
      const u = new URL(href, location.href);
      return u.origin === location.origin ? u.href : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * The links of the player bar's song: { artist, album, track, asin }, each
   * '' when it has none. An album's link that names the song
   * (/albums/<id>?trackAsin=<id>) is the song's own.
   */
  function links() {
    const out = { artist: '', album: '', track: '', asin: '' };
    const item = document.querySelector('music-app music-horizontal-item, #transport music-horizontal-item, music-horizontal-item');
    if (!item) return out;
    const roots = [item, shadowOf(item)].filter(Boolean);
    for (const root of roots) {
      for (const a of root.querySelectorAll('a[href]')) {
        const href = ownLink(a.getAttribute('href'));
        if (!href) continue;
        const path = new URL(href).pathname;
        if (!out.artist && /\/artists\//.test(path)) out.artist = href;
        else if (!out.album && /\/(?:albums|playlists|user-playlists)\//.test(path)) {
          out.album = href;
          const asin = new URL(href).searchParams.get('trackAsin') || '';
          if (/^[A-Z0-9]{10}$/.test(asin)) { out.asin = asin; out.track = href; }
        }
      }
    }
    return out;
  }

  /** What plays, or null when the page names nothing. */
  function getMetadata() {
    const md = sessionMetadata();
    const title = md ? flat(md.title) : '';
    if (!title) return null;
    const artist = flat(md.artist);
    const m = media();
    const l = links();
    const slug = `${artist}-${title}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return {
      track_id: l.asin || slug,
      title: title.slice(0, 200),
      artist: artist.slice(0, 200),
      album: flat(md.album).slice(0, 200),
      duration_ms: m ? Math.round(m.duration * 1000) : 0,
      progress_ms: m && isFinite(m.currentTime) ? Math.max(0, Math.round(m.currentTime * 1000)) : 0,
      is_playing: !!m && !m.paused && !m.ended,
      art_url: cover(md),
      track_url: l.track,
      artist_url: l.artist,
      album_url: l.album,
    };
  }

  // ── Push to Vybecord ──

  function pushToVybecord(data) {
    if (!data) return;
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

  // ── Core loop ──

  /** A new song, a pause or a play: said at once, the pause included, so the card goes with it. */
  function onStateChange() {
    const data = getMetadata();
    if (!data) return;
    const stateKey = `${data.title}|${data.artist}|${data.is_playing}`;
    if (stateKey !== lastStateKey) {
      lastStateKey = stateKey;
      pushToVybecord(data);
    }
  }

  /** While a song plays, one push per beat; a paused player has said so once already. */
  function periodicPush() {
    const data = getMetadata();
    if (data && data.is_playing) pushToVybecord(data);
  }

  /*
   * The media elements come and go with the songs, so rather than following
   * each one's events, the player is looked at once a second, and a seek is
   * caught by the push it lands in. Cheap: a query for the media elements and
   * one for the player bar.
   */
  function look() {
    try {
      onStateChange();
    } catch (e) {
      // The player halfway through drawing the next song: look again next time.
    } finally {
      setTimeout(look, LOOK_MS);
    }
  }

  function init() {
    reschedule(BASE_INTERVAL_MS);
    look();
    console.log('[VybecordTS] Amazon Music integration initialized ✓');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
