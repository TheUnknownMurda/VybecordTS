import type { LyricLine } from './types.js';

const LRC_TIMESTAMP = /\[(\d+):(\d+(?:\.\d+)?)]/g;
const LRC_LINE = /^((?:\[\d+:\d+(?:\.\d+)?])+)(.*)/;

/**
 * Parse an LRC string into an array of timed lyric lines.
 * Each line: { time: ms, text: string }
 *
 * Handles:
 *   - Standard: [mm:ss.xx]text
 *   - Multi-timestamp: [01:30.00][02:45.00]same text (expands to 2 lines)
 *   - Sorts by time (not guaranteed in all LRC sources)
 *   - Merges consecutive identical lines (reduces wasted timer fires)
 */
export function parseLrc(lrcString: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrcString.split('\n')) {
    const lineMatch = LRC_LINE.exec(raw);
    if (!lineMatch) continue;
    const timestamps = lineMatch[1];
    const text = lineMatch[2].trim();

    // Extract all timestamps from this line (multi-timestamp support)
    let m: RegExpExecArray | null;
    LRC_TIMESTAMP.lastIndex = 0;
    while ((m = LRC_TIMESTAMP.exec(timestamps)) !== null) {
      const minutes = parseInt(m[1], 10);
      const seconds = parseFloat(m[2]);
      const timeMs = Math.round((minutes * 60 + seconds) * 1000);
      lines.push({ time: timeMs, text });
    }
  }

  // Sort by time (some LRC files are out of order, especially with multi-timestamps)
  lines.sort((a, b) => a.time - b.time);

  // Remove empty-text lines (instrumental markers) but keep all duplicates
  // Repeated lines (choruses, ad-libs) are crucial for lyrics fidelity
  return lines.filter(line => line.text);
}

/**
 * Binary search: find the index of the lyric line active at `progressMs`.
 * Returns the index of the last line whose time <= progressMs, or -1 if before first line.
 */
export function findLyricIndex(lyrics: LyricLine[], progressMs: number): number {
  let lo = 0;
  let hi = lyrics.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lyrics[mid].time <= progressMs) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hi;
}

