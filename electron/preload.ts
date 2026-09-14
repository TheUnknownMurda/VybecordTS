/**
 * Preload — the only bridge between the renderer and the backend.
 *
 * Everything is an explicit named method. The renderer never gets `ipcRenderer`
 * itself, so it cannot reach a channel that is not listed here, and it never
 * gets node built-ins at all.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/** Backend events the renderer may subscribe to. */
const EVENTS = [
  'trackUpdate', 'progressUpdate', 'lyricsUpdate', 'plainLyricsUpdate',
  'statusUpdate', 'configUpdate', 'statsUpdate', 'fatal', 'updateStatus',
] as const;
type BackendEvent = typeof EVENTS[number];

const invoke = <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api = {
  // ── Lifecycle ──
  snapshot: () => invoke('app:snapshot'),
  version: () => invoke<string>('app:version'),
  quit: () => invoke('app:quit'),

  // ── Config ──
  getConfig: () => invoke<Record<string, unknown>>('config:get'),
  setConfig: (updates: Record<string, unknown>) => invoke<Record<string, unknown>>('config:set', updates),

  // ── Now playing ──
  // `slot` is the presence (0 or 1) the call is about; omitted means the first.
  getTrack: (slot = 0) => invoke('track:current', slot),
  getLyrics: (slot = 0) => invoke('lyrics:current', slot),
  getLrc: (slot = 0) => invoke<string | null>('lyrics:lrc', slot),
  getThumbnail: () => invoke<{ mime: string; bytes: Uint8Array } | null>('thumbnail:get'),
  setLyricsOffset: (ms: number, slot = 0) => invoke('lyrics:offset', ms, slot),
  lyricsOffsetCurrent: (slot = 0) => invoke('lyrics:offsetCurrent', slot),
  flagLyrics: (slot = 0) => invoke('lyrics:flag', slot),
  listFlagged: () => invoke('lyrics:flagged'),
  unflag: (key: string) => invoke('lyrics:unflag', key),

  // ── YouTube captions ──
  captionsStatus: () => invoke<{ available: boolean; command: string; dropDir: string; enabled: boolean }>('captions:status'),
  revealCaptionsDir: () => invoke<{ ok: boolean; dir: string }>('captions:revealDir'),

  // ── Browser extension ──
  extensionInfo: () => invoke<{
    path: string; available: boolean; connected: boolean; enabled: boolean;
    /** True when something else holds 127.0.0.1:8888 and the endpoint gave up. */
    portBlocked: boolean;
    browsers: { id: string; name: string; extensionsUrl: string; family: string }[];
  }>('extension:info'),
  revealExtension: () => invoke('extension:reveal'),
  copyExtensionsUrl: (url: string) => invoke('extension:copyUrl', url),
  copyExtensionPath: () => invoke('extension:copyPath'),

  // ── Updates ──
  updateStatus: () => invoke<{ status: string; version?: string; percent?: number; message?: string }>('update:status'),
  checkForUpdate: () => invoke<{ status: string; version?: string }>('update:check'),
  installUpdate: () => invoke('update:install'),

  // ── Spicetify ──
  spicetifyInfo: () => invoke<{
    installed: boolean; extensionCopied: boolean; extensionCurrent: boolean;
    extensionEnabled: boolean;
    bundled: boolean; connected: boolean; extensionsDir: string;
    commands: { install: string; enable: string; apply: string };
  }>('spicetify:info'),
  spicetifyInstall: () => invoke<{ ok: boolean; path: string }>('spicetify:install'),
  /** Copy, enable and apply in one go — this restarts Spotify. */
  spicetifySetup: () => invoke<{
    ok: boolean;
    steps: { id: string; label: string; ok: boolean; detail: string }[];
  }>('spicetify:setup'),
  spicetifyReveal: () => invoke<{ ok: boolean; dir: string }>('spicetify:reveal'),
  spicetifyCopy: (text: string) => invoke('spicetify:copy', text),

  // ── Players ──
  listPlayers: () => invoke('players:list'),
  /** Pin a player to a presence (0 or 1); null puts that presence back on automatic. */
  preferPlayer: (appId: string | null, slot = 0) => invoke('players:prefer', appId, slot),

  // ── Stats & history ──
  getStats: () => invoke('stats:session'),
  getStatsHistory: () => invoke('stats:history'),
  getHistory: (limit?: number, offset?: number, anchor?: number) => invoke('history:list', limit, offset, anchor),
  getWrapped: (days?: number) => invoke('history:wrapped', days),

  // ── Custom lyrics ──
  listCustom: (limit?: number, offset?: number, search?: string) => invoke('custom:list', limit, offset, search),
  getCustom: (id: number) => invoke('custom:get', id),
  importCustom: (data: unknown) => invoke('custom:import', data),
  updateCustom: (id: number, data: unknown) => invoke('custom:update', id, data),
  deleteCustom: (id: number) => invoke('custom:delete', id),
  checkExistingCustom: (track: string, artist: string, album: string, duration?: number) =>
    invoke('custom:checkExisting', track, artist, album, duration),

  // ── LRCLIB dump ──
  lrclibStatus: () => invoke<{ loaded: boolean; path: string; folder: string; configured: string }>('lrclib:status'),
  revealLrclibFolder: () => invoke<{ ok: boolean; folder: string }>('lrclib:revealFolder'),
  searchLrclib: (query: string, limit?: number) => invoke('lrclib:search', query, limit),
  getLrclibTrack: (id: number) => invoke('lrclib:track', id),

  // ── Cache ──
  clearCache: () => invoke('cache:clear'),
  clearTranslationCache: () => invoke('translate:clearCache'),

  // ── Translation ──
  translateLangs: () => invoke<Record<string, string>>('translate:langs'),
  translate: (text: string, target?: string) => invoke('translate:one', text, target),
  translateBatch: (lines: string[], target?: string) => invoke('translate:batch', lines, target),

  // ── Last.fm ──
  lastfmStatus: () => invoke<{
    scrobbling: boolean; canAuth: boolean; configured: boolean;
    user: string | null; pending: number;
  }>('lastfm:status'),
  lastfmBeginAuth: () => invoke<{ token: string }>('lastfm:beginAuth'),
  lastfmComplete: (token: string) => invoke('lastfm:complete', token),
  lastfmDisconnect: () => invoke('lastfm:disconnect'),

  // ── Bug report ──
  bugReportAvailable: () => invoke<boolean>('bugreport:available'),
  sendBugReport: (data: unknown) => invoke('bugreport:send', data),

  // ── Window ──
  minimize: () => invoke('window:minimize'),
  toggleMaximize: () => invoke('window:maximize'),
  close: () => invoke('window:close'),
  isMaximized: () => invoke<boolean>('window:isMaximized'),
  onWindowState: (cb: (state: { maximized: boolean }) => void) => {
    const listener = (_e: IpcRendererEvent, state: { maximized: boolean }) => cb(state);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.off('window:state', listener);
  },

  // ── Shell ──
  openExternal: (url: string) => invoke('shell:openExternal', url),

  /**
   * Subscribe to a backend event. Returns an unsubscribe function — the pages
   * re-register listeners as the user navigates, and without a way to detach
   * they would stack up one dead listener per visit.
   */
  on: (event: BackendEvent, cb: (payload: unknown, slot: number) => void): (() => void) => {
    if (!EVENTS.includes(event)) throw new Error(`Unknown event: ${event}`);
    // The second argument names the presence a track, progress or lyric
    // event belongs to; the other events send 0 and nothing reads it.
    const listener = (_e: IpcRendererEvent, payload: unknown, slot: number) => cb(payload, slot ?? 0);
    ipcRenderer.on(`backend:${event}`, listener);
    return () => ipcRenderer.off(`backend:${event}`, listener);
  },
};

contextBridge.exposeInMainWorld('vybecord', api);

export type VybecordApi = typeof api;
