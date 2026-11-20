/**
 * Films and episodes playing in a browser tab, as the extension reports them,
 * for every site that plays them: Prime Video (prime-video-source.ts) and
 * Netflix (netflix-source.ts). The two send the same thing and a card makes
 * the same of it, so the machinery is here and each site only says how it
 * differs: its name, the pages a card may link to, and how its episode line
 * reads.
 *
 * What a tab sends: the film or the show, the episode, where it is, the
 * poster and the title's page when the page names them, and the subtitles on
 * screen. That becomes a card the way the other video sources do, with the
 * subtitles as its lyrics.
 *
 * Several tabs at once are several cards at once: one entry per tab, one
 * track per film or episode (see push-instances.ts and kick-source.ts). Two
 * tabs on the same one are one card.
 *
 * A film is not a song. Nothing is looked up for it (no cover, no lyrics) and
 * it goes in neither the listening history nor Last.fm: see isFilmSource and
 * the backend.
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

/** The sites that play films and episodes, by media_source. */
const FILM_SOURCES: ReadonlySet<string> = new Set(['prime_video', 'netflix']);

/**
 * A card of a film or an episode: watched rather than listened to, never
 * looked up as a song, kept out of the listening history and Last.fm, and
 * given its subtitles as lyrics.
 */
export function isFilmSource(src: string | undefined): boolean {
  return !!src && FILM_SOURCES.has(src);
}

/** Shape of JSON pushed by the extension (sites/primevideo.js, sites/netflix.js). */
export interface FilmPayload {
  /** Which tab pushed this, so two tabs are two cards (see the same field in twitch-source.ts). */
  tab_id: string;
  /**
   * The site's own id for the film or episode, when its address carries one
   * (Netflix's /watch/<id>); '' otherwise (Prime Video). With one, it is what
   * a card is keyed by, so a title that arrives late does not start it over.
   */
  video_id: string;
  /** The film or the show, as the player names it. */
  title: string;
  /** The line under it, as the player writes it ("Season 1, Ep. 3 Name", "E3 Name"); '' for a film. */
  episode: string;
  paused: boolean;
  /** The title's page, when the tab knows it; ''. Checked against the site's own pages. */
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

/** What one film site does its own way. */
export interface FilmSite {
  /** The media_source of its cards. */
  source: string;
  /** Its name, for the log. */
  name: string;
  /** What its track ids start with, before a colon: `pv`, `nf`. */
  idPrefix: string;
  /**
   * The pages a card may link to. A link becomes a button and a link on the
   * card, so anything else is no link at all.
   */
  titlePage: RegExp;
  /** The episode line as the card shows it, from the line the player writes. */
  episodeLabel(raw: string): string;
}

/** A site's id for a film or an episode: letters, digits, '-' and '_' only, else none. */
const RE_VIDEO_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** Coerce a push into the shape above, whatever actually arrived. */
export function normalizeFilmPayload(raw: unknown, site: FilmSite): FilmPayload {
  const d = asRecord(raw);
  const page = asUrl(d.page_url);
  const art = asUrl(d.art_url);
  // Read past the limit, so that a longer one is refused rather than cut to fit.
  const id = asText(d.video_id, 64);
  return {
    tab_id: asText(d.tab_id, 32),
    video_id: RE_VIDEO_ID.test(id) ? id : '',
    title: asText(d.title, 200),
    episode: asText(d.episode, 200),
    paused: asBool(d.paused),
    page_url: site.titlePage.test(page) ? page : '',
    art_url: /^https:\/\//i.test(art) ? art : '',
    position_ms: asNonNegativeInt(d.position_ms),
    duration_ms: asNonNegativeInt(d.duration_ms),
    // Two rows of about forty characters, and slack for a third.
    caption: asText(d.caption, 400),
    caption_at: asNonNegativeInt(d.caption_at),
  };
}

/**
 * What a tab is playing, as one key: the site's id for it when the tab sends
 * one, else the title and the episode as the player names them. '' for
 * nothing named at all.
 */
function pageKey(d: { video_id: string; title: string; episode: string }): string {
  if (d.video_id) return `#${d.video_id}`;
  return d.title ? `${d.title}\n${d.episode}`.toLowerCase() : '';
}

/** One tab's latest push, plus the subtitles it has shown on this title. */
interface FilmTab extends FilmPayload {
  /** Handed on from push to push while the tab stays on the same film or episode. */
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
function seeked(prev: FilmPayload, next: FilmPayload, sinceMs: number): boolean {
  const expected = prev.position_ms + (prev.paused ? 0 : sinceMs);
  return Math.abs(next.position_ms - expected) > SEEK_MS;
}

export class FilmSource {
  /** One entry per tab, or one per title for a script that names no tab. */
  private readonly tabs = new PushInstances<FilmTab>();
  private _wasActive = false;
  private readonly log: ReturnType<typeof createLogger>;

  constructor(private readonly site: FilmSite) {
    this.log = createLogger(`${site.name.replace(/\s+/g, '')}Source`);
  }

  /**
   * A card's track id: `<prefix>:<id>` for a site that names it by an id,
   * else `<prefix>:<title>/<episode>` from the two names.
   */
  private trackIdOf(d: { video_id: string; title: string; episode: string }): string {
    if (d.video_id) return `${this.site.idPrefix}:${d.video_id}`;
    const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 100);
    return `${this.site.idPrefix}:${slug(d.title)}/${slug(d.episode)}`;
  }

  /** Ingest a push from the extension, as the web server hands it over. */
  update(raw: unknown): FilmPayload {
    const data = normalizeFilmPayload(raw, this.site);
    const now = performance.now();
    const page = pageKey(data);
    const key = data.tab_id || page || 'tab';
    const entry = this.tabs.get(key);
    const prev = entry?.data;
    const samePage = !!prev && pageKey(prev) === page;

    if (!this._wasActive) {
      this._wasActive = true;
      this.log.info(`${this.site.name} extension connected ✓ — using as primary ${this.site.name} source`);
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
      if (this.trackIdOf(t.data) !== trackId) continue;
      const lines = t.data.subtitles.lines;
      if (lines.length > best.length) best = lines;
    }
    return best;
  }

  /** What one tab should be shown as, or null for nothing (paused, nothing named). */
  private trackFor(t: PushInstance<FilmTab>, now: number): TrackData | null {
    const d = t.data;
    // A paused film is not playing anything, the same as a paused song. A tab
    // that has not seen the title yet has nothing to put on a card.
    if (d.paused || !d.title) return null;
    return {
      track_id: this.trackIdOf(d),
      track_name: d.title,
      artist_name: this.site.episodeLabel(d.episode),
      album_name: '',
      duration_ms: d.duration_ms,
      progress_ms: Math.min(Math.round(d.position_ms + now - t.receivedAt), d.duration_ms || Infinity),
      is_playing: true,
      is_live: false,
      album_art_url: d.art_url,
      spotify_url: '',
      artist_url: '',
      media_source: this.site.source,
      _received_at: now,
      _from_push: true,
      // The title's page; without one the card links a search for the title.
      video_url: d.page_url || undefined,
    };
  }

  /**
   * One track per film or episode some fresh tab is on. Two tabs on the same
   * one are one card: the one pushed most recently speaks for it.
   */
  getCurrentTracks(): TrackData[] {
    const now = performance.now();
    const byPage = new Map<string, PushInstance<FilmTab>>();
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
      this.log.warn(`${this.site.name} extension stale (>${this.tabs.windowSeconds}s) — falling back to SMTC`);
    }
    return fresh;
  }

  /** Whether the extension reports nothing to show: no fresh tab with a card. */
  get isPaused(): boolean {
    if (!this.isActive) return true;
    return this.getCurrentTracks().length === 0;
  }

  /** The most recent payload from any fresh tab. */
  get latest(): FilmPayload | null {
    return this.tabs.latest(performance.now())?.data ?? null;
  }
}
