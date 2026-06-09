// ==UserScript==
// @name         VybecordTS — Kick Integration
// @namespace    https://github.com/vybecord
// @version      1.0.0
// @description  Push real-time Kick stream data to VybecordTS for Discord RPC with exact streamer links
// @author       VybecordTS
// @match        https://kick.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ── Config ──
  const VYBECORD_URL = 'http://127.0.0.1:8888/api/kick';
  const BASE_INTERVAL_MS = 3000;
  const MAX_INTERVAL_MS = 15000;

  // ── State ──
  let lastStreamer = '';
  let lastState = '';
  let pushTimer = null;
  let currentInterval = BASE_INTERVAL_MS;
  let consecutiveFails = 0;

  // ── Helpers ──

  /**
   * Extract streamer username from Kick URL.
   * URL format: https://kick.com/{streamer} or https://kick.com/{streamer}/
   */
  function getStreamerFromUrl() {
    const path = window.location.pathname;
    const match = path.match(/^\/([^\/]+)/);
    return match ? match[1].toLowerCase() : '';
  }

  /**
   * Get stream title from page.
   * Tries multiple selectors for resilience.
   */
  function getStreamTitle() {
    // Primary: stream title element
    const titleEl = document.querySelector('h1.stream-title') ||
                    document.querySelector('[data-testid="stream-title"]') ||
                    document.querySelector('h1[class*="title"]') ||
                    document.querySelector('title');

    let title = titleEl?.textContent?.trim() || '';

    // Clean up title: remove " - Kick" suffix if present
    title = title.replace(/\s*[-–]\s*Kick\s*$/i, '').trim();

    // Fallback: use streamer name if no title found
    if (!title) {
      title = getStreamerFromUrl() || 'Live Stream';
    }

    return title;
  }

  /**
   * Get thumbnail URL from page if available.
   */
  function getThumbnailUrl() {
    const thumbEl = document.querySelector('img[class*="thumbnail"]') ||
                    document.querySelector('video') ||
                    document.querySelector('[data-testid="stream-thumbnail"] img');
    return thumbEl?.src || '';
  }

  /**
   * Check if we're on a valid stream page (not homepage, categories, etc.)
   */
  function isStreamPage() {
    const streamer = getStreamerFromUrl();
    // Exclude homepage, categories, and special pages
    if (!streamer) return false;
    const excluded = ['home', 'categories', 'browse', 'search', 'login', 'signup', 'settings'];
    return !excluded.includes(streamer);
  }

  /**
   * Check if tab is visible/active (document visibility API)
   */
  function isTabVisible() {
    return document.visibilityState === 'visible';
  }

  /**
   * Extract structured metadata from Kick page.
   */
  function getMetadata() {
    if (!isStreamPage()) return null;

    const streamer = getStreamerFromUrl();
    if (!streamer) return null;

    const title = getStreamTitle();
    const isLive = !!document.querySelector('[class*="live"]') ||
                   !!document.querySelector('[data-testid="live-badge"]') ||
                   !!document.querySelector('.live-indicator');

    // Check if video element exists (stream is playing)
    const video = document.querySelector('video');
    const hasVideo = !!video && video.readyState > 0;

    return {
      streamer: streamer,
      title: title,
      viewers: 0, // Not critical for now
      is_live: isLive,
      is_playing: isTabVisible() && hasVideo,
      kick_url: `https://kick.com/${streamer}`,
      thumbnail_url: getThumbnailUrl(),
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
    const stateKey = `${data.streamer}|${data.is_playing}|${data.title}`;

    if (stateKey !== lastState || data.streamer !== lastStreamer) {
      lastState = stateKey;
      lastStreamer = data.streamer;
      // Immediate push on streamer/state change
      pushToVybecord(data);
      console.log(`[VybecordTS] Stream detected: ${data.streamer} — "${data.title}"`);
    }
  }

  function periodicPush() {
    // Detect state changes
    onStateChange();
    // Keepalive push when active
    const data = getMetadata();
    if (data && data.is_playing) {
      pushToVybecord(data);
    }
  }

  function init() {
    reschedule(BASE_INTERVAL_MS);

    // Listen for visibility changes (pause when tab hidden)
    document.addEventListener('visibilitychange', () => {
      const data = getMetadata();
      if (data) {
        data.is_playing = isTabVisible();
        pushToVybecord(data);
      }
    });

    // Listen for SPA navigation (Kick uses client-side routing)
    let lastPath = window.location.pathname;
    setInterval(() => {
      if (window.location.pathname !== lastPath) {
        lastPath = window.location.pathname;
        lastStreamer = ''; // Reset to force new detection
        onStateChange();
      }
    }, 500);

    console.log('[VybecordTS] Kick integration initialized ✓');

    // Initial detection
    setTimeout(onStateChange, 1000);
  }

  // Wait for page to be ready
  function onReady() {
    init();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    onReady();
  } else {
    document.addEventListener('DOMContentLoaded', onReady);
  }
})();
