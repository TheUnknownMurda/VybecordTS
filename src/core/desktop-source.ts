/**
 * Desktop media source — reads Windows SMTC via a long-running PowerShell process.
 * Works WITHOUT Spotify Premium. Detects any media session (Spotify, YouTube, etc.)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';
import { existsSync } from 'node:fs';
import type { TrackData } from './types.js';

const log = createLogger('DesktopSource');

const THUMB_PATH = path.join(process.env.TEMP || os.tmpdir(), 'vybecord_thumb.jpg');

// The reader emits a line every ~400ms. Past this, its data no longer describes
// reality — better to report nothing than to keep interpolating a frozen track.
const STALE_DATA_MS = 5_000;
// No output at all for this long means the reader is wedged (a WinRT call that
// never returned, despite the bounded awaits). Kill it and let it respawn.
const HANG_RESTART_MS = 15_000;
const WATCHDOG_INTERVAL_MS = 5_000;

// SMTC WinRT APIs only work reliably under powershell.exe (5.1).
// pwsh 7.x cannot enumerate GlobalSystemMediaTransportControls sessions — $mgr is always null.
function getPowerShellExe(): string {
  return 'powershell.exe';
}

// Regex for cleaning browser/YouTube titles
const RE_TOPIC_SUFFIX = /\s*-\s*Topic\s*$/i;
const RE_VIDEO_SUFFIX = /\s*[([]*(?:official\s+(?:music\s+)?video|official\s+audio|official\s+lyric\s+video|music\s+video|lyric\s+video|official\s+visualizer|visualizer|official|audio|lyrics|with\s+lyrics|mv|m\/v|4k|hd|hq)[)\]]*\s*$/i;
const RE_UNRELEASED = /\s*[[(]\s*unreleased\s*\*?\s*[\])]\s*/gi;

interface SmtcData {
  is_playing: boolean;
  title?: string;
  artist?: string;
  album?: string;
  position_ms?: number;
  duration_ms?: number;
  source?: string;
  source_id?: string;
  is_live?: boolean;
  ready?: boolean;
  error?: string;
  thumb?: boolean;
}

export class DesktopSource {
  private psProcess: ChildProcess | null = null;
  private latestData: SmtcData | null = null;
  private dataReceivedAt = 0; // performance.now() when latestData was last set
  private ready = false;
  private lineBuffer = '';
  private _stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastStderrMsg = '';
  private errorLineCount = 0;
  // Parsed track for the current key. Used as a template only — getCurrentTrack()
  // never hands this instance out, see the comment there.
  private _cachedTemplate: TrackData | null = null;
  private _cachedTrackKey = ''; // Use track key instead of object reference

  start(): void {
    if (process.platform !== 'win32') {
      log.warn('SMTC is only available on Windows');
      return;
    }

    const IS_PKG = !!(process as unknown as { pkg?: unknown }).pkg;
    const scriptDir = IS_PKG
      ? path.dirname(process.execPath)
      : path.dirname(fileURLToPath(import.meta.url));
    const scriptPath = path.join(scriptDir, 'smtc-reader.ps1');

    log.info('Starting SMTC reader...');

    // Use powershell.exe (5.1) directly — pwsh 7.x cannot access WinRT SMTC sessions.
    // The PS1 script sets [Console]::OutputEncoding = UTF8 internally.
    this.psProcess = spawn(getPowerShellExe(), [
      '-NoProfile',
      '-InputFormat', 'None',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.psProcess.stdout!.on('data', (chunk: Buffer) => {
      this.lineBuffer += chunk.toString('utf8');
      const lines = this.lineBuffer.split('\n');
      this.lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const data = JSON.parse(trimmed) as SmtcData;
          if (data.ready) {
            this.ready = true;
            // Seed the watchdog clock — the reader is alive from here on.
            this.dataReceivedAt = performance.now();
            log.info('SMTC reader ready');
            continue;
          }
          if (data.error) {
            // A transient WinRT failure is not "nothing is playing". Keep the last
            // known state and leave dataReceivedAt alone, so a persistent failure
            // ages out through the staleness check instead of flapping the presence.
            this.errorLineCount++;
            if (this.errorLineCount === 1 || this.errorLineCount % 50 === 0) {
              log.warn(`SMTC reader error: ${data.error} (x${this.errorLineCount})`);
            }
            continue;
          }
          this.errorLineCount = 0;
          this.latestData = data;
          this.dataReceivedAt = performance.now();
        } catch (e) {
          // Limit error logging to prevent console spam
          if (Math.random() < 0.01) { // Log ~1% of parse errors
            log.debug(`SMTC parse error: ${trimmed.slice(0, 100)} - ${(e as Error).message}`);
          }
        }
      }
    });

    this.psProcess.stderr!.on('data', (chunk: Buffer) => {
      const msg = chunk.toString('utf-8').trim();
      if (msg && msg !== this.lastStderrMsg) {
        this.lastStderrMsg = msg;
        log.debug(`SMTC stderr: ${msg.slice(0, 200)}`);
      }
    });

    this.startWatchdog();

    this.psProcess.on('exit', (code) => {
      log.warn(`SMTC reader exited (code=${code})`);
      this.ready = false;
      this.psProcess = null;
      this.stopWatchdog();
      // Don't serve the last known track across a restart gap.
      this.latestData = null;
      // Auto-restart after 3s if not intentionally stopped
      if (!this._stopped) {
        log.info('SMTC reader will auto-restart in 3s...');
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          log.info('SMTC reader restarting...');
          this.start();
        }, 3000);
      }
    });
  }

  /**
   * Restart the reader if it stops emitting entirely.
   * The PowerShell side bounds every WinRT await and re-acquires a stale session
   * manager on its own, but a wedged process can't fix itself — only a respawn can.
   */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (!this.psProcess || !this.ready) return;
      const silentMs = performance.now() - this.dataReceivedAt;
      if (silentMs < HANG_RESTART_MS) return;
      log.warn(`SMTC reader silent for ${Math.round(silentMs)}ms — restarting`);
      this.ready = false; // Prevents a second kill before 'exit' fires
      this.latestData = null;
      try { this.psProcess.kill(); } catch { /* already gone */ }
    }, WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** Get the current track from the latest SMTC poll. */
  getCurrentTrack(): TrackData | null {
    const d = this.latestData;
    if (!d || !d.is_playing || !d.title) return null;

    // Staleness guard: the reader emits every ~400ms whether or not anything plays.
    // Silence means it died or wedged, and serving the last track from here would
    // freeze the presence on a phantom song while interpolating its position.
    if (performance.now() - this.dataReceivedAt > STALE_DATA_MS) return null;

    // Build track key for cache comparison
    const trackKey = `${d.source}:${d.title}:${d.artist}`;

    // Fast path: same track → reuse the parsed template (skips title parsing/regexes)
    if (trackKey === this._cachedTrackKey && this._cachedTemplate) {
      return this.snapshot(this._cachedTemplate, d);
    }

    // Ignore Windows Media Player / video players — not a music streaming source
    if (d.source === 'wmp' || d.source === 'groove') return null;
    if (d.source === 'unknown' && d.source_id) {
      log.debug(`SMTC unknown source: ${d.source_id}`);
    }

    let trackName = d.title;
    let artistName = d.artist || 'Unknown';
    const albumName = d.album || '';
    let source = d.source || 'spotify';

    // For browser sources (Chrome, Firefox, Edge, Brave, Opera), detect specific web service & extract artist
    if (source.startsWith('browser_') || source === 'unknown') {
      const detected = detectWebService(d);
      if (detected) source = detected;

      // Spotify/Apple Music Web Player: metadata is already clean — skip mangling
      if (source === 'spotify' || source === 'apple_music') {
        // No title parsing or cleaning needed
      } else if (source === 'soundcloud') {
        // SoundCloud: SMTC artist is often the uploader profile, not the real artist.
        // Try to extract the real artist from the title ("Artist - Track", "Artist // Track", etc.)
        [trackName, artistName] = parseSoundCloudTitle(trackName, artistName);
        trackName = cleanMediaTitle(trackName);
        artistName = cleanMediaTitle(artistName);
        artistName = artistName.replace(RE_TOPIC_SUFFIX, '').trim();
      } else {
        [trackName, artistName] = parseBrowserTitle(trackName, artistName);
        trackName = cleanMediaTitle(trackName);
        artistName = cleanMediaTitle(artistName);
        artistName = artistName.replace(RE_TOPIC_SUFFIX, '').trim();
      }
    }

    const template: TrackData = {
      track_id: `desktop:${trackName}:${artistName}`,
      track_name: trackName,
      artist_name: artistName,
      album_name: albumName,
      duration_ms: d.is_live ? 0 : (d.duration_ms || 240_000),
      progress_ms: 0,      // Filled in per snapshot
      is_playing: true,
      is_live: d.is_live ?? false,
      album_art_url: '',   // Filled in per snapshot
      spotify_url: '',
      artist_url: '',
      media_source: source,
      is_local: source === 'apple_music' && !d.source_id?.includes('music.apple'),  // Apple Music local files don't have music.apple URLs
      _received_at: 0,     // Filled in per snapshot
    };
    this._cachedTrackKey = trackKey;
    this._cachedTemplate = template;
    return this.snapshot(template, d);
  }

  /**
   * Build the TrackData handed to callers: a fresh object every time.
   *
   * Callers keep the returned reference and mutate it — the backend stores it as
   * `currentTrack` and stamps the uploaded Catbox art onto it, the lyrics engine
   * keeps it as `trackData`. Returning a shared cached instance made those the same
   * object, with two consequences: the enriched art was overwritten by the local
   * '/api/thumbnail' placeholder on the next poll (so the cover vanished from Discord
   * a few seconds in), and the engine's `prev.album_art_url !== next.album_art_url`
   * check compared an object with itself and could never fire.
   *
   * Only the placeholder is decided here. Whether real art exists is the backend's
   * call, and nothing in this snapshot may downgrade what it already resolved.
   */
  private snapshot(template: TrackData, d: SmtcData): TrackData {
    // local-art.ts may have written the file after SMTC reported no thumbnail
    const hasThumb = d.thumb || existsSync(THUMB_PATH);
    const rawPos = d.is_live ? 0 : this.getCompensatedPosition(d);
    const durMs = template.duration_ms;
    return {
      ...template,
      // Clamp position to duration (SMTC browser data can overshoot)
      progress_ms: durMs > 0 ? Math.min(rawPos, durMs) : rawPos,
      album_art_url: hasThumb ? '/api/thumbnail' : '',  // else enriched by provider
      _received_at: performance.now(),
    };
  }

  /**
   * Get the current playback position from SMTC data.
   * The PowerShell script already compensates for SMTC snapshot delay
   * (adds time elapsed since LastUpdatedTime), so we only need to account
   * for the small gap between the PS poll and when we read the data.
   * The PS process polls every 400ms, so this gap is minimal.
   */
  private getCompensatedPosition(d: SmtcData): number {
    const rawPos = d.position_ms ?? 0;
    const dur = d.duration_ms ?? 240_000;
    if (this.dataReceivedAt <= 0) return rawPos;
    const elapsed = performance.now() - this.dataReceivedAt;
    // Only compensate for very recent data (PS polls every 400ms)
    // Anything older than 800ms means PS is lagging — use raw position
    if (elapsed < 0 || elapsed > 800) return rawPos;
    return Math.min(Math.round(rawPos + elapsed), dur);
  }

  get isReady(): boolean {
    return this.ready;
  }

  stop(): void {
    this._stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopWatchdog();
    if (this.psProcess) {
      this.psProcess.kill();
      this.psProcess = null;
    }
    this.ready = false;
    this.latestData = null;
  }
}

// ── Web service detection from SMTC metadata ──

function detectWebService(d: SmtcData): string | null {
  // Combine all metadata fields for keyword detection
  const haystack = `${d.title ?? ''}\0${d.artist ?? ''}\0${d.album ?? ''}\0${d.source_id ?? ''}`.toLowerCase();
  if (haystack.includes('soundcloud')) return 'soundcloud';
  if (haystack.includes('bandcamp')) return 'bandcamp';
  if (haystack.includes('deezer')) return 'deezer';
  if (haystack.includes('tidal')) return 'tidal';
  if (haystack.includes('apple music') || haystack.includes('music.apple')) return 'apple_music';
  // Spotify detection BEFORE YouTube (avoids YouTube false positives for Spotify Web Player)
  if (haystack.includes('spotify')) return 'spotify';
  if (haystack.includes('youtube music')) return 'youtube_music';
  if (haystack.includes('youtube')) return 'youtube';

  // Heuristic: Spotify Web Player provides clean metadata with album name.
  // YouTube typically: no album, title contains " - " separator, or video-like patterns.
  const title = d.title ?? '';
  const album = d.album ?? '';
  const hasAlbum = album.length > 0;
  const hasYtPattern = /\((official|music)\s*(video|audio|mv|lyrics?)\)|\[(official|music)\s*(video|audio|mv|lyrics?)\]|\bMV\b|\blyric video\b/i.test(title);
  // Spotify Web Player: has album, no YouTube-like patterns, proper artist separation
  if (hasAlbum && !hasYtPattern && !title.includes(' - ')) {
    return 'spotify';
  }
  return null;
}

// ── Title parsing helpers ──

/**
 * SoundCloud-specific title parsing.
 * SMTC artist from SoundCloud is usually the uploader/profile name, not the real artist.
 * The real artist is often embedded in the title:
 *   "Drake - Gods Plan"
 *   "Juice WRLD // Lucid Dreams"
 *   "Lil Uzi Vert – XO Tour Llif3"
 *   "artist x artist2 - track"
 *   "track" (no separator — fall back to SMTC artist)
 */
const SC_SEPARATORS = [' - ', ' – ', ' — ', ' // ', ' | '];
const RE_SC_PROD = /\s*[\[(](?:prod\.?|produced\s+by)\s*.+[\])]\s*$/i;

function parseSoundCloudTitle(title: string, smtcArtist: string): [track: string, artist: string] {
  // Strip producer tags first: "Artist - Track (prod. X)" → "Artist - Track"
  let cleaned = title.replace(RE_SC_PROD, '').trim();

  for (const sep of SC_SEPARATORS) {
    const idx = cleaned.indexOf(sep);
    if (idx > 0) {
      const left = cleaned.slice(0, idx).trim();
      const right = cleaned.slice(idx + sep.length).trim();
      if (left && right) {
        // Convention: "Artist - Track" (artist on left)
        return [right, left];
      }
    }
  }

  // No separator found — use SMTC artist as-is (best we have)
  return [cleaned || title, smtcArtist.replace(RE_TOPIC_SUFFIX, '').trim()];
}

function parseBrowserTitle(title: string, smtcArtist: string): [track: string, artist: string] {
  for (const sep of [' - ', ' – ', ' — ', ' | ']) {
    const idx = title.indexOf(sep);
    if (idx > 0) {
      const left = title.slice(0, idx).trim();
      const right = title.slice(idx + sep.length).trim();
      if (left && right) {
        // Artist is almost always on the left in YouTube titles
        return [right, left];
      }
    }
  }
  return [title, smtcArtist.replace(RE_TOPIC_SUFFIX, '').trim()];
}

function cleanMediaTitle(title: string): string {
  let cleaned = title.replace(/\s*\/\/\s*/g, ' - ').trim();
  cleaned = cleaned.replace(RE_UNRELEASED, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const result = cleaned.replace(RE_VIDEO_SUFFIX, '').replace(/[\s\-–—|]+$/, '');
    if (result === cleaned) break;
    cleaned = result;
  }
  return cleaned || title;
}
