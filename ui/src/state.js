/**
 * Shared renderer state.
 *
 * One place holds what the backend last told us, and pages subscribe to the
 * slices they care about. Pages are rebuilt on navigation, so every subscription
 * returns an unsubscribe that the router calls — otherwise a page visited five
 * times would have five live listeners redrawing five detached DOM trees.
 */

const api = window.vybecord;

const emptySlot = () => ({ track: null, lyrics: null, progress: { progress_ms: 0, duration_ms: 0 } });

export const state = {
  config: {},
  /*
   * `track`, `lyrics` and `progress` are the presence the window is looking
   * at — the focused one — so every page that shows one track keeps working
   * unchanged with two on air. `slots` holds both by position; `focus` says
   * which of them the three mirrors follow.
   */
  track: null,
  lyrics: null,
  progress: { progress_ms: 0, duration_ms: 0 },
  slots: [emptySlot(), emptySlot()],
  focus: 0,
  stats: { topTracks: [], topArtists: [] },
  players: [],
  preferredPlayer: null,
  preferredPlayers: [null, null],
  status: {
    discordConnected: false, mediaSourceReady: false, adPlaying: false, showLyrics: true,
    showLyrics2: true, dualPresence: false, userAway: false, hideWhenAway: true,
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

/**
 * The bar a track should be showing the moment it arrives — its own position,
 * or an empty bar when there is no track at all.
 *
 * Progress reaches the window as its own event, which only ever fires while
 * something is playing: stopping produces no final "back to zero" tick, because
 * there is nothing left to report a position for. So the last position of the
 * last track stayed in the state after it ended, and any repaint that read the
 * state rather than the event -- opening the page again, most of all -- put that
 * dead bar back under "Nothing playing".
 */
const trackProgress = (track) => ({
  progress_ms: track?.progress_ms || 0,
  duration_ms: track?.duration_ms || 0,
});

/** Merge a patch into state and notify the affected keys. */
export function set(patch) {
  Object.assign(state, patch);
  for (const key of Object.keys(patch)) emit(key, state[key]);
}

/** Point the three single-track mirrors at the focused presence. */
function mirrorFocus() {
  const s = state.slots[state.focus] || emptySlot();
  set({ track: s.track, lyrics: s.lyrics, progress: s.progress });
}

/**
 * Look at one presence. The Now page calls this when a card is clicked; the
 * state calls it itself when the one being looked at goes quiet while the
 * other plays on, so the page never sits on "Nothing playing" beside a track.
 */
export function setFocus(index) {
  const i = index === 1 ? 1 : 0;
  if (i === state.focus) return;
  set({ focus: i });
  mirrorFocus();
}

function autoFocus() {
  const cur = state.slots[state.focus];
  if (cur?.track) return;
  const other = state.focus === 0 ? 1 : 0;
  if (state.slots[other]?.track) setFocus(other);
}

/** Apply a backend event to one presence's slice, and to the mirrors if it is the focused one. */
function updateSlot(index, patch) {
  const i = index === 1 ? 1 : 0;
  const slots = [...state.slots];
  slots[i] = { ...slots[i], ...patch };
  set({ slots });
  if (i === state.focus) set(patch);
  autoFocus();
}

/** Load the full snapshot and wire the backend event stream. */
export async function init() {
  const snap = await api.snapshot();
  const slots = Array.isArray(snap.slots) && snap.slots.length
    ? snap.slots.map((s) => ({
        track: s?.track ?? null,
        lyrics: s?.lyrics ?? null,
        progress: s?.track ? (s.progress || trackProgress(s.track)) : trackProgress(null),
      }))
    : [{ track: snap.track, lyrics: snap.lyrics, progress: trackProgress(snap.track) }, emptySlot()];
  while (slots.length < 2) slots.push(emptySlot());
  set({
    config: snap.config || {},
    slots,
    stats: snap.stats || { topTracks: [], topArtists: [] },
    players: snap.players || [],
    preferredPlayer: snap.preferredPlayer,
    preferredPlayers: snap.preferredPlayers || [snap.preferredPlayer ?? null, null],
    status: { ...state.status, ...(snap.status || {}) },
    version: snap.version || '',
  });
  mirrorFocus();
  autoFocus();

  /*
   * A new track invalidates the lines the old one left behind.
   *
   * Nothing else clears them — the backend pushes lyrics only once the new song
   * has some — so between a skip and its first line the pages were painting the
   * previous song's words under the new title. The id is what decides: the same
   * track is re-sent whenever its metadata is enriched, and that must not wipe
   * the lyrics it already has.
   */
  api.on('trackUpdate', (track, slot) => {
    const prev = state.slots[slot === 1 ? 1 : 0]?.track;
    const same = (track?.track_id || '') === (prev?.track_id || '');
    // A different track means the bar belongs to the new one -- at its own
    // position, or empty when playback simply stopped. Same reasoning as the
    // lyrics beside it: what the previous track left behind is not an
    // approximation of the new state, it is the wrong state.
    updateSlot(slot, same ? { track } : { track, lyrics: null, progress: trackProgress(track) });
  });
  api.on('progressUpdate', (progress, slot) => updateSlot(slot, { progress }));
  api.on('lyricsUpdate', (lyrics, slot) => updateSlot(slot, { lyrics }));
  api.on('plainLyricsUpdate', (lyrics, slot) => updateSlot(slot, { lyrics }));
  api.on('statsUpdate', (stats) => set({ stats }));
  api.on('configUpdate', (config) => set({ config }));
  api.on('statusUpdate', (status) => {
    set({ status: { ...state.status, ...status } });
    if (status && 'preferredPlayer' in status) set({ preferredPlayer: status.preferredPlayer });
    if (status && Array.isArray(status.preferredPlayers)) set({ preferredPlayers: status.preferredPlayers });
    // With the second card switched off, whatever it showed is gone too.
    if (status && status.dualPresence === false && state.focus === 1) setFocus(0);
  });

  /*
   * The player list has no push channel — WinRT reports sessions, not a
   * "session list changed" event we could forward cheaply — so it is polled.
   *
   * Only while somebody can see it, though. This app's normal state is hidden
   * in the tray with the window still alive behind it, and the poll ran there
   * too: an IPC round trip, a walk of every media session and a state emit,
   * every two seconds, for hours, painting a window nobody was looking at.
   * Nothing else in the renderer polls the main process, so this was the whole
   * of the app's idle cost.
   *
   * Refreshed on the way back rather than waiting for the next tick, so the
   * picker is right the instant the window opens.
   */
  const refreshPlayers = async () => {
    try {
      set({ players: await api.listPlayers() });
    } catch {
      /* main process is shutting down */
    }
  };
  setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    void refreshPlayers();
  }, 2000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshPlayers();
  });
}

/** Write config keys through to the backend, updating local state optimistically. */
export async function saveConfig(patch) {
  set({ config: { ...state.config, ...patch } });
  const fresh = await api.setConfig(patch);
  set({ config: fresh });
  return fresh;
}
