// ==UserScript==
// @name         VybecordTS — Bandcamp Integration
// @namespace    https://github.com/vybecord
// @version      1.0.0
// @description  Push real-time Bandcamp playback data to VybecordTS for lyrics sync & Discord RPC
// @author       VybecordTS
// @match        https://*.bandcamp.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── Config ──
  const VYBECORD_URL = 'http://127.0.0.1:8888/api/bandcamp';
  const BASE_INTERVAL_MS = 2500;
  const MAX_INTERVAL_MS = 15000;

  // ── State ──
  let lastStateKey = '';
  let pushTimer = null;
  let currentInterval = BASE_INTERVAL_MS;
  let consecutiveFails = 0;

  // ── Helpers ──

  /** Get the <audio> element Bandcamp uses for playback. */
  function getAudio() {
    return document.querySelector('audio') || document.querySelector('.jp-jplayer audio');
  }

  /** Check if the player is currently playing. */
  function isPlaying() {
    const audio = getAudio();
    if (audio) return !audio.paused && !audio.ended;
    // Fallback: check play button state
    const playBtn = document.querySelector('.playbutton, .play-btn, .play_button');
    return playBtn ? playBtn.classList.contains('playing') : false;
  }

  /** Parse "mm:ss" or "hh:mm:ss" to milliseconds. */
  function parseTime(str) {
    if (!str) return 0;
    const parts = str.trim().split(':').map(Number);
    if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
    return 0;
  }

  /** Extract metadata from a Bandcamp album/track page. */
  function getMetadata() {
    // ── Try TralbumData (Bandcamp's internal data object, most reliable) ──
    let tralbum = null;
    try {
      // Bandcamp embeds TralbumData in a <script> tag or on the window
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow.TralbumData) {
        tralbum = unsafeWindow.TralbumData;
      }
    } catch { /* sandbox restriction */ }

    // Fallback: parse from data attributes or JSON-LD
    if (!tralbum) {
      try {
        const dataEl = document.querySelector('[data-tralbum]');
        if (dataEl) tralbum = JSON.parse(dataEl.getAttribute('data-tralbum'));
      } catch { /* ignore */ }
    }

    // ── Audio element (progress/duration) ──
    const audio = getAudio();
    let progressMs = 0;
    let durationMs = 0;

    if (audio && isFinite(audio.duration)) {
      durationMs = Math.round(audio.duration * 1000);
      progressMs = Math.round((audio.currentTime || 0) * 1000);
    }

    // Fallback: time display elements
    if (!durationMs) {
      const timePos = document.querySelector('.time_elapsed');
      const timeDur = document.querySelector('.time_total');
      if (timePos && timeDur) {
        progressMs = parseTime(timePos.textContent);
        durationMs = parseTime(timeDur.textContent);
      }
    }

    // ── Track info from TralbumData ──
    if (tralbum && tralbum.trackinfo && tralbum.trackinfo.length > 0) {
      // Find the currently playing track
      let currentTrack = null;
      const tracks = tralbum.trackinfo;

      // If audio is playing, match by progress/position
      if (audio && audio.src) {
        for (const t of tracks) {
          if (t.file && Object.values(t.file).some(u => audio.src.includes(u.split('?')[0]))) {
            currentTrack = t;
            break;
          }
        }
      }

      // Fallback: check highlighted/playing track in DOM
      if (!currentTrack) {
        const playingRow = document.querySelector('.track_list .playing, .track_row_active, tr.current_track');
        if (playingRow) {
          const trackNum = parseInt(playingRow.querySelector('.track-number, .track_number')?.textContent || '0');
          if (trackNum > 0 && trackNum <= tracks.length) {
            currentTrack = tracks[trackNum - 1];
          }
        }
      }

      // Final fallback: first track (single track pages)
      if (!currentTrack && tracks.length === 1) {
        currentTrack = tracks[0];
      }

      if (currentTrack) {
        // Override duration from track data if available
        if (currentTrack.duration && currentTrack.duration > 0) {
          durationMs = Math.round(currentTrack.duration * 1000);
        }

        const artist = tralbum.artist || document.querySelector('#band-name-location .title')?.textContent?.trim() || '';
        const album = tralbum.current?.title || '';
        const title = currentTrack.title || '';

        // Art URL
        let artUrl = '';
        const artImg = document.querySelector('#tralbum_art img, .popupImage img, a.popupImage img');
        if (artImg) {
          artUrl = artImg.getAttribute('src') || '';
          // Upgrade to high-res (Bandcamp uses _16.jpg for large)
          artUrl = artUrl.replace(/_\d+\./, '_16.');
        }

        // Track URL
        let trackUrl = currentTrack.title_link
          ? window.location.origin + currentTrack.title_link
          : window.location.href;

        // Artist URL
        const artistUrl = window.location.origin;

        // Album URL
        const albumUrl = tralbum.url || window.location.href;

        // Track ID
        const trackId = currentTrack.id
          ? String(currentTrack.id)
          : `${artist}-${title}`.toLowerCase().replace(/\s+/g, '-');

        return {
          track_id: trackId,
          title: title,
          artist: artist,
          album: album,
          duration_ms: durationMs,
          progress_ms: progressMs,
          is_playing: isPlaying(),
          art_url: artUrl,
          track_url: trackUrl,
          artist_url: artistUrl,
          album_url: albumUrl,
        };
      }
    }

    // ── Fallback: DOM-only extraction ──
    const titleEl = document.querySelector('.trackTitle, #name-section .trackTitle, .title_link span');
    const artistEl = document.querySelector('#band-name-location .title, span[itemprop="byArtist"] a');
    const albumEl = document.querySelector('#name-section .fromAlbum, span[itemprop="inAlbum"] a');

    const title = titleEl?.textContent?.trim() || '';
    const artist = artistEl?.textContent?.trim() || '';
    const album = albumEl?.textContent?.trim() || '';

    if (!title) return null;

    let artUrl = '';
    const artImg = document.querySelector('#tralbum_art img, .popupImage img');
    if (artImg) {
      artUrl = (artImg.getAttribute('src') || '').replace(/_\d+\./, '_16.');
    }

    const trackUrl = window.location.href;
    const artistUrl = window.location.origin;
    const trackId = `${artist}-${title}`.toLowerCase().replace(/\s+/g, '-');

    return {
      track_id: trackId,
      title: title,
      artist: artist,
      album: album,
      duration_ms: durationMs,
      progress_ms: progressMs,
      is_playing: isPlaying(),
      art_url: artUrl,
      track_url: trackUrl,
      artist_url: artistUrl,
      album_url: trackUrl,
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

    const stateKey = `${data.title}|${data.artist}|${data.is_playing}`;
    if (stateKey !== lastStateKey) {
      lastStateKey = stateKey;
      pushToVybecord(data);
    }
  }

  function periodicPush() {
    if (!isPlaying()) return;
    const data = getMetadata();
    if (data) pushToVybecord(data);
  }

  function init() {
    reschedule(BASE_INTERVAL_MS);

    // NO MutationObserver — audio events + periodic push are sufficient
    // Bandcamp pages are mostly static; track changes are caught by audio events

    // Listen for audio events
    const attachAudioListeners = () => {
      const audio = getAudio();
      if (audio) {
        audio.addEventListener('play', onStateChange);
        audio.addEventListener('pause', onStateChange);
        audio.addEventListener('seeked', () => {
          const data = getMetadata();
          if (data) pushToVybecord(data);
        });
        audio.addEventListener('ended', onStateChange);
        return true;
      }
      return false;
    };

    if (!attachAudioListeners()) {
      // Audio element may appear later (album pages load player dynamically)
      let retries = 0;
      const audioCheck = setInterval(() => {
        if (attachAudioListeners() || ++retries > 10) clearInterval(audioCheck);
      }, 2000);
    }

    console.log('[VybecordTS] Bandcamp integration initialized ✓');

    // Initial push
    setTimeout(onStateChange, 500);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
