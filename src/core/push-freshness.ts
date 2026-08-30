/**
 * How long a push source may go quiet before it is treated as gone.
 *
 * Every userscript pushes on a timer -- 2.5 seconds when all is well -- so ten
 * seconds of silence used to be a safe verdict. It is not, because a browser
 * throttles timers in a background tab that is not playing audio: Chrome clamps
 * them to roughly once a minute. The app then called the source dead ten
 * seconds into every sixty-second gap, and a stream left open in a background
 * tab produced a sawtooth that never ended -- presence for ten seconds, gone
 * for fifty, a fresh "new track" and a restarted lyrics engine each time round.
 * Measured on a real log: twenty reconnections and fifteen staleness verdicts
 * from one tab nobody had touched.
 *
 * So the window follows the cadence the pushes actually arrive at rather than
 * the one they were written to keep. A tab pushing every 2.5 seconds still
 * clears ten seconds after it closes, which is what the old constant was for; a
 * throttled one is given room rather than being pronounced dead between beats.
 */

/** Never shorter than this: the old fixed window, and what a healthy tab gets. */
const BASE_WINDOW_MS = 10_000;

/**
 * Never longer than this.
 *
 * The gap that sets the window is whatever silence just ended, and that silence
 * can be a laptop lid closed for a night rather than a throttled timer. The cap
 * bounds how long a source that has genuinely gone away can hold the presence,
 * and the next push at a normal cadence pulls the window straight back down.
 */
const MAX_WINDOW_MS = 180_000;

/**
 * Room on top of the observed cadence.
 *
 * One missed push must not be a verdict -- pushes are HTTP requests to a local
 * server and any of them can be late -- so the window is a couple of intervals
 * wide rather than one.
 */
const GAP_FACTOR = 2.5;

export class PushFreshness {
  private lastSeen = 0;
  private windowMs = BASE_WINDOW_MS;
  private seenAny = false;

  /** Record a push. `now` is performance.now(), the clock the sources already use. */
  seen(now: number): void {
    if (this.seenAny) {
      const gap = now - this.lastSeen;
      this.windowMs = Math.min(Math.max(gap * GAP_FACTOR, BASE_WINDOW_MS), MAX_WINDOW_MS);
    }
    this.lastSeen = now;
    this.seenAny = true;
  }

  /** True once the source has been quiet for longer than its own cadence allows. */
  isStale(now: number): boolean {
    return !this.seenAny || (now - this.lastSeen) > this.windowMs;
  }

  /** The window in whole seconds, for the message that says a source went quiet. */
  get windowSeconds(): number {
    return Math.round(this.windowMs / 1_000);
  }
}
