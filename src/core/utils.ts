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
