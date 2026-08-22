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

export class PushServer {
  private server: http.Server | null = null;
  private backend: VybecordBackend;
  private port: number;

  constructor(backend: VybecordBackend, port = PUSH_PORT) {
    this.backend = backend;
    this.port = port;
  }

  get isRunning(): boolean {
    return !!this.server?.listening;
  }

  start(): void {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch(e => {
        log.debug(`Push request failed: ${e}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });

    this.server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        log.error(`Port ${this.port} is already in use — the extension cannot connect. `
          + 'Another copy of Vybecord may be running.');
      } else {
        log.error(`Push server error: ${e.message}`);
      }
      this.server = null;
    });

    // Loopback only. Binding the wildcard would put this on the local network.
    this.server.listen(this.port, '127.0.0.1', () => {
      log.info(`Extension endpoint listening on 127.0.0.1:${this.port}`);
    });
  }

  stop(): void {
    if (!this.server) return;
    this.server.close();
    this.server = null;
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

  /** Hand the payload to the matching source. Shapes are validated downstream. */
  private dispatch(path: string, data: any): void {
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

/** Read a bounded request body. An oversized one is dropped, not buffered. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
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
      body += chunk.toString('utf8');
    });
    req.on('end', () => { clearTimeout(timer); resolve(body); });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
