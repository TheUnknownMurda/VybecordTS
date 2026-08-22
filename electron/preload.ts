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
  getTrack: () => invoke('track:current'),
  getLyrics: () => invoke('lyrics:current'),
  getLrc: () => invoke<string | null>('lyrics:lrc'),
  getThumbnail: () => invoke<{ mime: string; bytes: Uint8Array } | null>('thumbnail:get'),
  setLyricsOffset: (ms: number) => invoke('lyrics:offset', ms),
  flagLyrics: () => invoke('lyrics:flag'),
  listFlagged: () => invoke('lyrics:flagged'),
  unflag: (key: string) => invoke('lyrics:unflag', key),

  // ── YouTube captions ──
  captionsStatus: () => invoke<{ available: boolean; command: string; dropDir: string; enabled: boolean }>('captions:status'),
  revealCaptionsDir: () => invoke<{ ok: boolean; dir: string }>('captions:revealDir'),

  // ── Browser extension ──
  extensionInfo: () => invoke<{
    path: string; available: boolean; connected: boolean; enabled: boolean;
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
    installed: boolean; extensionCopied: boolean; extensionEnabled: boolean;
    bundled: boolean; connected: boolean; extensionsDir: string;
    commands: { install: string; enable: string; apply: string };
  }>('spicetify:info'),
  spicetifyInstall: () => invoke<{ ok: boolean; path: string }>('spicetify:install'),
  spicetifyReveal: () => invoke<{ ok: boolean; dir: string }>('spicetify:reveal'),
  spicetifyCopy: (text: string) => invoke('spicetify:copy', text),

  // ── Players ──
  listPlayers: () => invoke('players:list'),
  preferPlayer: (appId: string | null) => invoke('players:prefer', appId),

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
  lastfmStatus: () => invoke<{ scrobbling: boolean; canAuth: boolean }>('lastfm:status'),
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
  on: (event: BackendEvent, cb: (payload: unknown) => void): (() => void) => {
    if (!EVENTS.includes(event)) throw new Error(`Unknown event: ${event}`);
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(`backend:${event}`, listener);
    return () => ipcRenderer.off(`backend:${event}`, listener);
  },
};

contextBridge.exposeInMainWorld('vybecord', api);

export type VybecordApi = typeof api;
