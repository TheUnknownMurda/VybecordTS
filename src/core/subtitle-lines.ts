/**
 * A film's or an episode's subtitles, cut into the lines the card shows.
 *
 * Prime Video's player shows subtitles in cues: one or two rows that come on
 * together, stay a second or more, and give way to the next. The extension
 * reports the rows on screen whenever they change (see sites/primevideo.js).
 * Unlike Kick's captions (live-captions.ts), whose overlay is a window of
 * words that moves a few at a time, nothing needs stitching back together:
 * each row becomes a line of its own, stamped when its cue came on.
 *
 * A line per row rather than per cue, because the card is two lines of about
 * forty characters and the rows of a cue are already cut to about that: two
 * rows joined on one line ran past what the card shows. So a cue of two rows
 * fills the card, the way it fills the bottom of the screen, and a cue of one
 * goes under the row before it, as Kick's newest line goes under the one
 * before (see setLiveLines in the lyrics engine).
 *
 * A cue that starts with the rows the last one ended with, as a second
 * speaker's answer sometimes does ("- Ready?" then "- Ready?" over "- No."),
 * only adds what is new: the rest is on the card already.
 */

import type { LyricLine } from './types.js';

/** Lines kept: the card shows two, the window a few more. The same as live-captions.ts. */
const MAX_LINES = 40;
/** Rows a cue may take on the card, which has two lines. */
const MAX_ROWS = 2;

/** A cue's rows as the card shows them: none empty, at most MAX_ROWS. */
function rowsOf(text: string): string[] {
  const rows = text.split('\n').map((r) => r.replace(/\s+/g, ' ').trim()).filter(Boolean);
  // A third row, a speaker's name over two rows of what they say now and then,
  // joins the one under it rather than pushing the first off the card.
  while (rows.length > MAX_ROWS) rows.splice(0, 2, `${rows[0]} ${rows[1]}`);
  return rows;
}

export class SubtitleLines {
  /** The lines, oldest first. A new array whenever one is added. */
  private view: LyricLine[] = [];
  /** The rows on screen as of the last report; none while no subtitle shows. */
  private onScreen: string[] = [];
  /** When the subtitles last changed, as the tab reported it; 0 before any report. */
  private lastChange: number;

  /**
   * @param since  when the subtitles last changed in the tab before these
   *   lines' title came on: a report no newer than that is the last title's.
   */
  constructor(since = 0) {
    this.lastChange = since;
  }

  /** The lines, oldest first: a new array when one is added, the same one otherwise. */
  get lines(): LyricLine[] {
    return this.view;
  }

  /** When the subtitles last changed, by the tab's clock, as far as these lines know. */
  get changedAt(): number {
    return this.lastChange;
  }

  /**
   * Take one report of what the subtitles say, one row per line of `text`.
   *
   * `changedAt` is when the tab saw them change (the tab's clock): the same
   * report sent again on the tab's regular beat carries the same one and adds
   * nothing. `now` stamps the lines, on the app's clock. Returns whether
   * `lines` changed.
   */
  add(text: string, changedAt: number, now: number): boolean {
    if (changedAt <= this.lastChange) return false;
    this.lastChange = changedAt;
    const rows = rowsOf(text);
    /*
     * The same rows as the last report are not a new cue, though something
     * changed in between: the player cleared them for a moment the tab saw and
     * the app did not. Counted again they read on the card as said twice. A
     * cue said twice over a gap the app saw (an empty report between) is
     * counted twice, as it should be.
     */
    const kept = this.keptRows(rows);
    this.onScreen = rows;
    const fresh = rows.slice(kept);
    if (!fresh.length) return false;
    const last = this.view[this.view.length - 1];
    // Strictly increasing, so a line keeps a time no other line has, as in
    // live-captions.ts.
    const first = last ? Math.max(Math.round(now), last.time + 1) : Math.round(now);
    const added = fresh.map((row, i): LyricLine => (i === 0
      ? { time: first, text: row }
      : { time: first + i, text: row, withPrevious: true }));
    this.view = [...this.view, ...added].slice(-MAX_LINES);
    return true;
  }

  /**
   * Start the lines over where the video now is, after a seek: the ones
   * already cut were said somewhere else in it, and beside the first line said
   * after the jump they would read as what is being said now.
   *
   * What is on screen still counts as seen. The player can go on showing the
   * cue from before the jump for a moment, and taken afresh it would open the
   * new lines.
   */
  restart(): void {
    this.view = [];
  }

  /** How many rows at the start of `rows` are the rows the last report ended with. */
  private keptRows(rows: string[]): number {
    const shown = this.onScreen;
    for (let k = Math.min(shown.length, rows.length); k > 0; k--) {
      let same = true;
      for (let i = 0; i < k && same; i++) same = shown[shown.length - k + i] === rows[i];
      if (same) return k;
    }
    return 0;
  }
}
