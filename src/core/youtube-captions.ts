/**
 * YouTube Closed Captions fetcher — uses yt-dlp subprocess.
 *
 * YouTube's timedtext API requires browser-context authentication (PoToken)
 * that cannot be replicated from server-side fetch. yt-dlp handles this
 * via its own YouTube extractor with impersonation/session management.
 *
 * Flow: spawn yt-dlp → ytsearch + download CC to temp dir → read json3 → parse → cleanup
 *
 * Features:
 * - Multi-language: fetches en + fr captions, prefers user's dashboard language
 * - Prefers manual subs over auto-generated (better quality)
 * - In-memory cache to avoid re-fetching for the same query
 * - Merges short auto-CC fragments into natural sentence lines
 * - Cleans search queries for better YouTube matching
 *
 * Requires: yt-dlp installed and in PATH.
 * Gracefully returns [] if yt-dlp is not available.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from './logger.js';
import type { LyricLine } from './types.js';

const log = createLogger('YouTube-CC');

// Noise patterns in auto-generated captions: [Music], [Applause], (singing), etc.
const RE_CC_NOISE = /^\[.*\]$|^\(.*\)$/;
// Extra noise: single punctuation, lone emoji, subscriber bait, etc.
const RE_CC_JUNK = /^[♪♫🎵🎶\s]+$|^\s*$/;

const YT_DLP_TIMEOUT = 15_000;

// Supported CC languages — ordered by preference (first = highest priority)
const CC_LANGS = ['fr', 'en'];
// Manual sub-lang: include locale variants (fr-CA, fr-FR, en-US, etc.)
const MANUAL_SUB_LANG = 'fr,fr-CA,fr-FR,en,en-US,en-GB';
// Auto CC sub-lang: keep minimal to avoid YouTube 429 rate limits
const CC_SUB_LANG = 'fr-orig,en-orig,fr,en';

// Maximum merged line length (chars) before forcing a break (Discord RPC max = 128)
const MAX_MERGED_CHARS = 128;
// Absolute max merge gap — never merge segments further apart than this
const MAX_MERGE_GAP_MS = 3_000;
// Default minimum segment gap when we can't compute a median
const DEFAULT_MIN_SEGMENT_MS = 800;
// Sentence-ending punctuation forces a line break
const RE_SENTENCE_END = /[.!?…]$/;
// Filler words at start/end of lines (common auto-CC noise)
const RE_FILLER_START = /^(?:uh|um|oh|ah|hmm|hm|mhm|yeah)\s+/i;
const RE_FILLER_SOLO = /^(?:uh|um|oh|ah|hmm|hm|mhm)$/i;

// One-time availability check (cached after first call)
let ytDlpChecked = false;
let ytDlpAvailable = false;

// ── Public result type ──
export interface CCResult {
  lines: LyricLine[];
  thumbnailUrl?: string;
}

// ── In-memory cache ──
interface CacheEntry { result: CCResult; ts: number; }
const ccCache = new Map<string, CacheEntry>();
const CACHE_TTL = 10 * 60 * 1000; // 10 min
const CACHE_MAX = 30;

/** Clear all cached CC results (e.g. after language change). */
export function clearCCCache(): void {
  ccCache.clear();
  log.info('[CC] Cache cleared');
}

function cacheKey(title: string, artist: string): string {
  return `${artist.toLowerCase().trim()}|${title.toLowerCase().trim()}`;
}

function getCached(key: string): CCResult | null {
  const entry = ccCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { ccCache.delete(key); return null; }
  return entry.result;
}

function setCache(key: string, result: CCResult): void {
  ccCache.set(key, { result, ts: Date.now() });
  // Evict oldest if over limit
  if (ccCache.size > CACHE_MAX) {
    const oldest = ccCache.keys().next().value;
    if (oldest) ccCache.delete(oldest);
  }
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: { utf8: string }[];
}

// ── Query cleaning ──
// Strip video noise from titles before searching YouTube
const RE_VIDEO_NOISE = /\s*[(\[](official\s*(audio|video|music\s*video|lyric\s*video|visualizer)?|lyric(s)?\s*video|audio|mv|m\/v|4k|hd|hq|visualizer|lyrics?|with\s*lyrics?)[)\]]/gi;
const RE_BRACKET_TAGS = /\s*[(\[](slowed|sped\s*up|reverb|slowed\s*\+\s*reverb|nightcore|bass\s*boosted|8d(\s*audio)?|lo-?fi|remix|acoustic|live|clean|explicit)[)\]]/gi;
const RE_FEAT = /\s*\(?\s*feat\.?\s.*$/i;
const RE_TOPIC = /\s*-\s*Topic\s*$/i;

function cleanQuery(title: string, artist: string): [string, string] {
  let t = title
    .replace(RE_VIDEO_NOISE, '')
    .replace(RE_BRACKET_TAGS, '')
    .replace(RE_FEAT, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  let a = artist
    .split(/[,&]/)[0]
    .replace(RE_TOPIC, '')
    .trim();
  return [t || title, a || artist];
}

// ── yt-dlp helpers ──

/** Check if yt-dlp is installed (cached). */
async function ensureYtDlp(): Promise<boolean> {
  if (ytDlpChecked) return ytDlpAvailable;
  ytDlpChecked = true;
  try {
    await execFileAsync('yt-dlp', ['--version'], { timeout: 5_000 });
    ytDlpAvailable = true;
    log.info('[CC] yt-dlp found — YouTube CC enabled');
  } catch {
    ytDlpAvailable = false;
    log.info('[CC] yt-dlp not found — YouTube CC disabled');
  }
  return ytDlpAvailable;
}

/** Promise wrapper around execFile. */
function execFileAsync(
  cmd: string,
  args: string[],
  opts: { timeout?: number; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout: opts.timeout,
      signal: opts.signal,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// ── JSON3 parser ──

/** Normalize Unicode oddities common in YouTube captions. */
function normalizeText(s: string): string {
  return s
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')  // Zero-width chars
    .replace(/\u00A0/g, ' ')                       // Non-breaking space → space
    .replace(/[\u2018\u2019\u201A]/g, "'")         // Smart single quotes → apostrophe
    .replace(/[\u2014\u2015]/g, '—')               // Em dashes
    .replace(/[\u2013]/g, '–')                     // En dash
    .replace(/\s{2,}/g, ' ')                       // Collapse multiple spaces
    .trim();
}

/** Parse YouTube JSON3 captions into LyricLine[]. */
function parseJson3(raw: string): LyricLine[] {
  let data: { events?: Json3Event[] };
  try { data = JSON.parse(raw); } catch { return []; }
  if (!data.events) return [];

  const lines: LyricLine[] = [];
  for (const ev of data.events) {
    if (ev.tStartMs == null || !ev.segs) continue;
    let text = ev.segs.map(s => s.utf8).join('').replace(/\n/g, ' ').trim();
    if (!text || RE_CC_NOISE.test(text) || RE_CC_JUNK.test(text)) continue;
    // Strip ♪/♫ wrappers from manual CC lines (e.g. "♪ We're no strangers ♪" → "We're no strangers")
    text = text.replace(/^[♪♫\s]+|[♪♫\s]+$/g, '').trim();
    text = normalizeText(text);
    if (!text) continue;
    lines.push({ time: ev.tStartMs, text });
  }

  // Deduplicate consecutive identical lines
  return lines.filter((line, i) => i === 0 || line.text !== lines[i - 1].text);
}

/**
 * Merge short auto-CC fragments into natural lines.
 * Auto-generated captions often split sentences into 1-2 word chunks
 * with timestamps only ~200ms apart — this merges them for readability.
 *
 * Improvements over naive fixed-threshold:
 *   - Adaptive threshold from median segment gap (handles different CC densities)
 *   - Sentence-ending punctuation (.!?) forces a break even if gap is short
 *   - Absolute ceiling (MAX_MERGE_GAP_MS) prevents merging across long pauses
 */
function mergeShortSegments(lines: LyricLine[]): LyricLine[] {
  if (lines.length < 2) return lines;

  // Compute adaptive merge threshold from median gap
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    gaps.push(lines[i].time - lines[i - 1].time);
  }
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)] || DEFAULT_MIN_SEGMENT_MS;
  // Merge threshold = 2× median (captures most intra-sentence fragments)
  // but capped between 400ms and MAX_MERGE_GAP_MS
  const mergeThreshold = Math.min(Math.max(medianGap * 2, 400), MAX_MERGE_GAP_MS);

  const merged: LyricLine[] = [];
  let buf: LyricLine = { ...lines[0] };

  for (let i = 1; i < lines.length; i++) {
    const cur = lines[i];
    const dt = cur.time - lines[i - 1].time;

    // Force break if: previous buffer ends a sentence, gap is too large, or merged text too long
    const sentenceEnd = RE_SENTENCE_END.test(buf.text);
    const shouldBreak = sentenceEnd || dt >= mergeThreshold || (buf.text.length + cur.text.length + 1) > MAX_MERGED_CHARS;

    if (shouldBreak) {
      merged.push(buf);
      buf = { ...cur };
    } else {
      buf = { time: buf.time, text: buf.text + ' ' + cur.text };
    }
  }
  merged.push(buf);
  return merged;
}

/**
 * Capitalize auto-CC lines (YouTube auto-CC is typically all lowercase).
 * Capitalizes the first letter of each line.
 * Does NOT capitalize after every period (preserves mid-line flow for lyrics).
 */
function capitalizeLines(lines: LyricLine[]): LyricLine[] {
  return lines.map(l => ({
    time: l.time,
    text: l.text.charAt(0).toUpperCase() + l.text.slice(1),
  }));
}

/**
 * Remove filler words/noise from auto-CC.
 * - Strip solo filler lines ("uh", "um")
 * - Strip filler words at the start of lines ("uh I don't care" → "I don't care")
 */
function stripFillerLines(lines: LyricLine[]): LyricLine[] {
  const result: LyricLine[] = [];
  for (const l of lines) {
    // Skip solo filler lines entirely
    if (RE_FILLER_SOLO.test(l.text.trim())) continue;
    // Strip filler at line start
    const cleaned = l.text.replace(RE_FILLER_START, '').trim();
    if (cleaned) result.push({ time: l.time, text: cleaned });
  }
  return result;
}

/**
 * Full post-processing pipeline for auto-generated CC.
 * Order matters: merge first (before text cleaning), then clean, then capitalize.
 */
function postProcessCC(lines: LyricLine[]): LyricLine[] {
  if (lines.length === 0) return lines;
  let result = mergeShortSegments(lines);
  result = stripFillerLines(result);
  result = capitalizeLines(result);
  // Final dedup pass (merging may create new consecutive duplicates)
  result = result.filter((line, i) => i === 0 || line.text !== result[i - 1].text);
  return result;
}

// ── File selection: prefer manual subs over auto-generated ──

/**
 * Pick the best subtitle file from the temp directory.
 * yt-dlp naming examples:
 *   Manual:  `<id>.fr.json3`
 *   Auto:    `<id>.en-eEY6OEpapPo.json3` (original auto-CC with hash suffix)
 * Priority: manual sub > auto original > auto translated.
 */
function pickBestSubFile(files: string[], langOrder: string[] = CC_LANGS): { file: string; isAuto: boolean; lang: string } | null {
  const json3Files = files.filter(f => f.endsWith('.json3'));
  if (!json3Files.length) return null;

  // Classify each file by extracting the sub-identifier between last dot-before-lang and .json3
  const classified = json3Files.map(f => {
    // Strip .json3, then take everything after the last '.' → sub identifier
    // e.g. "VHoT4N43jK8.fr.json3" → subId="fr"
    //      "VHoT4N43jK8.en-eEY6OEpapPo.json3" → subId="en-eEY6OEpapPo"
    const base = f.replace(/\.json3$/, '');
    const lastDot = base.lastIndexOf('.');
    const subId = lastDot >= 0 ? base.slice(lastDot + 1) : '';
    // Base language is always the first 2 chars
    const lang = subId.slice(0, 2);
    // Auto-CC indicators: '-orig' suffix (e.g. 'en-orig') or long hash (e.g. 'en-eEY6OEpapPo')
    // Manual subs: plain lang code (e.g. 'fr') or locale (e.g. 'fr-FR', 'fr-CA')
    const isAuto = /-(orig|[a-zA-Z0-9]{6,})/.test(subId);
    return { file: f, isAuto, lang };
  });

  // Log classification for debugging
  for (const c of classified) {
    log.debug(`[CC] File: ${c.file} → lang=${c.lang}, isAuto=${c.isAuto}`);
  }

  // Sort: manual first, then by language preference order
  classified.sort((a, b) => {
    if (a.isAuto !== b.isAuto) return a.isAuto ? 1 : -1;
    const aRank = langOrder.indexOf(a.lang);
    const bRank = langOrder.indexOf(b.lang);
    return (aRank >= 0 ? aRank : 99) - (bRank >= 0 ? bRank : 99);
  });

  log.debug(`[CC] Picked: ${classified[0]?.file} (isAuto=${classified[0]?.isAuto})`);
  return classified[0];
}

// ── Public API ──

/** YouTube thumbnail URL from video ID (high quality, always available). */
function ytThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/** Extract video ID from subtitle filename (e.g. "dQw4w9WgXcQ.en.json3" → "dQw4w9WgXcQ"). */
function extractVideoId(filename: string): string | null {
  const firstDot = filename.indexOf('.');
  if (firstDot <= 0) return null;
  const id = filename.slice(0, firstDot);
  // YouTube IDs are 11 chars, alphanumeric + _ + -
  return /^[\w-]{11}$/.test(id) ? id : null;
}

// ── Language helpers ──

/** All supported CC language codes + locale variants. */
const LANG_VARIANTS: Record<string, string[]> = {
  fr: ['fr', 'fr-CA', 'fr-FR'],
  en: ['en', 'en-US', 'en-GB', 'en-CA', 'en-AU'],
  es: ['es', 'es-ES', 'es-MX', 'es-419'],
  pt: ['pt', 'pt-BR', 'pt-PT'],
  de: ['de', 'de-DE', 'de-AT'],
  it: ['it', 'it-IT'],
  ja: ['ja'],
  ko: ['ko'],
  zh: ['zh', 'zh-Hans', 'zh-Hant', 'zh-CN', 'zh-TW'],
  ar: ['ar'],
  ru: ['ru'],
  hi: ['hi'],
};

/** Build ordered lang lists based on preferred language. */
function buildLangLists(preferred: string): { manualLangs: string; autoLangs: string; sortOrder: string[] } {
  // Default sort order
  const defaultOrder = ['fr', 'en'];

  if (!preferred || preferred === 'auto') {
    return {
      manualLangs: MANUAL_SUB_LANG,
      autoLangs: CC_SUB_LANG,
      sortOrder: defaultOrder,
    };
  }

  const pref = preferred.toLowerCase().slice(0, 2);
  // Build sort order: preferred first, then the rest
  const sortOrder = [pref, ...defaultOrder.filter(l => l !== pref)];

  // Manual: preferred variants first, then others
  const prefVariants = LANG_VARIANTS[pref] || [pref];
  const otherManual = Object.entries(LANG_VARIANTS)
    .filter(([k]) => k !== pref)
    .flatMap(([, v]) => v);
  const manualLangs = [...prefVariants, ...otherManual].join(',');

  // Auto: preferred-orig first
  const autoLangs = [`${pref}-orig`, ...sortOrder.filter(l => l !== pref).map(l => `${l}-orig`), ...sortOrder].join(',');

  return { manualLangs, autoLangs, sortOrder };
}

/**
 * Fetch YouTube closed captions for a video matching the given title + artist.
 * Uses yt-dlp to search YouTube, download CC in json3 format, then parse.
 * Returns CCResult with synced lines + video thumbnail URL.
 *
 * - Multi-language: fetches en + fr, prefers manual subs over auto-generated
 * - Cached: same query won't re-spawn yt-dlp within 10 minutes
 * - Auto-CC fragments are merged into readable sentence-length lines
 */
export async function fetchYouTubeCaptions(
  title: string,
  artist: string,
  signal?: AbortSignal,
  videoId?: string,
  preferredLang?: string,
): Promise<CCResult> {
  const EMPTY: CCResult = { lines: [] };
  if (!(await ensureYtDlp())) return EMPTY;

  // Check cache first — include lang in key so switching language re-fetches
  const langSuffix = preferredLang && preferredLang !== 'auto' ? `:${preferredLang}` : '';
  const key = videoId ? `yt:${videoId}${langSuffix}` : cacheKey(title, artist) + langSuffix;
  const cached = getCached(key);
  if (cached !== null) {
    log.debug(`[CC] Cache hit (${cached.lines.length} lines)`);
    return cached;
  }

  // Direct URL when video ID is known (from userscript), otherwise search
  let query: string;
  if (videoId) {
    query = `https://www.youtube.com/watch?v=${videoId}`;
    log.info(`[CC] Fetching CC by video ID: ${videoId}`);
  } else {
    const [cleanTitle, cleanArtist] = cleanQuery(title, artist);
    query = `ytsearch:${cleanArtist} ${cleanTitle}`;
    log.info(`[CC] Searching: "${cleanArtist} ${cleanTitle}"`);
  }

  // Create temp directory for subtitle output
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'vybecord-cc-'));
  const { manualLangs, autoLangs, sortOrder } = buildLangLists(preferredLang || 'auto');
  log.debug(`[CC] Lang preference: ${preferredLang || 'auto'} → manual=[${manualLangs}] auto=[${autoLangs}] sort=[${sortOrder}]`);

  try {

    // ── Step 1: Try manual subtitles first (higher quality, no auto-CC noise) ──
    const baseArgs = [
      query,
      '--sub-format', 'json3',
      '--skip-download',
      '--no-warnings',
      '--no-check-certificates',
      '--ignore-errors',
      '-o', path.join(tmpDir, '%(id)s'),
    ];

    let isManualSub = false;
    await execFileAsync('yt-dlp', [
      ...baseArgs,
      '--write-sub',
      '--sub-lang', manualLangs,
    ], { timeout: YT_DLP_TIMEOUT, signal }).catch(() => {});

    let files = await readdir(tmpDir);
    let pick = files.length ? pickBestSubFile(files, sortOrder) : null;

    if (pick) {
      isManualSub = true;
      log.info(`[CC] Found manual subtitles (${pick.lang}): ${pick.file}`);
    } else {
      // ── Step 2: No manual subs — fall back to auto-generated CC ──
      log.debug('[CC] No manual subs — trying auto-CC...');
      await execFileAsync('yt-dlp', [
        ...baseArgs,
        '--write-auto-sub',
        '--sub-lang', autoLangs,
      ], { timeout: YT_DLP_TIMEOUT, signal }).catch(() => {});

      files = await readdir(tmpDir);
      pick = files.length ? pickBestSubFile(files, sortOrder) : null;
    }

    if (!pick) {
      log.info('[CC] No subtitle files — video has no CC in supported languages');
      setCache(key, EMPTY);
      return EMPTY;
    }

    log.debug(`[CC] Using ${isManualSub ? 'manual' : 'auto'} subs (${pick.lang}): ${pick.file}`);

    // Parse json3 into LyricLine[]
    const raw = await readFile(path.join(tmpDir, pick.file), 'utf8');
    let lines = parseJson3(raw);

    // Auto-generated CC: full post-processing pipeline (merge + clean + capitalize)
    if (!isManualSub && lines.length > 0) {
      const before = lines.length;
      lines = postProcessCC(lines);
      if (lines.length !== before) {
        log.debug(`[CC] Post-processed auto-CC: ${before} → ${lines.length} lines`);
      }
    }

    // Extract video ID from filename for thumbnail
    const extractedVideoId = extractVideoId(pick.file);
    const thumbnailUrl = extractedVideoId ? ytThumbnail(extractedVideoId) : undefined;

    if (lines.length > 0) {
      // Tag lines: 'sub' for manual subtitles (treated like normal lyrics), 'cc' for auto-CC
      const sourceTag = isManualSub ? 'sub' as const : 'cc' as const;
      for (const l of lines) l.source = sourceTag;
      log.info(`[CC] Got ${lines.length} ${isManualSub ? 'manual subtitle' : 'auto-CC'} lines (${pick.lang})${videoId ? ` [${videoId}]` : ''}`);
    } else {
      log.debug('[CC] No usable lines in captions');
    }

    const result: CCResult = { lines, thumbnailUrl };
    setCache(key, result);
    return result;
  } catch (err: unknown) {
    if (signal?.aborted) return EMPTY;
    const msg = err instanceof Error ? err.message : String(err);
    // yt-dlp may exit non-zero but still have written partial subtitle files
    // (e.g. one language 429'd but another succeeded)
    try {
      const partialFiles = await readdir(tmpDir);
      log.debug(`[CC] Partial files after error: ${partialFiles.join(', ') || '(none)'}`);
      const pick = pickBestSubFile(partialFiles, sortOrder);
      if (pick) {
        log.info(`[CC] yt-dlp errored but found partial result: ${pick.file}`);
        const raw = await readFile(path.join(tmpDir, pick.file), 'utf8');
        let lines = parseJson3(raw);
        if (pick.isAuto && lines.length > 0) lines = postProcessCC(lines);
        if (lines.length > 0) {
          const sourceTag = pick.isAuto ? 'cc' as const : 'sub' as const;
          for (const l of lines) l.source = sourceTag;
          const videoId = extractVideoId(pick.file);
          const result: CCResult = { lines, thumbnailUrl: videoId ? ytThumbnail(videoId) : undefined };
          log.info(`[CC] Recovered ${lines.length} lines from partial download (${pick.lang})`);
          setCache(key, result);
          return result;
        }
      }
    } catch { /* tmp dir may not exist */ }
    log.warn(`[CC] yt-dlp failed: ${msg}`);
    setCache(key, EMPTY); // Negative cache — avoid re-spawning for the same query
    return EMPTY;
  } finally {
    // Clean up temp directory
    rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
