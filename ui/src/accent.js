/**
 * The window's accent colour: the green of the active page, the filled
 * buttons, the links and the switches, now the user's choice.
 *
 * Every accent use in styles.css already goes through a handful of tokens
 * (--accent, --accent-hex, --accent-hover, --on-accent, and --accent-text,
 * which each theme sets from --accent-text-d / --accent-text-l), so a colour
 * is applied by setting those on <html>, and nothing else in the stylesheet
 * has to know. --accent-text itself is never set inline: an inline value
 * would beat html[data-theme='light'] and leave the dark theme's lighter step
 * on the light theme's pale cards.
 *
 * Any colour can be picked, so the steps around it are worked out rather than
 * listed: the text step is the colour moved toward white (dark theme) or black
 * (light theme) until it reads at 4.5:1 on the card surface, the token
 * comments in styles.css ask for that much, and the text on a filled button is
 * near-black or white, whichever reads better on that colour.
 */

export const DEFAULT_ACCENT = '#10b981';

/** Offered as swatches; the colour input beside them takes anything else. */
export const ACCENT_PRESETS = [
  ['#10b981', 'Emerald'],
  ['#8b5cf6', 'Violet'],
  ['#3b82f6', 'Blue'],
  ['#0ea5e9', 'Sky'],
  ['#5865f2', 'Blurple'],
  ['#ec4899', 'Pink'],
  ['#f43f5e', 'Rose'],
  ['#f97316', 'Orange'],
];

/** The card surfaces the text step must read on, per theme (--bg-surface, --bg-elevated). */
const DARK_SURFACE = [28, 28, 38];
const LIGHT_SURFACES = [[241, 241, 245], [255, 255, 255]];
const ON_DARK = '#04140d';

/** `#rrggbb` (or `#rgb`) → [r, g, b], or null for anything else. */
export function parseHex(value) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

const toHex = (rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);

function luminance([r, g, b]) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Move `rgb` toward `target` in small steps until it reads at 4.5:1 on every
 * surface. `from` starts it a step along already: the default's text on dark
 * cards (#34d399) sits a fifth of the way from its fill (#10b981) to white,
 * and a picked colour should look as related to its own text.
 */
function readableOn(rgb, target, surfaces, from = 0) {
  for (let t = from; t <= 1; t += 0.04) {
    const c = mix(rgb, target, t);
    if (surfaces.every((s) => contrast(c, s) >= 4.5)) return c;
  }
  return target;
}

/** The token values for one accent colour. */
export function accentTokens(value) {
  const rgb = parseHex(value) || parseHex(DEFAULT_ACCENT);
  const onDark = parseHex(ON_DARK);
  const white = [255, 255, 255];
  return {
    '--accent': rgb.join(', '),
    '--accent-hex': toHex(rgb),
    '--accent-hover': toHex(mix(rgb, white, 0.25)),
    '--accent-text-d': toHex(readableOn(rgb, white, [DARK_SURFACE], 0.2)),
    '--accent-text-l': toHex(readableOn(rgb, [0, 0, 0], LIGHT_SURFACES)),
    '--on-accent': contrast(rgb, onDark) >= contrast(rgb, white) ? ON_DARK : '#ffffff',
  };
}

/** The colour a config value stands for, as `#rrggbb`; anything unreadable is the default. */
export function normalizeAccent(value) {
  const rgb = parseHex(value);
  return rgb ? toHex(rgb) : DEFAULT_ACCENT;
}

/**
 * Paint the window in this accent. The default clears the inline tokens
 * instead of setting worked-out ones, so it stays exactly the hand-picked
 * steps in styles.css.
 */
export function applyAccent(value) {
  const root = document.documentElement;
  const tokens = accentTokens(value);
  const isDefault = normalizeAccent(value) === DEFAULT_ACCENT;
  for (const [name, v] of Object.entries(tokens)) {
    if (isDefault) root.style.removeProperty(name);
    else root.style.setProperty(name, v);
  }
  // The pencil on an editable card part is a picture, not text: it follows
  // the button text through this flag (see styles.css).
  if (!isDefault && tokens['--on-accent'] === '#ffffff') root.dataset.onAccent = 'light';
  else delete root.dataset.onAccent;
}
