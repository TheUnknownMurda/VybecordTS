// ==UserScript==
// @name         VybecordTS — YouTube Integration
// @namespace    https://github.com/vybecord
// @version      1.0.0
// @description  Push real-time YouTube playback data to VybecordTS for precise lyrics sync & Discord RPC
// @author       VybecordTS
// @match        https://www.youtube.com/*
// @match        https://music.youtube.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

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

  // ── Helpers ──

  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('v') || '';
  }

  function isYouTubeMusic() {
    return window.location.hostname === 'music.youtube.com';
  }

  let cachedVideoEl = null;
  function getVideoElement() {
    // Reuse cached element if still in DOM
    if (cachedVideoEl && cachedVideoEl.isConnected) return cachedVideoEl;
    cachedVideoEl = document.querySelector('video.html5-main-video') ||
                    document.querySelector('video');
    return cachedVideoEl;
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

    let title = '';
    let artist = '';
    let channel = '';

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

    // Set stream start time when stream goes live
    if (isLive && streamStartTime === 0) {
      streamStartTime = Date.now();
    }
    // Reset when stream goes offline or when switching to non-live content
    if (!isLive) {
      streamStartTime = 0;
    }

    return {
      video_id: videoId,
      title: title,
      artist: artist,
      channel: channel || artist,
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
   * Push data to VybecordTS backend.
   * Uses GM_xmlhttpRequest to bypass CORS restrictions.
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
