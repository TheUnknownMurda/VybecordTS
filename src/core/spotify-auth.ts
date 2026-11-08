/**
 * Signing in to the Spotify Web API with the user's own Client ID.
 *
 * The way to Spotify's details for people who will not patch their client with
 * Spicetify. Vybecord cannot ship one Client ID for everyone: an app in
 * Spotify's Development Mode serves five accounts at most and, since March
 * 2026, works only while its owner has Premium, and Spotify grants more only to
 * registered organisations. So each user registers an app of their own — free,
 * a couple of minutes on the developer dashboard — and pastes its Client ID
 * here. The owner is the user, so the Premium rule is theirs to meet, and the
 * five-account cap never matters: the only account is their own.
 *
 * Authorization Code with PKCE: there is no client secret, so nothing on disk
 * could be used to impersonate the app, and nothing has to ship in the build.
 * An older Web API mode (removed in aec5b3d) asked for the secret too.
 *
 * The redirect lands on a loopback server that exists only while a sign-in is
 * waiting: 127.0.0.1, one path, one use, five minutes at most. Spotify refuses
 * `localhost` as a redirect and only allows plain http on an IP literal, and
 * the port cannot be 8888, which the extensions' push server holds.
 *
 * What is kept, in spotify-session.json: the refresh token, the account's name,
 * and when the user signed in. Spotify ends a refresh token six months after
 * the sign-in that issued it, whatever refreshes happen in between (since July
 * 2026), and a token does not say when it was issued — so the sign-in date is
 * the only way to warn before that happens rather than after.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('SpotifyAuth');

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';

/** Fixed, because the user registers the exact URI in their app's settings. */
export const SPOTIFY_REDIRECT_PORT = 8889;
export const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_REDIRECT_PORT}/callback`;

/**
 * Only what GET /me/player needs: the track, the position, shuffle, repeat,
 * the playlist and the device. The consent page lists exactly this, and
 * nothing that could change the user's library or playback.
 */
const SCOPES = 'user-read-playback-state';

/** Long enough to create the app and come back; short enough not to hold a port all evening. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
/** Refresh this long before Spotify's own expiry, so a poll never carries a dying token. */
const ACCESS_MARGIN_MS = 60_000;
/** Spotify's lifetime for a refresh token, counted from the sign-in. */
export const SPOTIFY_SESSION_LIFETIME_MS = 182 * 24 * 3600_000;

/** What a Spotify Client ID looks like: 32 hex digits. */
const CLIENT_ID = /^[0-9a-f]{32}$/i;

/** spotify-session.json. */
interface StoredSession {
  /** The app that issued the token: a different Client ID cannot use it. */
  client_id: string;
  refresh_token: string;
  /** When the user signed in, in ms since the epoch. */
  authorized_at: number;
  /** The account's display name, for "Connected as …". */
  user: string;
}

interface PendingSignIn {
  server: http.Server;
  /** The app the consent page was opened for: the code is only good with it. */
  clientId: string;
  state: string;
  verifier: string;
  timer: ReturnType<typeof setTimeout>;
  /** Set once a code has arrived: a reload of the tab must not spend it twice. */
  answered: boolean;
  finish: (err: Error | null) => void;
}

export interface SpotifyAuthStatus {
  clientId: string;
  /** A Client ID of the right shape is set. */
  configured: boolean;
  signedIn: boolean;
  signingIn: boolean;
  user: string;
  /** When the user signed in; 0 when not signed in. */
  authorizedAt: number;
  /** When Spotify will end the session; 0 when not signed in. */
  endsAt: number;
  /** Why the last sign-in or refresh failed, in words for the settings card. */
  error: string;
  redirectUri: string;
}

/** A failure the token endpoint explained. */
class TokenError extends Error {
  constructor(readonly status: number, readonly code: string, description: string) {
    super(description || code || `HTTP ${status}`);
  }
}

/** Raised when a sign-in is abandoned from the app, so the window can stay quiet about it. */
export const SIGN_IN_CANCELLED = 'cancelled';

export class SpotifyAuth {
  private clientId = '';
  private readonly sessionPath: string;
  private session: StoredSession | null = null;
  private accessToken = '';
  private accessExpiresAt = 0;
  private refreshing: Promise<string | null> | null = null;
  private pending: PendingSignIn | null = null;
  private lastError = '';
  /** What is wrong with the configured Client ID, if anything. */
  private idError = '';

  /**
   * @param onChange  called whenever signing in or out changes what is shown,
   *   so the poll can start or stop and the window repaint
   */
  constructor(configDir: string, private readonly onChange: () => void) {
    this.sessionPath = path.join(configDir, 'spotify-session.json');
    this.session = this.loadSession();
  }

  /**
   * Take the Client ID from the settings.
   *
   * A session belongs to the app that issued it, so a different ID, or none,
   * ends it — a token from another app would only earn errors. Safe to call
   * with the same ID again.
   */
  configure(rawId: string | undefined): void {
    const id = (rawId ?? '').trim();
    const next = CLIENT_ID.test(id) ? id.toLowerCase() : '';
    // Judged on every call, so a config.json edited by hand says what is wrong with it.
    const idError = id && !next ? 'The saved Client ID is not one — it is 32 letters and digits, on your app’s page.' : '';
    if (next === this.clientId) {
      if (idError !== this.idError) {
        this.idError = idError;
        this.onChange();
      }
      return;
    }
    // A sign-in still waiting was opened for the old app; its answer is no use now.
    this.cancelSignIn();
    this.clientId = next;
    this.idError = idError;
    this.lastError = '';
    if (this.session && this.session.client_id !== next) {
      if (next) log.info('Client ID changed — the saved Spotify session belonged to the old app, signing out');
      this.forget(true);
    }
    if (this.session) log.info(`Spotify Web API signed in${this.session.user ? ` as ${this.session.user}` : ''}`);
    this.onChange();
  }

  get signedIn(): boolean {
    return !!(this.clientId && this.session?.refresh_token);
  }

  status(): SpotifyAuthStatus {
    const s = this.signedIn ? this.session! : null;
    return {
      clientId: this.clientId,
      configured: !!this.clientId,
      signedIn: !!s,
      signingIn: !!this.pending,
      user: s?.user ?? '',
      authorizedAt: s?.authorized_at ?? 0,
      endsAt: s ? s.authorized_at + SPOTIFY_SESSION_LIFETIME_MS : 0,
      error: this.idError || this.lastError,
      redirectUri: SPOTIFY_REDIRECT_URI,
    };
  }

  // ── Signing in ──

  /**
   * Open the loopback door and build the page the user approves.
   *
   * Returns once the server is listening, with the URL to open and a promise
   * that settles when Spotify comes back — or the user gives up, or five
   * minutes pass. Starting again replaces an attempt still waiting.
   */
  async beginSignIn(): Promise<{ url: string; done: Promise<void> }> {
    if (!this.clientId) throw new Error('Paste your app’s Client ID first');
    this.cancelSignIn();

    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('base64url');

    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        reject(new Error(e.code === 'EADDRINUSE'
          ? `Another program is using port ${SPOTIFY_REDIRECT_PORT}, which the sign-in needs for a moment. Close it and try again.`
          : `Could not open the sign-in port: ${e.message}`));
      });
      server.listen(SPOTIFY_REDIRECT_PORT, '127.0.0.1', () => resolve());
    });
    let settle!: (err: Error | null) => void;
    const done = new Promise<void>((resolve, reject) => {
      settle = (err) => (err ? reject(err) : resolve());
    });
    // The window may be closed before the answer comes; that is no reason for
    // an unhandled rejection. Whoever awaits `done` still sees the error.
    done.catch(() => {});

    const pending: PendingSignIn = {
      server,
      clientId: this.clientId,
      state,
      verifier,
      answered: false,
      timer: setTimeout(() => {
        pending.finish(new Error('The sign-in was not finished within five minutes. Start it again from Vybecord.'));
      }, SIGN_IN_TIMEOUT_MS),
      finish: (err) => {
        if (this.pending !== pending) return;
        this.pending = null;
        clearTimeout(pending.timer);
        server.close();
        server.closeAllConnections();
        if (err && err.message !== SIGN_IN_CANCELLED) {
          this.lastError = err.message;
          log.warn(`Spotify sign-in failed: ${err.message}`);
        }
        settle(err);
        this.onChange();
      },
    };
    this.pending = pending;
    server.on('request', (req, res) => { void this.onCallback(pending, req, res); });
    // From here on a socket error ends this attempt rather than the process:
    // an 'error' event with no listener is thrown.
    server.removeAllListeners('error');
    server.on('error', (e) => pending.finish(new Error(`The sign-in port failed: ${e.message}`)));

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: SCOPES,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
    });
    this.lastError = '';
    this.onChange();
    log.info('Spotify sign-in started — waiting for the browser');
    return { url: `${ACCOUNTS}/authorize?${params}`, done };
  }

  /** Give up on a sign-in still waiting. Does nothing when none is. */
  cancelSignIn(): void {
    this.pending?.finish(new Error(SIGN_IN_CANCELLED));
  }

  /**
   * The browser coming back from Spotify's page.
   *
   * Nothing from the query string is ever written into the page: the replies
   * are fixed sentences, so a crafted link cannot put markup on 127.0.0.1.
   * A wrong `state` is answered but does not end the wait — it is an old tab
   * or somebody else's link, not this sign-in's answer.
   */
  private async onCallback(pending: PendingSignIn, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', SPOTIFY_REDIRECT_URI);
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404, { Connection: 'close' });
      res.end();
      return;
    }
    if (url.searchParams.get('state') !== pending.state) {
      replyPage(res, 400, 'This link is not the sign-in Vybecord is waiting for',
        'Start the sign-in again from Vybecord’s settings.');
      return;
    }
    const error = url.searchParams.get('error');
    if (error && !pending.answered) {
      const declined = error === 'access_denied';
      replyPage(res, 200, declined ? 'Sign-in cancelled' : 'Spotify refused the sign-in',
        'You can close this tab and go back to Vybecord.');
      pending.finish(new Error(declined
        ? 'You declined on Spotify’s page.'
        : `Spotify refused the sign-in (${error.slice(0, 60)}). Check that the Redirect URI in your app is exactly ${SPOTIFY_REDIRECT_URI}.`));
      return;
    }
    if (pending.answered) {
      replyPage(res, 200, 'Already done', 'Vybecord has this sign-in. You can close this tab.');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      replyPage(res, 400, 'Spotify sent nothing back', 'Start the sign-in again from Vybecord’s settings.');
      pending.finish(new Error('Spotify came back without an answer.'));
      return;
    }
    pending.answered = true;
    try {
      if (!await this.exchangeCode(code, pending)) {
        replyPage(res, 200, 'Sign-in cancelled', 'It was stopped from Vybecord. You can close this tab.');
        return;
      }
      replyPage(res, 200, 'Vybecord is connected to Spotify', 'You can close this tab.');
      pending.finish(null);
    } catch (e) {
      replyPage(res, 200, 'The sign-in did not go through', 'Vybecord says why in its settings. You can close this tab.');
      pending.finish(new Error(explainTokenError(e)));
    }
  }

  /**
   * Trade the code for tokens and keep them. False, keeping nothing, when the
   * attempt was cancelled, timed out or replaced while Spotify was answering:
   * the user has moved on — to another Client ID, perhaps — and must not find
   * themselves signed in behind their back.
   */
  private async exchangeCode(code: string, pending: PendingSignIn): Promise<boolean> {
    const data = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
    });
    if (!data.refresh_token) throw new Error('Spotify answered without a refresh token.');
    const user = await this.fetchDisplayName(data.access_token);
    if (this.pending !== pending) return false;
    this.session = {
      client_id: pending.clientId,
      refresh_token: data.refresh_token,
      authorized_at: Date.now(),
      user,
    };
    this.useAccessToken(data);
    this.saveSession();
    this.lastError = '';
    log.info(`Spotify Web API signed in ✓${user ? ` (as ${user})` : ''}`);
    return true;
  }

  /** The account's name, for the card. Never worth failing a sign-in over. */
  private async fetchDisplayName(token: string): Promise<string> {
    try {
      const resp = await fetch(`${API}/me`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) return '';
      const me = await resp.json() as { display_name?: unknown; id?: unknown };
      const name = typeof me.display_name === 'string' && me.display_name.trim() ? me.display_name : me.id;
      return typeof name === 'string' ? name.trim().slice(0, 100) : '';
    } catch {
      return '';
    }
  }

  // ── Tokens ──

  /**
   * A token good for the next request, refreshing it when it is about to lapse.
   *
   * Null means "not now": signed out, or Spotify unreachable for the moment.
   * The poll tells the two apart by asking `signedIn` afterwards. Concurrent
   * callers share one refresh — Spotify may rotate the refresh token, and two
   * refreshes racing would leave one of them holding a token already replaced.
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.signedIn) return null;
    if (this.accessToken && Date.now() < this.accessExpiresAt - ACCESS_MARGIN_MS) return this.accessToken;
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** The API refused the token before its time — take a fresh one next. */
  invalidateAccessToken(): void {
    this.accessToken = '';
    this.accessExpiresAt = 0;
  }

  private async refresh(): Promise<string | null> {
    const session = this.session;
    if (!session) return null;
    try {
      const data = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: session.refresh_token,
        client_id: this.clientId,
      });
      // Signed out or switched apps while the request was out.
      if (this.session !== session) return null;
      this.useAccessToken(data);
      // Spotify may hand out a new refresh token, and then the old one stops
      // working. The six months still run from the original sign-in.
      if (data.refresh_token && data.refresh_token !== session.refresh_token) {
        session.refresh_token = data.refresh_token;
        this.saveSession();
      }
      if (this.lastError) {
        this.lastError = '';
        this.onChange();
      }
      return this.accessToken;
    } catch (e) {
      if (this.session !== session) return null;
      if (e instanceof TokenError && (e.code === 'invalid_grant' || e.code === 'invalid_client')) {
        // Not coming back: the six months are up, access was removed on
        // spotify.com, or the app was deleted. Only a new sign-in helps.
        log.warn(`Spotify ended the session (${e.code}: ${e.message})`);
        this.forget(true);
        this.lastError = e.code === 'invalid_client'
          ? 'Spotify no longer recognises this Client ID. Check it on your app’s page, then sign in again.'
          : 'Spotify ended the sign-in — it lasts six months, or access was removed. Sign in again.';
        this.onChange();
        return null;
      }
      log.warn(`Spotify token refresh failed, will retry: ${(e as Error).message}`);
      return null;
    }
  }

  private useAccessToken(data: TokenResponse): void {
    this.accessToken = data.access_token;
    this.accessExpiresAt = Date.now() + Math.max(60, data.expires_in || 3600) * 1000;
  }

  // ── Signing out ──

  /**
   * Forget the session here.
   *
   * Spotify has no revocation endpoint for this flow: the app's access stays
   * listed on spotify.com/account/apps until the user removes it there, which
   * the card says. The token is gone from this machine either way.
   */
  signOut(): void {
    this.cancelSignIn();
    if (!this.session) return;
    this.forget(true);
    this.lastError = '';
    log.info('Spotify Web API signed out');
    this.onChange();
  }

  private forget(erase: boolean): void {
    this.session = null;
    this.invalidateAccessToken();
    if (erase) {
      try { fs.rmSync(this.sessionPath, { force: true }); } catch { /* already gone */ }
    }
  }

  private loadSession(): StoredSession | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionPath, 'utf-8')) as Partial<StoredSession>;
      if (typeof raw.client_id !== 'string' || typeof raw.refresh_token !== 'string' || !raw.refresh_token) return null;
      return {
        client_id: raw.client_id,
        refresh_token: raw.refresh_token,
        authorized_at: typeof raw.authorized_at === 'number' && Number.isFinite(raw.authorized_at) ? raw.authorized_at : Date.now(),
        user: typeof raw.user === 'string' ? raw.user : '',
      };
    } catch {
      return null;
    }
  }

  /** Written whole and renamed into place, so a crash mid-write cannot leave half a token. */
  private saveSession(): void {
    if (!this.session) return;
    const tmp = `${this.sessionPath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.sessionPath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.session, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, this.sessionPath);
    } catch (e) {
      log.error(`Failed to save the Spotify session: ${(e as Error).message}`);
    }
  }
}

// ── Helpers ──

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const resp = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await resp.json().catch(() => null) as Record<string, unknown> | null;
  if (!resp.ok || typeof data?.access_token !== 'string') {
    throw new TokenError(resp.status,
      typeof data?.error === 'string' ? data.error : '',
      typeof data?.error_description === 'string' ? data.error_description : '');
  }
  return {
    access_token: data.access_token,
    expires_in: typeof data.expires_in === 'number' ? data.expires_in : 3600,
    refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    scope: typeof data.scope === 'string' ? data.scope : undefined,
  };
}

/** What went wrong with a code exchange, in terms the settings card can show. */
function explainTokenError(e: unknown): string {
  if (e instanceof TokenError) {
    if (e.code === 'invalid_client') return 'Spotify does not recognise this Client ID. Copy it again from your app’s page.';
    if (e.code === 'invalid_grant') {
      return `Spotify refused the sign-in (${e.message}). Check that the Redirect URI in your app is exactly ${SPOTIFY_REDIRECT_URI}, then try again.`;
    }
    return `Spotify refused the sign-in: ${e.message}`;
  }
  return `Could not reach Spotify: ${(e as Error).message}`;
}

/**
 * The tab the browser is left on. Self-contained and script-free, with a
 * policy to match: it only ever shows the two fixed strings it is given.
 */
function replyPage(res: http.ServerResponse, status: number, title: string, body: string): void {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Vybecord</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark light}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#111214;color:#f2f3f5}
main{max-width:28rem;padding:24px;text-align:center}
h1{font-size:1.4rem;margin:0 0 8px}
p{margin:0;color:#b5bac1;line-height:1.5}
@media (prefers-color-scheme:light){body{background:#f6f7f9;color:#1e1f22}p{color:#4e5058}}
</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    Connection: 'close',
  });
  res.end(html);
}
