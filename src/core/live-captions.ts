/**
 * A Kick stream's captions, live or a past broadcast's, cut into lines the
 * card can show.
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
 * into lines. Cutting the window itself into lines was the obvious shortcut and
 * it does not hold: every new word shifts every boundary, so the card would
 * never show the same line twice.
 *
 * How a report is matched up: the words already taken from earlier reports end
 * somewhere inside the new one, and the longest run at its start that equals
 * the end of what was taken says where. Everything after that run is new. The
 * last few new words are held back until a later report agrees with them or
 * the speaker pauses, because those are the ones still being rewritten.
 *
 * The line being said is handed out with the finished ones, as it grows, and
 * the card shows it under the line before: the way Kick's own captions roll.
 * Lines used to be handed out only once finished, and a line was finished
 * whenever the overlay sat still for a second. The stream's captions move in
 * steps two seconds apart, so that was after every step: replaying five
 * minutes of a real broadcast's captions, a quarter of the lines were one or
 * two words, and the card showed the newest words 1.3 seconds after the player
 * did. Now a line ends when it is full, when a sentence ends, when the speaker
 * pauses or when the overlay empties, and the words still being guessed at
 * are shown as they stand, to be put right in place. The same replay has the
 * newest words on the card as the player shows them, a quarter more words on
 * the card at a time, and 90% of what was said in the lines: nearly all that
 * Kick's player itself showed.
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
 * less. Held-back words are still shown, on the line being said; holding them
 * back only keeps them out of the transcript, where they could no longer be
 * put right.
 */
const HOLD_BACK_SPEECH = 5;
const HOLD_BACK_STREAM = 2;
/** An overlay unchanged this long has stopped being rewritten for now: all of it is shown. */
const CAPTION_SETTLE_MS = 1200;
/**
 * An overlay unchanged this long means the speaker paused: what was held back
 * is final, the line ends, and what is said next starts a new one.
 *
 * Longer than one step of the stream's captions, which arrive two seconds
 * apart. Both used to happen once the overlay had been still for 1.2 seconds,
 * which was before every step: a line was cut at each one, and the word the
 * next step puts right was taken before it did, "min" for "mind", "ulti" for
 * "ultimate".
 */
const PAUSE_MS = 3000;
/** Lines kept: the card shows two, the window a few more. */
const MAX_LINES = 40;
/** Words of the transcript kept to match the next report against. */
const MATCH_WORDS = 40;

/** A word as compared, not as shown: case and punctuation are the recogniser's to change. */
function key(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
}

/** How wide these words are on one line, in characters. */
function width(words: string[]): number {
  return words.reduce((sum, w) => sum + w.length + 1, -1);
}

export class LiveCaptions {
  /** Finished lines, oldest first. A new array whenever one is added. */
  private done: LyricLine[] = [];
  /** What `lines` hands out: the finished lines and the one being said. */
  private view: LyricLine[] = [];
  /** Whether `done` changed since `view` was made. */
  private stale = false;
  /** Words of the line being said that are final. */
  private open: string[] = [];
  /** The time the line being said goes by, from when it first showed a word; 0 while there is none. */
  private openTime = 0;
  /** The transcript's last words, as compared — what the next report must continue. */
  private taken: string[] = [];
  /** The last report's words that were held back. They end the line being said. */
  private pending: string[] = [];
  /** When the overlay last changed, as the tab reported it; 0 before any report. */
  private lastChange = 0;

  /**
   * The finished lines, oldest first, and last the one being said, marked
   * `open`: its words can still change, and more can join it. A new array
   * whenever any text on it changes, and the same one otherwise.
   */
  get lines(): LyricLine[] {
    return this.view;
  }

  /**
   * Take one report of what the overlay shows.
   *
   * `changedAt` is when the tab saw it change (the tab's clock), which tells a
   * new report from the same one sent again on the tab's regular beat;
   * `ageMs` is how long it had been unchanged when sent. `fromStream` says the
   * captions came with the stream rather than from speech recognition. `now`
   * stamps the lines, on the app's clock. Returns whether `lines` changed.
   */
  add(text: string, changedAt: number, ageMs: number, fromStream: boolean, now: number): boolean {
    const before = this.view;
    // An older report than one already taken arrived late: it says nothing new.
    if (changedAt < this.lastChange) return false;
    const still = ageMs >= PAUSE_MS;

    if (changedAt === this.lastChange) {
      // The same overlay again, which once it has stayed still is a pause.
      if (still) this.pause(now);
      else this.makeRoom(fromStream, ageMs, now);
      return this.publish(now) !== before;
    }
    this.lastChange = changedAt;

    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) {
      // The overlay emptied: the speaker stopped.
      this.pause(now);
      /*
       * What comes next starts afresh rather than continuing these words, but
       * the last one is kept to be recognised. The stream's captions open what
       * is said after a pause with the word said last before it, again: on a
       * real broadcast's captions, nine pauses in ten, so "some unlucky
       * moment" was followed on the card by "moment good job on the boat".
       */
      this.taken = this.taken.slice(-1);
      return this.publish(now) !== before;
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
    if (run === 0 && (this.taken.length || this.open.length)) this.finishLine(now);
    // The rest of the held-back words, as the report now spells them, and
    // whatever came after them.
    const fresh = words.slice(Math.max(0, run - held));
    const keep = Math.min(fromStream ? HOLD_BACK_STREAM : HOLD_BACK_SPEECH, fresh.length);
    this.take(fresh.slice(0, fresh.length - keep), now);
    this.pending = fresh.slice(fresh.length - keep);
    // First heard of after it had already gone still.
    if (still) this.pause(now);
    else this.makeRoom(fromStream, ageMs, now);
    return this.publish(now) !== before;
  }

  /**
   * Start the lines over where a past broadcast now is, after a seek.
   *
   * The lines already cut go. The words on the overlay are kept, but only to
   * be recognised: it can go on showing what was said before the jump for a
   * moment (speech recognition's window certainly does), and taken afresh
   * those words would open the new lines. So the report the overlay was last
   * changed by still counts as seen, and what was held back from it joins the
   * words to match against instead of the transcript.
   */
  restart(): void {
    this.done = [];
    this.view = [];
    this.open = [];
    this.openTime = 0;
    this.taken = [...this.taken, ...this.pending.map(key)].slice(-MATCH_WORDS);
    this.pending = [];
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

  /**
   * Held-back words that no longer fit on the line being said open the next
   * one, and the line is finished: the words before them are final, and so are
   * the held-back words that fit, which stay where the card already shows
   * them. That is safe with the stream's captions, which only ever put right
   * their last word, and that one is the word that does not fit; and with any
   * overlay that has settled. Speech still being rewritten waits instead: the
   * words that do not fit stay off the card until a report takes them, half a
   * second or so on. Finishing the line on the words already final alone
   * left it short (a third more lines from speech) and moved the ones shown
   * at its end down to the next.
   */
  private makeRoom(fromStream: boolean, ageMs: number, now: number): void {
    if (width([...this.open, ...this.pending]) <= MAX_LINE_CHARS) return;
    if (!fromStream && ageMs < CAPTION_SETTLE_MS) return;
    let fit = 0;
    while (width([...this.open, ...this.pending.slice(0, fit + 1)]) <= MAX_LINE_CHARS) fit++;
    this.take(this.pending.slice(0, fit), now);
    this.pending = this.pending.slice(fit);
    this.finishLine(now);
  }

  /** The speaker paused: what was held back is final, and so is the line. */
  private pause(now: number): void {
    this.take(this.pending, now);
    this.pending = [];
    this.finishLine(now);
  }

  /** Add words to the transcript, finishing a line whenever one is full. */
  private take(words: string[], now: number): void {
    for (const word of words) {
      if (this.open.length && width([...this.open, word]) > MAX_LINE_CHARS) this.finishLine(now);
      this.stamp(now);
      this.open.push(word);
      this.taken.push(key(word));
      // A sentence that ends ends the line, when there is enough of it to read.
      if (/[.?!…]["')\]]*$/.test(word) && this.open.length >= 4) this.finishLine(now);
    }
    if (this.taken.length > MATCH_WORDS) this.taken = this.taken.slice(-MATCH_WORDS);
  }

  /** Give the line being said its time, when it is only now starting. */
  private stamp(now: number): void {
    if (this.openTime) return;
    const last = this.done[this.done.length - 1];
    // Strictly increasing, so a line keeps a time no other line has: the
    // engine finds its place again by it once older lines have been dropped.
    this.openTime = last ? Math.max(Math.round(now), last.time + 1) : Math.round(now);
  }

  private finishLine(now: number): void {
    if (!this.open.length) return;
    this.stamp(now);
    this.done = [...this.done, { time: this.openTime, text: this.open.join(' ') }].slice(-MAX_LINES);
    this.stale = true;
    this.open = [];
    this.openTime = 0;
  }

  /** Make `lines` say what is now known, in a new array only when its text changed. */
  private publish(now: number): LyricLine[] {
    const words = [...this.open];
    // The held-back words that fit, after the final ones.
    for (const word of this.pending) {
      if (words.length && width([...words, word]) > MAX_LINE_CHARS) break;
      words.push(word);
    }
    const text = words.join(' ');
    if (text) this.stamp(now);
    else this.openTime = 0;
    const last = this.view[this.view.length - 1];
    if (!this.stale && (last?.open ? last.text : '') === text) return this.view;
    this.stale = false;
    this.view = text
      ? [...this.done, { time: this.openTime, text, open: true }].slice(-MAX_LINES)
      : this.done;
    return this.view;
  }
}
