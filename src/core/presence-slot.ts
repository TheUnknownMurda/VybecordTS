/**
 * One presence card and everything that belongs to it alone.
 *
 * The backend used to hold exactly one of each of these as fields of its own,
 * which is the same as saying it could announce one thing. Announcing several
 * means several of everything that follows a track — the engine keeping its
 * lyrics in time, the fetch that may still be in flight for it, the lyric line
 * the window was last told — and none of what does not: the lyrics cache, the
 * config, the stats and the sources are shared, and stay on the backend.
 *
 * A slot is a place, not a source. Presence 1 is whatever ranks highest right
 * now, presence 2 the next thing playing, and so on; the backend moves the
 * *objects* between positions when the ranking changes, so the engine and the
 * socket follow the track rather than being torn down and rebuilt. `index` is
 * therefore the one field that changes hands — see swapSlots() in backend.ts.
 */

import { LyricsEngine } from '../sync/lyrics-engine.js';
import type { TrackData, LyricLine } from './types.js';

/** What the window is told on each lyric tick. */
export interface LyricsState {
  current: string;
  next: string;
  prev: string;
  progress_ms: number;
  duration_ms: number;
  lyrics?: LyricLine[];
  currentIndex?: number;
  translation?: string;
}

export class PresenceSlot {
  /** Stable identity, for the connection pool — unlike `index`, never changes. */
  readonly id: number;
  /** Position on the profile: 0 is presence 1. Reassigned on swap. */
  index: number;
  readonly engine = new LyricsEngine();
  track: TrackData | null = null;
  trackKey = '';
  cacheKey = '';
  /** Cancels in-flight lyric and cover fetches when the track moves on. */
  fetchAbort: AbortController | null = null;
  /** Thumbnail the last art resolution acted on — see resolveDiscordArt(). */
  artThumbSig = '';
  lastLyricsState: LyricsState | null = null;
  /** Cached per track: avoids WEB_SOURCES.some() on every poll. */
  isWebSource = false;
  /** Grace-period timestamp for an OS session that stopped reporting. */
  idleSince = 0;
  /** Discord application the card is published under; '' before the first. */
  appId = '';
  /** Pending application switch — see APP_ID_SWITCH_DEBOUNCE_MS in backend.ts. */
  appIdSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Application the pending switch will land on. */
  pendingAppId = '';
  /** The source `appId` (or the pending one) was chosen for. */
  appIdSource = '';
  /** Sources already logged as unpublishable for want of an application ID. */
  readonly noAppIdLogged = new Set<string>();

  constructor(index: number) {
    this.id = index;
    this.index = index;
  }

  /** Whether this is the card that counts for stats, history and scrobbling. */
  get primary(): boolean {
    return this.index === 0;
  }

  /** The 1-based name the log and the window use. */
  get name(): string {
    return `P${this.index + 1}`;
  }
}
