/**
 * Spotify OAuth + playback polling.
 * Uses native fetch — zero external dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createLogger } from './logger.js';
import { atomicWriteFileSync } from './utils.js';
import type { SpotifyPlayback, TokenCache } from './types.js';

const log = createLogger('Spotify');

const AUTH_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';
const SCOPE = 'user-read-playback-state user-read-currently-playing';
const FETCH_TIMEOUT = 8_000;

export class SpotifyClient {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private cachePath: string;
  private tokens: TokenCache | null = null;
  private refreshPromise: Promise<boolean> | null = null;

  constructor(opts: {
    clientId: string;
    clientSecret: string;
    redirectUri?: string;
    cacheDir?: string;
  }) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.redirectUri = opts.redirectUri ?? 'http://127.0.0.1:8888/callback';
    const dir = opts.cacheDir ?? path.join(process.cwd(), 'envs');
    fs.mkdirSync(dir, { recursive: true });
    this.cachePath = path.join(dir, '.cache.json');
    this.loadTokens();
  }

  // ── Token management ──

  private loadTokens(): void {
    try {
      if (fs.existsSync(this.cachePath)) {
        const raw = fs.readFileSync(this.cachePath, 'utf-8');
        this.tokens = JSON.parse(raw) as TokenCache;
        log.info('Loaded cached Spotify tokens');
      }
    } catch {
      this.tokens = null;
    }
  }

  private saveTokens(tokens: TokenCache): void {
    this.tokens = tokens;
    // Atomic write — a crash mid-write would otherwise leave .cache.json
    // truncated, forcing the user to re-authenticate from scratch.
    atomicWriteFileSync(this.cachePath, JSON.stringify(tokens, null, 2));
  }

  get isAuthenticated(): boolean {
    return this.tokens != null && !!this.tokens.refresh_token;
  }

  private get authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
  }

  // ── OAuth flow ──

  getAuthorizeUrl(): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: SCOPE,
    });
    return `${AUTH_BASE}/authorize?${params}`;
  }

  /**
   * Start a temporary local HTTP server, open the auth URL in the browser,
   * and wait for the OAuth callback. Returns when authenticated.
   */
  async authenticate(): Promise<void> {
    if (this.isAuthenticated) {
      // Try refreshing existing token
      const ok = await this.refreshToken();
      if (ok) return;
    }

    log.info('Starting OAuth flow...');
    const authUrl = this.getAuthorizeUrl();

    // Open browser
    const { exec } = await import('node:child_process');
    const cmd = process.platform === 'win32' ? `start "" "${authUrl}"` :
                process.platform === 'darwin' ? `open "${authUrl}"` :
                `xdg-open "${authUrl}"`;
    exec(cmd);
    log.info(`Auth URL opened in browser: ${authUrl}`);

    // Wait for callback
    const code = await this.waitForCallback();
    await this.exchangeCode(code);
    log.info('Spotify authenticated successfully');
  }

  private waitForCallback(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:8888`);
        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`<h1>Auth failed</h1><p>${error}</p>`);
            server.close();
            reject(new Error(`Spotify auth denied: ${error}`));
            return;
          }

          if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <html><body style="background:#0a0a0a;color:#10b981;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
                <div style="text-align:center">
                  <h1 style="font-size:2rem">✓ Authenticated</h1>
                  <p style="color:#888">You can close this tab and return to VybecordTS.</p>
                </div>
              </body></html>
            `);
            server.close();
            resolve(code);
            return;
          }
        }
        res.writeHead(404);
        res.end();
      });

      const port = parseInt(new URL(this.redirectUri).port) || 8888;
      server.listen(port, '127.0.0.1', () => {
        log.info(`Callback server listening on port ${port}`);
      });

      // Timeout after 2 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('OAuth callback timeout (2 min)'));
      }, 120_000);
    });
  }

  private async exchangeCode(code: string): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    });

    const resp = await fetch(`${AUTH_BASE}/api/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: this.authHeader,
      },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token exchange failed: ${resp.status} ${text}`);
    }

    const data = await resp.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };

    this.saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000 - 60_000, // 1 min buffer
      scope: data.scope,
    });
  }

  async refreshToken(): Promise<boolean> {
    if (!this.tokens?.refresh_token) return false;

    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refresh_token,
      });

      const resp = await fetch(`${AUTH_BASE}/api/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: this.authHeader,
        },
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });

      if (!resp.ok) {
        log.warn(`Token refresh failed: ${resp.status}`);
        return false;
      }

      const data = await resp.json() as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
        scope: string;
      };

      this.saveTokens({
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? this.tokens.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000 - 60_000,
        scope: data.scope,
      });

      log.info('Token refreshed');
      return true;
    } catch (e) {
      log.error(`Token refresh error: ${e}`);
      return false;
    }
  }

  private async ensureToken(): Promise<string | null> {
    if (!this.tokens) return null;
    if (Date.now() >= this.tokens.expires_at) {
      // Dedup: if a refresh is already in flight, reuse its promise
      if (!this.refreshPromise) {
        this.refreshPromise = this.refreshToken().finally(() => {
          this.refreshPromise = null;
        });
      }
      const ok = await this.refreshPromise;
      if (!ok) return null;
    }
    return this.tokens!.access_token;
  }

  // ── API calls ──

  /** Get the next track in the user's queue (for lyrics prefetch). */
  async getNextInQueue(): Promise<SpotifyPlayback['item'] | null> {
    const token = await this.ensureToken();
    if (!token) return null;
    try {
      const resp = await fetch(`${API_BASE}/me/player/queue`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as { queue?: SpotifyPlayback['item'][] };
      return data.queue?.[0] ?? null;
    } catch {
      return null;
    }
  }

  async getCurrentPlayback(): Promise<SpotifyPlayback | null> {
    const token = await this.ensureToken();
    if (!token) return null;

    try {
      const resp = await fetch(`${API_BASE}/me/player/currently-playing`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });

      if (resp.status === 204) return null; // Nothing playing
      if (!resp.ok) {
        if (resp.status === 401) {
          log.warn('Token expired, refreshing...');
          const refreshed = await this.refreshToken();
          if (refreshed) {
            // Retry once with the new token
            const retryToken = this.tokens?.access_token;
            if (retryToken) {
              const retry = await fetch(`${API_BASE}/me/player/currently-playing`, {
                headers: { Authorization: `Bearer ${retryToken}` },
                signal: AbortSignal.timeout(FETCH_TIMEOUT),
              });
              if (retry.status === 204) return null;
              if (retry.ok) return (await retry.json()) as SpotifyPlayback;
            }
          }
        }
        return null;
      }

      return (await resp.json()) as SpotifyPlayback;
    } catch (e) {
      log.error(`Playback fetch error: ${e}`);
      return null;
    }
  }
}
