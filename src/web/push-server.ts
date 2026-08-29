/**
 * Loopback endpoint the browser extension pushes playback state to.
 *
 * This is deliberately not the server the app used to run. That one served the
 * whole dashboard and the entire settings API on a fixed port, reachable by any
 * page in any browser, and it needed a stack of origin checks to hold that door
 * shut. This one:
 *
 *   - binds 127.0.0.1 only, so nothing off the machine can reach it;
 *   - answers POST on six push paths and nothing else — no config, no reads,
 *     no way to learn anything about the user;
 *   - accepts only extension origins, because an extension's origin is
 *     something the browser sets and a page cannot forge. A shared secret
 *     would be no use here: an extension's code is public by construction.
 *
 * It only listens while the extension integration is switched on, so an install
 * that does not use the extension opens no port at all.
 */

import http from 'node:http';
import { createLogger } from '../core/logger.js';
import type { VybecordBackend } from '../backend.js';

const log = createLogger('PushServer');

/** Fixed, because the extension has no way to discover a random one. */
export const PUSH_PORT = 8888;

/** Largest push body accepted. Real ones are ~1KB; this is slack, not a target. */
const MAX_BODY = 32 * 1024;

/** Paths the extension may POST to. Anything else is refused. */
const PUSH_PATHS = new Set([
  '/api/spicetify',
  '/api/youtube',
  '/api/soundcloud',
  '/api/bandcamp',
  '/api/twitch',
  '/api/kick',
  '/api/spotify-lyrics',
]);

/**
 * Origins allowed to push.
 *
 * Chrome and Edge extensions are `chrome-extension://<id>`, Firefox is
 * `moz-extension://<uuid>` — and Firefox's is regenerated per profile, so it
 * cannot be pinned to a known value. Requiring the scheme is what does the real
 * work: a web page can never present one, and the browser sets the header, not
 * the extension. Combined with the path allowlist, the worst a hostile
 * extension could do is lie about what you are listening to.
 */
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\/[\w-]+$/;

/**
 * The one pusher that is not a browser extension.
 *
 * Spicetify runs inside the Spotify client, so it presents Spotify's own page
 * origin and can never present an extension one. `/api/spicetify` was in the
 * path allowlist while the rule above made it unreachable, so every Spicetify
 * push was answered 403 and Spotify playback was never enriched — the two lists
 * contradicted each other for this single client. The same trap caught the
 * lyrics path later, which is why the allowed paths are a set rather than a
 * single constant to forget about.
 *
 * Read off a live client rather than assumed, because a wrong value here is the
 * kind that fails silently.
 *
 * It changes nothing about what the check is for. The point is that a *web
 * page* cannot push, and a page cannot lie about its origin — the browser sets
 * that header. Admitting this one origin admits the Spotify client and nothing
 * else, and only on the path meant for it.
 */
const SPICETIFY_ORIGIN = 'https://xpui.app.spotify.com';
/**
 * The paths the Spotify client is admitted on — its playback, and the lyrics
 * only it can read. Both are its own business and nothing else's; it still has
 * no way to report a YouTube tab.
 */
const SPICETIFY_PATHS = new Set(['/api/spicetify', '/api/spotify-lyrics']);

/**
 * How long to wait before trying the port again, and how many times.
 *
 * The address is almost never taken by something that means to keep it: it is
 * a copy of Vybecord that has just been closed and whose socket is still in
 * the kernel's hands for a few seconds, or an update installing itself over
 * the running app. Giving up on the first refusal meant the extension stayed
 * unreachable for the whole session, with one line in a log nobody reads and a
 * settings card that went on saying "waiting" — a permanent failure caused by
 * a transient condition.
 */
const RETRY_DELAY_MS = 4_000;
const RETRY_LIMIT = 5;

export class PushServer {
  private server: http.Server | null = null;
  private backend: VybecordBackend;
  private port: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  /** False once the port has been given up on, so callers can say why. */
  private available = true;

  constructor(backend: VybecordBackend, port = PUSH_PORT) {
    this.backend = backend;
    this.port = port;
  }

  get isRunning(): boolean {
    return !!this.server?.listening;
  }

  /**
   * Whether the endpoint is up, or still expects to be.
   *
   * False only after the retries have run out — which is the one case worth
   * telling somebody about, because it means another program holds the port.
   */
  get isAvailable(): boolean {
    return this.available;
  }

  start(): void {
    if (this.server) return;
    this.retries = 0;
    this.available = true;
    this.listen();
  }

  private listen(): void {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch(e => {
        log.debug(`Push request failed: ${e}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });

    this.server.on('error', (e: NodeJS.ErrnoException) => {
      // Dropping the reference alone left the failed server object alive with
      // its listeners attached, and a later start() would build a second one
      // beside it. Close it, so the field and reality agree.
      const failed = this.server;
      this.server = null;
      failed?.close();

      if (e.code !== 'EADDRINUSE') {
        log.error(`Push server error: ${e.message}`);
        this.available = false;
        return;
      }

      if (this.retries < RETRY_LIMIT) {
        this.retries++;
        log.warn(`Port ${this.port} is busy — retrying in ${RETRY_DELAY_MS / 1000}s `
          + `(${this.retries}/${RETRY_LIMIT}). A copy of Vybecord that has just closed `
          + 'usually releases it within a few seconds.');
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.listen();
        }, RETRY_DELAY_MS);
        this.retryTimer.unref?.();
        return;
      }

      this.available = false;
      log.error(`Port ${this.port} is still in use after ${RETRY_LIMIT} attempts — the browser `
        + 'extension cannot reach this app. Another copy of Vybecord is probably running.');
    });

    // Loopback only. Binding the wildcard would put this on the local network.
    this.server.listen(this.port, '127.0.0.1', () => {
      log.info(`Extension endpoint listening on 127.0.0.1:${this.port}`);
    });
  }

  stop(): void {
    // A retry may be queued with no server to show for it — switching the
    // setting off has to cancel that too, or the port would be grabbed back
    // seconds after the user turned the endpoint off.
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    // The extension holds the connection open between pushes, and close() only
    // stops accepting — it waits for every live socket to end on its own. That
    // left the port bound after the setting was turned off, so turning it back
    // on hit EADDRINUSE against ourselves.
    server.closeAllConnections?.();
    server.close();
    log.info('Extension endpoint stopped');
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = req.headers.origin ?? '';
    const path = (req.url ?? '/').split('?')[0];
    // Spotify is admitted only on its own path: the music client has no
    // business reporting a YouTube tab.
    const allowed = EXTENSION_ORIGIN.test(origin)
      || (origin === SPICETIFY_ORIGIN && SPICETIFY_PATHS.has(path));

    // Preflight. Answered before any other check so a legitimate extension is
    // not left guessing why its POST failed.
    if (req.method === 'OPTIONS') {
      if (!allowed) { res.writeHead(403); res.end(); return; }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        // Pushes run every couple of seconds; without this each one would be
        // preceded by its own preflight.
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      });
      res.end();
      return;
    }

    if (!allowed) {
      log.debug(`Refused ${req.method} ${path} from origin "${origin || '(none)'}"`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"error":"origin not allowed"}');
      return;
    }

    if (req.method !== 'POST' || !PUSH_PATHS.has(path)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin });
      res.end('{"error":"bad json"}');
      return;
    }

    this.dispatch(path, data);

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
    });
    res.end('{"ok":true}');
  }

  /**
   * Hand the payload to the matching source.
   *
   * `unknown`, not `any`: each handler coerces every field it uses before
   * touching it (see the normalize* functions beside each payload type), so
   * nothing downstream depends on this body having the shape it claims.
   */
  private dispatch(path: string, data: unknown): void {
    // `JSON.parse` happily returns null, a number or a string for a valid body.
    // The handlers cope, but there is nothing in such a body worth dispatching,
    // and saying so once here beats six silent no-ops.
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      log.debug(`Ignored a push to ${path} whose body was not an object`);
      return;
    }
    switch (path) {
      case '/api/spicetify': this.backend.handleSpicetifyPush(data); break;
      case '/api/youtube': this.backend.handleYouTubePush(data); break;
      case '/api/soundcloud': this.backend.handleSoundCloudPush(data); break;
      case '/api/bandcamp': this.backend.handleBandcampPush(data); break;
      case '/api/twitch': this.backend.handleTwitchPush(data); break;
      case '/api/kick': this.backend.handleKickPush(data); break;
      case '/api/spotify-lyrics': this.backend.handleSpotifyLyrics(data); break;
    }
  }
}

/**
 * Read a bounded request body. An oversized one is dropped, not buffered.
 *
 * Chunks are kept as bytes and decoded once at the end. Decoding each chunk as
 * it arrived split any multi-byte character that happened to straddle a chunk
 * boundary into two replacement characters — which is exactly the class of
 * title this app sees most (Japanese, Korean, accented Latin), and it corrupted
 * the track name for the whole song.
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => { req.destroy(); reject(new Error('body timeout')); }, 5_000);

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        clearTimeout(timer);
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
