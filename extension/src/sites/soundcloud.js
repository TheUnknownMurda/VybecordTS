/**
 * soundcloud — playback reporter.
 *
 * Carried over from the Tampermonkey userscript with its scraping logic intact;
 * see src/gm-shim.js for why. The only changes are the removal of the userscript
 * metadata block and of the handshake with the old setup page, which the desktop
 * app no longer serves.
 */

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
  let _timePassedEl = null;
  let _durationEl = null;
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
      /*
       * The wrapper *is* the progressbar: role="progressbar" sits on the
       * element itself, not on a child. The descendant selector this used to be
       * matched nothing at all, silently — so duration reached the app as 0,
       * every track was announced with the four-minute placeholder, and the
       * position never left zero.
       *
       * Ordered widest-last so a future DOM that moves the role back onto a
       * child still works.
       */
      _progressBar = document.querySelector('[role="progressbar"].playbackTimeline__progressWrapper')
        || document.querySelector('.playbackTimeline__progressWrapper [role="progressbar"]')
        || document.querySelector('.playbackTimeline [role="progressbar"]');
      _timePassedEl = document.querySelector('.playbackTimeline__timePassed');
      _durationEl = document.querySelector('.playbackTimeline__duration');
    } catch { /* CSP or DOM error — ignore */ }
  }

  function alive(el) { return el && el.isConnected; }

  /**
   * Milliseconds from the clock SoundCloud renders, e.g. "…0:17" / "…1:29".
   *
   * The text is prefixed with a localised description for screen readers
   * ("Temps écoulé : 17 secondes0:17"), so the clock is taken as the last
   * clock-shaped run rather than by parsing the sentence around it.
   */
  function clockToMs(el) {
    if (!alive(el)) return 0;
    const found = (el.textContent || '').match(/\d+:[0-5]\d(?::[0-5]\d)?/g);
    if (!found) return 0;
    const p = found[found.length - 1].split(':').map(Number);
    const secs = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    return secs * 1000;
  }

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
      // These are seconds. Read as milliseconds — which is what this did — a
      // 1:29 track is reported as 89 milliseconds long.
      const now = parseFloat(_progressBar.getAttribute('aria-valuenow') || '');
      const max = parseFloat(_progressBar.getAttribute('aria-valuemax') || '');
      if (isFinite(max) && max > 0) {
        durationMs = Math.round(max * 1000);
        progressMs = isFinite(now) && now > 0 ? Math.round(now * 1000) : 0;
      }
    }
    if (!durationMs) {
      // The times on screen, which are right whenever anything is playing.
      const d = clockToMs(_durationEl);
      if (d > 0) { durationMs = d; progressMs = clockToMs(_timePassedEl); }
    }
    // Last resort. SoundCloud no longer puts an <audio> element in the page at
    // all, so this only ever fires for a build that brings one back.
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

  /**
   * Whether this tab should keep reporting.
   *
   * Hiding a tab does not stop its audio, and the desktop app reads silence
   * from a source as that source having gone away -- so pausing the loop on
   * visibility alone took the presence off music that was still playing, and
   * left the app to fall back to whatever Windows reports, without the artist
   * and track link this script exists to add.
   *
   * A hidden tab with nothing playing still stops, which is what the gate was
   * for: several SoundCloud tabs sitting open is the ordinary case.
   */
  function keepsPushing() {
    return tabVisible || isPlaying();
  }

  function scheduleNext() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (!keepsPushing()) return;
    const delay = backoffMs || (isPlaying() ? POLL_MS : POLL_PAUSED_MS);
    pollTimer = setTimeout(tick, delay);
  }

  function tick() {
    pollTimer = null;
    if (!keepsPushing()) return;

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

  // ── Visibility (idle down when hidden, unless audio is still playing) ──

  function onVisibility() {
    tabVisible = !document.hidden;
    if (tabVisible) {
      _cacheTime = 0; // force fresh DOM query
      scheduleNext();
    } else if (!isPlaying()) {
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
