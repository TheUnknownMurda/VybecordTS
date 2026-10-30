/**
 * A live stream's captions, cut into lines the card can show.
 *
 * Kick draws its captions in one overlay on the player, and the extension
 * reports what that overlay says whenever it changes (see sites/kick.js). What
 * it says is a window, not a line: with Kick's "browser" captions — Chrome's
 * own speech recognition on the stream's sound — it is the last twenty words
 * heard, the newest few still being guessed at and rewritten; with captions
 * the stream carries, it is the last two lines of Kick's own roll-up. Either
 * way each report repeats most of the one before and drops a few words off the
 * front, and the words at the end may yet change.
 *
 * So the reports are stitched back into one running transcript here and cut
 * into lines that do not move once cut. Cutting the window itself into lines
 * was the obvious shortcut and it does not hold: every new word shifts every
 * boundary, so the card would never show the same line twice.
 *
 * How a report is matched up: the words already taken from earlier reports end
 * somewhere inside the new one, and the longest run at its start that equals
 * the end of what was taken says where. Everything after that run is new. The
 * last few new words are held back until a later report agrees with them or
 * the overlay goes still, because those are the ones still being rewritten.
 *
 * Checked against simulated streams (the harness is not in the repo): on
 * stream captions fed through a copy of Kick's own roll-up, every word came out
 * once and in order; on speech that was rewritten as it went, the word count
 * came out right and the words that differ are rewrites made after a word was
 * already taken.
 */

import type { LyricLine } from './types.js';

/** Longest line, in characters: about what the card shows before cutting it off. */
const MAX_LINE_CHARS = 40;
/**
 * New words held back for a later report to confirm.
 *
 * Speech recognition rewrites a guess until it has heard the rest of the
 * phrase, often several words back; on a simulated stream that rewrote one new
 * word in three until its phrase was final, holding back three words let 6% of
 * them through wrong, five let 1%. The stream's own captions only ever revise
 * their last word or two (Kick's roll-up allows for two), so they are held back
 * less and reach the card sooner.
 */
const HOLD_BACK_SPEECH = 5;
const HOLD_BACK_STREAM = 2;
/** An overlay unchanged this long has stopped being rewritten: take all of it. */
const CAPTION_SETTLE_MS = 1200;
/** Lines kept: the card shows two, the window a few more. */
const MAX_LINES = 40;
/** Words of the transcript kept to match the next report against. */
const MATCH_WORDS = 40;

/** A word as compared, not as shown: case and punctuation are the recogniser's to change. */
function key(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
}

export class LiveCaptions {
  /** Finished lines, oldest first. A new array whenever one is added. */
  private _lines: LyricLine[] = [];
  /** Words of the line being built. */
  private open: string[] = [];
  private openSince = 0;
  /** The transcript's last words, as compared — what the next report must continue. */
  private taken: string[] = [];
  /** The last report's words that were held back. */
  private pending: string[] = [];
  /** When the overlay last changed, as the tab reported it; 0 before any report. */
  private lastChange = 0;

  get lines(): LyricLine[] {
    return this._lines;
  }

  /**
   * Take one report of what the overlay shows.
   *
   * `changedAt` is when the tab saw it change (the tab's clock), which tells a
   * new report from the same one sent again on the tab's regular beat;
   * `ageMs` is how long it had been unchanged when sent. `fromStream` says the
   * captions came with the stream rather than from speech recognition. `now`
   * stamps the lines, on the app's clock. Returns whether a line was finished.
   */
  add(text: string, changedAt: number, ageMs: number, fromStream: boolean, now: number): boolean {
    const before = this._lines;
    // An older report than one already taken arrived late: it says nothing new.
    if (changedAt < this.lastChange) return false;
    const settled = ageMs >= CAPTION_SETTLE_MS;

    if (changedAt === this.lastChange) {
      // The same overlay again. Once it has gone still, what was held back
      // is final, and the pause ends the line.
      if (settled && (this.pending.length || this.open.length)) {
        this.take(this.pending, now);
        this.pending = [];
        this.finishLine();
      }
      return this._lines !== before;
    }
    this.lastChange = changedAt;

    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) {
      // The overlay emptied: the speaker stopped. Whatever was on it was final,
      // and what comes next starts afresh rather than continuing these words.
      this.take(this.pending, now);
      this.pending = [];
      this.finishLine();
      this.taken = [];
      return this._lines !== before;
    }

    /*
     * Matched against the words held back as well as the ones taken: the
     * window can drop words off its front faster than they are confirmed, and
     * a report that starts among the held-back words still continues the
     * transcript. Matched against the taken words alone, it read as a new
     * sentence and the held-back words came out twice.
     */
    const held = this.pending.length;
    const run = this.overlap(words.map(key), [...this.taken, ...this.pending.map(key)]);
    // Held-back words the report no longer shows were the last of what was said.
    const gone = Math.max(0, held - run);
    this.take(this.pending.slice(0, gone), now);
    if (run === 0 && (this.taken.length || this.open.length)) this.finishLine();
    // The rest of the held-back words, as the report now spells them, and
    // whatever came after them.
    const fresh = words.slice(Math.max(0, run - held));
    const keep = settled ? 0 : Math.min(fromStream ? HOLD_BACK_STREAM : HOLD_BACK_SPEECH, fresh.length);
    this.take(fresh.slice(0, fresh.length - keep), now);
    this.pending = fresh.slice(fresh.length - keep);
    if (settled) this.finishLine();
    return this._lines !== before;
  }

  /** Forget everything: a new page, or a stream that went off the air. */
  reset(): void {
    this._lines = [];
    this.open = [];
    this.taken = [];
    this.pending = [];
    this.lastChange = 0;
  }

  /**
   * How many words at the start of a report continue the end of `known`.
   *
   * The longest run that matches, allowing up to half its words to differ.
   * The recogniser rewrites words after they were first shown, held back or
   * not, and refusing the match over them takes the whole window again as new:
   * twenty words said twice. Taking a run for a match that was not one costs a
   * word or two at most, so the doubt goes that way. A run of one must match
   * exactly, or any "the" would do. Requiring the run's first word to match
   * was tried and made it far worse: that word is often one taken before the
   * recogniser corrected it.
   */
  private overlap(keys: string[], known: string[]): number {
    for (let n = Math.min(keys.length, known.length); n > 0; n--) {
      const from = known.length - n;
      const allowed = Math.floor(n / 2);
      let misses = 0;
      for (let i = 0; i < n && misses <= allowed; i++) {
        if (keys[i] !== known[from + i]) misses++;
      }
      if (misses <= allowed) return n;
    }
    return 0;
  }

  /** Add words to the transcript, finishing a line whenever one is full. */
  private take(words: string[], now: number): void {
    for (const word of words) {
      const len = this.open.reduce((sum, w) => sum + w.length + 1, 0) + word.length;
      if (this.open.length && len > MAX_LINE_CHARS) this.finishLine();
      if (!this.open.length) this.openSince = now;
      this.open.push(word);
      this.taken.push(key(word));
      // A sentence that ends ends the line, when there is enough of it to read.
      if (/[.?!…]["')\]]*$/.test(word) && this.open.length >= 4) this.finishLine();
    }
    if (this.taken.length > MATCH_WORDS) this.taken = this.taken.slice(-MATCH_WORDS);
  }

  private finishLine(): void {
    if (!this.open.length) return;
    const last = this._lines[this._lines.length - 1];
    // Strictly increasing, so a line keeps a time no other line has: the
    // engine finds its place again by it once older lines have been dropped.
    const time = last ? Math.max(Math.round(this.openSince), last.time + 1) : Math.round(this.openSince);
    this._lines = [...this._lines, { time, text: this.open.join(' ') }].slice(-MAX_LINES);
    this.open = [];
  }
}
