/**
 * Prime Video push-based track source (via the browser extension).
 *
 * Receives what a Prime Video tab is playing, on primevideo.com or on an
 * Amazon site: the film or the show, the episode, where it is, the poster and
 * the title's page when the page names them, and the subtitles on screen. It
 * turns that into a card the way the other video sources do, with the
 * subtitles as its lyrics.
 *
 * Several tabs at once are several cards at once: one entry per tab, one track
 * per title and episode (see push-instances.ts and kick-source.ts). Two tabs
 * on the same episode are one card.
 *
 * A film is not a song. Nothing is looked up for it (no cover, no lyrics) and
 * it goes in neither the listening history nor Last.fm: see the backend.
 *
 * Falls back to the Windows media session if the extension stops pushing,
 * judged against the cadence it had been keeping (see push-freshness.ts).
 */

import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import { asBool, asNonNegativeInt, asRecord, asText, asUrl } from './utils.js';
import type { LyricLine, TrackData } from './types.js';
import { PushInstances, type PushInstance } from './push-instances.js';
import { SubtitleLines } from './subtitle-lines.js';

const log = createLogger('PrimeVideoSource');

/** Shape of JSON pushed by the extension (sites/primevideo.js). */
export interface PrimeVideoPayload {
  /** Which tab pushed this, so two tabs are two cards (see the same field in twitch-source.ts). */
  tab_id: string;
  /** The film or the show, as the player names it. */
  title: string;
  /** The line under it, as the player writes it ("Season 1, Ep. 3 Name"); '' for a film. */
  episode: string;
  paused: boolean;
  /** The title's page, when the tab is on it; ''. Checked to be on Prime Video or Amazon. */
  page_url: string;
  /** The title's poster, when the player or the page names one; ''. */
  art_url: string;
  position_ms: number;
  duration_ms: number;
  /** The subtitles on screen when the tab pushed, a row per line; '' with none showing or subtitles off. */
  caption: string;
  /** When they last changed, by the tab's clock (epoch ms); 0 if not since this title came on. */
  caption_at: number;
}

/**
 * A title's page: Prime Video's own site or one of the Amazon sites the
 * extension runs on. It becomes a button and a link on the card, so anything
 * else is no link at all.
 */
const RE_TITLE_PAGE = /^https:\/\/(?:[a-z0-9-]+\.)*(?:primevideo\.com|amazon\.(?:com|ca|co\.uk|de|fr|it|es|co\.jp|com\.br|com\.mx|com\.au|in))\/\S*$/i;

/** Coerce a push into the shape above, whatever actually arrived. */
export function normalizePrimeVideoPayload(raw: unknown): PrimeVideoPayload {
  const d = asRecord(raw);
  const page = asUrl(d.page_url);
  const art = asUrl(d.art_url);
  return {
    tab_id: asText(d.tab_id, 32),
    title: asText(d.title, 200),
    episode: asText(d.episode, 200),
    paused: asBool(d.paused),
    page_url: RE_TITLE_PAGE.test(page) ? page : '',
    art_url: /^https:\/\//i.test(art) ? art : '',
    position_ms: asNonNegativeInt(d.position_ms),
    duration_ms: asNonNegativeInt(d.duration_ms),
    // Two rows of about forty characters, and slack for a third.
    caption: asText(d.caption, 400),
    caption_at: asNonNegativeInt(d.caption_at),
  };
}

/**
 * The episode line as the card shows it: "S1 E3 · Name".
 *
 * The player writes it in the viewer's language, "Season 1, Ep. 3 Name",
 * "Saison 1, ép. 3 Name", "Staffel 1, Folge 3 Name", with nothing between the
 * episode's number and its name, which on the card ran the two together.
 * Whatever the words, the shape is the same: a word and a number, a comma, a
 * word and a number, then the name. Anything else is kept as written.
 */
const RE_EPISODE = /^\p{L}+\.?\s*(\d{1,3})\s*[,،、]\s*\p{L}+\.?\s*(\d{1,4})(?:\s*[:.\-–—]\s*|\s+|$)(.*)$/u;

export function episodeLabel(raw: string): string {
  const m = RE_EPISODE.exec(raw);
  if (!m) return raw;
  const name = m[3].trim();
  return `S${Number(m[1])} E${Number(m[2])}${name ? ` · ${name}` : ''}`;
}

/** What a tab is playing, as one key: the title and the episode, as the player names them. */
function pageKey(d: { title: string; episode: string }): string {
  return d.title ? `${d.title}\n${d.episode}`.toLowerCase() : '';
}

/** A card's track id, from the same two names: `pv:<title>/<episode>`. */
function trackIdOf(d: { title: string; episode: string }): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  return `pv:${slug(d.title)}/${slug(d.episode)}`;
}

/** One tab's latest push, plus the subtitles it has shown on this title. */
interface PrimeVideoTab extends PrimeVideoPayload {
  /** Handed on from push to push while the tab stays on the same title and episode. */
  subtitles: SubtitleLines;
}

const NO_LINES: LyricLine[] = [];

/**
 * How far the video may land from where its last push said it would be
 * before it counts as a seek: the same line the lyrics engine draws (see
 * SEEK_DRIFT_MS there), and the same as for a Kick past broadcast.
 */
const SEEK_MS = 4_000;

/** Whether the position moved by more than playing on since the last push explains. */
function seeked(prev: PrimeVideoPayload, next: PrimeVideoPayload, sinceMs: number): boolean {
  const expected = prev.position_ms + (prev.paused ? 0 : sinceMs);
  return Math.abs(next.position_ms - expected) > SEEK_MS;
}

export class PrimeVideoSource {
  /** One entry per tab, or one per title for a script that names no tab. */
  private readonly tabs = new PushInstances<PrimeVideoTab>();
  private _wasActive = false;

  /**
   * Ingest a push from the extension.
   * Called by the web server on POST /api/primevideo.
   */
  update(raw: unknown): PrimeVideoPayload {
    const data = normalizePrimeVideoPayload(raw);
    const now = performance.now();
    const page = pageKey(data);
    const key = data.tab_id || page || 'tab';
    const entry = this.tabs.get(key);
    const prev = entry?.data;
    const samePage = !!prev && pageKey(prev) === page;

    if (!this._wasActive) {
      this._wasActive = true;
      log.info('Prime Video extension connected ✓ — using as primary Prime Video source');
    }

    /*
     * The next episode starts its own lines: the last one's final words do
     * not belong under this one's name, and while they are still on screen
     * (the tab's report not newer than the last it made) they are not taken
     * again. The extension already holds them back; this is the app's half.
     * A skip within the same episode starts the lines over (see
     * SubtitleLines.restart).
     */
    const subtitles = samePage ? prev!.subtitles : new SubtitleLines(prev?.subtitles.changedAt ?? 0);
    if (samePage && seeked(prev!, data, now - entry!.receivedAt)) subtitles.restart();
    subtitles.add(data.caption, data.caption_at, now);
    this.tabs.seen(key, { ...data, subtitles }, now);
    return data;
  }

  /**
   * The subtitle lines for a card, by its track id. From whichever fresh tab
   * on that title has the most, since a second tab with subtitles off reports
   * none. An empty list when no tab has any.
   */
  subtitleLines(trackId: string): LyricLine[] {
    let best = NO_LINES;
    for (const t of this.tabs.fresh(performance.now())) {
      if (trackIdOf(t.data) !== trackId) continue;
      const lines = t.data.subtitles.lines;
      if (lines.length > best.length) best = lines;
    }
    return best;
  }

  /** What one tab should be shown as, or null for nothing (paused, nothing named). */
  private trackFor(t: PushInstance<PrimeVideoTab>, now: number): TrackData | null {
    const d = t.data;
    // A paused film is not playing anything, the same as a paused song.
    if (d.paused || !d.title) return null;
    return {
      track_id: trackIdOf(d),
      track_name: d.title,
      artist_name: episodeLabel(d.episode),
      album_name: '',
      duration_ms: d.duration_ms,
      progress_ms: Math.min(Math.round(d.position_ms + now - t.receivedAt), d.duration_ms || Infinity),
      is_playing: true,
      is_live: false,
      album_art_url: d.art_url,
      spotify_url: '',
      artist_url: '',
      media_source: 'prime_video',
      _received_at: now,
      _from_push: true,
      // The title's page; without one the card links a search for the title.
      video_url: d.page_url || undefined,
    };
  }

  /**
   * One track per title and episode some fresh tab is on. Two tabs on the
   * same one are one card: the one pushed most recently speaks for it.
   */
  getCurrentTracks(): TrackData[] {
    const now = performance.now();
    const byPage = new Map<string, PushInstance<PrimeVideoTab>>();
    for (const t of this.tabs.fresh(now)) {
      const page = pageKey(t.data);
      if (!page) continue;
      const held = byPage.get(page);
      if (!held || t.receivedAt >= held.receivedAt) byPage.set(page, t);
    }
    const out: TrackData[] = [];
    for (const t of byPage.values()) {
      const track = this.trackFor(t, now);
      if (track) out.push(track);
    }
    return out;
  }

  /** The first card, for callers that want one — see getCurrentTracks(). */
  getCurrentTrack(): TrackData | null {
    return this.getCurrentTracks()[0] ?? null;
  }

  /** True while some tab is still pushing at the cadence it has been keeping. */
  get isActive(): boolean {
    const fresh = this.tabs.fresh(performance.now()).length > 0;
    if (!fresh && this._wasActive) {
      this._wasActive = false;
      log.warn(`Prime Video extension stale (>${this.tabs.windowSeconds}s) — falling back to SMTC`);
    }
    return fresh;
  }

  /** Whether the extension reports nothing to show: no fresh tab with a card. */
  get isPaused(): boolean {
    if (!this.isActive) return true;
    return this.getCurrentTracks().length === 0;
  }

  /** The most recent payload from any fresh tab. */
  get latest(): PrimeVideoPayload | null {
    return this.tabs.latest(performance.now())?.data ?? null;
  }
}
