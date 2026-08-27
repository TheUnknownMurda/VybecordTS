import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createLogger } from './logger.js';
import { evictOldest } from './utils.js';

const log = createLogger('Translate');

// ── Persistent disk cache ──
const cache = new Map<string, string>();
const CACHE_MAX = 5000;

/**
 * Lines a provider had nothing to add for, and when we last asked.
 *
 * A miss that never gets remembered is asked again on every single emit. The
 * RPC path is the one that makes that expensive: buildActivity() looks up the
 * current line and the next one on every push, and a push happens every couple
 * of lyric lines — sub-second for CC captions. Any line the providers decline
 * stays uncached, so those requests are re-issued at that rate for the whole
 * song.
 *
 * Declining is the *common* case, not the edge: `translate_target_lang`
 * defaults to 'en' and most lyrics are already English, so every line takes the
 * "identical to input, don't cache" path below. That turned the feature on into
 * roughly ten requests a second to a public endpoint, which is how it gets rate
 * limited into not working at all.
 *
 * Remembered with a timestamp rather than forever, so a genuine provider
 * outage — as opposed to "this line needs no translation" — heals on its own.
 * Aborts are deliberately not recorded: a track change is not a verdict on the
 * line.
 */
const noTranslation = new Map<string, number>();
const NEGATIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_MAX = 2000;

/** Remember that this line came back with nothing to show. */
function markNoTranslation(key: string): void {
  noTranslation.set(key, Date.now());
  evictOldest(noTranslation, NEGATIVE_MAX);
}

/** True while a recent lookup for this line is known to have produced nothing. */
function recentlyDeclined(key: string): boolean {
  const at = noTranslation.get(key);
  if (at === undefined) return false;
  if (Date.now() - at < NEGATIVE_TTL_MS) return true;
  noTranslation.delete(key);
  return false;
}

/** Store an accepted translation, keeping the cache within its bound. */
function remember(key: string, translation: string): void {
  // It answered after all — drop any stale verdict so the hit stands.
  noTranslation.delete(key);
  evictOldest(cache, CACHE_MAX - 1);
  cache.set(key, translation);
  scheduleCacheFlush();
}

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

/**
 * One caller waiting for a slot.
 *
 * `cancelled` is what keeps the semaphore honest. A caller whose signal aborts
 * while it is queued gives up and returns immediately — so handing it a slot
 * afterwards increments `activeRequests` for a caller that will never release
 * it. Twelve of those and the counter is pinned at MAX_CONCURRENT forever:
 * every later translation queues behind a slot nobody holds, and the feature is
 * dead until restart. Track changes abort queued batches routinely, so this is
 * not a rare path.
 */
interface Waiter {
  cancelled: boolean;
  /** Take the slot. False when the caller had already given up. */
  grant(): boolean;
}
const waitQueue: Waiter[] = [];

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

/**
 * Lines nobody should spend a request on.
 *
 * Note runs were already skipped; structural markers were not. A [Chorus]
 * heading or an (x2) comes back as itself, which is a guaranteed miss that
 * still costs a semaphore slot and a place in the batch — as does a line with
 * no letters in it at all, a bare number or a row of dashes.
 *
 * Only square brackets count as a section heading. Round brackets are left
 * alone on purpose: a line that is entirely parenthesised is usually a backing
 * vocal, which is words, and skipping it would leave a real lyric untranslated.
 * The one round-bracket form ruled out is an explicit repeat count.
 */
const NOTES_ONLY = /^[♪♫♬🎵🎶\s]+$/;
const SECTION_MARKER = /^\[[^\]]*\]$/;
const REPEAT_MARKER = /^\(\s*[xX×]\s*\d+\s*\)$/;
const NO_LETTERS = /^[^\p{L}]+$/u;

function isTranslatable(trimmed: string): boolean {
  if (trimmed.length < 2) return false;
  if (NOTES_ONLY.test(trimmed)) return false;
  if (SECTION_MARKER.test(trimmed)) return false;
  if (REPEAT_MARKER.test(trimmed)) return false;
  if (NO_LETTERS.test(trimmed)) return false;
  return true;
}

// ── Translation API ──
//
// Four providers, tried in order, because free endpoints come and go: the two
// Lingva instances this used to rely on both stopped answering (500 and 503),
// which is why translation silently produced nothing.
//
//   1. Google's dictionary-extension endpoint. The only one that takes many
//      lines in a single request, so a whole song costs two or three round
//      trips instead of one per line. It also reports the language it detected
//      per line, which is what lets an already-in-target song be dropped
//      without asking about every line separately.
//   2. Google's translate_a/single endpoint — the same service, a different
//      front door, and rate limited independently of the first, so the one
//      that is throttled is rarely both.
//   3. A Lingva mirror, which proxies the same service.
//   4. MyMemory, which needs an explicit source language, so it only gets a
//      turn once something has told us what that is.

/**
 * Every request goes out with a browser User-Agent.
 *
 * Google answers Node's default agent with the "your computer may be sending
 * automated queries" page — a 429 whose body is HTML, so it reads as a dead
 * provider rather than as a rejected client, and the code silently fell through
 * to the Lingva mirrors that are themselves mostly gone. Both Google endpoints
 * answer normally once the header is there.
 */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REQ_HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

const GOOGLE_BATCH_ENDPOINT = 'https://clients5.google.com/translate_a/t';
const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

/**
 * How much goes into one batched request.
 *
 * Both limits are about the URL: the lines ride as repeated `q=` parameters, so
 * a verse of long lines reaches the length ceiling well before the line count.
 * 80 lines of ~90 characters — a ~9.5 KB URL — still answers, so these leave
 * real headroom rather than sitting on the edge of what works.
 */
const BATCH_MAX_LINES = 40;
const BATCH_MAX_URL_CHARS = 6000;

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
// A batch carries up to BATCH_MAX_LINES lines, so it is given longer than a
// single line before being written off.
const BATCH_TIMEOUT_MS = 20_000;

function withTimeout(signal: AbortSignal | undefined, ms = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Google's dictionary-extension endpoint — the one that takes many lines.
 *
 * `q` repeats once per line, and the reply is one `[translation, detectedLang]`
 * pair per line in the order they were sent. That alignment is the whole point,
 * so a reply whose length does not match the request is rejected outright
 * rather than zipped up short: pinning the wrong translation under a line is
 * worse than showing none.
 *
 * Returns null when the provider failed as a whole; an individual entry is null
 * when that one line came back empty.
 */
async function fetchGoogleBatch(
  texts: string[],
  target: string,
  signal?: AbortSignal,
): Promise<(Translated | null)[] | null> {
  if (texts.length === 0) return [];
  const url = `${GOOGLE_BATCH_ENDPOINT}?client=dict-chrome-ex&sl=auto&tl=${encodeURIComponent(target)}`
    + texts.map(t => `&q=${encodeURIComponent(t)}`).join('');
  try {
    const res = await fetch(url, {
      signal: withTimeout(signal, texts.length > 1 ? BATCH_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
      headers: REQ_HEADERS,
    });
    if (!res.ok) return null;
    const data = await res.json() as unknown;
    if (!Array.isArray(data) || data.length !== texts.length) return null;
    return data.map(entry => {
      if (!Array.isArray(entry)) return null;
      const text = typeof entry[0] === 'string' ? entry[0].trim() : '';
      if (!text) return null;
      return { text, detected: typeof entry[1] === 'string' ? entry[1] : undefined };
    });
  } catch {
    return null;
  }
}

/**
 * Google's translate_a endpoint — one line per request.
 *
 * The response is a nested array rather than an object: [0] holds the segments,
 * each segment's [0] being the translated chunk, and [2] holds the language it
 * decided the input was. A long lyric line can come back split across several
 * segments, so they are joined rather than taking the first.
 */
async function fetchGoogle(text: string, target: string, signal?: AbortSignal): Promise<Translated | null> {
  const url = `${GOOGLE_ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const res = await fetch(url, { signal: withTimeout(signal), headers: REQ_HEADERS });
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
      const res = await fetch(url, { signal: withTimeout(signal), headers: REQ_HEADERS });
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
    if (signal?.aborted) { resolve(false); return; }
    const waiter: Waiter = {
      cancelled: false,
      grant() {
        signal?.removeEventListener('abort', onAbort);
        if (this.cancelled) return false;
        activeRequests++;
        resolve(true);
        return true;
      },
    };
    const onAbort = () => { waiter.cancelled = true; resolve(false); };
    signal?.addEventListener('abort', onAbort, { once: true });
    waitQueue.push(waiter);
  });
}

function releaseSlot(): void {
  activeRequests--;
  // Skip waiters that gave up while queued — see Waiter.cancelled. The slot
  // stays free rather than being charged to a caller that already returned.
  while (waitQueue.length > 0) {
    if (waitQueue.shift()!.grant()) return;
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
    const batched = await fetchGoogleBatch([trimmed], targetLang, signal);
    if (batched?.[0]) return batched[0];

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

/**
 * Decide what a provider's answer is worth, and record the verdict.
 *
 * Returns the translation to hand back, or null when the line is better left as
 * it is. Both outcomes are remembered, so the same line is not asked about
 * again on the next emit. Shared by the single-line and the batched paths so
 * the two cannot drift apart on what counts as an answer.
 */
function acceptTranslation(key: string, trimmed: string, result: Translated, targetLang: string): string | null {
  // A provider that recognised the line as already being in the target language
  // has nothing to add, and caching its echo would leave the original sitting
  // under itself for the rest of the song.
  if (result.detected && result.detected.split('-')[0] === targetLang) { markNoTranslation(key); return null; }

  // Don't cache if translation is identical to input (same language)
  if (result.text.toLowerCase() === trimmed.toLowerCase()) { markNoTranslation(key); return null; }

  remember(key, result.text);
  return result.text;
}

// ── Public API ──

export interface TranslateResult {
  translation: string;
  cached: boolean;
}

/**
 * Requests already on the wire, keyed the same way as the cache.
 *
 * The window and the presence both want the current line, and they ask
 * independently — the window on every lyric tick, the presence on every push.
 * Without this each opens its own request for the same string: double the
 * traffic for one answer, on the provider that is quickest to rate limit.
 * Latecomers wait on the first caller's promise instead.
 */
const inFlight = new Map<string, Promise<TranslateResult | null>>();

/**
 * Translate a text string from auto-detected language to target language.
 * Uses caching + concurrency limiting. Returns null if translation fails.
 */
export async function translateText(
  text: string,
  targetLang: string,
  signal?: AbortSignal,
): Promise<TranslateResult | null> {
  // Already abandoned — the track moved on before this call was even made.
  // Without this the aborted request still walks all the providers, each fetch
  // rejecting on the dead signal in turn.
  if (signal?.aborted) return null;

  // Skip empty/trivial text
  const trimmed = text.trim();
  if (!isTranslatable(trimmed)) return null;

  // Check cache
  const key = `${trimmed}|${targetLang}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return { translation: cached, cached: true };
  }
  // Asked recently, and the answer was "nothing" — see noTranslation.
  if (recentlyDeclined(key)) return null;

  // Skip if detected language matches target (don't translate EN→EN)
  const detected = detectScriptLang(trimmed);
  if (detected === targetLang) { markNoTranslation(key); return null; }

  // Somebody already asked for this exact line — ride along with their answer
  // rather than opening a second request for it.
  const pending = inFlight.get(key);
  if (pending) return pending;

  const run = (async (): Promise<TranslateResult | null> => {
    const result = await translateOne(trimmed, targetLang, detected, signal);
    if (!result) {
      // An abort is not a verdict on the line — the track simply moved on.
      if (!signal?.aborted) markNoTranslation(key);
      return null;
    }
    const accepted = acceptTranslation(key, trimmed, result, targetLang);
    return accepted === null ? null : { translation: accepted, cached: false };
  })();

  inFlight.set(key, run);
  return run.finally(() => { inFlight.delete(key); });
}

/**
 * Translate many lines at once — how a whole song gets warmed before it plays.
 *
 * The lines go out as one request per chunk rather than one request per line.
 * That is the difference between a three-minute song costing sixty requests and
 * costing two, which is what decides whether the provider is still answering by
 * the second chorus. Chunks share the same semaphore as everything else, so a
 * warm-up cannot starve the line that is on screen right now.
 *
 * A chunk the batch endpoint refuses falls back to per-line translation, so a
 * batch-only outage degrades to the old behaviour rather than to nothing.
 */
export async function translateBatch(
  lines: string[],
  targetLang: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  if (signal?.aborted) return results;

  // Settle everything that needs no request first. Dedupe matters more here
  // than anywhere else: a chorus repeats, and paying for the same line four
  // times is the easiest waste there is to remove.
  const pending: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!isTranslatable(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);

    const key = `${trimmed}|${targetLang}`;
    const hit = cache.get(key);
    if (hit !== undefined) { results.set(trimmed, hit); continue; }
    if (recentlyDeclined(key)) continue;
    if (detectScriptLang(trimmed) === targetLang) { markNoTranslation(key); continue; }
    pending.push(trimmed);
  }
  if (pending.length === 0) return results;

  // Lines somebody is already asking about ride their answer instead of going
  // into this request. Two warm-ups overlapping is the normal case, not the
  // rare one: the player hands over its own official lyrics and a provider's
  // synced set lands a fraction of a second later, and the two are the same
  // song. Without this the second warm-up re-sends every line of the first.
  const riding: Promise<unknown>[] = [];
  const fresh: string[] = [];
  for (const line of pending) {
    const already = inFlight.get(`${line}|${targetLang}`);
    if (already) {
      riding.push(already.then(r => { if (r) results.set(line, r.translation); }, () => {}));
    } else {
      fresh.push(line);
    }
  }

  // Claim the rest, so a warm-up starting while this one is on the wire rides
  // it in turn. Every claim must be settled — see the finally in each chunk.
  const settlers = new Map<string, (r: TranslateResult | null) => void>();
  const claimed = new Map<string, Promise<TranslateResult | null>>();
  for (const line of fresh) {
    const key = `${line}|${targetLang}`;
    let settle!: (r: TranslateResult | null) => void;
    const promise = new Promise<TranslateResult | null>(res => { settle = res; });
    settlers.set(key, settle);
    claimed.set(key, promise);
    inFlight.set(key, promise);
  }

  /** Answer this line's waiters and give up the claim. */
  const settle = (line: string, value: TranslateResult | null): void => {
    const key = `${line}|${targetLang}`;
    const done = settlers.get(key);
    if (!done) return;  // already settled
    settlers.delete(key);
    // Only ever retract our own claim — a later caller may have registered a
    // fresh one under this key by now.
    if (inFlight.get(key) === claimed.get(key)) inFlight.delete(key);
    done(value);
  };

  /** Drop the claim without answering, for lines about to be re-asked singly. */
  const release = (line: string): void => {
    const key = `${line}|${targetLang}`;
    if (inFlight.get(key) === claimed.get(key)) inFlight.delete(key);
  };

  // Chunk on line count *and* URL length — see BATCH_MAX_URL_CHARS.
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkChars = 0;
  for (const line of fresh) {
    const cost = line.length * 3 + 3;  // worst-case percent-encoding, plus "&q="
    if (chunk.length > 0 && (chunk.length >= BATCH_MAX_LINES || chunkChars + cost > BATCH_MAX_URL_CHARS)) {
      chunks.push(chunk);
      chunk = [];
      chunkChars = 0;
    }
    chunk.push(line);
    chunkChars += cost;
  }
  if (chunk.length > 0) chunks.push(chunk);

  await Promise.allSettled([...riding, ...chunks.map(async group => {
    try {
      if (signal?.aborted) return;
      const acquired = await acquireSlot(signal);
      if (!acquired) return;
      let answered: (Translated | null)[] | null;
      try {
        answered = await fetchGoogleBatch(group, targetLang, signal);
      } finally {
        releaseSlot();
      }

      if (!answered) {
        // Batch endpoint down or throttled — ask line by line, which still goes
        // through the cache and the negative cache. The claims are dropped
        // first: translateText registers its own, and would otherwise find ours
        // and wait on a promise only this function can settle.
        for (const line of group) release(line);
        await Promise.allSettled(group.map(async line => {
          const r = await translateText(line, targetLang, signal);
          if (r) results.set(line, r.translation);
          settle(line, r);
        }));
        return;
      }

      for (let i = 0; i < group.length; i++) {
        const line = group[i];
        const key = `${line}|${targetLang}`;
        const entry = answered[i];
        if (!entry) {
          if (!signal?.aborted) markNoTranslation(key);
          settle(line, null);
          continue;
        }
        const accepted = acceptTranslation(key, line, entry, targetLang);
        if (accepted !== null) results.set(line, accepted);
        settle(line, accepted === null ? null : { translation: accepted, cached: false });
      }
    } finally {
      // An abort, a refused slot or a throw mid-loop must not leave a claim
      // standing: whoever is riding it would wait for an answer that is never
      // coming, and the key would block every later request for that line.
      for (const line of group) settle(line, null);
    }
  })]);

  log.info(`Batch translated ${results.size}/${seen.size} lines → ${targetLang} in ${chunks.length} request${chunks.length === 1 ? '' : 's'}`);
  return results;
}

/** Clear the translation cache (memory + disk). */
export function clearTranslationCache(): void {
  cache.clear();
  noTranslation.clear();
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

/**
 * Whether asking about this line could still produce something.
 *
 * False for a line that is already cached, already declined, already on the
 * wire, or made of nothing a translator could work with. The RPC path uses it
 * to decide whether a miss is worth a request, so the common case — an English
 * song with the target left at English — stops allocating a promise per line
 * only to have translateText() drop it one branch later.
 */
export function isTranslationWorthFetching(text: string, targetLang: string): boolean {
  const trimmed = text.trim();
  if (!isTranslatable(trimmed)) return false;
  const key = `${trimmed}|${targetLang}`;
  if (cache.has(key) || inFlight.has(key)) return false;
  if (recentlyDeclined(key)) return false;
  return detectScriptLang(trimmed) !== targetLang;
}

/** Flush cache to disk (call on shutdown). */
export function flushTranslationCache(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushDiskCache();
}
