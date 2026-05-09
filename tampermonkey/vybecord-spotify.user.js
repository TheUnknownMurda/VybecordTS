// ==UserScript==
// @name         VybecordTS — Spotify Web Player Integration
// @namespace    https://github.com/vybecord
// @version      1.1.0
// @description  Push real-time Spotify Web Player data + synced lyrics to VybecordTS
// @author       VybecordTS
// @match        https://open.spotify.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      *.spotify.com
// @connect      *.spclient.spotify.com
// @connect      spclient.wg.spotify.com
// @connect      clienttoken.spotify.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ── Config ──
  const VYBECORD_URL = 'http://127.0.0.1:8888/api/spicetify';
  const LYRICS_URL = 'http://127.0.0.1:8888/api/spotify-lyrics';
  const BASE_INTERVAL_MS = 2500;
  const MAX_INTERVAL_MS = 15000;

  // ── State ──
  let lastTrackKey = '';
  let lastPlaying = null;
  let pushTimer = null;
  let currentInterval = BASE_INTERVAL_MS;
  let consecutiveFails = 0;
  let capturedToken = '';
  let spclientBase = ''; // dynamically detected from Spotify's own requests
  let lastLyricsTrackId = '';
  let lyricsFetchAbort = null;
  let artistImageCache = {}; // artistId → imageUrl
  let lastArtistId = ''; // set by getMetadata, read by onStateChange
  let lyricsDisabled = false; // Set to true on 403 (Premium required) — stops retrying
  let cachedTrackResult = null; // { trackName, result } - avoids re-running heavy extraction
  let lastTrackIdWarning = ''; // avoid spamming console with same warning

  // ── spclient auto-detection ──
  // Spotify's web player makes requests to a regional spclient server (e.g. gue1-, gew4-, etc.)
  // We intercept fetch/XHR to detect the correct base URL automatically.

  const SPCLIENT_RE = /https:\/\/([a-z0-9-]+\.spclient\.spotify\.com)/;
  const SPCLIENT_FALLBACKS = [
    'https://spclient.wg.spotify.com',
    'https://gue1-spclient.spotify.com',
    'https://gew4-spclient.spotify.com',
    'https://gae2-spclient.spotify.com',
    'https://guc3-spclient.spotify.com',
  ];
  let clientToken = ''; // Spotify client-token (required by some API endpoints)

  // ── Intercept fetch to sniff spclient, tokens & track IDs from Spotify's own requests ──
  let interceptedTrackId = ''; // Last track ID seen in Spotify's own API calls
  const TRACK_URL_RE = /\/track\/([A-Za-z0-9]{22})/;

  function getHeader(headers, name) {
    if (!headers) return '';
    // Headers object (fetch API)
    if (typeof headers.get === 'function') return headers.get(name) || '';
    // Plain object
    return headers[name] || headers[name.toLowerCase()] || headers[name.charAt(0).toUpperCase() + name.slice(1)] || '';
  }

  const _origFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      let url = '';
      let headers = null;
      if (typeof args[0] === 'string') {
        url = args[0];
        headers = args[1]?.headers;
      } else if (args[0] instanceof Request) {
        url = args[0].url;
        headers = args[0].headers;
      } else if (args[0]?.url) {
        url = args[0].url;
        headers = args[0].headers || args[1]?.headers;
      }

      // Sniff spclient base
      if (!spclientBase) {
        const m = url.match(SPCLIENT_RE);
        if (m) {
          spclientBase = `https://${m[1]}`;
          console.log(`[VybecordTS] Auto-detected spclient: ${spclientBase}`);
        }
      }

      // Sniff Authorization token from Spotify's own API calls
      const authHeader = getHeader(headers, 'Authorization');
      if (authHeader && authHeader.startsWith('Bearer ') && authHeader.length > 50) {
        if (capturedToken !== authHeader) {
          capturedToken = authHeader;
          tokenExpiry = Date.now() + 3600_000; // Assume 1h validity
          console.log('[VybecordTS] Intercepted auth token from Spotify request ✓');
        }
      }

      // Sniff client-token header
      const ct = getHeader(headers, 'client-token');
      if (ct && ct.length > 20 && !clientToken) {
        clientToken = ct;
        console.log('[VybecordTS] Intercepted client-token from Spotify request ✓');
      }

      // Sniff track ID
      const tm = url.match(TRACK_URL_RE);
      if (tm) interceptedTrackId = tm[1];
    } catch {}
    return _origFetch.apply(this, args);
  };

  // Also intercept XHR (Spotify uses both fetch and XHR)
  const _origXhrOpen = XMLHttpRequest.prototype.open;
  const _origXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._vybUrl = url;
    try {
      if (!spclientBase) {
        const m = (url || '').match(SPCLIENT_RE);
        if (m) {
          spclientBase = `https://${m[1]}`;
          console.log(`[VybecordTS] Auto-detected spclient (XHR): ${spclientBase}`);
        }
      }
      const tm = (url || '').match(TRACK_URL_RE);
      if (tm) interceptedTrackId = tm[1];
    } catch {}
    return _origXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (name.toLowerCase() === 'authorization' && value.startsWith('Bearer ') && value.length > 50) {
        if (capturedToken !== value) {
          capturedToken = value;
          tokenExpiry = Date.now() + 3600_000;
          console.log('[VybecordTS] Intercepted auth token from XHR ✓');
        }
      }
      if (name.toLowerCase() === 'client-token' && value.length > 20 && !clientToken) {
        clientToken = value;
        console.log('[VybecordTS] Intercepted client-token from XHR ✓');
      }
    } catch {}
    return _origXhrSetHeader.call(this, name, value);
  };

  // ── Token acquisition: use Spotify's own token endpoint ──
  // Much more reliable than hooking fetch (Spotify uses internal interceptors).

  let tokenExpiry = 0;

  async function refreshToken() {
    // If we already have a token from interception, just use it
    if (capturedToken && Date.now() < tokenExpiry - 60_000) {
      return true;
    }

    // Try the token endpoint as fallback
    try {
      const resp = await _origFetch('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', {
        credentials: 'include',
      });
      if (!resp.ok) {
        console.warn('[VybecordTS] Token endpoint returned', resp.status,
          capturedToken ? '— using intercepted token instead' : '— no token available');
        // Return true if we already have a token from interception
        return !!capturedToken;
      }
      const data = await resp.json();
      if (data.accessToken) {
        capturedToken = 'Bearer ' + data.accessToken;
        tokenExpiry = data.accessTokenExpirationTimestampMs || (Date.now() + 3600_000);
        if (!spclientBase) {
          spclientBase = SPCLIENT_FALLBACKS[0];
        }
        console.log('[VybecordTS] Token acquired via endpoint ✓ (expires in', Math.round((tokenExpiry - Date.now()) / 60000), 'min)');
        if (!clientToken) fetchClientToken();
        return true;
      }
    } catch (e) {
      console.warn('[VybecordTS] Token refresh error:', e.message,
        capturedToken ? '— using intercepted token' : '');
    }
    return !!capturedToken;
  }

  /**
   * Fetch Spotify client-token (required by color-lyrics and other internal APIs).
   * This is separate from the user access token.
   */
  function fetchClientToken() {
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://clienttoken.spotify.com/v1/clienttoken',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        data: JSON.stringify({
          client_data: {
            client_version: '1.2.52.442.g0f3a4106',
            client_id: 'd8a5ed958d274c2e8ee717e6a4b0971d',
            js_sdk_data: {
              device_brand: 'unknown',
              device_model: 'unknown',
              os: 'windows',
              os_version: 'NT 10.0',
            },
          },
        }),
        timeout: 5000,
        onload: function (r) {
          try {
            const data = typeof r.response === 'string' ? JSON.parse(r.response) : r.response;
            if (data?.granted_token?.token) {
              clientToken = data.granted_token.token;
              console.log('[VybecordTS] Client-token acquired ✓');
            }
          } catch {}
        },
        onerror: function () {},
      });
    } catch {}
  }

  async function ensureToken() {
    // Already have a valid token (from interception or endpoint)?
    if (capturedToken && Date.now() < tokenExpiry - 60_000) {
      return true;
    }
    // Try refresh (endpoint or check interception)
    return await refreshToken();
  }

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

    // Strategy 2: Intercepted track ID from Spotify's own fetch calls (zero DOM cost)
    if (interceptedTrackId) {
      return { id: interceptedTrackId, href: `/track/${interceptedTrackId}` };
    }

    // Strategy 3: Scan links in the widget
    const allLinks = nowPlayingWidget.querySelectorAll('a[href]');
    for (const a of allLinks) {
      const href = a.getAttribute('href') || '';
      const id = extractTrackId(href);
      if (id) return { id, href };
    }

    // Strategy 4: URL bar (if user is on a track page)
    const pathMatch = window.location.pathname.match(/\/track\/([A-Za-z0-9]{22})/);
    if (pathMatch) return { id: pathMatch[1], href: `/track/${pathMatch[1]}` };

    // Strategy 5: React fiber — lightweight walk (last resort, depth-limited)
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

    lastArtistId = artistId;

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
      artist_art_url: (artistId && artistImageCache[artistId]) || '',
      is_local: isLocal,
    };
  }

  /**
   * Fetch artist image from Spotify Web API and cache it.
   */
  function fetchArtistImage(artistId) {
    if (!artistId || artistImageCache[artistId] !== undefined) return;
    if (!capturedToken) return;
    artistImageCache[artistId] = ''; // Mark as fetching
    try {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://api.spotify.com/v1/artists/${artistId}`,
        headers: { 'Authorization': capturedToken },
        timeout: 5000,
        onload: function (r) {
          if (r.status < 200 || r.status >= 300) return;
          try {
            const data = typeof r.response === 'string' ? JSON.parse(r.response) : r.response;
            const images = data?.images || [];
            const img = images.find(i => i.width >= 300 && i.width <= 640) || images[0];
            if (img?.url) {
              artistImageCache[artistId] = img.url;
            }
          } catch {}
        },
        onerror: function () {},
        ontimeout: function () {},
      });
    } catch {}
  }

  // ── Lyrics fetching from Spotify's internal API ──

  /**
   * Low-level lyrics request to a specific spclient base.
   * Returns { ok, status, data } or throws on network/timeout error.
   */
  function lyricsRequest(base, trackId, ctrl) {
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (ctrl.signal.aborted) return onAbort();
      ctrl.signal.addEventListener('abort', onAbort, { once: true });

      const hdrs = {
        'Authorization': capturedToken,
        'app-platform': 'WebPlayer',
        'Accept': 'application/json',
      };
      if (clientToken) hdrs['client-token'] = clientToken;

      GM_xmlhttpRequest({
        method: 'GET',
        url: `${base}/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false&market=from_token`,
        headers: hdrs,
        timeout: 8000,
        onload: function (r) {
          let data = r.response || r.responseText;
          if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { data = null; }
          }
          resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, data });
        },
        onerror: function (e) { reject(new Error('Network error: ' + (e.statusText || e.error || 'unknown'))); },
        ontimeout: function () { reject(new Error('Timeout (8s)')); },
      });
    });
  }

  async function fetchSpotifyLyrics(trackId) {
    if (!trackId) return null;
    if (lyricsDisabled) return null; // Premium required — skip silently

    // Ensure we have a valid token before calling the API
    const hasToken = await ensureToken();
    if (!hasToken) {
      console.warn('[VybecordTS] Cannot fetch lyrics: no token');
      return null;
    }

    // Abort previous lyrics fetch
    if (lyricsFetchAbort) {
      try { lyricsFetchAbort.abort(); } catch {}
    }
    lyricsFetchAbort = new AbortController();
    const ctrl = lyricsFetchAbort;

    // Build server list: detected spclient first, then fallbacks
    const servers = spclientBase
      ? [spclientBase, ...SPCLIENT_FALLBACKS.filter(s => s !== spclientBase)]
      : [...SPCLIENT_FALLBACKS];

    for (const base of servers) {
      try {
        console.log(`[VybecordTS] Fetching lyrics from ${base} ...`);
        const resp = await lyricsRequest(base, trackId, ctrl);

        if (resp.status === 404) return []; // Track has no lyrics (definitive)

        if (resp.status === 403) {
          // Premium required — disable lyrics for the rest of the session
          lyricsDisabled = true;
          console.warn('[VybecordTS] Spotify lyrics require Premium — disabled for this session. Lyrics will come from LRCLib/Netease instead.');
          return null;
        }

        if (!resp.ok) {
          console.warn(`[VybecordTS] Lyrics API (${base}) returned ${resp.status} — trying next server`);
          continue; // Try next spclient
        }

        // Success — remember this server for future requests
        if (base !== spclientBase) {
          spclientBase = base;
          console.log(`[VybecordTS] Switching spclient to ${base}`);
        }

        const lyricsData = resp.data?.lyrics;
        if (!lyricsData?.lines) {
          console.warn(`[VybecordTS] Lyrics response has no lines. Keys: ${resp.data ? Object.keys(resp.data).join(',') : 'null'}`, resp.data);
          return null;
        }

        const isSynced = lyricsData.syncType === 'LINE_SYNCED';
        console.log(`[VybecordTS] Lyrics parsed: ${lyricsData.lines.length} lines, syncType=${lyricsData.syncType}`);

        return lyricsData.lines
          .map(line => ({
            time: isSynced ? parseInt(line.startTimeMs || '0', 10) : -1,
            text: (line.words || '').trim(),
          }))
          .filter(l => l.text && l.text !== '');
      } catch (e) {
        if (e.name === 'AbortError') return null;
        console.warn(`[VybecordTS] Lyrics fetch error (${base}):`, e.message);
        continue; // Try next spclient
      }
    }

    console.warn('[VybecordTS] All spclient servers failed for lyrics');
    return null;
  }

  /**
   * Push lyrics to the VybecordTS backend.
   */
  function pushLyrics(trackId, lines) {
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: LYRICS_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ track_id: trackId, lines }),
        timeout: 3000,
        onerror: function () {},
        ontimeout: function () {},
      });
    } catch { /* silent */ }
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

      // Fetch artist image in background (non-blocking)
      if (lastArtistId) fetchArtistImage(lastArtistId);

      // Fetch lyrics on track change (not on play/pause toggle)
      if (data.track_id && data.track_id !== lastLyricsTrackId) {
        lastLyricsTrackId = data.track_id;
        console.log(`[VybecordTS] New track: "${data.track_name}" by ${data.artist_name} | id=${data.track_id} | token=${capturedToken ? 'YES' : 'NO'} | spclient=${spclientBase || 'auto'}`);
        fetchSpotifyLyrics(data.track_id).then(lines => {
          if (lines === null) {
            console.warn(`[VybecordTS] Lyrics fetch returned null (no token or error)`);
          } else if (lines.length === 0) {
            console.log(`[VybecordTS] No lyrics available for this track`);
            pushLyrics(data.track_id, lines);
          } else {
            pushLyrics(data.track_id, lines);
            console.log(`[VybecordTS] Pushed ${lines.length} synced lyric lines for "${data.track_name}"`);
          }
        }).catch(e => console.error('[VybecordTS] Lyrics fetch failed:', e));
      }
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
      if (lastArtistId) fetchArtistImage(lastArtistId);
      if (data.track_id && data.track_id !== lastLyricsTrackId) {
        lastLyricsTrackId = data.track_id;
        fetchSpotifyLyrics(data.track_id).then(lines => {
          if (lines !== null) pushLyrics(data.track_id, lines);
        }).catch(() => {});
      }
      return;
    }

    // Position update — only when playing
    if (data.is_playing) pushToVybecord(data);
  }

  function init() {
    reschedule(BASE_INTERVAL_MS);

    // NO MutationObserver — Spotify's React DOM fires thousands of mutations/sec
    // Periodic push (2.5s) + state change detection is sufficient

    // Token interception: fetch/XHR hooks run since document-start,
    // so the token is often already captured by the time init() fires.
    function onTokenReady(ok) {
      console.log('[VybecordTS] Spotify Web Player integration initialized ✓');
      console.log(`[VybecordTS] Token: ${ok ? 'YES' : 'NO'} | spclient: ${spclientBase || 'fallback'} | client-token: ${clientToken ? 'YES' : 'NO'}`);
      if (!ok) console.warn('[VybecordTS] No token available — lyrics will not work.');
      onStateChange();
    }

    if (capturedToken) {
      // Already intercepted — skip wait entirely
      refreshToken().then(onTokenReady);
    } else {
      // Wait for interception (Spotify still loading)
      let tokenWaitCount = 0;
      const tokenWaitTimer = setInterval(() => {
        tokenWaitCount++;
        if (capturedToken || tokenWaitCount >= 20) { // 20 × 200ms = 4s max
          clearInterval(tokenWaitTimer);
          refreshToken().then(onTokenReady);
        }
      }, 200);
    }
  }

  // ── Startup ──
  // @run-at document-start → fetch/XHR hooks installed before Spotify loads.
  // Wait for DOM to be ready before initializing the observer + state push.

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
