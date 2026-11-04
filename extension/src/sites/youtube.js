/**
 * youtube — playback reporter.
 *
 * Carried over from the Tampermonkey userscript with its scraping logic intact;
 * see src/gm-shim.js for why. The only changes are the removal of the userscript
 * metadata block and of the handshake with the old setup page, which the desktop
 * app no longer serves.
 */

(function () {
  'use strict';

  // ── Config ──
  const VYBECORD_URL = 'http://127.0.0.1:8888/api/youtube';
  const BASE_INTERVAL_MS = 2500;
  const MAX_INTERVAL_MS = 15000;

  // ── State ──
  let lastVideoId = '';
  let lastState = '';
  let pushTimer = null;
  let video = null;
  let currentInterval = BASE_INTERVAL_MS;
  let consecutiveFails = 0;
  let streamStartTime = 0; // Track when live stream started
  let streamStartFor = ''; // ...and which video that start belongs to
  const STREAM_START_KEY = 'vybecord_yt_stream_start';

  // ── Helpers ──

  /**
   * Recover a persisted stream start time for `videoId`, if one was saved
   * earlier (YouTube is a single-page app, so navigating between videos —
   * or a manual reload of the same live video — would otherwise reset the
   * in-memory streamStartTime and make the Discord elapsed timer jump back
   * to 0 even though the stream never stopped).
   */
  function getPersistedStreamStart(videoId) {
    try {
      const raw = GM_getValue(STREAM_START_KEY, '');
      if (!raw) return 0;
      const saved = JSON.parse(raw);
      if (saved && saved.videoId === videoId && saved.start) {
        return saved.start;
      }
    } catch (e) { /* ignore malformed storage */ }
    return 0;
  }

  function setPersistedStreamStart(videoId, start) {
    try {
      GM_setValue(STREAM_START_KEY, JSON.stringify({ videoId, start }));
    } catch (e) { /* ignore */ }
  }

  function clearPersistedStreamStart() {
    try {
      GM_setValue(STREAM_START_KEY, '');
    } catch (e) { /* ignore */ }
  }

  /**
   * Estimate the real broadcast start time from the live video's own
   * playback position, instead of guessing "now" — for a live stream,
   * `currentTime` counts up from 0 at the moment the broadcast began, so
   * as long as we're near the live edge (not rewound into the DVR buffer),
   * `Date.now() - currentTime` is the actual start time. This is accurate
   * even if the tab is opened well after the stream started, and needs no
   * network request.
   */
  function estimateLiveStartFromVideo(vid) {
    try {
      if (!vid || !isFinite(vid.currentTime) || vid.currentTime <= 0) return 0;
      const seekable = vid.seekable;
      if (seekable && seekable.length > 0) {
        const liveEdge = seekable.end(seekable.length - 1);
        const behindLiveMs = Math.max(0, (liveEdge - vid.currentTime) * 1000);
        // If we're watching delayed/DVR content, currentTime no longer
        // reflects true elapsed broadcast time — don't trust it.
        if (behindLiveMs > 10000) return 0;
      }
      return Date.now() - Math.round(vid.currentTime * 1000);
    } catch (e) {
      return 0;
    }
  }

  /**
   * The id of the video this page plays: `?v=` on a watch page, the path on a
   * Short. A Short's page has no `v` parameter at all, so before this every
   * Short pushed nothing and reached the app only through the browser's media
   * session, as a nameless tab: no link, a letterboxed cover, the hashtags in
   * the title.
   */
  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('v');
    if (v) return v;
    const m = SHORTS_PATH.exec(window.location.pathname);
    return m ? m[1] : '';
  }

  const SHORTS_PATH = /^\/shorts\/([\w-]{6,64})/;

  function isShortsPage() {
    return !isYouTubeMusic() && SHORTS_PATH.test(window.location.pathname);
  }

  function isYouTubeMusic() {
    return window.location.hostname === 'music.youtube.com';
  }

  let cachedVideoEl = null;
  /**
   * The player of the page in view. YouTube keeps the Shorts player and the
   * watch page's player both in the document once either has been opened, the
   * one not in view hidden and paused, and the Shorts one comes first: the
   * first video on a watch page reached after a Short is the paused Short, and
   * on a Short it can be the paused video from before. Each page's own player
   * is asked for by its container.
   */
  function getVideoElement() {
    const scope = isShortsPage() ? '#shorts-player' : isYouTubeMusic() ? '' : '#movie_player';
    if (cachedVideoEl && cachedVideoEl.isConnected && (!scope || cachedVideoEl.closest(scope))) return cachedVideoEl;
    cachedVideoEl = (scope && document.querySelector(`${scope} video`)) ||
                    document.querySelector('video.html5-main-video') ||
                    document.querySelector('video');
    return cachedVideoEl;
  }

  // ── Shorts ──

  /** How long a Short's first reading waits for the player to name it. */
  const SHORT_NAME_WAIT_MS = 1500;
  /** How long it waits for the panel to stop showing the previous Short's title. */
  const SHORT_STALE_WAIT_MS = 4000;
  /** What was settled for the Short on screen; see shortDetails(). */
  let shortInfo = { id: '', title: '', channel: '', channelUrl: '', firstSeen: 0, thumb: '' };
  /** The title settled for the Short before this one. */
  let previousShortTitle = '';
  let shortRetry = null;

  /**
   * The Short's own panel: the one around the player, else the one YouTube
   * marks active, else the one across the middle of the window. YouTube keeps
   * its neighbours rendered, above and below, for the swipe.
   */
  function activeReel(vid) {
    const own = (vid && vid.closest('ytd-reel-video-renderer')) ||
                document.querySelector('ytd-reel-video-renderer[is-active]');
    if (own) return own;
    const mid = window.innerHeight / 2;
    for (const reel of document.querySelectorAll('ytd-reel-video-renderer')) {
      const r = reel.getBoundingClientRect();
      if (r.height > 0 && r.top <= mid && r.bottom >= mid) return reel;
    }
    return null;
  }

  /** Title, channel handle and channel link as the panel shows them. */
  function reelDetails(vid) {
    const reel = activeReel(vid);
    if (!reel) return { title: '', handle: '', channelUrl: '' };
    const titleEl = reel.querySelector('yt-shorts-video-title-view-model') ||
                    reel.querySelector('h2.title, .title yt-formatted-string');
    const channelEl = reel.querySelector('.ytReelChannelBarViewModelChannelName a') ||
                      reel.querySelector('#channel-name a') ||
                      reel.querySelector('a[href^="/@"]');
    return {
      title: (titleEl?.textContent || '').trim(),
      handle: (channelEl?.textContent || '').trim(),
      channelUrl: channelPage(channelEl?.getAttribute('href')),
    };
  }

  /**
   * The player's own announcement of what it plays (what Windows shows in its
   * media flyout), when its picture names this video: right after a swipe it
   * can still be the previous Short's.
   */
  function mediaSessionFor(videoId) {
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (!md || !md.title) return null;
      const ours = Array.from(md.artwork || []).some((a) => {
        const src = String(a.src || '');
        return src.includes(`/vi/${videoId}/`) || src.includes(`/vi_webp/${videoId}/`);
      });
      return ours ? { title: md.title.trim(), artist: (md.artist || '').trim() } : null;
    } catch (e) { /* ignore */ }
    return null;
  }

  /**
   * The vertical thumbnail, when the video has one.
   *
   * hqdefault.jpg is 4:3 for every video, and a Short's is its frame in a
   * blurred band on each side: Discord crops the cover to a square, so the
   * card showed a narrow strip of the Short between two smears. oar2.jpg is
   * the frame at its own 9:16, which the crop fills edge to edge. It answered
   * for each of 25 Shorts tried (oardefault.jpg, its sibling, missed 4), but
   * nothing documents it, so it is loaded once here, and hqdefault takes its
   * place if it fails or comes back the wrong way round.
   */
  function shortThumb(videoId) {
    if (shortInfo.thumb) return shortInfo.thumb;
    const vertical = `https://i.ytimg.com/vi/${videoId}/oar2.jpg`;
    shortInfo.thumb = vertical;
    try {
      const img = new Image();
      img.onload = () => {
        if (img.naturalHeight > img.naturalWidth) return;
        fallBackThumb(videoId);
      };
      img.onerror = () => fallBackThumb(videoId);
      img.src = vertical;
    } catch (e) { /* the optimistic answer stands */ }
    return vertical;
  }

  function fallBackThumb(videoId) {
    if (shortInfo.id !== videoId) return;
    shortInfo.thumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    const data = getMetadata();
    if (data) pushToVybecord(data);
  }

  function retryShortSoon() {
    if (!shortRetry) shortRetry = setTimeout(() => { shortRetry = null; onStateChange(); }, 400);
  }

  /**
   * Title, channel and channel link of the Short on screen, settled once per
   * Short.
   *
   * Swiping changes the address first and the rest a beat later: for a moment
   * the panel and the player can both still describe the previous Short. A
   * reading taken then put the last Short's title on the new one's card, and
   * kept it there. So a Short is named by the player's announcement once its
   * picture is this video's; failing that, after SHORT_NAME_WAIT_MS, by the
   * panel, provided it no longer shows the previous Short's title (two Shorts
   * in a row can share one, hence SHORT_STALE_WAIT_MS). The player's name
   * ("ClishiOh Clipz") also reads better than the panel's handle
   * ("@ClishiOhClipz"), which is used without its @.
   *
   * Settled once because the app tells tracks apart by title and artist as
   * well as id: a reading that changed under the same Short would start its
   * card over.
   */
  function shortDetails(videoId, vid) {
    if (shortInfo.id === videoId && shortInfo.title) return shortInfo;
    if (shortInfo.id !== videoId) {
      if (shortInfo.title) previousShortTitle = shortInfo.title;
      shortInfo = { id: videoId, title: '', channel: '', channelUrl: '', firstSeen: Date.now(), thumb: '' };
    }
    const waited = Date.now() - shortInfo.firstSeen;
    const panel = reelDetails(vid);
    const ms = mediaSessionFor(videoId);
    let title = '';
    let channel = '';
    let channelUrl = '';
    if (ms) {
      title = ms.title;
      channel = ms.artist;
      // The panel's link is this Short's only when the panel is.
      if (panel.title === ms.title) {
        channelUrl = panel.channelUrl;
        if (!channel) channel = panel.handle.replace(/^@/, '');
      }
    } else if (panel.title && waited >= SHORT_NAME_WAIT_MS &&
               (panel.title !== previousShortTitle || waited >= SHORT_STALE_WAIT_MS)) {
      title = panel.title;
      channel = panel.handle.replace(/^@/, '');
      channelUrl = panel.channelUrl;
    }
    if (!title) {
      if (waited < SHORT_STALE_WAIT_MS * 2) retryShortSoon();
      return null;
    }
    shortInfo.title = title;
    shortInfo.channel = channel;
    shortInfo.channelUrl = channelUrl;
    return shortInfo;
  }

  /** A channel link from the page, as an absolute link to the channel itself. */
  function channelPage(href) {
    const m = /^\/(@[^/?#]+|channel\/[\w-]+|c\/[^/?#]+|user\/[^/?#]+)/.exec(href || '');
    return m ? `https://www.youtube.com/${m[1]}` : '';
  }

  /**
   * Extract structured metadata from YouTube's page data.
   * Falls back to document.title parsing if structured data unavailable.
   */
  function getMetadata() {
    const videoId = getVideoId();
    if (!videoId) return null;

    const vid = getVideoElement();
    if (!vid) return null;

    if (isShortsPage()) return shortMetadata(videoId, vid);

    let title = '';
    let artist = '';
    let channel = '';
    let channelUrl = '';

    // YouTube Music: richer metadata via player API
    if (isYouTubeMusic()) {
      // Try the player bar metadata
      const titleEl = document.querySelector('.ytmusic-player-bar .title');
      const artistEl = document.querySelector('.ytmusic-player-bar .byline a');
      title = titleEl?.textContent?.trim() || '';
      artist = artistEl?.textContent?.trim() || '';
      channel = artist;
    }

    // Fallback: standard YouTube
    if (!title) {
      // Try structured data from ytInitialPlayerResponse
      try {
        const ytData = document.querySelector('#above-the-fold #title h1 yt-formatted-string');
        title = ytData?.textContent?.trim() || '';
      } catch { /* ignore */ }

      // Channel name
      try {
        const channelEl = document.querySelector('#owner #channel-name a') ||
                          document.querySelector('ytd-video-owner-renderer #channel-name a') ||
                          document.querySelector('.ytmusic-player-bar .byline a');
        channel = channelEl?.textContent?.trim() || '';
        if (!isYouTubeMusic()) channelUrl = channelPage(channelEl?.getAttribute('href'));
      } catch { /* ignore */ }
    }

    // Final fallback: parse document.title ("Title - YouTube")
    if (!title) {
      const docTitle = document.title.replace(/\s*-\s*YouTube\s*$/i, '').trim();
      title = docTitle;
    }

    // Detect live streams
    const isLive = !!document.querySelector('.ytp-live-badge[disabled]') ||
                   (vid.duration === Infinity) ||
                   !!document.querySelector('.badge-style-type-live-now');

    // Set stream start time when stream goes live — recover it from
    // persistent storage first so a reload/navigation doesn't reset
    // Discord's "time since stream started" display back to 0. On a
    // genuinely new detection, derive the real start from the video's own
    // playback position so it's accurate even if the tab was opened
    // mid-stream, falling back to Date.now() only if that's not possible.
    if (isLive) {
      // Per video: going from one live stream straight to another used to keep
      // the first one's start, so the second card counted from when the first
      // stream went live.
      if (streamStartTime === 0 || streamStartFor !== videoId) {
        streamStartTime = getPersistedStreamStart(videoId) || estimateLiveStartFromVideo(vid) || Date.now();
        streamStartFor = videoId;
        setPersistedStreamStart(videoId, streamStartTime);
      }
    } else if (streamStartTime !== 0) {
      // Reset when stream goes offline or when switching to non-live content
      streamStartTime = 0;
      streamStartFor = '';
      clearPersistedStreamStart();
    }

    return {
      video_id: videoId,
      title: title,
      artist: artist,
      channel: channel || artist,
      channel_url: channelUrl,
      duration_ms: isLive ? 0 : Math.round((vid.duration || 0) * 1000),
      progress_ms: Math.round((vid.currentTime || 0) * 1000),
      is_playing: !vid.paused && !vid.ended,
      is_live: isLive,
      stream_start_time_ms: isLive ? streamStartTime : undefined,
      thumbnail_url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      source: isYouTubeMusic() ? 'youtube_music' : 'youtube',
    };
  }

  /**
   * A Short's push. Same shape as a video's, plus `is_short`.
   *
   * A Short loops by itself, and the position reported is the loop's, which
   * is what the captions follow; the app keeps the bar off the card. A Short
   * is never treated as live, whatever badge some other part of the page
   * carries: the live badges looked for below are the watch page's, and that
   * page sits hidden in the document behind the Shorts player.
   */
  function shortMetadata(videoId, vid) {
    const info = shortDetails(videoId, vid);
    if (!info) return null;
    return {
      video_id: videoId,
      title: info.title,
      artist: '',
      channel: info.channel,
      channel_url: info.channelUrl,
      duration_ms: isFinite(vid.duration) ? Math.round((vid.duration || 0) * 1000) : 0,
      progress_ms: Math.round((vid.currentTime || 0) * 1000),
      is_playing: !vid.paused && !vid.ended,
      is_live: false,
      is_short: true,
      thumbnail_url: shortThumb(videoId),
      source: 'youtube',
    };
  }

  /**
   * Push data to the VybecordTS desktop app.
   *
   * GM_xmlhttpRequest here is the shim in gm-shim.js, not Tampermonkey's: it
   * relays through the service worker, which is what lets a content script
   * reach 127.0.0.1 at all. It is *not* a CORS bypass — it refuses every URL
   * that is not the app, loudly, on purpose. This comment used to say the
   * opposite, which is an invitation to the exact mistake the shim was written
   * to prevent.
   */
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

  // ── Core loop ──

  function onStateChange() {
    const data = getMetadata();
    if (!data) return;

    // Build state fingerprint for change detection
    const stateKey = `${data.video_id}|${data.is_playing}`;

    if (stateKey !== lastState || data.video_id !== lastVideoId) {
      lastState = stateKey;
      lastVideoId = data.video_id;
      // Immediate push on track/state change
      pushToVybecord(data);
    }
  }

  function periodicPush() {
    // Re-attach video listeners if element changed (SPA navigation)
    attachVideoListeners();
    // Detect state changes (replaces MutationObserver)
    onStateChange();
    // Position update — only when playing
    const data = getMetadata();
    if (data && data.is_playing) {
      pushToVybecord(data);
    }
  }

  function attachVideoListeners() {
    const vid = getVideoElement();
    if (!vid || vid === video) return;
    video = vid;

    // Event-driven updates for instant response
    vid.addEventListener('play', () => onStateChange());
    vid.addEventListener('pause', () => onStateChange());
    vid.addEventListener('seeked', () => {
      // Immediate push on seek for instant recalibration
      const data = getMetadata();
      if (data) pushToVybecord(data);
    });
    vid.addEventListener('ended', () => onStateChange());

    console.log('[VybecordTS] Video element attached ✓');
  }

  function init() {
    attachVideoListeners();
    reschedule(BASE_INTERVAL_MS);

    // NO MutationObserver — video events + periodic push are sufficient
    // YouTube's player DOM is extremely noisy (overlays, captions, comments)

    console.log('[VybecordTS] YouTube integration initialized ✓');

    setTimeout(() => {
      attachVideoListeners();
      onStateChange();
    }, 500);
  }

  // Wait for page to be ready (document-start means DOM isn't loaded yet)
  function onReady() {
    init();
    // YouTube SPA: re-init on client-side navigation
    window.addEventListener('yt-navigate-finish', () => {
      attachVideoListeners();
      onStateChange();
    });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    onReady();
  } else {
    document.addEventListener('DOMContentLoaded', onReady);
  }
})();
