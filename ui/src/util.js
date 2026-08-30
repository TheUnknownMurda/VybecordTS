/** Small DOM / formatting helpers shared by every page. */

/**
 * Build an element.
 *
 * `html` is deliberately the only way to inject markup, and pages only ever
 * pass literals to it. Anything coming from a track title, a lyric line or the
 * lyrics DB goes through `text` or `esc()` — those strings are attacker-adjacent
 * (a track title is whatever a filename or a web page says it is).
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * 1x1 transparent GIF, used wherever a cover is missing.
 *
 * A sized <img> with no src attribute is not blank in Chromium — it draws the
 * broken-image glyph. Pointing it at a transparent pixel leaves the styled empty
 * box the layout expects.
 */
export const BLANK_ART = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape text for the rare places that must build an HTML string. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** ms → m:ss (or h:mm:ss past an hour). */
export function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** ms → "3h 24m" for totals, where seconds are noise. */
export function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

export function fmtDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Turn a backend art URL into something an <img> can use directly.
 *
 * '/api/thumbnail' is the sentinel the backend still uses for art the OS handed
 * us; it used to be a route on the local HTTP server and has no URL now. Those
 * bytes come over IPC instead — see setArt(), which is the only caller that can
 * resolve them. Everywhere else the sentinel means "no usable URL".
 */
export function artUrl(url) {
  if (!url || url === '/api/thumbnail') return '';
  return /^https?:\/\//.test(url) ? url : '';
}

/**
 * Point an <img> at a track's cover, resolving local art over IPC.
 *
 * The blob URL is cached per track and the previous one revoked, so a long
 * session does not leak one object URL per track played.
 *
 * Concurrent calls for the same track share one fetch. Without that, two
 * overlapping repaints — which happen routinely, since cover art can arrive
 * after the track does — would each mint a blob URL and each revoke the other's,
 * leaving the <img> pointed at a URL that had just been invalidated.
 */
let thumbCache = { key: '', url: '' };
let thumbPending = { key: '', promise: null };

export async function setArt(img, url, key) {
  if (!url) {
    img.src = BLANK_ART;
    return '';
  }
  const direct = artUrl(url);
  if (direct) {
    img.src = direct;
    return direct;
  }
  if (url !== '/api/thumbnail') {
    img.src = BLANK_ART;
    return '';
  }

  if (thumbCache.key === key && thumbCache.url) {
    img.src = thumbCache.url;
    return thumbCache.url;
  }

  if (thumbPending.key !== key || !thumbPending.promise) {
    thumbPending = { key, promise: resolveThumb(key) };
  }
  const resolved = await thumbPending.promise;

  // The track may have moved on while this was in flight; a stale answer must
  // not paint over the cover that belongs to whatever is playing now.
  if (thumbCache.key !== key || !resolved) {
    img.src = BLANK_ART;
    return '';
  }
  img.src = resolved;
  return resolved;
}

/** Fetch the local cover bytes and publish them as a blob URL. */
async function resolveThumb(key) {
  let res = null;
  try {
    res = await window.vybecord.getThumbnail();
  } catch {
    return '';
  }
  if (!res?.bytes?.length) return '';
  if (thumbCache.url) URL.revokeObjectURL(thumbCache.url);
  thumbCache = { key, url: URL.createObjectURL(new Blob([res.bytes], { type: res.mime })) };
  return thumbCache.url;
}

/** Platform label + glyph for a media_source string. */
export function platformInfo(source) {
  const map = {
    spotify: ['Spotify', '🟢'],
    apple_music: ['Apple Music', '🍎'],
    youtube: ['YouTube', '▶️'],
    youtube_music: ['YouTube Music', '▶️'],
    soundcloud: ['SoundCloud', '🟠'],
    bandcamp: ['Bandcamp', '🔵'],
    deezer: ['Deezer', '🎵'],
    tidal: ['Tidal', '🌊'],
    amazon_music: ['Amazon Music', '📦'],
    // Live streams. The history logs them and a pin can name them, so they
    // need entries here as much as the music services do -- without one, a
    // Twitch stream showed as a lowercase "twitch" under a generic note.
    twitch: ['Twitch', '🟣'],
    kick: ['Kick', '🥊'],
    vlc: ['VLC', '🔶'],
    foobar2000: ['foobar2000', '🎛️'],
    musicbee: ['MusicBee', '🐝'],
    aimp: ['AIMP', '🎧'],
    winamp: ['Winamp', '🦙'],
    mediamonkey: ['MediaMonkey', '🐵'],
    browser_chrome: ['Chrome', '🌐'],
    browser_firefox: ['Firefox', '🦊'],
    browser_edge: ['Edge', '🌐'],
    browser_brave: ['Brave', '🦁'],
    browser_opera: ['Opera', '🔴'],
    browser_vivaldi: ['Vivaldi', '🌐'],
    browser_zen: ['Zen', '🌐'],
  };
  return map[source] || [source || 'Unknown', '🎵'];
}

/**
 * Transient message in the corner. `kind` is 'ok' | 'err' | ''.
 *
 * Every toast owns its own removal timer, so several can stack and each leaves
 * when its time is up. There used to be a module-level `toastTimer` cleared on
 * each call, but the new timer was never assigned to it — so the clear was
 * always a no-op against 0. Wiring it up would have been the wrong repair: it
 * would cancel the *previous* toast's removal and pin that one on screen
 * forever. The behaviour the dead line never had is not the behaviour wanted.
 */
export function toast(message, kind = '') {
  const host = $('#toasts');
  if (!host) return;
  const node = el('div', { class: `toast ${kind}`.trim(), text: message });
  host.append(node);
  setTimeout(() => node.remove(), kind === 'err' ? 6000 : 3200);
}

/** Show a modal; resolves when it closes. `render(close)` builds the body. */
export function modal(render) {
  return new Promise((resolve) => {
    const close = (value) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(undefined); };

    const box = el('div', { class: 'modal' });
    const backdrop = el('div', {
      class: 'modal-backdrop',
      onclick: (e) => { if (e.target === backdrop) close(undefined); },
    }, [box]);

    box.append(render(close));
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
    box.querySelector('input, textarea, button')?.focus();
  });
}

/** A labelled on/off switch row. */
export function toggleRow(label, desc, checked, onChange) {
  const input = el('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) });
  return el('div', { class: 'row' }, [
    el('div', {}, [
      el('div', { class: 'row-label', text: label }),
      desc ? el('div', { class: 'row-desc', text: desc }) : null,
    ]),
    el('label', { class: 'switch' }, [input, el('span', { class: 'track' }), el('span', { class: 'thumb' })]),
  ]);
}

/** A labelled <select> row. `options` is [[value, label], …]. */
export function selectRow(label, desc, value, options, onChange) {
  const select = el('select', { onchange: (e) => onChange(e.target.value) });
  for (const [val, text] of options) {
    select.append(el('option', { value: val, selected: String(val) === String(value), text }));
  }
  return el('div', { class: 'row' }, [
    el('div', {}, [
      el('div', { class: 'row-label', text: label }),
      desc ? el('div', { class: 'row-desc', text: desc }) : null,
    ]),
    el('div', { class: 'row-control' }, [select]),
  ]);
}

/** A labelled text/number input row. */
export function inputRow(label, desc, value, onChange, opts = {}) {
  const input = el('input', {
    type: opts.type || 'text',
    value: value ?? '',
    placeholder: opts.placeholder || '',
    min: opts.min,
    max: opts.max,
    onchange: (e) => onChange(opts.type === 'number' ? Number(e.target.value) : e.target.value),
  });
  return el('div', { class: 'row' }, [
    el('div', {}, [
      el('div', { class: 'row-label', text: label }),
      desc ? el('div', { class: 'row-desc', text: desc }) : null,
    ]),
    el('div', { class: 'row-control' }, [input]),
  ]);
}
