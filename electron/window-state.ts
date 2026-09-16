/**
 * Where the window was last left, so it opens there next time.
 *
 * The window used to open at one fixed size every launch. That size was
 * chosen for the page as it was — cover, metadata, lyrics — and the presence
 * tiles that sit above them when several cards are on air take a row of
 * their own, which pushed the lyrics down past the edge until the window was
 * dragged taller. Doing that every launch is the kind of thing an app should
 * do for you: the size and position the user settles on are written here and
 * restored, along with whether the window was maximised.
 *
 * Restored bounds are checked against the displays present now. A window
 * left on a monitor that has since been unplugged would otherwise open off
 * screen, with no way to reach it but the keyboard.
 */

import { screen, type BrowserWindow, type Rectangle } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../src/core/logger.js';

const log = createLogger('Window');

interface SavedState {
  bounds?: Rectangle;
  maximized?: boolean;
}

/** How long after the last resize or move the state is written. */
const SAVE_DEBOUNCE_MS = 500;

export class WindowState {
  private readonly file: string;
  private state: SavedState = {};
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(dir: string) {
    this.file = path.join(dir, 'window-state.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as SavedState;
      if (raw && typeof raw === 'object') this.state = raw;
    } catch {
      /* first launch, or an unreadable file — the defaults apply */
    }
  }

  /**
   * Bounds to open with: the saved ones when they still land on a display,
   * else the defaults, which Electron centres.
   */
  initialBounds(defaults: { width: number; height: number }, min: { width: number; height: number }): Partial<Rectangle> {
    const b = this.state.bounds;
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.width) || !Number.isFinite(b.height)) {
      return { ...defaults };
    }
    const width = Math.max(min.width, Math.round(b.width));
    const height = Math.max(min.height, Math.round(b.height));
    // Enough of the window must be on some display to grab its title bar.
    const area = screen.getDisplayMatching({ x: b.x, y: b.y, width, height }).workArea;
    const visible = b.x + width > area.x + 60 && b.x < area.x + area.width - 60
      && b.y >= area.y - 10 && b.y < area.y + area.height - 60;
    if (!visible) {
      log.info('Saved window position is off every display — opening at the default size');
      return { width, height };
    }
    log.debug(`Restoring window at ${b.x},${b.y} ${width}x${height} (display work area ${area.x},${area.y} ${area.width}x${area.height})`);
    return { x: Math.round(b.x), y: Math.round(b.y), width, height };
  }

  get maximized(): boolean {
    return this.state.maximized === true;
  }

  /**
   * Put the window where the saved bounds say, once it exists.
   *
   * The constructor takes x and y too, and honours the size, but on a scaled
   * display the position it applies is not the one asked for. setBounds()
   * after creation lands exactly; the maximised flag goes on afterwards so
   * that un-maximising returns to those bounds.
   */
  apply(win: BrowserWindow, defaults: { width: number; height: number }, min: { width: number; height: number }): void {
    const b = this.initialBounds(defaults, min);
    if (typeof b.x === 'number' && typeof b.y === 'number') {
      win.setBounds({ x: b.x, y: b.y, width: b.width!, height: b.height! });
    }
    if (this.maximized) win.maximize();
  }

  /** Follow the window from here on, writing its bounds as they settle. */
  track(win: BrowserWindow): void {
    const record = () => {
      if (win.isDestroyed()) return;
      const maximized = win.isMaximized();
      // The bounds worth restoring are the normal ones: a maximised window
      // reports the screen's, and un-maximising later should go back to what
      // the user had, not to full screen minus a pixel.
      this.state = {
        bounds: maximized || win.isMinimized() ? this.state.bounds : win.getNormalBounds(),
        maximized,
      };
      this.scheduleSave();
    };
    win.on('resize', record);
    win.on('move', record);
    win.on('maximize', record);
    win.on('unmaximize', record);
    win.on('close', () => { record(); this.flush(); });
  }

  private scheduleSave(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (e) {
      log.debug(`Could not save the window state: ${(e as Error).message}`);
    }
  }
}
