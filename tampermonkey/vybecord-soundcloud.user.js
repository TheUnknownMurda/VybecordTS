// ==UserScript==
// @name         VybecordTS — SoundCloud Integration
// @namespace    https://github.com/vybecord
// @version      2.0.0
// @description  Push real-time SoundCloud playback data to VybecordTS for lyrics sync & Discord RPC
// @author       VybecordTS
// @match        https://soundcloud.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── Config ──
  const VYBECORD_URL = 'http://127.0.0.1:8888/api/soundcloud';
  const POLL_MS = 3000;
  const POLL_PAUSED_MS = 8000;
  const MAX_BACKOFF_MS = 30000;
  const CACHE_TTL_MS = 8000;
  const REQUEST_TIMEOUT_MS = 2000;

  // ── State ──
  let lastPushKey = '';
  let pollTimer = null;
  let backoffMs = 0;
  let inFlight = false;
  let tabVisible = true;

  // ── Cached DOM refs ──
  let _audio = null;
  let _playBtn = null;
  let _titleEl = null;
  let _artistEl = null;
  let _artSpan = null;
  let _progressBar = null;
  let _cacheTime = 0;
  let _boundAudio = null;

  function queryDOM() {
    const now = Date.now();
    if (now - _cacheTime < CACHE_TTL_MS) return;
    _cacheTime = now;
    try {
      _audio = document.querySelector('audio');
      _playBtn = document.querySelector('.playControl');
      _titleEl = document.querySelector('.playbackSoundBadge__titleLink');
      _artistEl = document.querySelector('.playbackSoundBadge__lightLink');
      _artSpan = document.querySelector('.playbackSoundBadge .sc-artwork span');
      _progressBar = document.querySelector('.playbackTimeline__progressWrapper [role="progressbar"]');
    } catch { /* CSP or DOM error — ignore */ }
  }

  function alive(el) { return el && el.isConnected; }

  function isPlaying() {
    if (alive(_playBtn)) return _playBtn.classList.contains('playing');
    if (alive(_audio)) return !_audio.paused;
    return false;
  }

  function getMetadata() {
    queryDOM();
    if (!alive(_titleEl)) return null;

    const title = (_titleEl.getAttribute('title') || _titleEl.textContent || '').trim();
    if (!title) return null;
    const artist = (_artistEl && alive(_artistEl)
      ? (_artistEl.getAttribute('title') || _artistEl.textContent || '')
      : '').trim();

    let artUrl = '';
    if (alive(_artSpan)) {
      const bg = _artSpan.style.backgroundImage || '';
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m) artUrl = m[1].replace(/-large\./, '-t500x500.').replace(/-small\./, '-t500x500.');
    }

    const titleHref = _titleEl.getAttribute('href') || '';
    const trackUrl = titleHref ? 'https://soundcloud.com' + titleHref : '';
    const artistHref = (alive(_artistEl) && _artistEl.getAttribute('href')) || '';
    const artistUrl = artistHref ? 'https://soundcloud.com' + artistHref : '';

    let progressMs = 0, durationMs = 0;
    if (alive(_progressBar)) {
      const now = parseFloat(_progressBar.getAttribute('aria-valuenow') || '0');
      const max = parseFloat(_progressBar.getAttribute('aria-valuemax') || '0');
      if (max > 0) { progressMs = Math.round(now); durationMs = Math.round(max); }
    }
    if (!durationMs && alive(_audio) && isFinite(_audio.duration)) {
      durationMs = Math.round(_audio.duration * 1000);
      progressMs = Math.round((_audio.currentTime || 0) * 1000);
    }

    return {
      track_id: trackUrl || window.location.pathname,
      title, artist,
      duration_ms: durationMs,
      progress_ms: progressMs,
      is_playing: isPlaying(),
      art_url: artUrl,
      track_url: trackUrl,
      artist_url: artistUrl,
      likes: 0,
    };
  }

  // ── Push (single in-flight guard) ──

  function push(data) {
    if (!data || inFlight) return;
    inFlight = true;
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: VYBECORD_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(data),
        timeout: REQUEST_TIMEOUT_MS,
        onload() {
          inFlight = false;
          if (backoffMs > 0) { backoffMs = 0; scheduleNext(); }
        },
        onerror() { inFlight = false; applyBackoff(); },
        ontimeout() { inFlight = false; applyBackoff(); },
      });
    } catch {
      inFlight = false;
      applyBackoff();
    }
  }

  function applyBackoff() {
    backoffMs = backoffMs ? Math.min(backoffMs * 1.5, MAX_BACKOFF_MS) : POLL_MS * 2;
    scheduleNext();
  }

  // ── Scheduling ──

  function scheduleNext() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (!tabVisible) return;
    const delay = backoffMs || (isPlaying() ? POLL_MS : POLL_PAUSED_MS);
    pollTimer = setTimeout(tick, delay);
  }

  function tick() {
    pollTimer = null;
    if (!tabVisible) return;

    // Re-attach audio listeners if element changed
    attachAudio();

    const data = getMetadata();
    if (data) {
      const key = `${data.title}|${data.artist}|${data.is_playing}|${Math.floor(data.progress_ms / 2000)}`;
      if (key !== lastPushKey || data.is_playing) {
        lastPushKey = key;
        push(data);
      }
    }
    scheduleNext();
  }

  // ── Audio event listeners (auto-reconnect) ──

  function onAudioEvent() {
    const data = getMetadata();
    if (!data) return;
    const key = `${data.title}|${data.artist}|${data.is_playing}`;
    if (key !== lastPushKey) {
      lastPushKey = key;
      push(data);
    }
  }

  function attachAudio() {
    queryDOM();
    if (!alive(_audio)) { _boundAudio = null; return; }
    if (_audio === _boundAudio) return;
    // Detach old
    if (_boundAudio) {
      try {
        _boundAudio.removeEventListener('play', onAudioEvent);
        _boundAudio.removeEventListener('pause', onAudioEvent);
        _boundAudio.removeEventListener('seeked', onAudioEvent);
      } catch { /* already GC'd */ }
    }
    _audio.addEventListener('play', onAudioEvent);
    _audio.addEventListener('pause', onAudioEvent);
    _audio.addEventListener('seeked', onAudioEvent);
    _boundAudio = _audio;
  }

  // ── Visibility (pause when tab hidden) ──

  function onVisibility() {
    tabVisible = !document.hidden;
    if (tabVisible) {
      _cacheTime = 0; // force fresh DOM query
      scheduleNext();
    } else {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    }
  }

  // ── Lifecycle ──

  function init() {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', cleanup);

    attachAudio();
    // If audio not found yet, retry a few times
    if (!_boundAudio) {
      let retries = 0;
      const check = setInterval(() => {
        attachAudio();
        if (_boundAudio || ++retries > 8) clearInterval(check);
      }, 3000);
    }

    scheduleNext();
    // Initial push after short delay
    setTimeout(tick, 1000);
    console.log('[VybecordTS] SoundCloud integration v2.0.0 ✓');
  }

  function cleanup() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    document.removeEventListener('visibilitychange', onVisibility);
    if (_boundAudio) {
      try {
        _boundAudio.removeEventListener('play', onAudioEvent);
        _boundAudio.removeEventListener('pause', onAudioEvent);
        _boundAudio.removeEventListener('seeked', onAudioEvent);
      } catch {}
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
