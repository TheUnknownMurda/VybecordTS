/**
 * Desktop media source — reads Windows SMTC via a long-running PowerShell process.
 * Works WITHOUT Spotify Premium. Detects any media session (Spotify, YouTube, etc.)
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';
import type { TrackData } from './types.js';

const log = createLogger('DesktopSource');

// Prefer pwsh.exe (PS 7.x — 2-3x faster startup/runtime) with fallback to powershell.exe (5.1)
let _psExe: string | null = null;
function getPowerShellExe(): string {
  if (_psExe) return _psExe;
  try {
    execFileSync('pwsh.exe', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true, stdio: 'ignore', timeout: 3000 });
    _psExe = 'pwsh.exe';
    log.info('Using pwsh.exe (PowerShell 7.x) for SMTC reader');
  } catch {
    _psExe = 'powershell.exe';
    log.info('pwsh.exe not found — falling back to powershell.exe (5.1)');
  }
  return _psExe;
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
  private onTrack?: (track: TrackData | null) => void;
  private lastStderrMsg = '';
  // Cached getCurrentTrack result — avoids re-creating an identical object every 400ms
  private _cachedTrack: TrackData | null = null;
  private _cachedDataRef: SmtcData | null = null; // reference equality check

  constructor(onTrack?: (track: TrackData | null) => void) {
    this.onTrack = onTrack;
  }

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

    this.psProcess = spawn(getPowerShellExe(), [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.psProcess.stdout!.on('data', (chunk: Buffer) => {
      this.lineBuffer += chunk.toString('utf-8');
      const lines = this.lineBuffer.split('\n');
      this.lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const data = JSON.parse(trimmed) as SmtcData;
          if (data.ready) {
            this.ready = true;
            log.info('SMTC reader ready');
            continue;
          }
          this.latestData = data;
          this.dataReceivedAt = performance.now();
        } catch {
          log.debug(`SMTC parse error: ${trimmed.slice(0, 100)}`);
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

    this.psProcess.on('exit', (code) => {
      log.warn(`SMTC reader exited (code=${code})`);
      this.ready = false;
      this.psProcess = null;
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

  /** Get the current track from the latest SMTC poll. */
  getCurrentTrack(): TrackData | null {
    const d = this.latestData;
    if (!d || !d.is_playing || !d.title) return null;

    // Fast path: same SmtcData reference → return cached TrackData (avoids object alloc every 400ms)
    if (d === this._cachedDataRef && this._cachedTrack) {
      // Update only the progress field (it's interpolated from performance.now())
      const rawPos = d.is_live ? 0 : this.getCompensatedPosition(d);
      const durMs = this._cachedTrack.duration_ms;
      this._cachedTrack.progress_ms = durMs > 0 ? Math.min(rawPos, durMs) : rawPos;
      this._cachedTrack._received_at = performance.now();
      return this._cachedTrack;
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

      // Spotify Web Player: metadata is already clean (proper title, artist, album) — skip mangling
      if (source === 'spotify') {
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

    const durMs = d.is_live ? 0 : (d.duration_ms || 240_000);
    const rawPos = d.is_live ? 0 : this.getCompensatedPosition(d);
    // Clamp position to duration (SMTC browser data can overshoot)
    const posMs = durMs > 0 ? Math.min(rawPos, durMs) : rawPos;

    const track: TrackData = {
      track_id: `desktop:${trackName}:${artistName}`,
      track_name: trackName,
      artist_name: artistName,
      album_name: albumName,
      duration_ms: durMs,
      progress_ms: posMs,
      is_playing: true,
      is_live: d.is_live ?? false,
      album_art_url: d.thumb ? '/api/thumbnail' : '',  // Use SMTC thumbnail if available, else enriched by provider
      spotify_url: '',
      artist_url: '',
      media_source: source,
      _received_at: performance.now(),
    };
    this._cachedDataRef = d;
    this._cachedTrack = track;
    return track;
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
    if (this.psProcess) {
      this.psProcess.kill();
      this.psProcess = null;
    }
    this.ready = false;
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
