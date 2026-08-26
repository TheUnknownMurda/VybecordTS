/**
 * Shared renderer state.
 *
 * One place holds what the backend last told us, and pages subscribe to the
 * slices they care about. Pages are rebuilt on navigation, so every subscription
 * returns an unsubscribe that the router calls — otherwise a page visited five
 * times would have five live listeners redrawing five detached DOM trees.
 */

const api = window.vybecord;

export const state = {
  config: {},
  track: null,
  lyrics: null,
  progress: { progress_ms: 0, duration_ms: 0 },
  stats: { topTracks: [], topArtists: [] },
  players: [],
  preferredPlayer: null,
  status: {
    discordConnected: false, mediaSourceReady: false, adPlaying: false, showLyrics: true,
    userAway: false, hideWhenAway: true,
  },
  version: '',
};

const listeners = new Map();

/** Subscribe to a state key. Returns an unsubscribe function. */
export function subscribe(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key)?.delete(fn);
}

function emit(key, value) {
  for (const fn of listeners.get(key) ?? []) {
    try {
      fn(value);
    } catch (e) {
      console.error(`listener for "${key}" failed`, e);
    }
  }
}

/** Merge a patch into state and notify the affected keys. */
export function set(patch) {
  Object.assign(state, patch);
  for (const key of Object.keys(patch)) emit(key, state[key]);
}

/** Load the full snapshot and wire the backend event stream. */
export async function init() {
  const snap = await api.snapshot();
  set({
    config: snap.config || {},
    track: snap.track,
    lyrics: snap.lyrics,
    stats: snap.stats || { topTracks: [], topArtists: [] },
    players: snap.players || [],
    preferredPlayer: snap.preferredPlayer,
    status: snap.status || state.status,
    version: snap.version || '',
    progress: snap.track
      ? { progress_ms: snap.track.progress_ms, duration_ms: snap.track.duration_ms }
      : { progress_ms: 0, duration_ms: 0 },
  });

  /*
   * A new track invalidates the lines the old one left behind.
   *
   * Nothing else clears them — the backend pushes lyrics only once the new song
   * has some — so between a skip and its first line the pages were painting the
   * previous song's words under the new title. The id is what decides: the same
   * track is re-sent whenever its metadata is enriched, and that must not wipe
   * the lyrics it already has.
   */
  api.on('trackUpdate', (track) => {
    const same = (track?.track_id || '') === (state.track?.track_id || '');
    set(same ? { track } : { track, lyrics: null });
  });
  api.on('progressUpdate', (progress) => set({ progress }));
  api.on('lyricsUpdate', (lyrics) => set({ lyrics }));
  api.on('plainLyricsUpdate', (lyrics) => set({ lyrics }));
  api.on('statsUpdate', (stats) => set({ stats }));
  api.on('configUpdate', (config) => set({ config }));
  api.on('statusUpdate', (status) => {
    set({ status: { ...state.status, ...status } });
    if (status && 'preferredPlayer' in status) set({ preferredPlayer: status.preferredPlayer });
  });

  // The player list has no push channel — WinRT reports sessions, not a
  // "session list changed" event we could forward cheaply — so it is polled.
  // It is a plain in-memory read on the main side, so the cost is negligible.
  setInterval(async () => {
    try {
      set({ players: await api.listPlayers() });
    } catch {
      /* main process is shutting down */
    }
  }, 2000);
}

/** Write config keys through to the backend, updating local state optimistically. */
export async function saveConfig(patch) {
  set({ config: { ...state.config, ...patch } });
  const fresh = await api.setConfig(patch);
  set({ config: fresh });
  return fresh;
}
