/**
 * The window's accent colour: the green of the active page, the filled
 * buttons, the links and the switches, now the user's choice, and with it the
 * tint of the background.
 *
 * Every accent use in styles.css already goes through a handful of tokens
 * (--accent, --accent-hex, --accent-hover, --on-accent, --accent-text and the
 * six --bg-* surfaces), so a colour is applied by setting those on <html>,
 * and nothing else in the stylesheet has to know. The ones that differ per
 * theme (--accent-text, --bg-*) are never set inline: an inline value would
 * beat html[data-theme='light'] and leave the dark theme's values on the
 * light theme. Each theme reads them from a -d or -l twin instead, and those
 * twins are what is set here.
 *
 * Any colour can be picked, so the values around it are worked out rather
 * than listed:
 * - the text step is the colour moved toward white (dark theme) or black
 *   (light theme) until it reads at 4.5:1 on the card surface, as the token
 *   comments in styles.css ask;
 * - the text on a filled button is near-black or white, whichever reads
 *   better on that colour;
 * - each background surface takes the colour's hue at the surface's own
 *   brightness, so text keeps its contrast. A plain mix toward the colour did
 *   not: 6 % of a bright red or yellow lifted the dark cards enough to put the
 *   faintest grey text under 3.8:1. Where even the hue alone would cost
 *   contrast (pale light-theme cards toward a colour too dark to match their
 *   brightness), the tint backs off until the faintest text reads as well as
 *   on the neutral surface.
 *
 * The default, emerald, is the original look: neutral background, hand-picked
 * steps from styles.css. Only another colour tints the background.
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

/** The neutral surfaces of each theme, as in styles.css, and how far each takes the colour's hue. */
const SURFACES = {
  d: {
    'bg-base': ['#0b0b10', 0.45], 'bg-side': ['#0f0f15', 0.45], 'bg-elevated': ['#14141c', 0.45],
    'bg-surface': ['#1c1c26', 0.45], 'bg-hover': ['#23232e', 0.45], 'bg-sunken': ['#101017', 0.45],
  },
  l: {
    'bg-base': ['#f4f4f7', 0.12], 'bg-side': ['#ececf1', 0.14], 'bg-elevated': ['#ffffff', 0.05],
    'bg-surface': ['#f1f1f5', 0.12], 'bg-hover': ['#e7e7ee', 0.14], 'bg-sunken': ['#f7f7fa', 0.08],
  },
};
/** The faintest text of each theme (--text-faint): what a tinted surface must still carry. */
const FAINT = { d: '#8a8a96', l: '#6b6b76' };
const ON_DARK = '#04140d';
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

/** `#rrggbb` (or `#rgb`) → [r, g, b], or null for anything else. */
export function parseHex(value) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

const toHex = (rgb) => `#${rgb.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);
const toLinear = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const linLuminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const luminance = (rgb) => linLuminance(rgb.map(toLinear));

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

/**
 * `surface` taking `accent`'s hue by `t`, at the surface's own brightness:
 * the accent is scaled in linear light to the surface's luminance and mixed
 * there, so the mix keeps it. Backs off while the faintest text would read
 * worse than it does on the neutral surface (only when scaling had to clip).
 */
function tintSurface(surface, accent, t, faint) {
  const s = surface.map(toLinear);
  const a = accent.map(toLinear);
  const k = linLuminance(s) / Math.max(linLuminance(a), 1e-6);
  const hue = a.map((c) => Math.min(1, c * k));
  const floor = Math.min(4.5, contrast(faint, surface));
  for (let step = t; step > 0.001; step -= 0.02) {
    const out = s.map((c, i) => fromLinear(c + (hue[i] - c) * step));
    if (contrast(faint, out) >= floor) return out;
  }
  return surface;
}

/** The token values for one accent colour, by CSS custom property name. */
export function accentTokens(value) {
  const rgb = parseHex(value) || parseHex(DEFAULT_ACCENT);
  const onDark = parseHex(ON_DARK);
  const tokens = {
    '--accent': rgb.join(', '),
    '--accent-hex': toHex(rgb),
    '--accent-hover': toHex(mix(rgb, WHITE, 0.25)),
    '--on-accent': contrast(rgb, onDark) >= contrast(rgb, WHITE) ? ON_DARK : '#ffffff',
  };
  const tinted = { d: {}, l: {} };
  for (const theme of ['d', 'l']) {
    const faint = parseHex(FAINT[theme]);
    for (const [name, [neutral, t]] of Object.entries(SURFACES[theme])) {
      tinted[theme][name] = tintSurface(parseHex(neutral), rgb, t, faint);
      tokens[`--${name}-${theme}`] = toHex(tinted[theme][name]);
    }
  }
  // The text step reads on the cards it sits on: the tinted ones.
  tokens['--accent-text-d'] = toHex(readableOn(rgb, WHITE, [tinted.d['bg-surface']], 0.2));
  tokens['--accent-text-l'] = toHex(readableOn(rgb, BLACK, [tinted.l['bg-surface'], tinted.l['bg-elevated']]));
  return tokens;
}

/** The colour a config value stands for, as `#rrggbb`; anything unreadable is the default. */
export function normalizeAccent(value) {
  const rgb = parseHex(value);
  return rgb ? toHex(rgb) : DEFAULT_ACCENT;
}

/**
 * Paint the window in this accent. The default clears the inline tokens
 * instead of setting worked-out ones, so it stays exactly the hand-picked
 * values in styles.css.
 */
export function applyAccent(value) {
  const root = document.documentElement;
  const tokens = accentTokens(value);
  const isDefault = normalizeAccent(value) === DEFAULT_ACCENT;
  for (const [name, v] of Object.entries(tokens)) {
    if (isDefault) root.style.removeProperty(name);
    else root.style.setProperty(name, v);
  }
  // A picked colour also takes the background glow over from the cover (see
  // styles.css), and the pencil on an editable card part, a picture rather
  // than text, follows the button text.
  if (isDefault) delete root.dataset.accent;
  else root.dataset.accent = 'custom';
  if (!isDefault && tokens['--on-accent'] === '#ffffff') root.dataset.onAccent = 'light';
  else delete root.dataset.onAccent;
}
