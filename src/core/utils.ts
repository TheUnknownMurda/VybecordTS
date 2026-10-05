/**
 * Shared micro-utilities — zero dependencies, pure functions only.
 * Keeps repetitive patterns DRY across the codebase.
 */

/**
 * Evict the oldest entry from a Map if it exceeds `maxSize`.
 * Maps iterate in insertion order, so the first key is the oldest.
 * Call **after** inserting to ensure the map never exceeds maxSize + 1.
 */
export function evictOldest<K, V>(map: Map<K, V>, maxSize: number): void {
  if (map.size <= maxSize) return;
  const first = map.keys().next().value;
  if (first !== undefined) map.delete(first);
}

/**
 * Evict entries from the front of a Map until its size is at most `maxSize`.
 * Use for bulk eviction (e.g. cache trim after batch inserts).
 */
export function evictUntil<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
    else break;
  }
}

// ── Coercion for pushed payloads ──
//
// Everything the browser extension and Spicetify send arrives as parsed JSON
// with no guarantee beyond "it was a JSON object". The payload interfaces
// describe what the shipped extension sends, not what the socket will actually
// deliver: an extension a version behind, a half-finished field, or a userscript
// someone edited all produce shapes TypeScript has already been told to trust.
//
// The failure that matters is not a wrong value but a wrong *type*. A numeric
// `artist_name` reaches `.split()` several layers down, in code with no reason
// to doubt it, and throws there rather than where the bad data entered. These
// turn that into a boring default at the boundary.

/** Longest pushed text kept. Discord truncates to 128; this is slack, not a target. */
const MAX_TEXT = 300;
/** Longest pushed URL kept. */
const MAX_URL = 2048;

/**
 * A trimmed, length-capped string.
 *
 * A finite number is accepted and stringified — ids in particular arrive as
 * numbers from some scrapers. Anything else becomes '', which every consumer
 * already treats as "not supplied".
 */
export function asText(value: unknown, maxLength = MAX_TEXT): string {
  const raw = typeof value === 'string' ? value
    : typeof value === 'number' && Number.isFinite(value) ? String(value)
    : '';
  const trimmed = raw.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/**
 * An identifier safe to interpolate into a URL.
 *
 * Video ids are pasted straight into watch and thumbnail URLs, and those URLs
 * become Discord button targets. Keeping only the characters real ids use means
 * a malformed one yields a harmless short string rather than a URL with extra
 * query parameters — or an extra URL — grafted onto it.
 */
export function asId(value: unknown, maxLength = 64): string {
  return asText(value, maxLength).replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * `true` only for values that plainly mean it.
 *
 * Deliberately biased to false: these flags gate whether a source claims the
 * presence, and a source that wrongly says "not playing" falls back to the OS
 * media session, while one that wrongly says "playing" holds the presence on
 * nothing. `1` and `'true'` are admitted because they are what a hand-edited
 * userscript is most likely to send instead of a real boolean.
 */
export function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === 'true';
}

/**
 * A non-negative integer, for durations, positions, counts and epoch stamps.
 *
 * NaN and Infinity are the two that actually break things downstream —
 * `Math.min(x, Infinity)`, `new Date(NaN)`, a progress bar divided by NaN — and
 * a negative position runs the presence timer backwards. All three become 0.
 */
export function asNonNegativeInt(value: unknown): number {
  const n = typeof value === 'number' ? value
    : typeof value === 'string' ? Number(value)
    : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(n), Number.MAX_SAFE_INTEGER);
}

/**
 * An http(s) URL, or ''.
 *
 * These end up as Discord button targets, as `details_url`/`state_url`, and
 * behind "open it" in the window. Restricting the scheme at the boundary means
 * no other kind of URI can reach any of them, and it matches what the renderer
 * already insists on before calling openExternal.
 *
 * @param extraSchemes prefixes also allowed — Spotify's own
 *   `spotify:localfileimage:` art URIs are meaningful further down, where they
 *   are recognised and swapped for something Discord can load.
 */
export function asUrl(value: unknown, extraSchemes: readonly string[] = []): string {
  const s = asText(value, MAX_URL);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  const low = s.toLowerCase();
  for (const scheme of extraSchemes) {
    if (low.startsWith(scheme)) return s;
  }
  return '';
}

/** The payload as a property bag, whatever arrived. Never throws. */
export function asRecord(value: unknown): Record<string, unknown> {
  return (value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {};
}
