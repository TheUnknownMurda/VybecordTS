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

function initCachePath(): void {
  if (cacheFile) return;
  // Store next to config.json
  cacheFile = join(process.cwd(), 'translate-cache.json');
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

// Load cache on module init
loadDiskCache();

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

// ── Translation API (Lingva Translate — free Google Translate proxy) ──
const LINGVA_INSTANCES = [
  'https://lingva.ml',
  'https://lingva.thedaviddelta.com',
];

let activeInstance = 0;

async function fetchLingva(text: string, source: string, target: string, signal?: AbortSignal): Promise<string | null> {
  const encoded = encodeURIComponent(text);
  for (let attempt = 0; attempt < LINGVA_INSTANCES.length; attempt++) {
    const base = LINGVA_INSTANCES[(activeInstance + attempt) % LINGVA_INSTANCES.length];
    const url = `${base}/api/v1/${source}/${target}/${encoded}`;
    try {
      const res = await fetch(url, { signal, headers: { 'Accept': 'application/json' } });
      if (!res.ok) continue;
      const data = await res.json() as { translation?: string };
      if (data.translation) {
        activeInstance = (activeInstance + attempt) % LINGVA_INSTANCES.length;
        return data.translation;
      }
    } catch {
      // Try next instance
    }
  }
  return null;
}

// ── Fallback: MyMemory API (1000 req/day free) ──
async function fetchMyMemory(text: string, source: string, target: string, signal?: AbortSignal): Promise<string | null> {
  const encoded = encodeURIComponent(text);
  const langPair = `${source}|${target}`;
  const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=${langPair}`;
  try {
    const res = await fetch(url, { signal });
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

async function translateOne(trimmed: string, targetLang: string, signal?: AbortSignal): Promise<string | null> {
  const acquired = await acquireSlot(signal);
  if (!acquired) return null;
  try {
    let result = await fetchLingva(trimmed, 'auto', targetLang, signal);
    if (!result) result = await fetchMyMemory(trimmed, 'auto', targetLang, signal);
    return result;
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

  const result = await translateOne(trimmed, targetLang, signal);

  if (result) {
    // Don't cache if translation is identical to input (same language)
    if (result.toLowerCase() === trimmed.toLowerCase()) return null;
    evictOldest(cache, CACHE_MAX - 1);
    cache.set(key, result);
    scheduleCacheFlush();
    return { translation: result, cached: false };
  }

  return null;
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
  flushDiskCache();
}
