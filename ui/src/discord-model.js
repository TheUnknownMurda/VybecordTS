/**
 * What Discord draws for an activity, as plain data.
 *
 * The preview used to pick fields by guesswork, and guessed wrong in the ways
 * that matter: it dropped the cover text, which Discord's profile shows as a
 * third line (title | artist | album | playlist under the lyrics), it left out
 * the platform badge on the cover, it cut a stream title to one line where
 * Discord wraps it, and it printed its own clock format. So the mapping lives
 * here, apart from the DOM, where harness/test-discord-preview.ts can hold it
 * against the activities the engine really builds.
 *
 * The rules, read off Discord's profile card:
 *   header   "<verb> <name>" on one line — the activity's name, else the app's
 *   lines    details, state, then assets.large_text, each shown whole when set
 *   cover    assets.large_image, with assets.small_image as a badge on it
 *   time     a bar with both ends when the activity has an end, otherwise the
 *            time since it started; both in Discord's clock (02:58, 4:39:44)
 *   buttons  their labels — Discord shows them to others, never on your own
 *            profile
 *
 * No imports, no DOM: the harness runs this under Node.
 */

/** Discord's verbs for activity types. */
export const VERBS = { 0: 'Playing', 1: 'Streaming', 2: 'Listening to', 3: 'Watching', 5: 'Competing in' };

/** A field as Discord shows it — '' for unset, and for the blank '  ' the engine uses as a spacer. */
const field = (s) => (typeof s === 'string' ? s.trim() : '');

const https = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : '');

/**
 * Discord's clock: minutes always two digits, hours only once there are any.
 * 2:58 reads "02:58", a stream four and a half hours in reads "4:39:44".
 */
export function fmtClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * The card for one activity.
 *
 * @param {object} activity a DiscordActivity, as the engine hands it to Discord
 * @param {{ appName?: string, now?: number }} opts
 *   appName — what Discord heads the card with when the activity carries no
 *   name of its own: the application's name. now — the wall clock, in ms;
 *   Discord counts from the timestamps, not from the player, and so does this.
 */
export function presenceModel(activity, opts = {}) {
  const a = activity || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const verb = VERBS[a.type ?? 2] || VERBS[2];
  const name = field(a.name) || field(opts.appName);
  const assets = a.assets || {};

  const ts = a.timestamps || {};
  let time = null;
  if (ts.start && ts.end && ts.end > ts.start) {
    const totalMs = (ts.end - ts.start) * 1000;
    const elapsedMs = Math.min(totalMs, Math.max(0, now - ts.start * 1000));
    time = {
      kind: 'bar',
      elapsed: fmtClock(elapsedMs),
      total: fmtClock(totalMs),
      pct: Math.round((elapsedMs / totalMs) * 1000) / 10,
    };
  } else if (ts.start) {
    time = { kind: 'elapsed', text: fmtClock(now - ts.start * 1000) };
  }

  return {
    header: name ? `${verb} ${name}` : verb,
    lines: [a.details, a.state, assets.large_text].map(field).filter(Boolean),
    largeImage: https(assets.large_image),
    largeText: field(assets.large_text),
    smallImage: https(assets.small_image),
    smallText: field(assets.small_text),
    time,
    buttons: (Array.isArray(a.buttons) ? a.buttons : []).map((b) => field(b?.label)).filter(Boolean),
  };
}
