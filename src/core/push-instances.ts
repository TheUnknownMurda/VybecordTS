/**
 * Several tabs of one site, each pushing on its own.
 *
 * A push source used to keep the last payload it was handed and nothing else,
 * which is the same as saying one tab per site. Two Twitch tabs both push to
 * the same endpoint every couple of seconds, so the source held whichever had
 * spoken last and the presence flipped between the two streams on every push.
 *
 * Kept per instance instead: one entry per tab (or per channel, for a script
 * old enough not to say which tab it is), each with its own freshness clock,
 * so a tab that goes quiet ages out on its own while the others carry on.
 * Insertion order is kept — the stream opened first ranks first among equals.
 */

import { PushFreshness } from './push-freshness.js';

export interface PushInstance<T> {
  key: string;
  data: T;
  /** performance.now() of the last push. */
  receivedAt: number;
  freshness: PushFreshness;
}

export class PushInstances<T> {
  private readonly map = new Map<string, PushInstance<T>>();

  /** Record a push for one instance and hand its entry back. */
  seen(key: string, data: T, now: number): PushInstance<T> {
    let entry = this.map.get(key);
    if (!entry) {
      entry = { key, data, receivedAt: now, freshness: new PushFreshness() };
      this.map.set(key, entry);
    }
    entry.data = data;
    entry.receivedAt = now;
    entry.freshness.seen(now);
    return entry;
  }

  get(key: string): PushInstance<T> | undefined {
    return this.map.get(key);
  }

  remove(key: string): void {
    this.map.delete(key);
  }

  /**
   * Every instance still pushing at the cadence it has been keeping, in the
   * order they first appeared. Stale ones are dropped on the way.
   */
  fresh(now: number): PushInstance<T>[] {
    const out: PushInstance<T>[] = [];
    for (const [key, entry] of this.map) {
      if (entry.freshness.isStale(now)) this.map.delete(key);
      else out.push(entry);
    }
    return out;
  }

  /** The instance that pushed most recently, or null with none fresh. */
  latest(now: number): PushInstance<T> | null {
    let best: PushInstance<T> | null = null;
    for (const entry of this.fresh(now)) {
      if (!best || entry.receivedAt > best.receivedAt) best = entry;
    }
    return best;
  }

  /** The widest window among the instances, for the message that says a source went quiet. */
  get windowSeconds(): number {
    let widest = 0;
    for (const entry of this.map.values()) widest = Math.max(widest, entry.freshness.windowSeconds);
    return widest;
  }
}
