import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createLogger } from './logger.js';
import { evictOldest } from './utils.js';

const log = createLogger('Translate');

// ── Persistent disk cache ──
const cache = new Map<string, string>();
const CACHE_MAX = 5000;
let cacheFile = '';
let cacheDirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// Set by initTranslateCache(); falls back to cwd only if that was never called.
let cacheBaseDir = '';

function initCachePath(): void {
  if (cacheFile) return;
  // Store next to config.json — that is the exe's own directory when packaged,
  // which is NOT process.cwd() when the app is launched from a shortcut.
  cacheFile = join(cacheBaseDir || process.cwd(), 'translate-cache.json');
}

function loadDiskCache(): void {
  initCachePath();
  try {
    if (!existsSync(cacheFile)) return;
    const raw = readFileSync(cacheFile, 'utf8');
    const entries = JSON.parse(raw) as [string, string][];
    for (const [k, v] of entries) cache.set(k, v);
    log.info(`Loaded ${cache.size} cached translations from disk`);
  } catch { /* ignore corrupt cache */ }
}

/**
 * Load the on-disk translation cache. Call once, early in startup — after the banner.
 * `baseDir` is the app's data directory (exe dir when packaged, cwd in dev).
 */
export function initTranslateCache(baseDir?: string): void {
  if (baseDir) cacheBaseDir = baseDir;
  loadDiskCache();
}

function flushDiskCache(): void {
  if (!cacheDirty) return;
  initCachePath();
  try {
    const dir = dirname(cacheFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entries = [...cache.entries()].slice(-CACHE_MAX);
    writeFileSync(cacheFile, JSON.stringify(entries));
    cacheDirty = false;
  } catch (e) { log.warn(`Failed to flush translation cache: ${e}`); }
}

function scheduleCacheFlush(): void {
  cacheDirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushDiskCache(); }, 10_000);
}

// Cache is loaded via initTranslateCache(), called explicitly from index.ts
// (not at module-import time — that ran before the startup banner could print).

// ── Concurrency limiter (async semaphore — zero polling) ──
let activeRequests = 0;
const MAX_CONCURRENT = 12;
const waitQueue: (() => void)[] = [];

// ── Supported languages ──
export const TRANSLATE_LANGS: Record<string, string> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
  pt: 'Português',
  it: 'Italiano',
  ru: 'Русский',
  ja: '日本語',
  ko: '한국어',
  zh: '中文',
  ar: 'العربية',
  hi: 'हिन्दी',
  tr: 'Türkçe',
  pl: 'Polski',
  nl: 'Nederlands',
  sv: 'Svenska',
};

// ── Language detection (fast heuristic to skip same-lang translations) ──
const LANG_PATTERNS: [RegExp, string][] = [
  [/[\u3040-\u309F\u30A0-\u30FF]/, 'ja'],                     // Hiragana/Katakana
  [/[\uAC00-\uD7AF]/, 'ko'],                                   // Hangul
  [/[\u4E00-\u9FFF\u3400-\u4DBF]/, 'zh'],                     // CJK
  [/[\u0400-\u04FF]/, 'ru'],                                    // Cyrillic
  [/[\u0600-\u06FF\u0750-\u077F]/, 'ar'],                      // Arabic
  [/[\u0900-\u097F]/, 'hi'],                                    // Devanagari
];

function detectScriptLang(text: string): string | null {
  for (const [re, lang] of LANG_PATTERNS) {
    if (re.test(text)) return lang;
  }
  // Don't detect 'en' — too many false positives with FR/ES/DE/PT etc.
  // Only skip for non-Latin scripts where detection is reliable.
  return null;
}

// ── Translation API ──
//
// Three providers, tried in order, because free endpoints come and go: the two
// Lingva instances this used to rely on both stopped answering (500 and 503),
// which is why translation silently produced nothing.
//
//   1. Google's public translate endpoint. Fastest, and the only one that
//      detects the source language itself — which matters for lyrics, where we
//      cannot know it up front.
//   2. A Lingva mirror, which proxies the same service.
//   3. MyMemory, which needs an explicit source language, so it only gets a
//      turn once something has told us what that is.

const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

/** Lingva mirrors. Public instances die often — order is the try order. */
const LINGVA_INSTANCES = [
  'https://lingva.dialectapp.org',
  'https://lingva.ml',
  'https://lingva.thedaviddelta.com',
];

let activeInstance = 0;

/** What a provider returns: the text, plus the source language when it knows it. */
interface Translated {
  text: string;
  detected?: string;
}

// Several call sites (lyrics-engine lookahead, translate:batch) pass no signal,
// so without a per-attempt timeout a hung translation server would pin one of
// the MAX_CONCURRENT semaphore slots forever — 12 hung fetches and the whole
// translation feature is dead until restart.
const REQUEST_TIMEOUT_MS = 8000;

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Google's translate_a endpoint.
 *
 * The response is a nested array rather than an object: [0] holds the segments,
 * each segment's [0] being the translated chunk, and [2] holds the language it
 * decided the input was. A long lyric line can come back split across several
 * segments, so they are joined rather than taking the first.
 */
async function fetchGoogle(text: string, target: string, signal?: AbortSignal): Promise<Translated | null> {
  const url = `${GOOGLE_ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const res = await fetch(url, { signal: withTimeout(signal), headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json() as [Array<[string, ...unknown[]]>, unknown, string?];
    const segments = data?.[0];
    if (!Array.isArray(segments)) return null;
    const out = segments.map(seg => (Array.isArray(seg) ? seg[0] : '')).join('').trim();
    if (!out) return null;
    return { text: out, detected: typeof data[2] === 'string' ? data[2] : undefined };
  } catch {
    return null;
  }
}

async function fetchLingva(text: string, target: string, signal?: AbortSignal): Promise<Translated | null> {
  const encoded = encodeURIComponent(text);
  for (let attempt = 0; attempt < LINGVA_INSTANCES.length; attempt++) {
    const index = (activeInstance + attempt) % LINGVA_INSTANCES.length;
    const url = `${LINGVA_INSTANCES[index]}/api/v1/auto/${target}/${encoded}`;
    try {
      const res = await fetch(url, { signal: withTimeout(signal), headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const data = await res.json() as { translation?: string };
      if (data.translation) {
        // Stick with whichever mirror answered, so the dead ones are not retried
        // line after line.
        activeInstance = index;
        return { text: data.translation };
      }
    } catch {
      // Try next instance
    }
  }
  return null;
}

// ── Fallback: MyMemory API (1000 req/day free) ──
/**
 * MyMemory. Needs a real source language — passing 'auto' returns a 200 whose
 * body is the words "'AUTO' IS AN INVALID SOURCE LANGUAGE", which is how this
 * fallback used to fail while looking like it had answered.
 */
async function fetchMyMemory(text: string, source: string, target: string, signal?: AbortSignal): Promise<string | null> {
  if (!source || source === 'auto' || source === target) return null;
  const encoded = encodeURIComponent(text);
  const langPair = `${source}|${target}`;
  const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=${langPair}`;
  try {
    const res = await fetch(url, { signal: withTimeout(signal) });
    if (!res.ok) return null;
    const data = await res.json() as { responseData?: { translatedText?: string }; responseStatus?: number };
    if (data.responseStatus === 200 && data.responseData?.translatedText) {
      const result = data.responseData.translatedText;
      // MyMemory returns uppercase when it fails — detect that
      if (result === text.toUpperCase() && text !== text.toUpperCase()) return null;
      return result;
    }
  } catch {
    // Fallback failed
  }
  return null;
}

// ── Core single-line translate (internal) ──

function acquireSlot(signal?: AbortSignal): Promise<boolean> {
  if (activeRequests < MAX_CONCURRENT) {
    activeRequests++;
    return Promise.resolve(true);
  }
  return new Promise<boolean>(resolve => {
    const onAbort = () => { resolve(false); };
    if (signal?.aborted) { resolve(false); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    waitQueue.push(() => {
      signal?.removeEventListener('abort', onAbort);
      activeRequests++;
      resolve(true);
    });
  });
}

function releaseSlot(): void {
  activeRequests--;
  if (waitQueue.length > 0) {
    const next = waitQueue.shift()!;
    next();
  }
}

/**
 * @param sourceHint the source language when something already knows it — the
 *   script detector, say. Only MyMemory needs one; the others detect their own.
 */
async function translateOne(
  trimmed: string,
  targetLang: string,
  sourceHint: string | null,
  signal?: AbortSignal,
): Promise<Translated | null> {
  const acquired = await acquireSlot(signal);
  if (!acquired) return null;
  try {
    const google = await fetchGoogle(trimmed, targetLang, signal);
    if (google) return google;

    const lingva = await fetchLingva(trimmed, targetLang, signal);
    if (lingva) return lingva;

    const source = sourceHint || detectScriptLang(trimmed);
    if (!source) return null;
    const mem = await fetchMyMemory(trimmed, source, targetLang, signal);
    return mem ? { text: mem } : null;
  } finally {
    releaseSlot();
  }
}

// ── Public API ──

export interface TranslateResult {
  translation: string;
  cached: boolean;
}

/**
 * Translate a text string from auto-detected language to target language.
 * Uses caching + concurrency limiting. Returns null if translation fails.
 */
export async function translateText(
  text: string,
  targetLang: string,
  signal?: AbortSignal,
): Promise<TranslateResult | null> {
  // Skip empty/trivial text
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 2 || /^[♪♫🎵\s]+$/.test(trimmed)) return null;

  // Check cache
  const key = `${trimmed}|${targetLang}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return { translation: cached, cached: true };
  }

  // Skip if detected language matches target (don't translate EN→EN)
  const detected = detectScriptLang(trimmed);
  if (detected === targetLang) return null;

  const result = await translateOne(trimmed, targetLang, detected, signal);
  if (!result) return null;

  // A provider that recognised the line as already being in the target language
  // has nothing to add, and caching its echo would leave the original sitting
  // under itself for the rest of the song.
  if (result.detected && result.detected.split('-')[0] === targetLang) return null;

  // Don't cache if translation is identical to input (same language)
  if (result.text.toLowerCase() === trimmed.toLowerCase()) return null;

  evictOldest(cache, CACHE_MAX - 1);
  cache.set(key, result.text);
  scheduleCacheFlush();
  return { translation: result.text, cached: false };
}

/**
 * Batch translate multiple lines (for pre-caching full lyrics).
 * Uses parallel requests with concurrency limit for ~4x speedup.
 */
export async function translateBatch(
  lines: string[],
  targetLang: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const unique = [...new Set(lines.filter(l => l.trim().length >= 2 && !/^[♪♫🎵\s]+$/.test(l.trim())))];

  // Run all unique lines in parallel with higher concurrency for batch
  const BATCH_CONCURRENT = 20;
  for (let i = 0; i < unique.length; i += BATCH_CONCURRENT) {
    if (signal?.aborted) break;
    const chunk = unique.slice(i, i + BATCH_CONCURRENT);
    const promises = chunk.map(async line => {
      const r = await translateText(line, targetLang, signal);
      if (r) results.set(line, r.translation);
    });
    await Promise.allSettled(promises);
  }

  log.info(`Batch translated ${results.size}/${unique.length} lines → ${targetLang}`);
  return results;
}

/** Clear the translation cache (memory + disk). */
export function clearTranslationCache(): void {
  cache.clear();
  cacheDirty = true;
  flushDiskCache();
}

/** Get cache stats. */
export function getTranslationCacheSize(): number {
  return cache.size;
}

/** Sync cache lookup — returns cached translation or null. No network calls.
 *  Hot path (~2-5 calls/sec) — callers are expected to pass already-trimmed text. */
export function getCachedTranslation(text: string, targetLang: string): string | null {
  const key = `${text}|${targetLang}`;
  return cache.get(key) ?? null;
}

/** Flush cache to disk (call on shutdown). */
export function flushTranslationCache(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushDiskCache();
}
