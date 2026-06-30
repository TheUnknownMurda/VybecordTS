/**
 * Multi-provider lyrics engine — 4-phase lookup for maximum speed + coverage.
 *
 * Phase 0:   Local LRCLib SQLite (~1ms) — instant, offline
 * Phase 1:   Promise.any([LRCLib API direct, Netease Cloud Music, Musixmatch]) (~200-300ms)
 * Phase 1.5: Last.fm autocorrect → retry Phase 0+1 with corrected names (~300-500ms)
 * Phase 2:   LRCLib fuzzy search + scoring (~400-800ms fallback)
 *
 * Album art: Last.fm → Deezer → iTunes (with corrected query variants)
 */

import { createLogger } from './logger.js';
import { parseLrc } from './lrc-parser.js';
import { similarity, batchScore } from './similarity.js';
import { hasLocalDb, searchLocalDb } from './local-lyrics-db.js';
import { hasLastFm, getCorrection } from './lastfm.js';
import type { LyricLine, LrcLibResult } from './types.js';

const log = createLogger('Provider');

const LRCLIB_BASE = 'https://lrclib.net';
const USER_AGENT = 'VybecordTS v1.0.0 (by TheUnknownMurda)';
const FETCH_TIMEOUT = 8_000;

// ── Regex for cleaning search queries ──
const RE_VERSION_SUFFIX = /\s*[-–]\s*(Long Version|Extended Version|Extended|Radio Edit|Radio|Remastered|Deluxe|Deluxe Edition|Bonus Track|Acoustic|Live|Demo|Instrumental|Clean|Explicit|Edit|Mix|Remix|Version|Slowed|Sped Up|Reverb|Nightcore|Daycore|Bass Boosted|8D Audio|Lo-?fi)\s*$/i;
const RE_BRACKET_TAG = /\s*[(\[](slowed|sped up|reverb|slowed \+ reverb|nightcore|daycore|bass boosted|8d(?: audio)?|lo-?fi|remix|acoustic|live|official audio|official video|official music video|music video|lyric video|official lyric video|official visualizer|visualizer|lyrics|with lyrics|audio|mv|m\/v|4k|hd|hq|clean|explicit|prod\.?\s+[^)\]]*|ft\.?\s+[^)\]]*)[)\]]/gi;
const RE_ARTIST_SPLIT = /[,&]/;
const RE_TOPIC_SUFFIX = /\s*-\s*Topic\s*$/i;
const RE_UNRELEASED = /\s*[[(]\s*unreleased\s*\*?\s*[\])\]]\s*/gi;
const RE_FEAT = /\s*\(?\s*feat\.?\s.*$/i;

// SoundCloud / web noise patterns (also used by cleanForArtSearch below)
const RE_SC_TAGS = /\s*[\[({]\s*(?:free\s*(?:dl|download)?|exclusive|premiere|leak(?:ed)?|unreleas(?:ed)?|snippet|preview|repost|type\s+beat|instrumental|bonus|deluxe|slowed\s*\+?\s*reverb|sped\s+up|chopped\s+(?:and|&|n)\s+screwed|bass\s+boosted|8d\s*audio|lo-?fi|remix|bootleg|flip|edit|cover|reprod|remake)\s*[\])}]/gi;
const RE_HASHTAGS = /#\w+/g;
const RE_EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}]/gu;
const RE_TYPE_BEAT = /\s*(?:type\s+beat|type\s+instrumental).*$/i;
const RE_PROD_TAG = /\s*[\[(]?(?:prod\.?|produced\s+by)\s+[^\])]*[\])]?/gi;

function cleanForSearch(name: string, artist: string): [cleanName: string, primaryArtist: string] {
  let clean = name.split('(feat')[0].split('feat.')[0].split('- Original mix')[0].split('Original mix')[0].trim();
  clean = clean.replace(RE_UNRELEASED, ' ').trim();
  // Strip SoundCloud / web noise (safe for all sources — these never appear in LRCLib)
  clean = clean.replace(RE_SC_TAGS, ' ').trim();
  clean = clean.replace(RE_PROD_TAG, ' ').trim();
  clean = clean.replace(RE_TYPE_BEAT, '').trim();
  clean = clean.replace(RE_HASHTAGS, ' ').trim();
  clean = clean.replace(RE_EMOJI, ' ').trim();
  clean = clean.replace(RE_BRACKET_TAG, '').trim();
  clean = clean.replace(RE_VERSION_SUFFIX, '').trim();
  clean = clean.replace(RE_FEAT, '').trim();
  // Collapse multiple spaces/dashes left after stripping
  clean = clean.replace(/\s{2,}/g, ' ').replace(/[-–—]+\s*$/, '').trim();
  const primaryArtist = artist.split(RE_ARTIST_SPLIT)[0].replace(RE_TOPIC_SUFFIX, '').replace(RE_EMOJI, '').trim();
  return [clean, primaryArtist];
}

async function fetchJson<T>(url: string, externalSignal?: AbortSignal): Promise<T | null> {
  try {
    // Combine external abort signal with timeout
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT);
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, timeoutSignal])
      : timeoutSignal;
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal,
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

// ── Direct lookup (fast path) ──

interface DirectParams {
  track_name: string;
  artist_name: string;
  album_name?: string;
  duration?: number;
}

async function directLookup(params: DirectParams, signal?: AbortSignal): Promise<LrcLibResult | null> {
  const qs = new URLSearchParams();
  qs.set('track_name', params.track_name);
  qs.set('artist_name', params.artist_name);
  if (params.album_name) qs.set('album_name', params.album_name);
  if (params.duration != null) qs.set('duration', String(params.duration));
  return fetchJson<LrcLibResult>(`${LRCLIB_BASE}/api/get?${qs}`, signal);
}

async function searchLrcLib(query: string, signal?: AbortSignal): Promise<LrcLibResult[]> {
  const qs = new URLSearchParams({ q: query });
  return (await fetchJson<LrcLibResult[]>(`${LRCLIB_BASE}/api/search?${qs}`, signal)) ?? [];
}

// ── Netease Cloud Music provider ──

const NETEASE_BASE = 'https://music.163.com';
const NETEASE_TIMEOUT = 6_000;

interface NeteaseSearchResult {
  result?: {
    songs?: { id: number; name: string; artists: { name: string }[]; duration: number }[];
  };
}

interface NeteaseLyricResult {
  lrc?: { lyric?: string };
}

async function searchNetease(
  track: string,
  artist: string,
  durationSec: number | undefined,
  signal?: AbortSignal,
): Promise<LyricLine[] | null> {
  const query = `${track} ${artist}`;
  try {
    const timeoutSignal = AbortSignal.timeout(NETEASE_TIMEOUT);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    // Step 1: Search for the song
    const searchResp = await fetch(`${NETEASE_BASE}/api/search/get/web`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': NETEASE_BASE,
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({
        s: query,
        type: '1',
        offset: '0',
        limit: '5',
      }),
      signal: combinedSignal,
    });
    if (!searchResp.ok) return null;
    const searchData = (await searchResp.json()) as NeteaseSearchResult;
    const songs = searchData.result?.songs;
    if (!songs?.length) return null;

    // Filter by artist similarity first — reject songs from completely different artists
    const artistLow = artist.toLowerCase();
    const artistFiltered = songs.filter(s => {
      const candArtist = (s.artists?.[0]?.name ?? '').toLowerCase();
      return similarity(artistLow, candArtist) >= 0.50;
    });
    const pool = artistFiltered.length > 0 ? artistFiltered : songs;

    // Pick best match: prefer duration-close songs
    let bestSong = pool[0];
    if (durationSec != null) {
      for (const s of pool) {
        const sDur = Math.round(s.duration / 1000);
        const bestDur = Math.round(bestSong.duration / 1000);
        if (Math.abs(sDur - durationSec) < Math.abs(bestDur - durationSec)) {
          bestSong = s;
        }
      }
      // Reject if best match is >20s off
      const diff = Math.abs(Math.round(bestSong.duration / 1000) - durationSec);
      if (diff > 20) {
        log.debug(`[NETEASE] Duration mismatch (${diff}s) — skipping`);
        return null;
      }
    }

    // Final artist check on selected song
    const bestArtist = (bestSong.artists?.[0]?.name ?? '').toLowerCase();
    if (similarity(artistLow, bestArtist) < 0.40) {
      log.debug(`[NETEASE] Artist mismatch: "${bestSong.artists?.[0]?.name}" vs "${artist}" — skipping`);
      return null;
    }

    // Step 2: Fetch lyrics by song ID
    const lyricResp = await fetch(
      `${NETEASE_BASE}/api/song/lyric?os=osx&id=${bestSong.id}&lv=-1&kv=-1&tv=-1`,
      {
        headers: { 'Referer': NETEASE_BASE, 'User-Agent': USER_AGENT },
        signal: combinedSignal,
      },
    );
    if (!lyricResp.ok) return null;
    const lyricData = (await lyricResp.json()) as NeteaseLyricResult;
    const lrcText = lyricData.lrc?.lyric;
    if (!lrcText || lrcText.length < 100) return null;

    // Verify it has actual timestamps (not just metadata tags like [ti:], [ar:])
    if (!/\[\d{2}:\d{2}/.test(lrcText)) return null;

    const lines = parseLrc(lrcText);
    if (lines.length < 5) return null; // Too few lines = likely metadata only

    log.info(`[NETEASE] Found ${lines.length} lines for "${bestSong.name}" (id=${bestSong.id})`);
    return lines;
  } catch {
    return null;
  }
}

// ── Musixmatch provider ──

const MUSIXMATCH_BASE = 'https://apic-desktop.musixmatch.com/ws/1.1';
const MUSIXMATCH_TIMEOUT = 6_000;
let musixmatchToken: string | null = null;
let musixmatchTokenExpiry = 0;
let _mxmTokenInflight: Promise<string | null> | null = null;

/** Acquire a temporary Musixmatch guest token (valid ~10 min). */
async function getMusixmatchToken(signal?: AbortSignal): Promise<string | null> {
  if (musixmatchToken && Date.now() < musixmatchTokenExpiry) return musixmatchToken;
  if (_mxmTokenInflight) return _mxmTokenInflight;
  _mxmTokenInflight = _fetchMusixmatchToken(signal).finally(() => { _mxmTokenInflight = null; });
  return _mxmTokenInflight;
}

async function _fetchMusixmatchToken(signal?: AbortSignal): Promise<string | null> {
  try {
    const timeoutSignal = AbortSignal.timeout(MUSIXMATCH_TIMEOUT);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const resp = await fetch(
      `${MUSIXMATCH_BASE}/token.get?app_id=web-desktop-app-v1.0`,
      {
        headers: { 'User-Agent': USER_AGENT, 'Cookie': 'x-mxm-token-guid=' },
        signal: combinedSignal,
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      message?: { body?: { user_token?: string }; header?: { status_code?: number } };
    };
    if (data.message?.header?.status_code !== 200) return null;
    const token = data.message?.body?.user_token;
    if (!token || token === 'MusixmatchUsertoken') return null;
    musixmatchToken = token;
    musixmatchTokenExpiry = Date.now() + 600_000; // 10 min
    return token;
  } catch {
    return null;
  }
}

/** Search Musixmatch for synced lyrics. */
async function searchMusixmatch(
  track: string,
  artist: string,
  durationSec: number | undefined,
  signal?: AbortSignal,
): Promise<LyricLine[] | null> {
  const token = await getMusixmatchToken(signal);
  if (!token) return null;

  try {
    const timeoutSignal = AbortSignal.timeout(MUSIXMATCH_TIMEOUT);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    // Step 1: Search for the track
    const searchParams = new URLSearchParams({
      app_id: 'web-desktop-app-v1.0',
      usertoken: token,
      q_track: track,
      q_artist: artist,
      page_size: '5',
      page: '1',
      s_track_rating: 'desc',
      f_has_subtitle: '1', // Only tracks with synced lyrics
    });

    const searchResp = await fetch(`${MUSIXMATCH_BASE}/track.search?${searchParams}`, {
      headers: { 'User-Agent': USER_AGENT, 'Cookie': 'x-mxm-token-guid=' },
      signal: combinedSignal,
    });
    if (!searchResp.ok) return null;

    const searchData = (await searchResp.json()) as {
      message?: {
        header?: { status_code?: number };
        body?: {
          track_list?: { track: {
            track_id: number;
            track_name: string;
            artist_name: string;
            track_length: number;
            has_subtitles: number;
          } }[];
        };
      };
    };
    if (searchData.message?.header?.status_code !== 200) return null;
    const tracks = searchData.message?.body?.track_list;
    if (!tracks?.length) return null;

    // Pick best match by duration
    const artistLow = artist.toLowerCase();
    let best = tracks[0].track;
    for (const { track: t } of tracks) {
      const candArtist = t.artist_name.toLowerCase();
      if (similarity(artistLow, candArtist) < 0.40) continue;
      if (durationSec != null) {
        const tDur = Math.round(t.track_length);
        const bDur = Math.round(best.track_length);
        if (Math.abs(tDur - durationSec) < Math.abs(bDur - durationSec)) {
          best = t;
        }
      } else {
        best = t;
        break;
      }
    }

    // Reject if duration is way off
    if (durationSec != null && Math.abs(Math.round(best.track_length) - durationSec) > 20) {
      return null;
    }

    if (!best.has_subtitles) return null;

    // Step 2: Fetch subtitles (synced lyrics)
    const subParams = new URLSearchParams({
      app_id: 'web-desktop-app-v1.0',
      usertoken: token,
      track_id: String(best.track_id),
      subtitle_format: 'lrc',
      f_subtitle_length_max_deviation: '1',
    });

    const subResp = await fetch(`${MUSIXMATCH_BASE}/track.subtitle.get?${subParams}`, {
      headers: { 'User-Agent': USER_AGENT, 'Cookie': 'x-mxm-token-guid=' },
      signal: combinedSignal,
    });
    if (!subResp.ok) return null;

    const subData = (await subResp.json()) as {
      message?: {
        header?: { status_code?: number };
        body?: { subtitle?: { subtitle_body?: string } };
      };
    };
    if (subData.message?.header?.status_code !== 200) return null;
    const lrcText = subData.message?.body?.subtitle?.subtitle_body;
    if (!lrcText || lrcText.length < 50) return null;

    // Verify timestamps
    if (!/\[\d{2}:\d{2}/.test(lrcText)) return null;

    const lines = parseLrc(lrcText);
    if (lines.length < 5) return null;

    log.info(`[MUSIXMATCH] Found ${lines.length} synced lines for "${best.track_name}" (id=${best.track_id})`);
    return lines;
  } catch {
    return null;
  }
}

// ── Public API ──

/**
 * Fetch synced lyrics for a track.
 * Strategy: Local DB → Parallel race (LRCLib | Netease | Musixmatch) → Last.fm corrected retry → Fuzzy fallback
 * Returns parsed LyricLine[] or empty array.
 */
export async function fetchLyrics(
  name: string,
  artist: string,
  album: string,
  durationMs: number,
  signal?: AbortSignal,
): Promise<LyricLine[]> {
  const [cleanName, primaryArtist] = cleanForSearch(name, artist);
  const durationSec = durationMs > 0 ? Math.round(durationMs / 1000) : undefined;
  // Clean album name too (strip Deluxe Edition, Remastered, etc.)
  let albumClean = album.replace(RE_UNRELEASED, ' ').trim();
  albumClean = albumClean.replace(RE_BRACKET_TAG, '').trim();
  albumClean = albumClean.replace(RE_VERSION_SUFFIX, '').trim();

  // Global timeout to prevent indefinite hanging (20s max total)
  const globalTimeout = AbortSignal.timeout(20_000);
  const combinedSignal = signal ? AbortSignal.any([signal, globalTimeout]) : globalTimeout;

  // ── PHASE 0: LOCAL DB (~1ms) ──
  if (hasLocalDb()) {
    const localResult = searchLocalDb(cleanName, primaryArtist, durationSec)
      ?? searchLocalDb(name, primaryArtist, durationSec)
      ?? (artist !== primaryArtist ? searchLocalDb(cleanName, artist, durationSec) : null)
      ?? (artist !== primaryArtist ? searchLocalDb(name, artist, durationSec) : null);
    if (localResult) {
      log.info(`[LYRICS] Local DB hit (${localResult.length} lines)`);
      return localResult;
    }
  }

  // ── PHASE 1: PARALLEL RACE — LRCLib direct | Netease ──
  // First valid result wins. This cuts latency from sequential ~600ms to ~200-300ms.
  // Child abort: cancel the loser when winner arrives (save bandwidth)
  const phase1Start = Date.now();
  const raceAbort = new AbortController();
  const raceSignal = combinedSignal ? AbortSignal.any([combinedSignal, raceAbort.signal]) : raceAbort.signal;

  const racers: Promise<{ source: string; lines: LyricLine[] }>[] = [];

  // Racer 1: LRCLib direct lookup (usually fastest for exact matches)
  racers.push(
    tryDirectLookup(name, cleanName, artist, primaryArtist, albumClean, durationSec, combinedSignal)
      .then(lines => {
        if (!lines) throw new Error('no result');
        return { source: 'LRCLib-direct', lines };
      }),
  );

  // Racer 2: Netease Cloud Music (huge catalogue, often has what LRCLib doesn't)
  racers.push(
    searchNetease(cleanName, primaryArtist, durationSec, combinedSignal)
      .then(lines => {
        if (!lines) throw new Error('no result');
        return { source: 'Netease', lines };
      }),
  );

  // Racer 3: Musixmatch (largest synced lyrics database — guest token, no API key needed)
  racers.push(
    searchMusixmatch(cleanName, primaryArtist, durationSec, combinedSignal)
      .then(lines => {
        if (!lines) throw new Error('no result');
        return { source: 'Musixmatch', lines };
      }),
  );

  try {
    const winner = await Promise.any(racers);
    raceAbort.abort(); // Cancel the loser
    const phase1Duration = Date.now() - phase1Start;
    log.info(`[LYRICS] ${winner.source} won race (${winner.lines.length} lines) in ${phase1Duration}ms`);
    return winner.lines;
  } catch {
    // All racers failed — fall through
    const phase1Duration = Date.now() - phase1Start;
    log.info(`[LYRICS] Phase 1 failed after ${phase1Duration}ms (all racers timed out)`);
  } finally {
    raceAbort.abort(); // Ensure cleanup
  }

  // ── PHASE 1.5: LAST.FM AUTOCORRECT RETRY ──
  // If raw names failed, ask Last.fm to fix misspellings and retry
  const phase15Start = Date.now();
  if (hasLastFm()) {
    const correction = await getCorrection(cleanName, primaryArtist, combinedSignal);
    if (correction) {
      const cTrack = correction.track;
      const cArtist = correction.artist;
      const cAlbum = correction.album || albumClean;
      const cDur = correction.durationMs && correction.durationMs > 0
        ? Math.round(correction.durationMs / 1000)
        : durationSec;

      // Only retry if Last.fm actually changed something
      const changed = cTrack.toLowerCase() !== cleanName.toLowerCase()
        || cArtist.toLowerCase() !== primaryArtist.toLowerCase();

      if (changed) {
        // Try local DB with corrected names first
        if (hasLocalDb()) {
          const localCorrected = searchLocalDb(cTrack, cArtist, cDur);
          if (localCorrected) {
            log.info(`[LYRICS] Local DB hit after Last.fm correction (${localCorrected.length} lines)`);
            return localCorrected;
          }
        }

        // Parallel race with corrected names
        const corrAbort = new AbortController();
        const corrSignal = combinedSignal ? AbortSignal.any([combinedSignal, corrAbort.signal]) : corrAbort.signal;
        const corrRacers: Promise<{ source: string; lines: LyricLine[] }>[] = [];
        const [corrClean] = cleanForSearch(cTrack, cArtist);
        corrRacers.push(
          tryDirectLookup(cTrack, corrClean, cArtist, cArtist, cAlbum, cDur, combinedSignal)
            .then(lines => {
              if (!lines) throw new Error('no result');
              return { source: 'LRCLib-corrected', lines };
            }),
        );
        corrRacers.push(
          searchNetease(cTrack, cArtist, cDur, combinedSignal)
            .then(lines => {
              if (!lines) throw new Error('no result');
              return { source: 'Netease-corrected', lines };
            }),
        );
        corrRacers.push(
          searchMusixmatch(cTrack, cArtist, cDur, combinedSignal)
            .then(lines => {
              if (!lines) throw new Error('no result');
              return { source: 'Musixmatch-corrected', lines };
            }),
        );
        try {
          const winner = await Promise.any(corrRacers);
          corrAbort.abort();
          const phase15Duration = Date.now() - phase15Start;
          log.info(`[LYRICS] ${winner.source} won race (${winner.lines.length} lines) in ${phase15Duration}ms (Last.fm corrected)`);
          return winner.lines;
        } catch {
          // corrected names also failed
          const phase15Duration = Date.now() - phase15Start;
          log.info(`[LYRICS] Phase 1.5 failed after ${phase15Duration}ms (Last.fm correction failed)`);
        } finally {
          corrAbort.abort();
        }
      }
    }
    const phase15Duration = Date.now() - phase15Start;
    if (phase15Duration > 100) {
      log.info(`[LYRICS] Phase 1.5 skipped after ${phase15Duration}ms (no correction needed)`);
    }
  }

  // ── PHASE 2: FALLBACK — LRCLib fuzzy search + scoring ──
  const phase2Start = Date.now();
  const searchResult = await tryFuzzySearch(name, cleanName, artist, primaryArtist, albumClean, durationSec, combinedSignal);
  const phase2Duration = Date.now() - phase2Start;
  if (searchResult) {
    log.info(`[LYRICS] Fuzzy match (${searchResult.length} lines) in ${phase2Duration}ms`);
    return searchResult;
  }
  log.info(`[LYRICS] Phase 2 failed after ${phase2Duration}ms (no fuzzy match)`);

  log.info('[LYRICS] No lyrics found (all providers exhausted)');
  return [];
}

// Cache last-seen plainLyrics from direct lookups (avoids duplicate HTTP call in fetchPlainLyrics)
let _lastPlainCache: { key: string; plainLyrics: string } | null = null;

async function tryDirectLookup(
  name: string,
  cleanName: string,
  artist: string,
  primaryArtist: string,
  album: string,
  durationSec: number | undefined,
  signal?: AbortSignal,
): Promise<LyricLine[] | null> {
  const names = [...new Set([name, cleanName].map(n => n.trim()).filter(Boolean))];
  const artists = [...new Set([primaryArtist, artist].filter(Boolean))];

  // Build all parameter combos, ordered by specificity (most specific first)
  type Combo = [string | undefined, number | undefined];
  const allCombos: Combo[] = [];
  const seenCombos = new Set<string>();
  for (const combo of [
    [album, durationSec],
    [undefined, durationSec],
    [album, undefined],
    [undefined, undefined],
  ] as Combo[]) {
    const key = `${combo[0] ?? ''}|${combo[1] ?? ''}`;
    if (!seenCombos.has(key)) { seenCombos.add(key); allCombos.push(combo); }
  }

  /** Try a single lookup and validate the result. */
  async function attempt(trackName: string, tryArtist: string, tryAlbum: string | undefined, tryDur: number | undefined): Promise<LyricLine[] | null> {
    const result = await directLookup({
      track_name: trackName,
      artist_name: tryArtist,
      album_name: tryAlbum,
      duration: tryDur,
    }, signal);
    if (!result) return null;
    // Stash plainLyrics for fetchPlainLyrics (avoid duplicate HTTP call)
    if (result.plainLyrics && result.plainLyrics.length >= 20) {
      _lastPlainCache = { key: `${trackName}|${tryArtist}`.toLowerCase(), plainLyrics: result.plainLyrics };
    }
    if (!result.syncedLyrics || result.syncedLyrics.length <= 100) return null;
    // Artist validation — LRCLib may return a different artist for common track names
    const resultArtist = (result.artistName ?? '').toLowerCase();
    const requestArtist = tryArtist.toLowerCase();
    const primaryResult = resultArtist.split(/[,&]/)[0].trim();
    const artistSim = Math.max(
      similarity(requestArtist, resultArtist),
      similarity(requestArtist, primaryResult),
    );
    if (artistSim < 0.50) {
      log.debug(`[LYRICS] Direct hit rejected — artist mismatch (${artistSim.toFixed(2)}): "${result.artistName}" vs "${tryArtist}"`);
      return null;
    }
    // Duration sanity check
    if (durationSec != null && result.duration != null) {
      const diff = Math.abs(durationSec - result.duration);
      if (diff > 30) {
        log.debug(`[LYRICS] Direct hit rejected — duration mismatch (${diff}s): "${result.trackName}"`);
        return null;
      }
    }
    return parseLrc(result.syncedLyrics);
  }

  // ── Tiered parallel: fire combos at the same specificity level in parallel ──
  // Tier 1: most specific combo (album+duration) × all name/artist variants
  // Tier 2: remaining combos (looser) × all name/artist variants
  // Each tier fires all variants simultaneously; first valid result wins (short-circuit).
  for (const combo of allCombos) {
    const promises: Promise<LyricLine[]>[] = [];
    for (const trackName of names) {
      for (const tryArtist of artists) {
        promises.push(
          attempt(trackName, tryArtist, combo[0], combo[1])
            .then(result => {
              if (!result) throw new Error('no result');
              return result;
            })
            .catch((e: unknown) => {
              const msg = String(e).toLowerCase();
              if (msg.includes('timed out') || msg.includes('connect')) {
                log.warn(`[LYRICS] Direct lookup network error: ${e}`);
              }
              throw e; // re-throw so Promise.any skips this racer
            }),
        );
      }
    }

    // First non-null result wins — don't wait for slower variants
    try {
      return await Promise.any(promises);
    } catch {
      // All variants at this tier failed — try next tier
    }
  }

  return null;
}

async function tryFuzzySearch(
  name: string,
  cleanName: string,
  artist: string,
  primaryArtist: string,
  album: string,
  durationSec: number | undefined,
  signal?: AbortSignal,
): Promise<LyricLine[] | null> {
  const queries = [...new Set([
    `${cleanName} ${primaryArtist}`,
    `${name} - ${primaryArtist}`,
    `${cleanName} - ${primaryArtist}`,
    `${primaryArtist} - ${cleanName}`,
    cleanName,
  ])].filter(q => q.length >= 3);

  // Fire all search queries in parallel (much faster than sequential)
  const allResults: LrcLibResult[] = [];
  const seenIds = new Set<number>();

  const settled = await Promise.allSettled(
    queries.map(q => searchLrcLib(q, signal)),
  );
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      for (const r of result.value) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          allResults.push(r);
        }
      }
    }
  }

  if (!allResults.length) return null;

  // Score candidates
  const candidates = allResults.map(r => ({
    trackName: r.trackName ?? '',
    artistName: r.artistName ?? '',
    albumName: r.albumName ?? '',
    duration: r.duration ?? undefined,
  }));

  const scored = batchScore(name, cleanName, artist, album, durationSec ?? null, candidates);

  const MIN_SCORE = 70;
  const MIN_ARTIST_SIM = 0.50;

  for (const s of scored.slice(0, 5)) {
    const cand = allResults[s.index];
    if (!cand.syncedLyrics || cand.syncedLyrics.length <= 100) continue;

    // Artist similarity: check full vs full, primary vs primary, and cross
    const candArtist = cand.artistName ?? '';
    const primaryCand = candArtist.split(RE_ARTIST_SPLIT)[0].trim();
    let artistSim = similarity(artist, candArtist);
    artistSim = Math.max(artistSim, similarity(primaryArtist, primaryCand));
    if (primaryCand !== candArtist) {
      artistSim = Math.max(artistSim, similarity(artist, primaryCand));
    }

    // Duration sanity check: reject candidates with >30s mismatch
    if (durationSec != null && cand.duration != null) {
      const durDiff = Math.abs(durationSec - cand.duration);
      if (durDiff > 30) {
        log.debug(`[LYRICS] Fuzzy rejected — duration mismatch (${durDiff}s): "${cand.trackName}"`);
        continue;
      }
    }

    if (s.score >= MIN_SCORE && artistSim >= MIN_ARTIST_SIM) {
      log.info(`[LYRICS] Accepted: "${cand.trackName}" (score=${s.score.toFixed(1)}, artist_sim=${artistSim.toFixed(2)})`);
      return parseLrc(cand.syncedLyrics);
    }
  }

  return null;
}

// ── Album art: aggressive title cleaning for search ──

// Delegates to cleanForSearch, then strips extra trailing separators (|) for broader art matches
function cleanForArtSearch(name: string, artist: string): [cleanName: string, cleanArtist: string] {
  const [clean, cleanArt] = cleanForSearch(name, artist);
  // Art search also strips trailing pipe separators (YouTube titles: "Song | Artist")
  const artClean = clean.replace(/[-–—|]+\s*$/, '').trim();
  return [artClean || clean, cleanArt];
}

// ── Album art: multi-source search (Deezer → iTunes → cleaned retry) ──

interface DeezerTrack {
  id: number;
  title: string;
  artist: { name: string; link?: string };
  album: { title: string; cover_xl?: string; cover_big?: string };
  link?: string;
}

interface DeezerTrackDetail {
  contributors?: { name: string }[];
}

interface ITunesResult {
  artworkUrl100?: string;
  collectionName?: string;
  artistName?: string;
}

type MetadataResult = { albumArtUrl?: string; albumName?: string; artistName?: string; spotifyUrl?: string; artistUrl?: string };

async function searchDeezer(
  query: string,
  expectedTrack: string,
  expectedArtist: string,
  signal?: AbortSignal,
): Promise<MetadataResult> {
  const q = encodeURIComponent(query);
  const data = await fetchJson<{ data?: DeezerTrack[] }>(
    `https://api.deezer.com/search?q=${q}&limit=5`,
    signal,
  );
  if (!data?.data?.length) return {};

  // Score results — pick the one that best matches expected track + artist
  const expTrackLow = expectedTrack.toLowerCase();
  const expArtistLow = expectedArtist.toLowerCase();
  let bestHit: DeezerTrack | null = null;
  let bestScore = -1;

  for (const hit of data.data) {
    const trackSim = similarity(expTrackLow, hit.title.toLowerCase());
    const artistSim = similarity(expArtistLow, hit.artist.name.toLowerCase());
    // Reject if artist is completely wrong (< 0.40)
    if (artistSim < 0.40) continue;
    const score = trackSim * 0.5 + artistSim * 0.5;
    if (score > bestScore) {
      bestScore = score;
      bestHit = hit;
    }
  }

  if (!bestHit) return {};

  // Fetch full track details to get ALL artists (contributors)
  let fullArtist = bestHit.artist.name;
  try {
    const detail = await fetchJson<DeezerTrackDetail>(
      `https://api.deezer.com/track/${bestHit.id}`,
      signal,
    );
    if (detail?.contributors?.length) {
      fullArtist = detail.contributors.map(c => c.name).join(', ');
    }
  } catch { /* contributors fetch is best-effort */ }

  return {
    albumArtUrl: bestHit.album.cover_xl ?? bestHit.album.cover_big,
    albumName: bestHit.album.title,
    artistName: fullArtist,
    artistUrl: bestHit.artist.link,
  };
}

async function searchITunes(
  query: string,
  expectedTrack: string,
  expectedArtist: string,
  signal?: AbortSignal,
): Promise<MetadataResult> {
  const q = encodeURIComponent(query);
  const data = await fetchJson<{ results?: ITunesResult[] }>(
    `https://itunes.apple.com/search?term=${q}&entity=song&limit=5`,
    signal,
  );
  if (!data?.results?.length) return {};

  const expArtistLow = expectedArtist.toLowerCase();
  let bestHit: ITunesResult | null = null;
  let bestScore = -1;

  for (const hit of data.results) {
    if (!hit.artworkUrl100) continue;
    const artistSim = similarity(expArtistLow, (hit.artistName ?? '').toLowerCase());
    if (artistSim < 0.40) continue;
    if (artistSim > bestScore) {
      bestScore = artistSim;
      bestHit = hit;
    }
  }

  if (!bestHit?.artworkUrl100) return {};
  // Scale artwork from 100×100 to 600×600
  const artUrl = bestHit.artworkUrl100.replace('100x100', '600x600');
  return {
    albumArtUrl: artUrl,
    albumName: bestHit.collectionName,
    artistName: bestHit.artistName,
  };
}

export async function fetchTrackMetadata(
  track: string,
  artist: string,
  album?: string,
  signal?: AbortSignal,
): Promise<MetadataResult> {
  // Build query variants: full → lyrics-cleaned → art-cleaned → track-only
  const [cleanTrack, primaryArtist] = cleanForSearch(track, artist);
  const [artTrack, artArtist] = cleanForArtSearch(track, artist);

  const queries = new Set<string>();
  queries.add(`${track} ${artist}`);
  queries.add(`${cleanTrack} ${primaryArtist}`);
  if (artTrack !== cleanTrack) queries.add(`${artTrack} ${artArtist}`);
  if (cleanTrack !== track) queries.add(`${cleanTrack} ${artist}`);

  // For mixed-language titles like "잊지마 (It G Ma)" or "It-ji ma (Woo)",
  // extract parenthetical text and main text as separate query variants
  const parenMatch = cleanTrack.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    const mainPart = parenMatch[1].trim();
    const parenPart = parenMatch[2].trim();
    if (parenPart.length >= 2) queries.add(`${parenPart} ${primaryArtist}`);
    if (mainPart.length >= 2) queries.add(`${mainPart} ${primaryArtist}`);
  }

  // Album name can help narrow down results (esp. for romanized/non-Latin titles)
  if (album && album.trim()) {
    const cleanAlbum = album.replace(RE_BRACKET_TAG, '').replace(RE_VERSION_SUFFIX, '').trim();
    if (cleanAlbum) queries.add(`${primaryArtist} ${cleanAlbum}`);
  }

  // Last.fm corrected names — often fixes noisy YouTube/SoundCloud metadata
  if (hasLastFm()) {
    const correction = await getCorrection(cleanTrack, primaryArtist, signal);
    if (correction) {
      // Insert corrected query early so Deezer/iTunes use the fixed names
      queries.add(`${correction.track} ${correction.artist}`);
    }
  }

  queries.add(artTrack); // Aggressively cleaned track name only — last resort

  let first = true;
  for (const query of queries) {
    if (!query.trim()) continue;

    // First query: race Deezer + iTunes in parallel — first with art wins
    if (first) {
      first = false;
      const metaAbort = new AbortController();
      const metaSignal = signal ? AbortSignal.any([signal, metaAbort.signal]) : metaAbort.signal;
      try {
        const winner = await Promise.any([
          searchDeezer(query, cleanTrack, primaryArtist, metaSignal).then(r => {
            if (!r.albumArtUrl) throw new Error('no art');
            return r;
          }),
          searchITunes(query, cleanTrack, primaryArtist, metaSignal).then(r => {
            if (!r.albumArtUrl) throw new Error('no art');
            return r;
          }),
        ]);
        metaAbort.abort(); // Cancel the loser
        return winner;
      } catch (e: unknown) {
        metaAbort.abort();
        if (e instanceof DOMException && e.name === 'AbortError') break;
      }
      continue;
    }

    // Subsequent queries: sequential (avoid hammering APIs)
    try {
      const deezer = await searchDeezer(query, cleanTrack, primaryArtist, signal);
      if (deezer.albumArtUrl) return deezer;
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') break;
    }

    try {
      const itunes = await searchITunes(query, cleanTrack, primaryArtist, signal);
      if (itunes.albumArtUrl) return itunes;
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') break;
    }
  }

  return {};
}

// ══════════════════════════════════════════════════
// ── Plain lyrics (unsynced) — dashboard only ──
// ══════════════════════════════════════════════════

const GENIUS_TIMEOUT = 8_000;
const RE_GENIUS_CONTAINER = /<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/gi;

/** Scrape plain lyrics from a Genius lyrics page. */
async function scrapeGeniusLyrics(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const timeoutSignal = AbortSignal.timeout(GENIUS_TIMEOUT);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: combinedSignal,
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    // Genius stores lyrics inside <div data-lyrics-container="true"> elements
    const chunks: string[] = [];
    RE_GENIUS_CONTAINER.lastIndex = 0;
    let match;
    while ((match = RE_GENIUS_CONTAINER.exec(html)) !== null) {
      chunks.push(match[1]);
    }
    if (chunks.length === 0) return null;

    // Strip HTML tags, decode entities, normalize
    let text = chunks.join('\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<[^>]+>/g, '');
    text = text.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    return text.length >= 20 ? text : null;
  } catch {
    return null;
  }
}

/** Search Genius for a song and return its lyrics page URL. */
async function searchGenius(track: string, artist: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const timeoutSignal = AbortSignal.timeout(GENIUS_TIMEOUT);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const query = encodeURIComponent(`${track} ${artist}`);
    const resp = await fetch(`https://genius.com/api/search/multi?q=${query}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: combinedSignal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      response?: {
        sections?: {
          type: string;
          hits?: { type: string; result: { url?: string; title?: string; primary_artist?: { name?: string } } }[];
        }[];
      };
    };
    const sections = data.response?.sections;
    if (!sections) return null;

    // Find the "song" section
    for (const section of sections) {
      if (section.type !== 'song') continue;
      for (const hit of section.hits ?? []) {
        if (hit.type !== 'song' || !hit.result?.url) continue;
        // Basic artist validation
        const hitArtist = (hit.result.primary_artist?.name ?? '').toLowerCase();
        const queryArtist = artist.toLowerCase();
        if (similarity(queryArtist, hitArtist) >= 0.40 || hitArtist.includes(queryArtist.split(/[,&]/)[0].trim())) {
          return hit.result.url;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch unsynced (plain text) lyrics for dashboard display.
 * Strategy: LRCLib plainLyrics → Genius scrape.
 * Returns lines as string[] or null.
 */
export async function fetchPlainLyrics(
  name: string,
  artist: string,
  album: string,
  durationMs: number,
  signal?: AbortSignal,
): Promise<string[] | null> {
  const [cleanName, primaryArtist] = cleanForSearch(name, artist);
  const durationSec = durationMs > 0 ? Math.round(durationMs / 1000) : undefined;
  let albumClean = album.replace(RE_UNRELEASED, ' ').trim();
  albumClean = albumClean.replace(RE_BRACKET_TAG, '').trim();
  albumClean = albumClean.replace(RE_VERSION_SUFFIX, '').trim();

  // ── Try 1: Check in-memory cache from the earlier fetchLyrics race (zero cost) ──
  const cacheKey = `${cleanName}|${primaryArtist}`.toLowerCase();
  if (_lastPlainCache && _lastPlainCache.key === cacheKey) {
    const lines = _lastPlainCache.plainLyrics.split('\n').filter(l => l.trim());
    if (lines.length >= 3) {
      log.info(`[PLAIN] LRCLib plain lyrics from cache (${lines.length} lines)`);
      return lines;
    }
  }

  // ── Try 2: LRCLib plainLyrics API (fallback if cache miss — e.g. different name variant) ──
  try {
    const result = await directLookup({
      track_name: cleanName,
      artist_name: primaryArtist,
      album_name: albumClean || undefined,
      duration: durationSec,
    }, signal);
    if (result?.plainLyrics && result.plainLyrics.length >= 20) {
      const lines = result.plainLyrics.split('\n').filter(l => l.trim());
      if (lines.length >= 3) {
        log.info(`[PLAIN] LRCLib plain lyrics (${lines.length} lines)`);
        return lines;
      }
    }
  } catch { /* fall through */ }

  // ── Try 3: Genius search + scrape ──
  try {
    const geniusUrl = await searchGenius(cleanName, primaryArtist, signal);
    if (geniusUrl) {
      const text = await scrapeGeniusLyrics(geniusUrl, signal);
      if (text) {
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length >= 3) {
          log.info(`[PLAIN] Genius lyrics (${lines.length} lines)`);
          return lines;
        }
      }
    }
  } catch { /* fall through */ }

  return null;
}
