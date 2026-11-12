/**
 * Rebuild every raster copy of the Vybecord logo from its two SVG cuts:
 *
 *   assets/logo/vybecord.svg        full cut: glow and fine detail, for 72 px and up
 *   assets/logo/vybecord-small.svg  small cut: heavier strokes, a bigger glyph and no
 *                                   glow, for 64 px and down, where the full cut's
 *                                   strokes blur into the tile
 *
 * and writes
 *
 *   assets/icon.ico                 window, taskbar, tray, shortcuts and installer
 *   extension/icons/icon{16,32,48,128}.png
 *
 * Electron's own Chromium draws the SVGs, so the PNGs match the window title bar and the
 * website, which show the same files, and there is nothing to install. It replaces
 * make-extension-icons.ps1, which redrew the old mark by hand with GDI+ primitives and
 * could not follow a gradient.
 *
 *     npx electron scripts/make-icons.mjs
 *
 * Not part of any build: the mark changes about once a year. Bump the version in
 * extension/manifest.json afterwards and re-run scripts/pack-extension.mjs, or the store
 * zips keep the old icons.
 */

import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * Windows picks the frame nearest the size it needs and only then scales, so every size it
 * asks for at the common display scales gets a frame of its own: 16/20/24/28/32 in the
 * tray, 24/30/36/48 on the taskbar, 32 to 96 in Explorer and on shortcuts, 256 for the
 * installer and large icon views.
 */
const ICO_SIZES = [16, 20, 24, 28, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256];
const EXTENSION_SIZES = [16, 32, 48, 128];
const SMALL_MAX = 64;

// One CSS pixel per image pixel, even on a 150 % display.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
// Each size closes its window before the next opens; by default that would quit the app.
app.on('window-all-closed', () => {});

const svgFor = (size) => fs.readFileSync(
  path.join(root, 'assets/logo', size <= SMALL_MAX ? 'vybecord-small.svg' : 'vybecord.svg'), 'utf8');

/**
 * Offscreen rendering hands over each frame with its alpha channel. A fresh window per
 * size, because a reused one paints the previous page once more before the new one. A new
 * window's first frames are not the drawing either: blank, or flat white from before the
 * page commits (a third of the frames came out white when that was all it checked). So
 * only frames after the load count, and only one with ink that is not a single colour.
 */
async function rasterise(size) {
  const win = new BrowserWindow({
    show: false,
    width: Math.max(size, 64),
    height: Math.max(size, 64),
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  try {
    const svg = svgFor(size).replace('<svg ', `<svg width="${size}" height="${size}" `);
    const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style>${svg}`;
    const wc = win.webContents;
    let loaded = false;
    const drawn = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        wc.off('paint', onPaint);
        reject(new Error(`nothing was drawn at ${size} px`));
      }, 10_000);
      function onPaint(_event, _dirty, image) {
        if (!loaded) return;
        const square = image.crop({ x: 0, y: 0, width: size, height: size });
        if (!isDrawing(square)) return wc.invalidate();
        clearTimeout(timer);
        wc.off('paint', onPaint);
        resolve(square);
      }
      wc.on('paint', onPaint);
    });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    loaded = true;
    wc.invalidate();
    return (await drawn).toPNG();
  } finally {
    win.destroy();
  }
}

/** Some ink, and more than one colour: neither a blank frame nor a flat background. */
function isDrawing(image) {
  const bgra = image.toBitmap();
  const px = new Uint32Array(bgra.buffer.slice(bgra.byteOffset, bgra.byteOffset + bgra.byteLength));
  let ink = false;
  for (let i = 0; i < px.length; i++) {
    if (px[i] >>> 24) ink = true;
    if (px[i] !== px[0] && ink) return true;
  }
  return false;
}

/** PNG-compressed entries, which every Windows since Vista reads at every size. */
function packIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  const entries = [];
  let offset = 6 + 16 * frames.length;
  for (const { size, png } of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.png)]);
}

app.whenReady().then(async () => {
  const cache = new Map();
  const png = async (size) => {
    if (!cache.has(size)) cache.set(size, await rasterise(size));
    return cache.get(size);
  };

  const frames = [];
  for (const size of ICO_SIZES) frames.push({ size, png: await png(size) });
  const ico = path.join(root, 'assets/icon.ico');
  fs.writeFileSync(ico, packIco(frames));
  console.log(`  wrote  assets/icon.ico (${frames.length} frames, ${fs.statSync(ico).size} bytes)`);

  for (const size of EXTENSION_SIZES) {
    const file = path.join(root, `extension/icons/icon${size}.png`);
    fs.writeFileSync(file, await png(size));
    console.log(`  wrote  extension/icons/icon${size}.png (${fs.statSync(file).size} bytes)`);
  }

  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
