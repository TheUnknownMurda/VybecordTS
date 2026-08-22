/**
 * spotify — playback reporter.
 *
 * Carried over from the Tampermonkey userscript with its scraping logic intact;
 * see src/gm-shim.js for why.
 *
 * What this no longer does, and why
 * ---------------------------------
 * The userscript also fetched official synced lyrics from Spotify's internal
 * color-lyrics API, an artist image from api.spotify.com, and a client token
 * from clienttoken.spotify.com. All three are gone. As a content script none of
 * them worked anyway — see src/gm-shim.js — but the reason not to restore them
 * is that making them work would mean reading the user's session.
 *
 * Those endpoints authenticate with the OAuth bearer token of the logged-in
 * Spotify session. The userscript lifted it out of the page by patching
 * window.fetch and XMLHttpRequest. A content script cannot: it runs in an
 * isolated world, so it patches its own copies of those and never sees the
 * page's requests. The way to make it work — a MAIN-world injected script
 * bridging the token back out — is precisely the behaviour this extension
 * certifies it does not have. extension/STORE_SUBMISSION.md tells reviewers the
 * extension "does not read credentials, cookies, or anything the user has
 * typed", and ticks no Authentication-information data category.
 *
 * The feature is covered elsewhere regardless. The desktop app fetches lyrics
 * itself in src/core/provider.ts — LRCLib, Netease and Musixmatch raced in
 * parallel, a Last.fm-corrected retry, a fuzzy fallback and a local SQLite
 * database — which works for every source rather than only the Spotify web
 * player, and is not gated behind Premium the way color-lyrics is.
 *
 * So this script scrapes the page and posts to 127.0.0.1, and nothing else.
 */

(function () {
  'use strict';

  // ── Config ──
  const VYBECORD_URL = 'http://127.0.0.1:8888/api/spicetify';
  const BASE_INTERVAL_MS = 2500;
  const MAX_INTERVAL_MS = 15000;

  // ── State ──
  let lastTrackKey = '';
  let lastPlaying = null;
  let pushTimer = null;
  let currentInterval = BASE_INTERVAL_MS;
  let consecutiveFails = 0;
  let cachedTrackResult = null; // { trackName, result } - avoids re-running heavy extraction
  let lastTrackIdWarning = ''; // avoid spamming console with same warning

  // ── Helpers ──

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
    } catch { backoff(); }
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

  /**
   * Parse "M:SS" or "H:MM:SS" time string to ms.
   */
  function parseTime(str) {
    if (!str) return 0;
    const parts = str.split(':').map(Number);
    if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
    return 0;
  }

  /**
   * Extract track ID from Spotify URI or link.
   * "spotify:track:4iV5W9uYEdYUVa79Axb7Rh" → "4iV5W9uYEdYUVa79Axb7Rh"
   * "/track/4iV5W9uYEdYUVa79Axb7Rh" → "4iV5W9uYEdYUVa79Axb7Rh"
   */
  function extractTrackId(uri) {
    if (!uri) return '';
    const m = uri.match(/track[/:]([A-Za-z0-9]+)/);
    return m ? m[1] : '';
  }

  /**
   * Extract track ID using multiple strategies (Spotify changes DOM frequently).
   * Returns the 22-char base62 Spotify track ID or ''.
   */
  function extractTrackIdFromPage(nowPlayingWidget) {
    // Strategy 1: Direct link with /track/ in href (fast, most common)
    const trackLink = nowPlayingWidget.querySelector('a[href*="/track/"]');
    if (trackLink) {
      const id = extractTrackId(trackLink.getAttribute('href'));
      if (id) return { id, href: trackLink.getAttribute('href') };
    }

    // Strategy 2: Scan links in the widget
    const allLinks = nowPlayingWidget.querySelectorAll('a[href]');
    for (const a of allLinks) {
      const href = a.getAttribute('href') || '';
      const id = extractTrackId(href);
      if (id) return { id, href };
    }

    // Strategy 3: URL bar (if user is on a track page)
    const pathMatch = window.location.pathname.match(/\/track\/([A-Za-z0-9]{22})/);
    if (pathMatch) return { id: pathMatch[1], href: `/track/${pathMatch[1]}` };

    // Strategy 4: React fiber — lightweight walk (last resort, depth-limited)
    try {
      const fiberKey = Object.keys(nowPlayingWidget).find(k =>
        k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (fiberKey) {
        const visited = new Set();
        const queue = [{ obj: nowPlayingWidget[fiberKey], depth: 0 }];
        while (queue.length > 0) {
          const { obj, depth } = queue.shift();
          if (!obj || depth > 4 || typeof obj !== 'object') continue;
          if (visited.has(obj)) continue;
          visited.add(obj);
          if (visited.size > 30) break;
          for (const key of Object.keys(obj)) {
            const val = obj[key];
            if (typeof val === 'string') {
              const m = val.match(/spotify:track:([A-Za-z0-9]{22})/);
              if (m) return { id: m[1], href: `/track/${m[1]}` };
              const m2 = val.match(/\/track\/([A-Za-z0-9]{22})/);
              if (m2) return { id: m2[1], href: `/track/${m2[1]}` };
            } else if (typeof val === 'object' && val !== null &&
                       key !== 'stateNode' && key !== '_owner' && key !== 'containerInfo') {
              queue.push({ obj: val, depth: depth + 1 });
            }
          }
        }
      }
    } catch {}

    return null;
  }

  /**
   * Extract metadata from Spotify Web Player DOM.
   */
  function getMetadata() {
    // ── Now Playing bar (bottom of page) ──
    const nowPlayingWidget = document.querySelector('[data-testid="now-playing-widget"]') ||
                              document.querySelector('[data-testid="now-playing-bar"]') ||
                              document.querySelector('.now-playing-bar');
    if (!nowPlayingWidget) return null;

    // Track name — try multiple selectors
    const titleEl = nowPlayingWidget.querySelector('[data-testid="context-item-link"]') ||
                    nowPlayingWidget.querySelector('a[href*="/track/"]') ||
                    nowPlayingWidget.querySelector('[data-testid="context-item-info-title"] a') ||
                    nowPlayingWidget.querySelector('[data-testid="context-item-info-title"]') ||
                    nowPlayingWidget.querySelector('a[data-testid]') ||
                    nowPlayingWidget.querySelector('a');
    const trackName = titleEl?.textContent?.trim() || '';
    if (!trackName) return null;

    // Track ID — multi-strategy extraction (cached to avoid re-running heavy strategies)
    let trackResult = null;
    if (cachedTrackResult && cachedTrackResult.trackName === trackName) {
      trackResult = cachedTrackResult.result;
    } else {
      trackResult = extractTrackIdFromPage(nowPlayingWidget);
      cachedTrackResult = { trackName, result: trackResult };
    }
    const trackId = trackResult?.id || '';
    const trackHref = trackResult?.href || '';
    const trackUrl = trackHref ? `https://open.spotify.com${trackHref}` : '';
    if (!trackId && lastTrackIdWarning !== trackName) {
      lastTrackIdWarning = trackName;
      console.warn(`[VybecordTS] Could not extract track ID for "${trackName}" — lyrics won't be fetched. DOM:`, nowPlayingWidget.innerHTML.slice(0, 500));
    }

    // Artist name(s) — may be multiple links
    const artistContainer = nowPlayingWidget.querySelector('[data-testid="context-item-info-subtitles"]') ||
                            nowPlayingWidget.querySelector('[data-testid="context-item-info-artist"]');
    let artistName = '';
    let artistUrl = '';
    let artistId = '';
    if (artistContainer) {
      const artistLinks = artistContainer.querySelectorAll('a');
      if (artistLinks.length > 0) {
        artistName = Array.from(artistLinks).map(a => a.textContent?.trim()).filter(Boolean).join(', ');
        const firstLink = artistLinks[0]?.getAttribute('href') || '';
        artistUrl = firstLink ? `https://open.spotify.com${firstLink}` : '';
        const artistMatch = firstLink.match(/\/artist\/([A-Za-z0-9]+)/);
        if (artistMatch) artistId = artistMatch[1];
      } else {
        artistName = artistContainer.textContent?.trim() || '';
      }
    }
    // Fallback: if no artist found from subtitles, try any artist link in widget
    if (!artistName) {
      const anyArtist = nowPlayingWidget.querySelector('a[href*="/artist/"]');
      if (anyArtist) {
        artistName = anyArtist.textContent?.trim() || '';
        const href = anyArtist.getAttribute('href') || '';
        artistUrl = href ? `https://open.spotify.com${href}` : '';
        const m = href.match(/\/artist\/([A-Za-z0-9]+)/);
        if (m) artistId = m[1];
      }
    }

    // Album art
    const artEl = nowPlayingWidget.querySelector('img[src*="i.scdn.co"]') ||
                  nowPlayingWidget.querySelector('img');
    let albumArtUrl = artEl?.getAttribute('src') || '';
    if (albumArtUrl.includes('i.scdn.co')) {
      albumArtUrl = albumArtUrl.replace(/\/ab67616d0000[0-9a-f]+\//, '/ab67616d0000b273/');
    }

    // Album name
    const albumLink = nowPlayingWidget.querySelector('a[href*="/album/"]');
    const albumName = albumLink?.textContent?.trim() ||
                      artEl?.getAttribute('alt') ||
                      '';
    const albumHref = albumLink?.getAttribute('href') || '';
    const albumUrl = albumHref ? `https://open.spotify.com${albumHref}` : '';

    // ── Playback controls ──

    // Playing state
    const playBtn = document.querySelector('[data-testid="control-button-playpause"]');
    const isPlaying = playBtn?.getAttribute('aria-label')?.toLowerCase()?.includes('pause') ||
                      playBtn?.querySelector('button')?.getAttribute('aria-label')?.toLowerCase()?.includes('pause') ||
                      !!document.querySelector('[data-testid="control-button-playpause"] [aria-label*="ause"]') ||
                      false;

    // Progress & duration from the playback bar
    const progressEl = document.querySelector('[data-testid="playback-position"]');
    const durationEl = document.querySelector('[data-testid="playback-duration"]');
    const progressMs = parseTime(progressEl?.textContent);
    const durationMs = parseTime(durationEl?.textContent);

    // Context (playlist, album, artist radio, etc.)
    let contextName = '';
    let contextUrl = '';
    let contextType = '';

    // Strategy 1: "context-link" data-testid (Spotify's dedicated context element)
    const ctxLink = document.querySelector('[data-testid="context-link"]');
    // Strategy 2: Now Playing View panel header (right sidebar)
    const npvHeader = document.querySelector('[data-testid="now-playing-view"] [data-testid="context-link"]') ||
                      document.querySelector('[data-testid="now-playing-view"] a[href*="/playlist/"]') ||
                      document.querySelector('[data-testid="now-playing-view"] a[href*="/album/"]');
    // Strategy 3: Links in the now-playing bar area (bottom bar)
    const barLink = document.querySelector('.Root__now-playing-bar a[href*="/playlist/"]') ||
                    document.querySelector('.Root__now-playing-bar a[href*="/album/"]') ||
                    document.querySelector('.Root__now-playing-bar a[href*="/artist/"]') ||
                    document.querySelector('.Root__now-playing-bar a[href*="/collection/"]');
    // Strategy 4: Now-playing widget subtitles area
    const widgetCtx = nowPlayingWidget.querySelector('a[href*="/playlist/"]') ||
                      nowPlayingWidget.querySelector('a[href*="/album/"]');

    const bestCtx = ctxLink || npvHeader || barLink || widgetCtx;
    if (bestCtx) {
      contextName = bestCtx.textContent?.trim() || '';
      const href = bestCtx.getAttribute('href') || '';
      contextUrl = href ? (href.startsWith('http') ? href : `https://open.spotify.com${href}`) : '';
      if (href.includes('/playlist/')) contextType = 'playlist';
      else if (href.includes('/album/')) contextType = 'album';
      else if (href.includes('/artist/')) contextType = 'artist';
      else if (href.includes('/collection/')) {
        contextType = 'collection';
        if (!contextName) contextName = 'Liked Songs';
      }
    }

    // Strategy 5: Fallback — parse from current page URL if nothing found
    if (!contextName) {
      const path = window.location.pathname;
      if (path.startsWith('/playlist/')) {
        const headerEl = document.querySelector('[data-testid="entityTitle"] h1') ||
                         document.querySelector('h1');
        contextName = headerEl?.textContent?.trim() || '';
        contextUrl = window.location.href;
        contextType = 'playlist';
      } else if (path.startsWith('/album/')) {
        const headerEl = document.querySelector('[data-testid="entityTitle"] h1') ||
                         document.querySelector('h1');
        contextName = headerEl?.textContent?.trim() || '';
        contextUrl = window.location.href;
        contextType = 'album';
      } else if (path.startsWith('/collection/')) {
        contextName = 'Liked Songs';
        contextUrl = window.location.href;
        contextType = 'collection';
      }
    }


    // Local files detection: no track ID but track name exists
    const isLocal = !trackId && !!trackName;

    return {
      track_id: trackId,
      uri: isLocal ? `spotify:local:${trackName}:${artistName}` : `spotify:track:${trackId}`,
      track_name: trackName,
      artist_name: artistName,
      album_name: albumName,
      album_art_url: albumArtUrl,
      duration_ms: durationMs,
      progress_ms: progressMs,
      is_playing: !!isPlaying,
      spotify_url: trackUrl,
      artist_url: artistUrl,
      album_url: albumUrl,
      context_name: contextName,
      context_url: contextUrl,
      context_type: contextType,
      is_local: isLocal,
    };
  }

  // ── Core loop ──

  function onStateChange() {
    const data = getMetadata();
    if (!data) return;

    const trackKey = `${data.track_id}|${data.is_playing}`;

    if (trackKey !== lastTrackKey || data.is_playing !== lastPlaying) {
      lastTrackKey = trackKey;
      lastPlaying = data.is_playing;
      pushToVybecord(data);
      console.log(`[VybecordTS] New track: "${data.track_name}" by ${data.artist_name} | id=${data.track_id}`);
    }
  }

  function periodicPush() {
    // Always check for track/state changes (replaces MutationObserver)
    const data = getMetadata();
    if (!data) return;

    // Detect track or play-state change
    const trackKey = `${data.track_id}|${data.is_playing}`;
    if (trackKey !== lastTrackKey || data.is_playing !== lastPlaying) {
      lastTrackKey = trackKey;
      lastPlaying = data.is_playing;
      pushToVybecord(data);
      return;
    }

    // Position update — only when playing
    if (data.is_playing) pushToVybecord(data);
  }

  function init() {
    reschedule(BASE_INTERVAL_MS);

    // NO MutationObserver — Spotify's React DOM fires thousands of mutations/sec
    // Periodic push (2.5s) + state change detection is sufficient
    console.log('[VybecordTS] Spotify Web Player integration initialized ✓');
    // Said once. "The extension is running but I get no lyrics here" is
    // otherwise indistinguishable from a scraper that has quietly broken.
    console.log('[VybecordTS] Lyrics are not read from Spotify — the desktop app sources them itself.');
    onStateChange();
  }

  // ── Startup ──
  // Wait for DOM to be ready before initializing the state push.

  function startWhenReady() {
    // Spotify's player bar loads after the main DOM, so give extra time
    setTimeout(init, 800);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    startWhenReady();
  } else {
    window.addEventListener('DOMContentLoaded', startWhenReady);
  }
})();
