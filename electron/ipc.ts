/**
 * IPC bridge — the window's entire API surface.
 *
 * Every channel here replaces a route on the localhost HTTP server the app used
 * to run. Two things changed for the better in the move:
 *
 *   - Reachability. The old server bound a port, so any page in any browser on
 *     the machine could POST to it; a stack of Origin/Host checks existed purely
 *     to hold that door shut. IPC is reachable only from this app's own
 *     renderer, so those checks are gone rather than reimplemented.
 *   - Push. `/api/events` was an SSE stream. Backend events now go straight to
 *     the renderer through webContents.send.
 *
 * Rate limiting on bug reports is kept even though the caller is now trusted:
 * it protects the *webhook* from a stuck retry loop in the UI, which is a
 * failure mode that has nothing to do with who is calling.
 */

import { ipcMain, shell, app, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../src/core/logger.js';
import type { VybecordBackend } from '../src/backend.js';
import {
  isScrobbleEnabled, canAuth, requestAuthToken, getAuthUrlForToken,
  completeAuth, disconnectScrobble,
} from '../src/core/lastfm.js';
import {
  translateText, translateBatch, clearTranslationCache, TRANSLATE_LANGS,
} from '../src/core/translate.js';
import { ytDlpStatus, ytDlpDropDir } from '../src/core/youtube-captions.js';
import {
  extensionPath, extensionExists, detectBrowsers,
  revealExtensionFolder, copyExtensionsUrl, copyExtensionPath,
} from './extension-install.js';
import {
  spicetifyInfo, installSpicetifyExtension, revealSpicetifyExtensions, copyToClipboard,
  setupSpicetify,
  SPICETIFY_INSTALL_CMD, SPICETIFY_ENABLE_CMD, SPICETIFY_APPLY_CMD,
} from './spicetify-install.js';
import { updateState, check as checkForUpdate, installNow } from './updater.js';

const log = createLogger('IPC');

/**
 * The maintainer's webhook, replaced at build time by esbuild's `define`
 * (see scripts/build-electron.mjs). Empty when the build had none configured.
 *
 * Reports go here so problems reach whoever can fix them; end users are not
 * asked to supply a webhook of their own. It is readable by anyone who unpacks
 * the app, so it is treated as a public write-only endpoint, not a secret.
 */
declare const __BUG_REPORT_WEBHOOK__: string;
const BUILT_IN_WEBHOOK = typeof __BUG_REPORT_WEBHOOK__ === 'string' ? __BUG_REPORT_WEBHOOK__ : '';

/** The built-in webhook, or a local override from config.json for testing. */
function reportWebhook(backend: VybecordBackend): string {
  const override = backend.getConfig().bug_report_webhook as string | undefined;
  return (override && override.trim()) || BUILT_IN_WEBHOOK;
}

/** Where the media source drops the cover art the OS handed it. */
const THUMB_PATH = path.join(process.env.TEMP || os.tmpdir(), 'vybecord_thumb.jpg');

/** Backend events forwarded verbatim to the renderer. */
const FORWARDED_EVENTS = [
  'trackUpdate', 'progressUpdate', 'lyricsUpdate', 'plainLyricsUpdate',
  'statusUpdate', 'configUpdate', 'statsUpdate',
] as const;

// `updateStatus` is pushed by the updater itself rather than the backend, so it
// is not in the list above — see initUpdater().

// ── Bug report guards ──
/**
 * Discord's own hosts only: whatever is configured here receives the text of
 * every report, so it must not be pointable at an arbitrary server. An explicit
 * API version is allowed because Discord's docs hand out both forms and people
 * paste what they are given. Mirrored in the Report page for an inline error.
 */
const VALID_WEBHOOK_REGEX = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api(?:\/v\d{1,2})?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;
const DISCORD_PING_REGEX = /@(?:everyone|here)|<@\d+>|<@&\d+>/g;
const REPORT_MIN_GAP_MS = 30_000;
const REPORT_DUPLICATE_WINDOW_MS = 10 * 60_000;
const REPORT_DAILY_MAX = 20;

let lastReportAt = 0;
let reportsToday = 0;
let reportDayStamp = '';
const recentReportHashes = new Map<string, number>();

/** Strip mass-ping tokens so a report can never make the webhook shout. */
function sanitizeDiscord(text: string): string {
  return text.replace(DISCORD_PING_REGEX, '[ping removed]');
}

export function registerIpc(backend: VybecordBackend, getWindow: () => BrowserWindow | null): void {
  // ── Backend → renderer ──
  for (const event of FORWARDED_EVENTS) {
    backend.on(event, (payload: unknown) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send(`backend:${event}`, payload);
    });
  }

  /**
   * Wrap a handler so a thrown error becomes a rejected invoke on the renderer
   * side with a readable message, instead of Electron's opaque
   * "Error invoking remote method" wrapper.
   */
  const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        log.error(`${channel} failed: ${e}`);
        throw new Error(`${(e as Error).message || e}`);
      }
    });
  };

  // ── Snapshot ──
  // One call the window makes on load, so it paints a complete state instead of
  // an empty shell waiting for the first event to arrive.
  handle('app:snapshot', () => ({
    config: backend.getConfig(),
    track: backend.getCurrentTrack(),
    lyrics: backend.getCurrentLyricsState(),
    stats: backend.getSessionStats(),
    players: backend.listPlayers(),
    preferredPlayer: backend.getPreferredPlayer(),
    status: {
      discordConnected: backend.isDiscordConnected(),
      mediaSourceReady: backend.isMediaSourceReady(),
      adPlaying: backend.isAdPlaying(),
      showLyrics: backend.getConfig().show_lyrics !== false,
      userAway: backend.isUserAway(),
      hideWhenAway: backend.getConfig().rpc_hide_when_away !== false,
    },
    version: app.getVersion(),
  }));

  // ── Config ──
  handle('config:get', () => backend.getConfig());
  handle('config:set', (updates: Record<string, unknown>) => {
    backend.updateConfig(updates);
    return backend.getConfig();
  });

  // ── Now playing ──
  handle('track:current', () => backend.getCurrentTrack());
  handle('lyrics:current', () => backend.getCurrentLyricsState());
  handle('lyrics:lrc', () => backend.getCurrentLyricsLrc());
  handle('lyrics:offset', (ms: number) => { backend.setLyricsOffset(ms); return { ok: true }; });
  handle('lyrics:flag', () => ({ ok: backend.flagCurrentLyrics() }));
  handle('lyrics:flagged', () => backend.listFlaggedTracks());
  handle('lyrics:unflag', (key: string) => ({ ok: backend.clearFlaggedTrack(key) }));

  /**
   * Raw bytes of the current local cover.
   *
   * The renderer turns these into a blob URL. A custom protocol would be the
   * tidier route, but the window is loaded over file://, and Chromium blocks
   * cross-origin image loads from a file:// page to any non-standard scheme.
   * Bytes over IPC have no origin to argue about.
   */
  handle('thumbnail:get', async () => {
    try {
      const data = await fs.promises.readFile(THUMB_PATH);
      if (!data.length) return null;
      // Named .jpg, but SMTC often hands back a PNG — sniff rather than trust.
      const isPng = data[0] === 0x89 && data[1] === 0x50;
      return { mime: isPng ? 'image/png' : 'image/jpeg', bytes: data };
    } catch {
      return null;  // nothing playing, or the track has no embedded art
    }
  });

  /**
   * Whether YouTube captions can run at all.
   *
   * They need yt-dlp, and without it the feature does nothing while its setting
   * still reads as on — which looks exactly like a bug. The window asks for this
   * so it can say so plainly.
   */
  handle('captions:status', async () => {
    const status = await ytDlpStatus();
    return { ...status, enabled: backend.getConfig().cc_enabled !== false };
  });
  handle('captions:revealDir', async () => {
    const dir = ytDlpDropDir();
    if (!dir) throw new Error('No folder configured');
    await fs.promises.mkdir(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true, dir };
  });

  // ── Browser extension ──
  handle('extension:info', async () => ({
    path: extensionPath(),
    available: extensionExists(),
    browsers: await detectBrowsers(),
    connected: backend.isExtensionConnected(),
    enabled: backend.getConfig().extension_enabled !== false,
  }));
  handle('extension:reveal', () => { revealExtensionFolder(); return { ok: true }; });
  handle('extension:copyUrl', (url: string) => { copyExtensionsUrl(url); return { ok: true }; });
  handle('extension:copyPath', () => { copyExtensionPath(); return { ok: true }; });

  // ── Updates ──
  handle('update:status', () => updateState());
  handle('update:check', () => checkForUpdate());
  handle('update:install', () => { installNow(); return { ok: true }; });

  // ── Spicetify ──
  handle('spicetify:info', () => ({
    ...spicetifyInfo(),
    // Whether it is actually reporting right now, which is the only proof that
    // all three steps landed.
    connected: backend.isSpicetifyActive(),
    commands: {
      install: SPICETIFY_INSTALL_CMD,
      enable: SPICETIFY_ENABLE_CMD,
      apply: SPICETIFY_APPLY_CMD,
    },
  }));
  handle('spicetify:install', () => installSpicetifyExtension());
  handle('spicetify:setup', () => setupSpicetify());
  handle('spicetify:reveal', () => revealSpicetifyExtensions());
  handle('spicetify:copy', (text: string) => { copyToClipboard(String(text).slice(0, 500)); return { ok: true }; });

  // ── Players ──
  handle('players:list', () => backend.listPlayers());
  handle('players:prefer', (appId: string | null) => {
    backend.setPreferredPlayer(appId || null);
    return { ok: true, preferred: backend.getPreferredPlayer() };
  });

  // ── Stats & history ──
  handle('stats:session', () => backend.getSessionStats());
  handle('stats:history', () => backend.getStatsHistory());
  // `anchor` pins the listing to the log as it stood when paging began, so a
  // track finishing mid-scroll cannot repeat a row at the seam between pages.
  handle('history:list', (limit = 50, offset = 0, anchor?: number) =>
    backend.getListeningHistory(limit, offset, anchor));
  handle('history:wrapped', (days?: number) => backend.getListeningWrapped(days));

  // ── Custom lyrics library ──
  handle('custom:list', (limit = 50, offset = 0, search?: string) =>
    backend.listCustomLyrics(limit, offset, search));
  handle('custom:get', (id: number) => backend.getCustomLyricsEntry(id));
  handle('custom:import', (data: { track: string; artist: string; album: string; duration?: number; lrc: string }) =>
    ({ id: backend.importCustomLyrics(data) }));
  handle('custom:update', (id: number, data: Record<string, unknown>) =>
    ({ ok: backend.updateCustomLyricsEntry(id, data) }));
  handle('custom:delete', (id: number) => ({ ok: backend.deleteCustomLyricsEntry(id) }));
  handle('custom:checkExisting', (track: string, artist: string, album: string, duration?: number) =>
    backend.checkExistingCustomLyrics(track, artist, album, duration));

  // ── LRCLIB dump search ──
  handle('lrclib:status', () => backend.getLrclibDumpStatus());
  /** Create the drop folder if needed and open it, so "put it here" is one click. */
  handle('lrclib:revealFolder', async () => {
    const { folder } = backend.getLrclibDumpStatus();
    await fs.promises.mkdir(folder, { recursive: true });
    shell.openPath(folder);
    return { ok: true, folder };
  });
  handle('lrclib:search', (query: string, limit?: number) => backend.searchLrclibDump(query, limit));
  handle('lrclib:track', (id: number) => backend.getLrclibTrackLyrics(id));

  // ── Cache ──
  handle('cache:clear', () => ({ cleared: backend.clearLyricsCache() }));
  handle('translate:clearCache', () => { clearTranslationCache(); return { ok: true }; });

  // ── Translation ──
  handle('translate:langs', () => TRANSLATE_LANGS);
  handle('translate:one', async (text: string, target = 'en') => {
    if (!text?.trim()) throw new Error('Missing text');
    if (!TRANSLATE_LANGS[target]) throw new Error(`Unsupported language: ${target}`);
    const result = await translateText(text, target);
    return result
      ? { translation: result.translation, cached: result.cached }
      : { translation: null, reason: 'rate_limited_or_unavailable' };
  });
  handle('translate:batch', async (lines: string[], target = 'en') => {
    if (!lines?.length) throw new Error('Missing lines');
    if (!TRANSLATE_LANGS[target]) throw new Error(`Unsupported language: ${target}`);
    const results = await translateBatch(lines.slice(0, 200), target);
    return { translations: Object.fromEntries(results), count: results.size };
  });

  // ── Last.fm ──
  handle('lastfm:status', () => ({ scrobbling: isScrobbleEnabled(), canAuth: canAuth() }));
  /**
   * Step 1+2 of the desktop flow: take a token, then send the user to Last.fm to
   * approve it. The token is handed back so the renderer can pass it to
   * lastfm:complete once the user says they are done — there is no redirect to
   * catch, so the user's confirmation is what drives the exchange.
   */
  handle('lastfm:beginAuth', async () => {
    const token = await requestAuthToken();
    if (!token) throw new Error('Last.fm API key/secret not configured, or Last.fm is unreachable');
    const url = getAuthUrlForToken(token);
    if (!url) throw new Error('Last.fm API key not configured');
    await shell.openExternal(url);
    return { token };
  });
  handle('lastfm:complete', async (token: string) => {
    if (!token) throw new Error('Missing token');
    const ok = await completeAuth(token);
    if (!ok) throw new Error('Last.fm rejected the token — approve the page in your browser first, then retry');
    return { ok, scrobbling: isScrobbleEnabled() };
  });
  handle('lastfm:disconnect', () => { disconnectScrobble(); return { ok: true, scrobbling: false }; });

  // ── Bug report ──
  /** Whether a report can be sent at all. Deliberately a boolean, not the URL. */
  handle('bugreport:available', () => VALID_WEBHOOK_REGEX.test(reportWebhook(backend)));

  handle('bugreport:send', async (data: {
    summary?: string; category?: string; details?: string;
    track?: { name?: string; artist?: string; album?: string; platform?: string } | null;
    lang?: string; timestamp?: string;
  }) => {
    if (!data?.summary?.trim()) throw new Error('Missing summary');
    if (data.summary.length > 256) throw new Error('Summary too long (max 256 chars)');
    if (data.details && data.details.length > 2000) throw new Error('Details too long (max 2000 chars)');

    const webhookUrl = reportWebhook(backend);
    if (!webhookUrl) throw new Error('Bug reporting is not configured in this build');
    if (!VALID_WEBHOOK_REGEX.test(webhookUrl)) throw new Error('The configured webhook URL is not a valid Discord webhook');

    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    if (today !== reportDayStamp) { reportDayStamp = today; reportsToday = 0; }
    if (now - lastReportAt < REPORT_MIN_GAP_MS) throw new Error('Please wait a moment before sending another report');
    if (reportsToday >= REPORT_DAILY_MAX) throw new Error('Daily report limit reached');

    const hash = createHash('sha256').update(`${data.summary}\0${data.details ?? ''}`).digest('hex');
    const seenAt = recentReportHashes.get(hash);
    if (seenAt && now - seenAt < REPORT_DUPLICATE_WINDOW_MS) throw new Error('That report was already sent recently');

    const trackInfo = data.track
      ? `${data.track.name || '?'} — ${data.track.artist || '?'} (${data.track.platform || '?'})`
      : 'No track playing';
    const details = data.details ? sanitizeDiscord(data.details.slice(0, 1024)) : undefined;

    const embed = {
      title: `🐛 ${sanitizeDiscord(data.summary)}`.slice(0, 256),
      color: 0xff6b6b,
      fields: [
        { name: 'Category', value: sanitizeDiscord(data.category || 'other'), inline: true },
        { name: 'Language', value: sanitizeDiscord(data.lang || '?'), inline: true },
        { name: 'Current Track', value: sanitizeDiscord(trackInfo), inline: false },
        ...(details ? [{ name: 'Details', value: details, inline: false }] : []),
        { name: 'App', value: `Vybecord Desktop ${app.getVersion()} — ${process.platform}`, inline: false },
      ],
      timestamp: data.timestamp || new Date().toISOString(),
      footer: { text: 'Vybecord Bug Report' },
    };

    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`Webhook returned ${resp.status}`);

    // Counted only after the send succeeds, so a failed attempt does not eat
    // the user's quota.
    lastReportAt = now;
    reportsToday++;
    recentReportHashes.set(hash, now);
    if (recentReportHashes.size > 200) {
      for (const [k, t] of recentReportHashes) {
        if (now - t > REPORT_DUPLICATE_WINDOW_MS) recentReportHashes.delete(k);
      }
    }
    return { ok: true };
  });

  // ── Window controls (the frame is custom, so these are ours to implement) ──
  handle('window:minimize', () => { getWindow()?.minimize(); });
  handle('window:maximize', () => {
    const w = getWindow();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  handle('window:close', () => { getWindow()?.close(); });
  handle('window:isMaximized', () => getWindow()?.isMaximized() ?? false);

  // ── Shell ──
  handle('shell:openExternal', async (url: string) => {
    if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) URLs can be opened');
    await shell.openExternal(url);
    return { ok: true };
  });
  handle('app:quit', () => { app.quit(); });
  handle('app:version', () => app.getVersion());
}
