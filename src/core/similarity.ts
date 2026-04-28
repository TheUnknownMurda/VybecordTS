/**
 * String similarity algorithms for lyrics matching.
 * Implements Jaro-Winkler and Levenshtein — same logic as the Rust vybecord_native module.
 */

/** Jaro similarity (0..1). */
function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0.0;

  const matchDist = Math.max(Math.floor(Math.max(len1, len2) / 2) - 1, 0);
  const s1Matches = new Uint8Array(len1);
  const s2Matches = new Uint8Array(len2);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = 1;
      s2Matches[j] = 1;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (
    (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3
  );
}

/** Jaro-Winkler similarity (0..1). Boosts score for common prefix. */
export function jaroWinkler(s1: string, s2: string): number {
  const j = jaro(s1, s2);
  if (j === 0) return 0;

  let prefix = 0;
  const maxPrefix = Math.min(4, Math.min(s1.length, s2.length));
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return j + prefix * 0.1 * (1 - j);
}

/** Levenshtein distance. */
function levenshteinDist(s1: string, s2: string): number {
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0) return len2;
  if (len2 === 0) return len1;

  // Single-row optimization
  const row = new Uint32Array(len2 + 1);
  for (let j = 0; j <= len2; j++) row[j] = j;

  for (let i = 1; i <= len1; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      const val = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = row[j];
      row[j] = val;
    }
  }

  return row[len2];
}

/** Levenshtein similarity (0..1). */
export function levenshteinSim(s1: string, s2: string): number {
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshteinDist(s1, s2) / maxLen;
}

/** Combined similarity: weighted average of Jaro-Winkler (70%) + Levenshtein (30%). */
// LRU memo: avoids recomputing for the same (artist, candidate) pairs in batchScore/fuzzy loops
const simCache = new Map<string, number>();
const SIM_CACHE_MAX = 512;

export function similarity(s1: string, s2: string): number {
  const a = s1.toLowerCase().trim();
  const b = s2.toLowerCase().trim();
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;

  // Order-independent key (similarity is symmetric)
  const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;
  const cached = simCache.get(key);
  if (cached !== undefined) return cached;

  const score = jaroWinkler(a, b) * 0.7 + levenshteinSim(a, b) * 0.3;
  if (simCache.size >= SIM_CACHE_MAX) {
    // Batch eviction: clear entirely (amortized cheaper than per-entry iterator)
    simCache.clear();
  }
  simCache.set(key, score);
  return score;
}

/**
 * Batch-score lyrics candidates against a target track.
 * Returns scored results sorted by score descending.
 */
export function batchScore(
  targetName: string,
  targetCleanName: string,
  targetArtist: string,
  targetAlbum: string,
  targetDurSec: number | null,
  candidates: { trackName: string; artistName: string; albumName?: string; duration?: number }[],
): { index: number; score: number; trackSim: number; artistSim: number; albumSim: number }[] {
  // Also extract primary artist for cross-comparison
  const primaryTarget = targetArtist.split(/[,&]/)[0].trim();

  const results = candidates.map((c, i) => {
    // Score against both raw and clean track name, take best
    const tSim = Math.max(similarity(targetName, c.trackName), similarity(targetCleanName, c.trackName));
    // Best of: full vs full, primary vs primary, full vs primary
    const primaryCand = c.artistName.split(/[,&]/)[0].trim();
    let aSim = similarity(targetArtist, c.artistName);
    aSim = Math.max(aSim, similarity(primaryTarget, primaryCand));
    if (primaryCand !== c.artistName) {
      aSim = Math.max(aSim, similarity(targetArtist, primaryCand));
    }
    const alSim = targetAlbum && c.albumName ? similarity(targetAlbum, c.albumName) : 0;

    let score = tSim * 45 + aSim * 35 + alSim * 10;

    // Duration bonus/penalty
    if (targetDurSec != null && c.duration != null) {
      const diff = Math.abs(targetDurSec - c.duration);
      if (diff <= 2) score += 10;
      else if (diff <= 5) score += 5;
      else if (diff > 15) score -= 10; // Penalty for likely wrong version
    }

    return { index: i, score, trackSim: tSim, artistSim: aSim, albumSim: alSim };
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}
