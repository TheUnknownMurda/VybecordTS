/**
 * Web server — Settings dashboard + REST API + SSE real-time events.
 * Uses native Node.js http module — zero external dependencies.
 */

import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../core/logger.js';
import { romanize, needsRomanization } from '../core/romanize.js';
import { evictOldest } from '../core/utils.js';
import { isScrobbleEnabled, canAuth, getAuthUrl, completeAuth, disconnectScrobble } from '../core/lastfm.js';
import { translateText, translateBatch, TRANSLATE_LANGS, clearTranslationCache, getTranslationCacheSize, flushTranslationCache } from '../core/translate.js';
import type { VybecordBackend } from '../backend.js';

const log = createLogger('WebServer');

/** Memoized romanize for SSE — avoids re-computing for repeated lyric text within a track. */
function sseRomanizeCached(cache: Map<string, string>, text: string): string {
  if (!text) return '';
  let r = cache.get(text);
  if (r === undefined) {
    r = romanize(text);
    cache.set(text, r);
    evictOldest(cache, 500);
  }
  return r;
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export class WebServer {
  private server: http.Server;
  private backend: VybecordBackend;
  private sseClients = new Set<http.ServerResponse>();
  private port: number;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(backend: VybecordBackend, port = 8888) {
    this.backend = backend;
    this.port = port;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    // Wire backend events → SSE broadcast
    const sseRomanizeCache = new Map<string, string>();
    backend.on('trackUpdate', (track) => {
      sseRomanizeCache.clear(); // new track → clear romanization cache
      this.broadcast('trackUpdate', track);
    });
    const sseTranslateCache = new Map<string, string>();
    backend.on('trackUpdate', () => { sseTranslateCache.clear(); }); // clear on track change
    backend.on('lyricsUpdate', (data: { current?: string; next?: string; prev?: string; [k: string]: unknown }) => {
      // Skip all enrichment work when no clients are listening (common when dashboard is closed)
      if (this.sseClients.size === 0) return;
      // Attach romanized text for dashboard display (memoized per text)
      const cur = data.current || '';
      const nxt = data.next || '';
      const prv = data.prev || '';
      if ((cur && needsRomanization(cur)) || (nxt && needsRomanization(nxt)) || (prv && needsRomanization(prv))) {
        data.r_current = sseRomanizeCached(sseRomanizeCache, cur);
        data.r_next = sseRomanizeCached(sseRomanizeCache, nxt);
        data.r_prev = sseRomanizeCached(sseRomanizeCache, prv);
      }
      // Attach translations from server cache (non-blocking — only if already cached)
      const cfg = this.backend.getConfig();
      if (cfg.translate_lyrics && cur) {
        const tgt = cfg.translate_target_lang || 'en';
        const tCur = sseTranslateCache.get(cur + '|' + tgt);
        if (tCur) data.t_current = tCur;
        const tNxt = nxt ? sseTranslateCache.get(nxt + '|' + tgt) : undefined;
        if (tNxt) data.t_next = tNxt;
        // Fire-and-forget: translate current + next in background, cache for later SSE pushes
        if (!tCur && cur.length >= 2 && !/^[♪♫🎵\s]+$/.test(cur)) {
          translateText(cur, tgt).then(r => { if (r) sseTranslateCache.set(cur + '|' + tgt, r.translation); }).catch(() => {});
        }
        if (nxt && !tNxt && nxt.length >= 2 && !/^[♪♫🎵\s]+$/.test(nxt)) {
          translateText(nxt, tgt).then(r => { if (r) sseTranslateCache.set(nxt + '|' + tgt, r.translation); }).catch(() => {});
        }
      }
      this.broadcast('lyricsUpdate', data);
    });
    backend.on('configUpdate', (cfg) => {
      this.broadcast('configUpdate', cfg);
    });
    let lastProgressBroadcast = 0;
    backend.on('progressUpdate', (data) => {
      if (this.sseClients.size === 0) return; // No clients → skip throttle check + broadcast
      const now = Date.now();
      if (now - lastProgressBroadcast < 1000) return; // Throttle to 1/s — dashboard only needs ~1Hz for seekbar
      lastProgressBroadcast = now;
      this.broadcast('progressUpdate', data);
    });
    backend.on('statusUpdate', (data) => {
      this.broadcast('statusUpdate', data);
    });
    backend.on('statsUpdate', (data) => {
      this.broadcast('statsUpdate', data);
    });
    backend.on('plainLyricsUpdate', (data) => {
      this.broadcast('plainLyricsUpdate', data);
    });
  }

  start(): void {
    this.server.listen(this.port, '127.0.0.1', () => {
      log.info(`Dashboard → http://localhost:${this.port}`);
    });

    // SSE keepalive: prevent silent disconnections by proxies/firewalls
    this.keepaliveTimer = setInterval(() => {
      for (const client of this.sseClients) {
        try { client.write(': keepalive\n\n'); } catch { this.sseClients.delete(client); }
      }
    }, 30_000);
  }

  stop(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    for (const client of this.sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.sseClients.clear();
    this.server.close();
  }

  // ── Request router ──

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const method = req.method ?? 'GET';

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // API routes
      if (url.pathname === '/api/config' && method === 'GET') {
        return this.jsonResponse(res, this.backend.getConfig());
      }
      if (url.pathname === '/api/config' && method === 'POST') {
        return await this.handleConfigUpdate(req, res);
      }
      if (url.pathname === '/api/status' && method === 'GET') {
        return this.jsonResponse(res, {
          track: this.backend.getCurrentTrack(),
          sourceMode: this.backend.getSourceMode(),
          discordConnected: this.backend.isDiscordConnected(),
          spotifyConnected: this.backend.isSpotifyConnected(),
          spicetifyActive: this.backend.isSpicetifyActive(),
          youtubeActive: this.backend.isYouTubeSourceActive(),
        });
      }
      if (url.pathname === '/api/events' && method === 'GET') {
        return this.handleSSE(req, res);
      }
      if (url.pathname === '/api/stats' && method === 'GET') {
        return this.jsonResponse(res, this.backend.getSessionStats());
      }
      if (url.pathname === '/api/stats/history' && method === 'GET') {
        return this.jsonResponse(res, this.backend.getStatsHistory());
      }
      if (url.pathname === '/api/thumbnail' && method === 'GET') {
        return await this.serveThumbnail(res);
      }
      if (url.pathname === '/api/spicetify' && method === 'POST') {
        return await this.handlePush(req, res, d => this.backend.handleSpicetifyPush(d), 'Spicetify');
      }
      if (url.pathname === '/api/youtube' && method === 'POST') {
        return await this.handlePush(req, res, d => this.backend.handleYouTubePush(d), 'YouTube');
      }
      if (url.pathname === '/api/soundcloud' && method === 'POST') {
        return await this.handlePush(req, res, d => this.backend.handleSoundCloudPush(d), 'SoundCloud');
      }
      if (url.pathname === '/api/bandcamp' && method === 'POST') {
        return await this.handlePush(req, res, d => this.backend.handleBandcampPush(d), 'Bandcamp');
      }
      if (url.pathname === '/api/spotify-lyrics' && method === 'POST') {
        return await this.handleSpotifyLyricsPush(req, res);
      }
      if (url.pathname === '/api/lyrics/import' && method === 'POST') {
        return await this.handleLyricsImport(req, res);
      }
      if (url.pathname === '/api/lyrics/offset' && method === 'POST') {
        return await this.handleLyricsOffset(req, res);
      }
      if (url.pathname === '/api/lyrics/flag' && method === 'POST') {
        const flagged = this.backend.flagCurrentLyrics();
        return this.jsonResponse(res, { ok: flagged, message: flagged ? 'Lyrics flagged' : 'No lyrics to flag' });
      }
      if (url.pathname === '/api/lyrics/flagged' && method === 'GET') {
        return this.jsonResponse(res, { entries: this.backend.listFlaggedTracks() });
      }
      if (url.pathname === '/api/lyrics/flagged' && method === 'DELETE') {
        const body = await this.readBody(req);
        const data = JSON.parse(body) as { key?: string };
        if (!data.key) return this.jsonResponse(res, { error: 'Missing key' }, 400);
        const ok = this.backend.clearFlaggedTrack(data.key);
        return this.jsonResponse(res, { ok });
      }
      if (url.pathname === '/api/lyrics/current' && method === 'GET') {
        const lrc = this.backend.getCurrentLyricsLrc();
        return this.jsonResponse(res, { lrc });
      }
      if (url.pathname === '/api/lyrics/custom' && method === 'GET') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50') || 50, 200);
        const offset = parseInt(url.searchParams.get('offset') || '0') || 0;
        const search = url.searchParams.get('search') || undefined;
        return this.jsonResponse(res, this.backend.listCustomLyrics(limit, offset, search));
      }
      if (url.pathname.startsWith('/api/lyrics/custom/') && method === 'GET') {
        const id = parseInt(url.pathname.split('/').pop() || '');
        if (isNaN(id)) return this.jsonResponse(res, { error: 'Invalid ID' }, 400);
        const entry = this.backend.getCustomLyricsEntry(id);
        if (!entry) return this.jsonResponse(res, { error: 'Not found' }, 404);
        return this.jsonResponse(res, entry);
      }
      if (url.pathname.startsWith('/api/lyrics/custom/') && method === 'PUT') {
        const id = parseInt(url.pathname.split('/').pop() || '');
        if (isNaN(id)) return this.jsonResponse(res, { error: 'Invalid ID' }, 400);
        const body = await this.readBody(req, 524_288);
        const data = JSON.parse(body);
        const ok = this.backend.updateCustomLyricsEntry(id, data);
        return this.jsonResponse(res, { ok });
      }
      if (url.pathname.startsWith('/api/lyrics/custom/') && method === 'DELETE') {
        const id = parseInt(url.pathname.split('/').pop() || '');
        if (isNaN(id)) return this.jsonResponse(res, { error: 'Invalid ID' }, 400);
        const ok = this.backend.deleteCustomLyricsEntry(id);
        return this.jsonResponse(res, { ok });
      }
      if (url.pathname === '/api/cache/clear' && method === 'POST') {
        const cleared = this.backend.clearLyricsCache();
        return this.jsonResponse(res, { ok: true, cleared });
      }
      if (url.pathname === '/api/bug-report' && method === 'POST') {
        return await this.handleBugReport(req, res);
      }
      if (url.pathname === '/api/history' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50') || 50;
        const offset = parseInt(url.searchParams.get('offset') || '0') || 0;
        return this.jsonResponse(res, {
          entries: this.backend.getListeningHistory(Math.min(limit, 200), offset),
          total: this.backend.getListeningHistoryCount(),
        });
      }
      if (url.pathname === '/api/history/wrapped' && method === 'GET') {
        const days = url.searchParams.get('days') ? parseInt(url.searchParams.get('days')!) : undefined;
        return this.jsonResponse(res, this.backend.getListeningWrapped(days));
      }
      if (url.pathname === '/api/network' && method === 'GET') {
        const nets = os.networkInterfaces();
        let lanIp = '127.0.0.1';
        for (const ifaces of Object.values(nets)) {
          for (const iface of ifaces ?? []) {
            if (iface.family === 'IPv4' && !iface.internal) { lanIp = iface.address; break; }
          }
          if (lanIp !== '127.0.0.1') break;
        }
        return this.jsonResponse(res, { lanUrl: `http://${lanIp}:${this.port}`, ip: lanIp, port: this.port });
      }
      if (url.pathname === '/api/shutdown' && method === 'POST') {
        this.jsonResponse(res, { ok: true });
        log.info('Shutdown requested from dashboard');
        // Defer 100ms so HTTP response flushes, then trigger graceful shutdown
        setTimeout(() => this.backend.emit('shutdownRequested'), 100);
        return;
      }

      // ── Last.fm Scrobbling routes ──
      if (url.pathname === '/api/lastfm/status' && method === 'GET') {
        return this.jsonResponse(res, {
          scrobbling: isScrobbleEnabled(),
          canAuth: canAuth(),
        });
      }
      if (url.pathname === '/api/lastfm/auth' && method === 'GET') {
        const callbackUrl = `http://127.0.0.1:${this.port}/lastfm-callback`;
        const authUrl = getAuthUrl(callbackUrl);
        if (!authUrl) {
          return this.jsonResponse(res, { error: 'Last.fm API key/secret not configured' });
        }
        // Redirect browser to Last.fm authorization page
        res.writeHead(302, { Location: authUrl });
        res.end();
        return;
      }
      if (url.pathname === '/lastfm-callback' && method === 'GET') {
        const token = url.searchParams.get('token');
        if (!token) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h2>Error: No token received from Last.fm</h2>');
          return;
        }
        const ok = await completeAuth(token);
        // Redirect to dashboard with success/failure indicator
        res.writeHead(302, { Location: `/?lastfm=${ok ? 'connected' : 'error'}` });
        res.end();
        return;
      }
      if (url.pathname === '/api/lastfm/disconnect' && method === 'POST') {
        disconnectScrobble();
        return this.jsonResponse(res, { ok: true, scrobbling: false });
      }

      // ── Lyrics Translation ──
      if (url.pathname === '/api/translate' && method === 'GET') {
        const text = url.searchParams.get('text') || '';
        const target = url.searchParams.get('target') || 'en';
        if (!text.trim()) return this.jsonResponse(res, { error: 'Missing text' }, 400);
        if (!TRANSLATE_LANGS[target]) return this.jsonResponse(res, { error: 'Unsupported language', supported: Object.keys(TRANSLATE_LANGS) }, 400);
        try {
          const result = await translateText(text, target);
          if (result) return this.jsonResponse(res, { translation: result.translation, cached: result.cached });
          return this.jsonResponse(res, { translation: null, reason: 'rate_limited_or_unavailable' });
        } catch (e) {
          return this.jsonResponse(res, { error: `Translation failed: ${e}` }, 500);
        }
      }
      if (url.pathname === '/api/translate/batch' && method === 'POST') {
        const body = await this.readBody(req, 262_144);
        const { lines, target } = JSON.parse(body) as { lines?: string[]; target?: string };
        if (!lines?.length) return this.jsonResponse(res, { error: 'Missing lines' }, 400);
        const tgt = target || 'en';
        if (!TRANSLATE_LANGS[tgt]) return this.jsonResponse(res, { error: 'Unsupported language' }, 400);
        try {
          const results = await translateBatch(lines.slice(0, 200), tgt);
          return this.jsonResponse(res, { translations: Object.fromEntries(results), count: results.size });
        } catch (e) {
          return this.jsonResponse(res, { error: `Batch translation failed: ${e}` }, 500);
        }
      }
      if (url.pathname === '/api/translate/langs' && method === 'GET') {
        return this.jsonResponse(res, { langs: TRANSLATE_LANGS });
      }
      if (url.pathname === '/api/translate/cache' && method === 'DELETE') {
        clearTranslationCache();
        return this.jsonResponse(res, { ok: true });
      }

      // Dashboard version switch: POST /api/dashboard/version
      if (url.pathname === '/api/dashboard/version' && method === 'POST') {
        const body = await this.readBody(req);
        const { version } = JSON.parse(body);
        const v = version === 'v1' ? 'v1' : 'v2';
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `vybecord_dashboard=${v}; Path=/; Max-Age=31536000; SameSite=Lax`
        });
        res.end(JSON.stringify({ ok: true, version: v }));
        return;
      }
      if (url.pathname === '/api/dashboard/version' && method === 'GET') {
        const cookie = (req.headers.cookie || '').match(/vybecord_dashboard=(v[12])/);
        return this.jsonResponse(res, { version: cookie ? cookie[1] : 'v2' });
      }

      // Static file serving (dashboard)
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const cookie = (req.headers.cookie || '').match(/vybecord_dashboard=(v[12])/);
        const ver = cookie ? cookie[1] : 'v2';
        return await this.serveFile(res, ver === 'v1' ? 'dashboard.html' : 'dashboard-v2.html');
      }
      if (url.pathname === '/v1') {
        return await this.serveFile(res, 'dashboard.html');
      }
      if (url.pathname === '/v2') {
        return await this.serveFile(res, 'dashboard-v2.html');
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (e) {
      log.error(`Request error: ${e}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  // ── Helpers ──

  private jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private async handleConfigUpdate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req);
      const updates = JSON.parse(body) as Record<string, unknown>;
      this.backend.updateConfig(updates);
      this.jsonResponse(res, { ok: true, config: this.backend.getConfig() });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid config: ${e}` }));
    }
  }

  private async handlePush(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: (data: any) => void,  // eslint-disable-line @typescript-eslint/no-explicit-any -- JSON.parse returns any; backend handlers validate
    label: string,
  ): Promise<void> {
    try {
      const body = await this.readBody(req, 8192);
      const data = JSON.parse(body);
      handler(data);
      res.writeHead(204);
      res.end();
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid ${label} payload: ${e}` }));
    }
  }

  private async handleSpotifyLyricsPush(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req, 256_000); // Lyrics can be large
      const data = JSON.parse(body);
      this.backend.handleSpotifyLyrics(data);
      res.writeHead(204);
      res.end();
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid Spotify lyrics payload: ${e}` }));
    }
  }

  private async handleLyricsOffset(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req, 256);
      const data = JSON.parse(body) as { offset_ms?: number };
      const ms = typeof data.offset_ms === 'number' ? data.offset_ms : 0;
      this.backend.setLyricsOffset(ms);
      res.writeHead(204);
      res.end();
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid offset: ${e}` }));
    }
  }

  private async handleLyricsImport(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req, 524_288); // 512KB max for LRC content
      const data = JSON.parse(body) as { track?: string; artist?: string; album?: string; duration?: number; lrc?: string };
      if (!data.track || !data.artist || !data.lrc) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required fields: track, artist, lrc' }));
        return;
      }
      const trackId = this.backend.importCustomLyrics({
        track: data.track,
        artist: data.artist,
        album: data.album || '',
        duration: data.duration,
        lrc: data.lrc,
      });
      this.jsonResponse(res, { ok: true, trackId });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Import failed: ${e}` }));
    }
  }

  private lastBugReportTime = 0;

  private async handleBugReport(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const now = Date.now();
      if (now - this.lastBugReportTime < 30_000) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Rate limited — wait 30s' }));
        return;
      }
      const body = await this.readBody(req, 16_384);
      const data = JSON.parse(body) as {
        summary?: string; category?: string; details?: string;
        track?: { name?: string; artist?: string; album?: string; platform?: string } | null;
        userAgent?: string; lang?: string; timestamp?: string;
      };
      if (!data.summary) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing summary' }));
        return;
      }
      const webhookUrl = 'https://discord.com/api/webhooks/1496517886783521011/rkt9Jpph6PNZ7_OIi4Za3lt2QAzZ2xmVntl3RcDs7Bx4x4wz-92xL40ylqqeA7413hLR';
      const trackInfo = data.track
        ? `${data.track.name || '?'} — ${data.track.artist || '?'} (${data.track.platform || '?'})`
        : 'No track playing';
      const embed = {
        title: `🐛 ${data.summary}`.slice(0, 256),
        color: 0xff6b6b,
        fields: [
          { name: 'Category', value: data.category || 'other', inline: true },
          { name: 'Language', value: data.lang || '?', inline: true },
          { name: 'Current Track', value: trackInfo, inline: false },
          ...(data.details ? [{ name: 'Details', value: data.details.slice(0, 1024), inline: false }] : []),
          { name: 'User Agent', value: (data.userAgent || '?').slice(0, 256), inline: false },
        ],
        timestamp: data.timestamp || new Date().toISOString(),
        footer: { text: 'VybecordTS Bug Report' },
      };
      const webhookBody = JSON.stringify({ embeds: [embed] });
      const isHttps = webhookUrl.startsWith('https');
      const proto = isHttps ? await import('node:https') : await import('node:http');
      await new Promise<void>((resolve, reject) => {
        const wreq = proto.request(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(webhookBody) },
        }, (wres) => {
          let d = '';
          wres.on('data', (c: Buffer) => { d += c; });
          wres.on('end', () => {
            if (wres.statusCode && wres.statusCode >= 200 && wres.statusCode < 300) resolve();
            else reject(new Error(`Webhook returned ${wres.statusCode}: ${d}`));
          });
        });
        wreq.on('error', reject);
        wreq.write(webhookBody);
        wreq.end();
      });
      this.lastBugReportTime = now;
      log.info(`Bug report sent: ${data.summary}`);
      this.jsonResponse(res, { ok: true });
    } catch (e) {
      log.error(`Bug report failed: ${e}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `${e}` }));
    }
  }

  private readBody(req: http.IncomingMessage, maxBytes = 1_048_576): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let done = false;
      const timeout = setTimeout(() => {
        if (!done) { done = true; req.destroy(); reject(new Error('Body read timeout (5s)')); }
      }, 5000);
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          done = true; clearTimeout(timeout);
          req.destroy();
          reject(new Error(`Body too large (>${maxBytes} bytes)`));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => { if (!done) { done = true; clearTimeout(timeout); resolve(Buffer.concat(chunks).toString('utf-8')); } });
      req.on('error', (e) => { if (!done) { done = true; clearTimeout(timeout); reject(e); } });
    });
  }

  private async serveThumbnail(res: http.ServerResponse): Promise<void> {
    const thumbPath = path.join(process.env.TEMP || os.tmpdir(), 'vybecord_thumb.jpg');
    try {
      const data = await fsp.readFile(thumbPath);
      // Detect format from magic bytes
      const isPng = data[0] === 0x89 && data[1] === 0x50;
      const mime = isPng ? 'image/png' : 'image/jpeg';
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-cache, no-store',
        'Content-Length': data.length,
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  }

  private async serveFile(res: http.ServerResponse, filename: string): Promise<void> {
    const IS_PKG = !!(process as unknown as { pkg?: unknown }).pkg;
    const dir = IS_PKG
      ? path.dirname(process.execPath)
      : path.dirname(fileURLToPath(import.meta.url));
    const filePath = path.join(dir, filename);

    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      const ext = path.extname(filePath);
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('File not found');
    }
  }

  // ── SSE (Server-Sent Events) ──

  private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial state
    res.write(`data: ${JSON.stringify({
      type: 'init',
      track: this.backend.getCurrentTrack(),
      config: this.backend.getConfig(),
      sourceMode: this.backend.getSourceMode(),
      discordConnected: this.backend.isDiscordConnected(),
      spotifyConnected: this.backend.isSpotifyConnected(),
      spicetifyActive: this.backend.isSpicetifyActive(),
      youtubeActive: this.backend.isYouTubeSourceActive(),
      stats: this.backend.getSessionStats(),
      statsHistory: this.backend.getStatsHistory(),
      lyrics: this.backend.getCurrentLyricsState(),
    })}\n\n`);

    this.sseClients.add(res);
    log.info(`SSE client connected (${this.sseClients.size} total)`);

    req.on('close', () => {
      this.sseClients.delete(res);
      log.info(`SSE client disconnected (${this.sseClients.size} total)`);
    });
  }

  private broadcast(type: string, data: unknown): void {
    if (this.sseClients.size === 0) return; // Fast exit — no clients, no work
    // Pre-encode once: JSON.stringify + UTF-8 encoding done a single time regardless of client count
    const buf = Buffer.from(`data: ${JSON.stringify({ type, data })}\n\n`, 'utf-8');
    for (const client of this.sseClients) {
      try {
        client.write(buf);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }
}
