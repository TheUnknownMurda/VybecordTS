/**
 * Shared renderer state.
 *
 * One place holds what the backend last told us, and pages subscribe to the
 * slices they care about. Pages are rebuilt on navigation, so every subscription
 * returns an unsubscribe that the router calls — otherwise a page visited five
 * times would have five live listeners redrawing five detached DOM trees.
 */

const api = window.vybecord;

const emptySlot = () => ({ track: null, lyrics: null, activity: null, progress: { progress_ms: 0, duration_ms: 0 }, lastTrack: null });
/** How many presence cards the app can hold — matches MAX_SLOTS in the backend. */
export const MAX_SLOTS = 5;

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
  /** The card the engine last built for the focused presence — the Discord preview. */
  activity: null,
  progress: { progress_ms: 0, duration_ms: 0 },
  /*
   * The song a presence was playing when it stopped, paused where it stopped.
   * The backend takes the track down on a pause — Discord's card reads
   * "Nothing playing" then — so without this a paused Spotify read as
   * "Waiting for a player… Play something in Spotify", with Spotify open on
   * the song. Null once anything
   * plays again, and never a live stream: one that stops has ended.
   */
  lastTrack: null,
  slots: Array.from({ length: MAX_SLOTS }, emptySlot),
  focus: 0,
  players: [],
  preferredPlayer: null,
  preferredPlayers: new Array(MAX_SLOTS).fill(null),
  status: {
    discordConnected: false, mediaSourceReady: false, adPlaying: false, showLyrics: true,
    presenceCount: 1, userAway: false, hideWhenAway: true,
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

/** Point the single-track mirrors at the focused presence. */
function mirrorFocus() {
  const s = state.slots[state.focus] || emptySlot();
  set({ track: s.track, lyrics: s.lyrics, activity: s.activity ?? null, progress: s.progress, lastTrack: s.lastTrack ?? null });
}

const slotIndex = (index) => Math.max(0, Math.min(MAX_SLOTS - 1, Number.isInteger(index) ? index : 0));

/**
 * An empty presence the user picked by hand, or -1: picked on purpose, it is
 * not taken away from them. Cleared once something plays on it, after which
 * it is moved off like any other when it goes quiet.
 */
let chosen = -1;

function focusOn(i) {
  if (i === state.focus) return;
  set({ focus: i });
  mirrorFocus();
}

/** Look at one presence: the Now page calls this when a card is clicked. */
export function setFocus(index) {
  const i = slotIndex(index);
  chosen = i;
  focusOn(i);
}

/*
 * The state moves the view itself when the presence being looked at has
 * nothing to show while another plays, so the page never sits on "Nothing
 * playing" beside a track. A paused song is something to show: it ran on
 * every update of any presence, and with a live stream on the other card
 * that is every second, so clicking the paused card showed it for a moment
 * and then jumped back to the stream. Nor does it undo a click.
 */
function autoFocus() {
  const cur = state.slots[state.focus];
  if (cur?.track || cur?.lastTrack || chosen === state.focus) return;
  const other = state.slots.findIndex((s) => s?.track);
  if (other >= 0) focusOn(other);
}

/** Apply a backend event to one presence's slice, and to the mirrors if it is the focused one. */
function updateSlot(index, patch) {
  const i = slotIndex(index);
  const slots = [...state.slots];
  slots[i] = { ...slots[i], ...patch };
  if (i === chosen && slots[i].track) chosen = -1;
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
        activity: s?.activity ?? null,
        progress: s?.track ? (s.progress || trackProgress(s.track)) : trackProgress(null),
        lastTrack: null,
      }))
    : [{ track: snap.track, lyrics: snap.lyrics, progress: trackProgress(snap.track) }];
  while (slots.length < MAX_SLOTS) slots.push(emptySlot());
  set({
    config: snap.config || {},
    slots,
    players: snap.players || [],
    preferredPlayer: snap.preferredPlayer,
    preferredPlayers: snap.preferredPlayers || [snap.preferredPlayer ?? null],
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
    // Compared against its own presence. This read `slot === 1 ? 1 : 0` from
    // when there were two, so presences 3 to 5 measured every track against
    // presence 1's and kept or dropped their lyrics on the strength of it.
    const was = state.slots[slotIndex(slot)];
    const prev = was?.track;
    const same = (track?.track_id || '') === (prev?.track_id || '');
    // A different track means the bar belongs to the new one -- at its own
    // position, or empty when playback simply stopped. Same reasoning as the
    // lyrics beside it: what the previous track left behind is not an
    // approximation of the new state, it is the wrong state. The card built
    // for the previous track goes with them.
    const stopped = !track && prev && !prev.is_live
      ? { ...prev, is_playing: false, progress_ms: was.progress?.progress_ms ?? prev.progress_ms }
      : null;
    updateSlot(slot, same ? { track } : {
      track, lyrics: null, activity: null, progress: trackProgress(track), lastTrack: stopped,
    });
  });
  api.on('progressUpdate', (progress, slot) => updateSlot(slot, { progress }));
  /*
   * The words-only fallback and the engine's state share one slice, and the
   * engine keeps talking after the fallback lands: a song with no synced lines
   * still gets its "♪♪" tick, and that tick replaced the 39 plain lines a
   * moment after they arrived, so they never showed. Each event now carries
   * over what the other one set. A new track still starts clean — trackUpdate
   * drops the slice on a change of id — and synced lines, once there, win.
   */
  api.on('lyricsUpdate', (lyrics, slot) => {
    const prev = state.slots[slotIndex(slot)]?.lyrics;
    const synced = Array.isArray(lyrics?.lyrics) && lyrics.lyrics.length > 0;
    const keep = !synced && Array.isArray(prev?.lines) && prev.lines.length > 0;
    updateSlot(slot, { lyrics: keep ? { ...lyrics, lines: prev.lines } : lyrics });
  });
  api.on('plainLyricsUpdate', (plain, slot) => {
    const prev = state.slots[slotIndex(slot)]?.lyrics;
    updateSlot(slot, { lyrics: { ...prev, lines: plain?.lines ?? [] } });
  });
  api.on('activityUpdate', (activity, slot) => updateSlot(slot, { activity }));
  api.on('configUpdate', (config) => set({ config }));
  api.on('statusUpdate', (status) => {
    set({ status: { ...state.status, ...status } });
    if (status && 'preferredPlayer' in status) set({ preferredPlayer: status.preferredPlayer });
    if (status && Array.isArray(status.preferredPlayers)) set({ preferredPlayers: status.preferredPlayers });
    // A card beyond the new count is gone, whatever it showed.
    if (status && typeof status.presenceCount === 'number' && state.focus >= status.presenceCount) focusOn(0);
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
