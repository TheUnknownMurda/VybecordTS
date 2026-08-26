/**
 * Away detection — the presence follows Discord's own auto-idle.
 *
 * Discord flips an account to Idle after ten minutes without keyboard or mouse
 * input, and its built-in Spotify integration takes the "Listening to" card
 * down with it. Reproducing that is a matter of watching the same signal:
 * Discord reads the machine's idle clock, and so does powerMonitor. Asking
 * Discord directly is not an option — the local IPC socket accepts SET_ACTIVITY
 * from a third-party app and nothing else, so the account's status is not
 * readable over it without an OAuth flow the app has no reason to ask for.
 *
 * This lives in the main process because powerMonitor is Electron's. The
 * backend stays plain Node and is simply told the answer.
 */

import { powerMonitor } from 'electron';
import { createLogger } from '../src/core/logger.js';

const log = createLogger('Away');

/** How often the idle clock is read. One syscall, so it can be tight enough
 *  that coming back to the keyboard feels immediate. */
const CHECK_INTERVAL_MS = 5000;

/** Discord's own delay, used when the configured one is missing or nonsense. */
const DEFAULT_MINUTES = 10;

/**
 * Watch the machine's idle clock and report every crossing of the threshold.
 *
 * @param thresholdMinutes read on each check rather than captured, so changing
 *   the setting takes effect without restarting the watch.
 * @param onChange called only on a transition, never on every tick.
 * @returns a function that stops the watch.
 */
export function startAwayWatch(
  thresholdMinutes: () => number,
  onChange: (away: boolean) => void,
): () => void {
  let away = false;
  let warned = false;

  const check = (): void => {
    const minutes = thresholdMinutes();
    const thresholdSec = Math.round((minutes > 0 ? minutes : DEFAULT_MINUTES) * 60);

    let idleSec: number;
    try {
      idleSec = powerMonitor.getSystemIdleTime();
    } catch (e) {
      // No idle clock to read on this platform. Staying present is the safe
      // failure: hiding a presence that should be up looks like the app broke.
      if (!warned) {
        warned = true;
        log.warn(`System idle time unavailable — away detection is off: ${(e as Error).message}`);
      }
      return;
    }

    const next = idleSec >= thresholdSec;
    if (next === away) return;
    away = next;
    log.info(next ? `Idle for ${idleSec}s — away` : 'Input detected — back');
    onChange(next);
  };

  const timer = setInterval(check, CHECK_INTERVAL_MS);

  // Unlocking the screen and waking the machine are input by definition, so
  // checking on the spot spares the user up to five seconds of a profile that
  // still says they are away.
  const wake = (): void => check();
  powerMonitor.on('unlock-screen', wake);
  powerMonitor.on('resume', wake);

  check();

  return () => {
    clearInterval(timer);
    powerMonitor.removeListener('unlock-screen', wake);
    powerMonitor.removeListener('resume', wake);
  };
}
