/**
 * LRCLIB dump worker — hosts the read-only dump on its own thread.
 *
 * Why a worker at all: better-sqlite3 is synchronous, and the dump is routinely
 * 100 GB+. Any query against it on the main thread stops the window from
 * painting, the tray from responding and the Discord presence from updating for
 * as long as it runs. The search box issues one query per keystroke, so that
 * cost lands over and over, and a slow one reads as a crash rather than a wait.
 *
 * The thread does no interpretation beyond what lrclib-dump.ts already does: it
 * is a request/response shell around that module, one reply per request, matched
 * by id. Requests are answered in the order they arrive — a query in flight
 * blocks this thread and only this thread, which is the entire point.
 */

import { parentPort } from 'node:worker_threads';
import { setLogSink, type LogLevel } from '../src/core/logger.js';
import {
  openDump, closeDump, dumpSearch, dumpTrack, dumpLookup,
} from '../src/core/lrclib-dump.js';

/** main → worker */
export type DumpWorkerIn =
  | { t: 'open'; id: number; path: string; nativeBinding?: string }
  | { t: 'search'; id: number; query: string; limit: number }
  | { t: 'track'; id: number; trackId: number }
  | { t: 'lookup'; id: number; track: string; artist: string; duration?: number }
  | { t: 'close' };

/** worker → main */
export type DumpWorkerOut =
  | { t: 'ok'; id: number; value: unknown }
  | { t: 'err'; id: number; message: string }
  | { t: 'log'; level: LogLevel; name: string; message: string };

const port = parentPort;
if (!port) throw new Error('lrclib-worker must be started as a worker thread');

// This thread has no log file of its own — hand every line to the main thread,
// which writes it where the rest of the app's log already goes.
setLogSink((level, name, message) => {
  port.postMessage({ t: 'log', level, name, message } satisfies DumpWorkerOut);
});

port.on('message', (msg: DumpWorkerIn) => {
  if (msg.t === 'close') {
    closeDump();
    port.close();
    return;
  }

  try {
    let value: unknown;
    switch (msg.t) {
      case 'open':
        value = openDump(msg.path, msg.nativeBinding);
        break;
      case 'search':
        value = dumpSearch(msg.query, msg.limit);
        break;
      case 'track':
        value = dumpTrack(msg.trackId);
        break;
      case 'lookup':
        value = dumpLookup(msg.track, msg.artist, msg.duration);
        break;
    }
    port.postMessage({ t: 'ok', id: msg.id, value } satisfies DumpWorkerOut);
  } catch (e) {
    // A throw here would take the thread down and strand every caller waiting
    // on a reply; the request fails on its own instead.
    port.postMessage({
      t: 'err', id: msg.id, message: `${(e as Error).message || e}`,
    } satisfies DumpWorkerOut);
  }
});
