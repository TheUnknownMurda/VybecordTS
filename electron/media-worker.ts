/**
 * Media worker — hosts the WinRT addon on its own thread.
 *
 * Why a worker at all: Electron initialises its main thread as a single-threaded
 * COM apartment (STA) for Windows shell integration. The addon's WinRT calls
 * expect a multi-threaded apartment, and in an STA thread
 * `getMediaSessions()` never returns — it blocks forever, with no error to
 * catch. A worker thread gets its own apartment, so the addon behaves normally
 * there. (Plain Node has no such conflict, which is why this only shows up once
 * the backend moves into Electron.)
 *
 * The thread does no interpretation: it forwards raw WinRT state to the main
 * thread, where NativeMediaSource owns the timing anchors and the session
 * priority rules.
 */

import { parentPort } from 'node:worker_threads';

// Mirrors @coooookies/windows-smtc-monitor's binding.d.ts.
interface MediaProps {
  title: string; artist: string; albumTitle: string; albumArtist: string;
  genres: string[]; albumTrackCount: number; trackNumber: number;
  thumbnail?: Buffer;
}
interface PlaybackInfo { playbackStatus: number; playbackType: number }
interface TimelineProps { position: number; duration: number }
interface MediaInfo {
  sourceAppId: string; media: MediaProps; playback: PlaybackInfo;
  timeline: TimelineProps; lastUpdatedTime: number;
}

/** worker → main */
export type WorkerOut =
  | { t: 'ready'; sessions: MediaInfo[] }
  | { t: 'added'; info: MediaInfo }
  | { t: 'removed'; id: string }
  | { t: 'media'; id: string; media: MediaProps }
  | { t: 'timeline'; id: string; timeline: TimelineProps }
  | { t: 'playback'; id: string; playback: PlaybackInfo }
  | { t: 'resync'; id: string; info: MediaInfo | null }
  | { t: 'error'; message: string };

/** main → worker */
export type WorkerIn =
  | { t: 'resync'; id: string }
  | { t: 'stop' };

const port = parentPort;
if (!port) throw new Error('media-worker must be run as a worker thread');

const post = (msg: WorkerOut): void => port.postMessage(msg);

let monitor: { destroy(): void } | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const addon = require('@coooookies/windows-smtc-monitor');
  const { SMTCMonitor } = addon as {
    SMTCMonitor: {
      new(): {
        sessions: MediaInfo[];
        on(ev: string, cb: (...a: any[]) => void): void;
        destroy(): void;
      };
      getMediaSessions(): MediaInfo[];
      getMediaSessionByAppId(id: string): MediaInfo | null;
    };
  };

  const mon = new SMTCMonitor();
  monitor = mon;

  mon.on('session-added', (_id: string, info: MediaInfo) => post({ t: 'added', info }));
  mon.on('session-removed', (id: string) => post({ t: 'removed', id }));
  mon.on('session-media-changed', (id: string, media: MediaProps) => post({ t: 'media', id, media }));
  mon.on('session-timeline-changed', (id: string, timeline: TimelineProps) => post({ t: 'timeline', id, timeline }));
  mon.on('session-playback-changed', (id: string, playback: PlaybackInfo) => post({ t: 'playback', id, playback }));

  // Seed the main thread with whatever is already open.
  post({ t: 'ready', sessions: SMTCMonitor.getMediaSessions() });

  port.on('message', (msg: WorkerIn) => {
    if (msg.t === 'stop') {
      try { mon.destroy(); } catch { /* already gone */ }
      process.exit(0);
    }
    if (msg.t === 'resync') {
      let info: MediaInfo | null = null;
      try {
        info = SMTCMonitor.getMediaSessionByAppId(msg.id);
      } catch {
        info = null;
      }
      // The thumbnail is already on the main thread from the media event, and
      // it is by far the biggest part of the payload — drop it so a resync
      // every few seconds does not copy a cover across threads each time.
      if (info?.media) info.media = { ...info.media, thumbnail: undefined };
      post({ t: 'resync', id: msg.id, info });
    }
  });
} catch (e) {
  post({ t: 'error', message: (e as Error).message });
  try { monitor?.destroy(); } catch { /* nothing to clean */ }
}
