/**
 * Lyrics library — the local custom-lyrics database.
 *
 * Four jobs: browse and edit what you have imported, write or paste lyrics and
 * time them against the playing track, pull a track out of a LRCLIB dump to
 * seed an entry, and clear tracks you have flagged as having the wrong lyrics.
 */

import { el, modal, toast, fmtTime } from '../util.js';
import { state, subscribe } from '../state.js';

const api = window.vybecord;
const PAGE_SIZE = 40;

/** A presence with nothing in it — what an out-of-range slot reads as. */
const EMPTY_SLOT = { track: null, lyrics: null, progress: { progress_ms: 0, duration_ms: 0 } };

/** How many presences are on air, and one presence's slice of the state. */
const presenceCount = () => Math.max(1, Number(state.status?.presenceCount) || 1);
const slotOf = (i) => state.slots?.[i] || EMPTY_SLOT;

/**
 * @param params optional handover from another page — `{ tab, prefill }`. Now
 *   playing uses it to drop a track's lyrics straight into the import form
 *   after the user reports the timing as off.
 */
export function render(root, params) {
  const TABS = { import: renderImport, browse: renderBrowse, dump: renderDump, flagged: renderFlagged };
  const body = el('div');
  let tab = TABS[params?.tab] ? params.tab : 'import';
  // Consumed by the first paint of the tab it was meant for; coming back to the
  // page later must not resurrect it.
  let prefill = params?.prefill || null;
  // The import tab holds a key handler and a ticker while its sync studio is
  // open, so a tab can hand back a disposer. The router calls ours on the way
  // out; switching tabs calls it too, since the old tab's DOM is thrown away.
  let disposeTab = null;

  const tabs = el('div', { class: 'tabs' }, [
    tabBtn('Import', 'import'),
    tabBtn('My lyrics', 'browse'),
    tabBtn('LRCLIB dump', 'dump'),
    tabBtn('Flagged', 'flagged'),
  ]);

  root.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('h1', { text: 'Lyrics library' }),
      el('div', { class: 'sub', text: 'Custom lyrics stored locally. These always win over anything fetched online.' }),
    ]),
    tabs,
    body,
  );

  function tabBtn(label, id) {
    return el('button', {
      class: `tab ${id === tab ? 'active' : ''}`.trim(),
      text: label,
      onclick: (e) => {
        tab = id;
        [...tabs.children].forEach((c) => c.classList.toggle('active', c === e.target));
        show();
      },
    });
  }

  function releaseTab() {
    if (!disposeTab) return;
    try {
      disposeTab();
    } catch (e) {
      console.error('library tab cleanup failed', e);
    }
    disposeTab = null;
  }

  function show() {
    releaseTab();
    body.replaceChildren();
    const handover = tab === params?.tab ? prefill : null;
    prefill = null;
    // The async tabs resolve to a promise rather than a disposer; only the ones
    // that actually own something outside their own DOM return a function.
    const result = TABS[tab](body, show, handover);
    disposeTab = typeof result === 'function' ? result : null;
  }
  show();

  return releaseTab;
}

// ── Browse ────────────────────────────────────────────────────────────────────

async function renderBrowse(body, refresh) {
  let offset = 0;
  let search = '';
  const list = el('div', { class: 'list' });
  const counter = el('div', { class: 'muted' });
  const more = el('button', { class: 'btn', text: 'Load more', style: 'margin-top:12px', onclick: () => load(false) });

  const searchInput = el('input', {
    type: 'search', placeholder: 'Search title, artist or album…',
    oninput: debounce((e) => { search = e.target.value; load(true); }, 250),
  });

  body.replaceChildren(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h2', { text: 'Stored lyrics' }), counter]),
    el('div', { style: 'margin-bottom:12px' }, [searchInput]),
    list,
    more,
  ]));

  async function load(reset) {
    if (reset) { offset = 0; list.replaceChildren(); }
    more.disabled = true;
    try {
      const res = await api.listCustom(PAGE_SIZE, offset, search || undefined);
      const entries = res?.entries || [];
      const total = res?.total || 0;
      offset += entries.length;

      if (!entries.length && offset === 0) {
        list.replaceChildren(el('div', { class: 'empty', text: search ? 'No match.' : 'Nothing imported yet.' }));
      } else {
        list.append(...entries.map((e) => entryRow(e, refresh)));
      }
      counter.textContent = total ? `${offset} of ${total}` : '';
      more.style.display = offset >= total ? 'none' : '';
    } catch (e) {
      toast(`Could not load: ${e.message}`, 'err');
    } finally {
      more.disabled = false;
    }
  }
  await load(true);
}

function entryRow(e, refresh) {
  return el('div', { class: 'item' }, [
    el('div', { class: 'item-body' }, [
      el('div', { class: 'item-title', text: e.track_name }),
      el('div', { class: 'item-sub', text: `${e.artist_name}${e.album_name ? ` · ${e.album_name}` : ''}${e.duration ? ` · ${fmtTime(e.duration * 1000)}` : ''}` }),
    ]),
    el('div', { class: 'item-actions' }, [
      el('button', { class: 'btn btn-sm', text: 'Edit', onclick: () => editEntry(e, refresh) }),
      el('button', {
        class: 'btn btn-sm btn-danger', text: 'Delete',
        onclick: async () => {
          if (!(await confirmBox(`Delete the lyrics for “${e.track_name}”?`))) return;
          await api.deleteCustom(e.track_id);
          toast('Deleted', 'ok');
          refresh();
        },
      }),
    ]),
  ]);
}

async function editEntry(entry, refresh) {
  let full;
  try {
    full = await api.getCustom(entry.track_id);
  } catch (e) {
    return toast(`Could not open: ${e.message}`, 'err');
  }

  const track = el('input', { type: 'text', value: full?.track_name ?? entry.track_name });
  const artist = el('input', { type: 'text', value: full?.artist_name ?? entry.artist_name });
  const album = el('input', { type: 'text', value: full?.album_name ?? entry.album_name ?? '' });
  const lrc = el('textarea', { rows: 14, text: full?.synced_lyrics ?? '' });

  // Not dismissable: this box holds a textarea the user may have spent ten
  // minutes in, and a click that missed it — or an Escape meant for something
  // else — used to close it and drop every edit without asking.
  await modal((close) => el('div', {}, [
    el('h2', { text: 'Edit lyrics' }),
    el('div', { class: 'muted', style: 'margin-top:6px', text: 'Save or Cancel to close — clicking outside leaves your edits alone.' }),
    el('div', { style: 'margin-top:16px' }, [
      field('Title', track), field('Artist', artist), field('Album', album), field('Synced lyrics (.lrc)', lrc),
    ]),
    el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px' }, [
      el('button', { class: 'btn', text: 'Cancel', onclick: () => close() }),
      el('button', {
        class: 'btn btn-primary', text: 'Save',
        onclick: async () => {
          try {
            await api.updateCustom(entry.track_id, {
              track_name: track.value.trim(),
              artist_name: artist.value.trim(),
              album_name: album.value.trim(),
              synced_lyrics: lrc.value,
            });
            toast('Saved', 'ok');
            close();
            refresh();
          } catch (e) {
            toast(`Save failed: ${e.message}`, 'err');
          }
        },
      }),
    ]),
  ]), { dismissable: false });
}

// ── Import ────────────────────────────────────────────────────────────────────

/*
 * The import form's draft.
 *
 * Switching tabs throws that tab's DOM away, and rebuilding it handed back an
 * empty form: a song half typed in, or a hundred lines pasted and not yet
 * saved, were gone because the user glanced at My lyrics for a second. The
 * draft outlives the DOM instead — across tabs, and across leaving the page
 * altogether — for as long as the window is alive. Closing to the tray only
 * hides that window, so it survives that too; quitting does not.
 */
const importDraft = {
  track: '', artist: '', album: '', duration: '', lrc: '', status: '',
  /** null until a presence is picked; the focused one is the first answer. */
  slot: null,
};

const LRC_PLACEHOLDER = [
  'Paste the lyrics here, or type them out — one line per line, exactly as you',
  'want them to appear.',
  '',
  'Already timed? Paste the .lrc as it is:',
  '[00:12.34] First line',
  '[00:16.78] Second line',
  '',
  'Just the words? That is fine — play the song and hit “Sync while playing”',
  'to stamp each line as you hear it.',
].join('\n');

function renderImport(body, refresh, prefill) {
  const track = el('input', { type: 'text', placeholder: 'Song title', value: importDraft.track });
  const artist = el('input', { type: 'text', placeholder: 'Artist', value: importDraft.artist });
  const album = el('input', { type: 'text', placeholder: 'Album (optional)', value: importDraft.album });
  const duration = el('input', { type: 'number', placeholder: 'Duration in seconds (optional)', min: 0, value: importDraft.duration });
  const lrc = el('textarea', { rows: 14, placeholder: LRC_PLACEHOLDER, text: importDraft.lrc });
  const status = el('div', { class: 'muted', style: 'margin-top:8px', text: importDraft.status });

  const fields = [track, artist, album, duration, lrc];

  /*
   * Which presence this page works against.
   *
   * With one on air "the current track" means one thing and this stays hidden.
   * With several it does not, and the window's focus is the wrong answer: it
   * moves on its own the moment the presence it points at falls quiet, which
   * used to drag a half-finished sync onto whatever the other player had just
   * started. So the choice is made here, and the studio is pinned to it.
   */
  let slot = importDraft.slot ?? Math.min(Math.max(0, state.focus || 0), presenceCount() - 1);

  /**
   * Mirror the form into the draft.
   *
   * Typing is covered by the listeners below; every place that writes a value
   * itself — the fill button, Clear, a save, timings coming back from the
   * studio — has to say so, because setting .value fires no input event.
   */
  const keepDraft = () => {
    importDraft.track = track.value;
    importDraft.artist = artist.value;
    importDraft.album = album.value;
    importDraft.duration = duration.value;
    importDraft.lrc = lrc.value;
    importDraft.status = status.textContent;
    importDraft.slot = slot;
  };
  fields.forEach((f) => f.addEventListener('input', keepDraft));

  /** What a presence's option says: the position, and what is on it. */
  const slotLabel = (i) => {
    const t = slotOf(i).track;
    return `Presence ${i + 1} — ${t ? (t.track_name || 'Unknown track') : 'nothing playing'}`;
  };

  const picker = el('div');
  // Rebuilt only when the words on it change. 'slots' fires on every progress
  // tick, and replacing the control once a second would swallow the click that
  // happened to land on it.
  let pickerKey = '';
  function paintPicker() {
    const count = presenceCount();
    if (slot >= count) slot = 0;
    const key = count < 2 ? '' : [slot, ...Array.from({ length: count }, (_, i) => slotLabel(i))].join('|');
    if (key === pickerKey) return;
    pickerKey = key;
    if (!key) return picker.replaceChildren();
    picker.replaceChildren(el('div', { class: 'row' }, [
      el('div', {}, [
        el('div', { class: 'row-label', text: 'Which presence' }),
        el('div', { class: 'row-desc', text: 'Several players are on air. This picks the one Fill from current track '
          + 'reads, and the one Sync while playing follows — it stays on that player for the whole pass, whatever '
          + 'the others start or stop doing.' }),
      ]),
      el('div', { class: 'row-control' }, [
        el('select', {
          onchange: (e) => { slot = Number(e.target.value) || 0; keepDraft(); paintPicker(); },
        }, Array.from({ length: count }, (_, i) => el('option', {
          value: String(i), selected: i === slot, text: slotLabel(i),
        }))),
      ]),
    ]));
  }
  paintPicker();

  /**
   * Copy the chosen presence's track into the form — the words with it.
   *
   * The lyrics are the whole reason to be on this page, so leaving that one box
   * empty made the button half a feature: the app had the lines on screen and
   * the user retyped them underneath. Timed lines come in with their stamps,
   * which the studio can re-tap one by one; a plain fetch comes in bare, which
   * is exactly what the studio is for.
   */
  async function fillFromTrack() {
    const t = slotOf(slot).track;
    if (!t) {
      return toast(presenceCount() > 1 ? `Presence ${slot + 1} is not playing anything` : 'Nothing is playing', 'err');
    }

    const words = await loadedLyrics(slot);
    const typed = lrc.value.trim();
    if (words && typed && typed !== words.text.trim()
      && !(await confirmBox('Replace what is in the lyrics box with the lines loaded for this track?'))) return;

    track.value = t.track_name || '';
    artist.value = t.artist_name || '';
    album.value = t.album_name || '';
    duration.value = t.duration_ms > 0 ? String(Math.round(t.duration_ms / 1000)) : '';
    if (words) lrc.value = words.text;

    status.textContent = !words
      ? 'Track filled in — no lyrics are loaded for this one, so the box is left as it was.'
      : words.synced
        ? 'Filled in, timings and all. Save as it is, or re-tap the lines that drift with Sync while playing.'
        : 'Filled in. These lines carry no timings yet — start the song and hit Sync while playing.';
    keepDraft();
  }

  /** Empty the page — and the draft behind it, which would otherwise refill it. */
  async function clearForm() {
    if (!fields.some((f) => f.value.trim())) return toast('Nothing to clear', '');
    // A hundred pasted lines are one misclick away from this button, and there
    // is no undo on the other side of it.
    if (!(await confirmBox('Clear the title, artist, album, duration and lyrics?'))) return;
    fields.forEach((f) => { f.value = ''; });
    status.textContent = '';
    keepDraft();
    toast('Cleared', 'ok');
  }

  // A handover from Now playing is an explicit "work on this one", so it wins
  // over whatever the draft was holding.
  if (prefill) {
    track.value = prefill.track || '';
    artist.value = prefill.artist || '';
    album.value = prefill.album || '';
    duration.value = prefill.duration || '';
    lrc.value = prefill.lrc || '';
    keepDraft();
  }

  const formCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { text: 'Import lyrics' }),
      el('div', { class: 'item-actions' }, [
        el('button', { class: 'btn btn-sm', text: 'Fill from current track', onclick: () => { void fillFromTrack(); } }),
        el('button', {
          class: 'btn btn-sm btn-danger', text: 'Clear all',
          title: 'Empty every field on this page',
          onclick: () => { void clearForm(); },
        }),
      ]),
    ]),

    prefill ? el('div', { class: 'notice' },
      prefill.lrc
        ? `Carried over from “${prefill.track}”. The words are here — hit Sync while playing and `
          + 're-tap the lines that drift, then save. Your copy wins over anything fetched online.'
        : `“${prefill.track}” had no synced lyrics to carry over. Paste or write them below, `
          + 'then time them with Sync while playing.') : null,

    picker,

    el('ol', { class: 'steps' }, [
      el('li', {}, ['Name the track. ', el('b', { text: 'Fill from current track' }), ' copies whatever is playing right now — its lyrics too, when the app has them.']),
      el('li', {}, ['Put the lyrics in the box below — paste them from anywhere, or type them yourself. One line per line.']),
      el('li', {}, [
        'If they already carry ', el('code', { text: '[mm:ss.xx]' }), ' timings, save straight away. If they do not, start the song and hit ',
        el('b', { text: 'Sync while playing' }), ' to stamp every line by ear.',
      ]),
    ]),

    field('Title', track), field('Artist', artist), field('Album', album), field('Duration', duration),
    field('Lyrics — timed or not', lrc),

    el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [
      el('button', {
        class: 'btn btn-primary', text: 'Save to library',
        onclick: save,
      }),
      el('button', {
        class: 'btn', text: 'Sync while playing',
        title: 'Play the song, then tap a key on each line to time it',
        onclick: openStudio,
      }),
      status,
    ]),
  ]);

  const studioHost = el('div');
  body.replaceChildren(formCard, studioHost);

  let studio = null;

  /**
   * Put the studio away.
   *
   * `keep` writes the timings stamped so far back into the box. Cancel does not
   * pass it — that is what Cancel means — but a tab switch is not a cancel, and
   * dropping a pass someone was halfway through is the very loss the draft
   * exists to prevent.
   */
  function closeStudio(keep = false) {
    if (!studio) return;
    if (keep) {
      lrc.value = studio.toLrc();
      status.textContent = 'Sync closed — the timings stamped so far are in the box.';
      keepDraft();
    }
    studio.dispose();
    studio = null;
    studioHost.replaceChildren();
    formCard.style.display = '';
  }

  function openStudio() {
    if (studio) return;
    studio = createSyncStudio({
      text: lrc.value,
      title: track.value.trim(),
      artist: artist.value.trim(),
      slot,
      onApply: (text) => {
        lrc.value = text;
        closeStudio();
        status.textContent = 'Timings applied — save to keep them.';
        keepDraft();
      },
      onCancel: () => closeStudio(),
    });
    if (!studio) return;                       // nothing to sync; the studio said so
    formCard.style.display = 'none';
    studioHost.replaceChildren(studio.node);
  }

  async function save() {
    if (!track.value.trim() || !artist.value.trim()) return toast('Title and artist are required', 'err');
    if (!lrc.value.trim()) return toast('Add the lyrics first', 'err');
    try {
      const existing = await api.checkExistingCustom(
        track.value.trim(), artist.value.trim(), album.value.trim(),
        duration.value ? Number(duration.value) : undefined,
      );
      if (existing && !(await confirmBox('Lyrics for this track already exist. Replace them?'))) return;

      await api.importCustom({
        track: track.value.trim(),
        artist: artist.value.trim(),
        album: album.value.trim(),
        duration: duration.value ? Number(duration.value) : undefined,
        lrc: lrc.value,
      });
      toast('Imported ✓', 'ok');
      lrc.value = '';
      status.textContent = '';
      keepDraft();
    } catch (e) {
      toast(`Import failed: ${e.message}`, 'err');
    }
  }

  const unsubs = [subscribe('slots', paintPicker), subscribe('status', paintPicker)];

  return () => {
    closeStudio(true);
    unsubs.forEach((fn) => fn());
  };
}

/**
 * The lyrics the app is holding for a presence, as text for the import box.
 *
 * The timed copy is asked of the backend rather than read off the state: the
 * state only holds what a lyric tick last pushed, and a track paused before its
 * first line has lyrics loaded but has pushed nothing yet. The plain fallback
 * has no such cache behind it, so that one does come from the state.
 */
async function loadedLyrics(slot) {
  const cached = await api.getLrc(slot).catch(() => null);
  if (cached && cached.trim()) return { text: cached.replace(/\r\n?/g, '\n').trimEnd(), synced: true };

  const l = slotOf(slot).lyrics;
  if (Array.isArray(l?.lyrics) && l.lyrics.length) {
    return {
      text: l.lyrics.map((x) => (Number.isFinite(x.time) ? `${lrcStamp(x.time)} ${x.text}` : x.text)).join('\n'),
      synced: true,
    };
  }
  if (Array.isArray(l?.lines) && l.lines.length) return { text: l.lines.join('\n'), synced: false };
  return null;
}

// ── Sync studio ───────────────────────────────────────────────────────────────

/** Leading `[mm:ss.xx]` (or several) on a lyric line. */
const TIME_PREFIX = /^\s*((?:\[\d+:\d+(?:\.\d+)?])+)\s*/;
const ONE_TIME = /\[(\d+):(\d+(?:\.\d+)?)]/;

/**
 * How much earlier than the tap the line is written down.
 *
 * A line is stamped when the user hears it, which is already after it started —
 * reaction time, plus whatever the player is buffering. Left at zero every line
 * lands late. It is adjustable and applies to every tap at once, so noticing
 * halfway through does not mean starting over.
 */
const DEFAULT_TAP_OFFSET_MS = -250;

/** ms → `[mm:ss.xx]`, via centiseconds so 59.999s cannot round to `:60.00`. */
function lrcStamp(ms) {
  const cs = Math.max(0, Math.round(ms / 10));
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}]`;
}

/** ms → `m:ss.xx` for the live readout. */
function fmtPos(ms) {
  const cs = Math.max(0, Math.round(ms / 10));
  return `${Math.floor(cs / 6000)}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/**
 * Split the textarea into lines, keeping any timings already on them.
 *
 * Existing stamps are preserved rather than stripped, so a half-finished pass
 * can be picked up where it stopped and a downloaded .lrc can have three bad
 * lines re-tapped without redoing the other ninety.
 */
function readLines(text) {
  const lines = text.split('\n').map((raw) => {
    const prefix = TIME_PREFIX.exec(raw);
    let preset = null;
    if (prefix) {
      const t = ONE_TIME.exec(prefix[1]);
      if (t) preset = Math.round((parseInt(t[1], 10) * 60 + parseFloat(t[2])) * 1000);
    }
    return { text: (prefix ? raw.slice(prefix[0].length) : raw).trim(), preset };
  });
  while (lines.length && !lines[lines.length - 1].text) lines.pop();
  return lines;
}

/**
 * The tap-to-time panel.
 *
 * Returns `{ node, dispose }`, or null when there is nothing to time. The
 * disposer is not optional: this holds a document-level key handler and an
 * interval, both of which outlive the DOM it is attached to.
 *
 * `slot` is the presence being timed, and it does not change for the life of the
 * panel. Everything here reads that slot rather than the window's focused
 * mirrors, which is the point: the focus follows whatever is playing, so a
 * second player starting — or this one going quiet for a poll — used to swap the
 * clock under a half-finished pass and time every line after it against another
 * song.
 */
function createSyncStudio({ text, title, artist, slot = 0, onApply, onCancel }) {
  const lines = readLines(text);
  const firstStampable = lines.findIndex((l) => l.text);
  if (firstStampable < 0) {
    toast('Put the lyrics in the box first', 'err');
    return null;
  }

  const taps = lines.map(() => null);          // raw tap position, before the offset
  let offset = DEFAULT_TAP_OFFSET_MS;
  let cursor = firstStampable;

  /** The timing a line ends up with: a tap plus the offset, or what it came in with. */
  const timeOf = (i) => (taps[i] != null ? Math.max(0, taps[i] + offset) : lines[i].preset);

  // ── live position ──
  const trackNow = () => slotOf(slot).track;
  const progressNow = () => slotOf(slot).progress || EMPTY_SLOT.progress;

  // Same trick as Now playing: the backend reports a position once per poll, so
  // read the gap off a timestamp rather than trusting the tick to be on time.
  let posRef = progressNow();
  let base = posRef.progress_ms || 0;
  let baseAt = performance.now();
  /*
   * One subscription for the lot.
   *
   * Every track and progress event reaches the state through the slot array, so
   * watching it covers both — and unlike the 'track' and 'progress' keys, it is
   * not a mirror of the focused presence. A slot's progress object is replaced
   * wholesale on each report and left alone by every other patch, so its
   * identity is what says a fresh position has landed.
   */
  const onSlots = () => {
    const p = progressNow();
    if (p !== posRef) {
      posRef = p;
      base = p.progress_ms || 0;
      baseAt = performance.now();
    }
    paintTransport();
  };
  function livePosition() {
    if (!trackNow()?.is_playing) return base;
    const total = progressNow().duration_ms;
    const elapsed = base + (performance.now() - baseAt);
    return total > 0 ? Math.min(elapsed, total) : elapsed;
  }

  // ── chrome ──
  const posEl = el('div', { class: 'sync-pos', text: '0:00.00' });
  const totalEl = el('div', { class: 'sync-total', text: '' });
  const fill = el('div', { class: 'np-fill' });
  const nowPlaying = el('div', { class: 'sync-playing' });
  const counter = el('div', { class: 'muted' });

  const stampBtn = el('button', {
    class: 'btn btn-primary sync-stamp', text: 'Stamp this line',
    onclick: () => stamp(),
  });
  const undoBtn = el('button', { class: 'btn', text: 'Undo', onclick: () => undo() });
  const skipBtn = el('button', { class: 'btn', text: 'Skip', onclick: () => skip() });

  const offsetEl = el('span', { class: 'sync-offset-val', text: `${offset} ms` });
  const lineList = el('div', { class: 'sync-lines' });

  // One node per line, kept and mutated: a stamp must not rebuild a 100-line
  // list, and rebuilding would lose the scroll position on every tap.
  const rows = lines.map((line, i) => {
    const time = el('span', { class: 'sync-line-time' });
    const row = el('div', {
      class: `sync-line${line.text ? '' : ' is-blank'}`,
      title: line.text ? 'Click to stamp from here' : '',
      onclick: () => { if (line.text) { cursor = i; paintLines(); } },
    }, [
      el('span', { class: 'sync-line-n', text: line.text ? String(i + 1) : '' }),
      time,
      el('span', { class: 'sync-line-text', text: line.text || '·' }),
    ]);
    return { row, time };
  });
  lineList.replaceChildren(...rows.map((r) => r.row));

  const node = el('div', { class: 'card sync' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { text: 'Sync while playing' }),
      counter,
    ]),

    el('div', { class: 'row-desc', style: 'margin-bottom:14px;max-width:none' },
      'Start the song in your player, then stamp each line the moment you hear it. '
      + 'Space or Enter stamps and moves on, Backspace takes the last one back. '
      + 'Click any line to jump there.'),

    nowPlaying,

    el('div', { class: 'sync-transport' }, [
      posEl,
      el('div', { class: 'np-bar', style: 'flex:1' }, [fill]),
      totalEl,
    ]),

    el('div', { class: 'sync-controls' }, [
      stampBtn,
      undoBtn,
      skipBtn,
      el('button', { class: 'btn', text: 'Clear all', onclick: () => resetAll() }),
    ]),

    el('div', { class: 'row' }, [
      el('div', {}, [
        el('div', { class: 'row-label', text: 'Tap compensation' }),
        el('div', { class: 'row-desc', text: 'You always tap a moment after the line starts. This shifts every stamp back by that much — change it any time, it re-applies to all of them.' }),
      ]),
      el('div', { class: 'row-control', style: 'display:flex;gap:6px;align-items:center' }, [
        el('button', { class: 'btn btn-sm', text: '−50', onclick: () => nudge(-50) }),
        offsetEl,
        el('button', { class: 'btn btn-sm', text: '+50', onclick: () => nudge(50) }),
        el('button', { class: 'btn btn-sm', text: 'Reset', onclick: () => nudge(DEFAULT_TAP_OFFSET_MS - offset) }),
      ]),
    ]),

    lineList,

    el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px' }, [
      el('button', { class: 'btn', text: 'Cancel', onclick: () => onCancel() }),
      el('button', {
        class: 'btn btn-primary', text: 'Apply timings',
        onclick: () => onApply(toLrc()),
      }),
    ]),
  ]);

  // ── actions ──

  function nextStampable(from) {
    for (let i = from; i < lines.length; i++) if (lines[i].text) return i;
    return lines.length;
  }
  function prevStampable(from) {
    for (let i = from; i >= 0; i--) if (lines[i].text) return i;
    return -1;
  }

  function stamp() {
    if (cursor >= lines.length) return;
    taps[cursor] = livePosition();
    cursor = nextStampable(cursor + 1);
    paintLines(true);
  }

  function undo() {
    const target = prevStampable(Math.min(cursor, lines.length) - 1);
    if (target < 0) return;
    taps[target] = null;
    cursor = target;
    paintLines(true);
  }

  function skip() {
    if (cursor >= lines.length) return;
    cursor = nextStampable(cursor + 1);
    paintLines(true);
  }

  function resetAll() {
    taps.fill(null);
    cursor = firstStampable;
    paintLines(true);
  }

  function nudge(by) {
    offset = Math.max(-3000, Math.min(3000, offset + by));
    offsetEl.textContent = `${offset} ms`;
    paintLines();
  }

  function toLrc() {
    return lines.map((line, i) => {
      if (!line.text) return '';
      const t = timeOf(i);
      return t == null ? line.text : `${lrcStamp(t)} ${line.text}`;
    }).join('\n');
  }

  // ── painting ──

  function paintLines(scroll = false) {
    let done = 0;
    let total = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].text) continue;
      total++;
      const t = timeOf(i);
      if (t != null) done++;
      rows[i].time.textContent = t == null ? '--:--.--' : lrcStamp(t).slice(1, -1);
      rows[i].row.classList.toggle('is-timed', t != null);
      rows[i].row.classList.toggle('is-current', i === cursor);
    }
    counter.textContent = `${done} of ${total} lines timed`;
    stampBtn.disabled = cursor >= lines.length;
    stampBtn.textContent = cursor >= lines.length ? 'All lines timed' : 'Stamp this line';
    skipBtn.disabled = cursor >= lines.length;
    undoBtn.disabled = prevStampable(Math.min(cursor, lines.length) - 1) < 0;
    if (scroll && cursor < lines.length) centerLine(rows[cursor].row);
  }

  /**
   * Bring a line to the middle of the list — and of nothing else.
   *
   * scrollIntoView scrolls every scrollable ancestor it can find, the page among
   * them. In a window too short to hold the whole studio that meant each stamp
   * scrolled the page as well as the list, sliding the Stamp button out from
   * under the cursor so the next click landed on empty space.
   */
  function centerLine(row) {
    const r = row.getBoundingClientRect();
    const box = lineList.getBoundingClientRect();
    const target = lineList.scrollTop + (r.top - box.top - lineList.clientTop)
      - (lineList.clientHeight - r.height) / 2;
    lineList.scrollTo({
      top: Math.max(0, Math.min(target, lineList.scrollHeight - lineList.clientHeight)),
      behavior: 'smooth',
    });
  }

  function paintTransport() {
    const pos = livePosition();
    const total = progressNow().duration_ms || 0;
    posEl.textContent = fmtPos(pos);
    totalEl.textContent = total > 0 ? fmtTime(total) : '--:--';
    fill.style.width = total > 0 ? `${Math.min(100, (pos / total) * 100)}%` : '0%';

    // Named while several are on air, so it is plain which clock this is and
    // that the panel has not wandered off to the other one.
    const where = presenceCount() > 1 ? `presence ${slot + 1}` : 'your player';
    const t = trackNow();
    if (!t) {
      nowPlaying.className = 'sync-playing is-warn';
      nowPlaying.textContent = `Nothing is playing on ${where} — start the song there, the clock follows it.`;
      return;
    }
    const same = !title || norm(t.track_name) === norm(title);
    nowPlaying.className = `sync-playing${same ? '' : ' is-warn'}`;
    nowPlaying.textContent = same
      ? `Following ${where}: ${t.track_name} — ${t.artist_name}`
      : `Careful — ${where} is on “${t.track_name}”, but you are timing “${title}”.`;
  }

  const unsubs = [subscribe('slots', onSlots)];
  // 80ms keeps the centiseconds readable without being a spin loop; it only
  // rewrites two text nodes and one width.
  const ticker = setInterval(paintTransport, 80);

  const onKey = (e) => {
    // The offset box and anything else focusable must keep their own keys.
    if (document.activeElement?.matches('input, textarea, select')) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      stamp();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      undo();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };
  document.addEventListener('keydown', onKey);

  paintLines();
  paintTransport();

  return {
    node,
    toLrc,
    dispose() {
      clearInterval(ticker);
      unsubs.forEach((fn) => fn());
      document.removeEventListener('keydown', onKey);
    },
  };
}

const norm = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// ── LRCLIB dump ───────────────────────────────────────────────────────────────

/** lrclib.net publishes the dumps; the page lists them newest first. */
const LRCLIB_DUMPS_URL = 'https://lrclib.net/db-dumps';

/**
 * Shortest query the dump is searched for.
 *
 * The last word typed is prefix-matched, so one or two letters means "every
 * track whose title starts with these" — millions of rows out of a 30M-track
 * dump, for a result nobody could use. Three is where the answer starts being
 * worth the disk it costs.
 */
const MIN_DUMP_QUERY = 3;

function renderDump(body) {
  const results = el('div', { class: 'list' });
  const status = el('div', { class: 'notice', text: 'Checking for a dump…' });
  // The dump has its own worker thread, which takes one message at a time, so
  // two searches cannot run at once — they queue. (This comment used to say
  // "the backend's main thread", from before the dump moved off it; the
  // conclusion held, the reason did not.) The counter only guards against an
  // earlier answer landing after a later one and painting stale results over
  // fresh ones.
  let searchSeq = 0;
  const input = el('input', {
    type: 'search', placeholder: 'Search the local LRCLIB dump…',
    oninput: debounce(async (e) => {
      const q = e.target.value.trim();
      const seq = ++searchSeq;
      if (q.length < MIN_DUMP_QUERY) {
        return results.replaceChildren(...(q.length
          ? [el('div', { class: 'empty', text: `Keep typing — ${MIN_DUMP_QUERY} characters minimum.` })]
          : []));
      }
      results.replaceChildren(el('div', { class: 'empty', text: 'Searching…' }));
      try {
        const rows = (await api.searchLrclib(q, 30)) || [];
        if (seq !== searchSeq) return;
        results.replaceChildren(...(rows.length
          ? rows.map(dumpRow)
          : [el('div', { class: 'empty', text: 'No match in the dump.' })]));
      } catch (err) {
        if (seq !== searchSeq) return;
        results.replaceChildren(el('div', { class: 'empty', text: `Search failed: ${err.message}` }));
      }
    }, 280),
  });

  body.replaceChildren(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h2', { text: 'LRCLIB dump' })]),
    el('div', { class: 'row-desc', style: 'margin-bottom:12px;max-width:none' },
      'A full offline copy of the LRCLIB lyrics database. Optional — the app works without it, '
      + 'but with it, lyrics are found instantly and with no network. Copy a result into your library to keep it.'),

    status,

    el('div', { class: 'card-head', style: 'margin:18px 0 6px' }, [el('h2', { text: 'Getting a dump' })]),
    el('ol', { class: 'steps' }, [
      el('li', {}, [
        'Download the newest dump from ',
        el('a', {
          href: '#', text: 'lrclib.net/db-dumps',
          onclick: (e) => { e.preventDefault(); api.openExternal(LRCLIB_DUMPS_URL); },
        }),
        '. It is one ', el('code', { text: '.sqlite3.gz' }), ' file, around 40 GB — and several times '
        + 'that once unpacked, so check you have the room first.',
      ]),
      el('li', {}, [
        'Unpack it with 7-Zip or any gzip tool. You end up with a single ',
        el('code', { text: '.sqlite3' }), ' file — that file is the database, nothing else is needed.',
      ]),
      el('li', {}, [
        'Point the app at it, either way round: put it in the folder below and rename it ',
        el('code', { text: 'lrclib-dump.sqlite3' }), ', or leave it wherever it is and paste its full path into ',
        el('b', { text: 'Settings → LRCLIB dump path' }), ' (handy if it lives on another drive).',
      ]),
      el('li', {}, ['Restart Vybecord. The database is opened once at startup, so it is not picked up before that.']),
    ]),

    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px' }, [
      el('button', {
        class: 'btn', text: 'Open the dump folder',
        onclick: async () => {
          try {
            const res = await api.revealLrclibFolder();
            toast(`Opened ${res.folder}`, 'ok');
          } catch (e) {
            toast(`Could not open the folder: ${e.message}`, 'err');
          }
        },
      }),
      el('button', {
        class: 'btn', text: 'Open lrclib.net/db-dumps',
        onclick: () => api.openExternal(LRCLIB_DUMPS_URL),
      }),
    ]),

    el('div', { class: 'card-head', style: 'margin:18px 0 6px' }, [el('h2', { text: 'Search the dump' })]),
    el('div', { style: 'margin-bottom:12px' }, [input]),
    results,
  ]));

  paintStatus();

  async function paintStatus() {
    let s;
    try {
      s = await api.lrclibStatus();
    } catch (e) {
      status.className = 'notice is-warn';
      status.textContent = `Could not check the dump: ${e.message}`;
      return;
    }
    if (s?.loaded) {
      // A dump is open, but not the one Settings asks for. Saying so here is the
      // only chance the user gets: everything downstream just works, quietly, on
      // the wrong file.
      if (s.ignoredConfigured) {
        status.className = 'notice is-warn';
        status.replaceChildren(
          el('b', { text: 'A dump is loaded — but not the one you configured. ' }),
          el('span', {
            text: `At startup “${s.ignoredConfigured}” could not be opened, so Vybecord fell back to ${s.path}. `
              + (s.configured && s.configured !== s.ignoredConfigured
                ? `Settings now points at “${s.configured}” — restart Vybecord to use it.`
                : 'Check the path in Settings → LRCLIB dump path, then restart Vybecord.'),
          }),
        );
        return;
      }
      status.className = 'notice';
      status.replaceChildren(
        el('b', { text: 'Dump loaded. ' }),
        el('span', { text: `Searching ${s.path}` }),
      );
      return;
    }
    status.className = 'notice is-warn';
    status.replaceChildren(
      el('b', { text: 'No dump loaded — searches below will find nothing. ' }),
      el('span', {
        text: s?.configured
          ? `Settings points at “${s.configured}”, and there is no file there. Fix the path, or drop a dump in ${s.folder}.`
          : `Follow the steps below; the folder the app looks in is ${s.folder}.`,
      }),
    );
  }
}

function dumpRow(r) {
  return el('div', { class: 'item' }, [
    el('div', { class: 'item-body' }, [
      el('div', { class: 'item-title', text: r.track }),
      el('div', { class: 'item-sub', text: `${r.artist}${r.album ? ` · ${r.album}` : ''}${r.duration ? ` · ${fmtTime(r.duration * 1000)}` : ''}` }),
    ]),
    el('span', { class: `badge ${r.hasSynced ? 'accent' : ''}`.trim(), text: r.hasSynced ? 'Synced' : 'Plain' }),
    el('div', { class: 'item-actions' }, [
      el('button', {
        class: 'btn btn-sm', text: 'Copy to library',
        onclick: async () => {
          try {
            const full = await api.getLrclibTrack(r.id);
            const lrc = full?.syncedLyrics || full?.synced_lyrics || full?.plainLyrics || full?.plain_lyrics;
            if (!lrc) return toast('That entry has no usable lyrics', 'err');
            await api.importCustom({
              track: r.track, artist: r.artist, album: r.album || '',
              duration: r.duration || undefined, lrc,
            });
            toast('Copied to your library ✓', 'ok');
          } catch (e) {
            toast(`Copy failed: ${e.message}`, 'err');
          }
        },
      }),
    ]),
  ]);
}

// ── Flagged ───────────────────────────────────────────────────────────────────

async function renderFlagged(body, refresh) {
  const list = el('div', { class: 'list' });
  body.replaceChildren(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h2', { text: 'Flagged tracks' })]),
    el('div', { class: 'row-desc', style: 'margin-bottom:12px;max-width:none' },
      'Lyrics you marked as wrong. The app will not reuse those results for these tracks — clear a flag to let it try again.'),
    list,
  ]));

  try {
    const rows = (await api.listFlagged()) || [];
    list.replaceChildren(...(rows.length
      ? rows.map((f) => el('div', { class: 'item' }, [
          el('div', { class: 'item-body' }, [
            el('div', { class: 'item-title', text: f.track || '(unknown)' }),
            el('div', { class: 'item-sub', text: f.artist || '' }),
          ]),
          el('div', { class: 'item-meta', text: `${f.count} flagged` }),
          el('div', { class: 'item-actions' }, [
            el('button', {
              class: 'btn btn-sm', text: 'Clear',
              onclick: async () => { await api.unflag(f.key); toast('Cleared', 'ok'); refresh(); },
            }),
          ]),
        ]))
      : [el('div', { class: 'empty', text: 'Nothing flagged.' })]));
  } catch (e) {
    list.replaceChildren(el('div', { class: 'empty', text: `Could not load: ${e.message}` }));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function field(label, input) {
  return el('label', { class: 'field' }, [el('span', { text: label }), input]);
}

function confirmBox(message) {
  return modal((close) => el('div', {}, [
    el('h2', { text: 'Are you sure?' }),
    el('div', { class: 'muted', style: 'margin:12px 0 20px', text: message }),
    el('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, [
      el('button', { class: 'btn', text: 'Cancel', onclick: () => close(false) }),
      el('button', { class: 'btn btn-danger', text: 'Confirm', onclick: () => close(true) }),
    ]),
  ])).then((v) => v === true);
}

function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
