/**
 * Whether the browser extension is there, as opposed to whether it is sending.
 *
 * The install card used to call the extension connected only while one of its
 * sources was reporting, and a source only reports while something plays. So an
 * extension installed and running, with nothing playing in the browser, read
 * "Not detected", which is exactly when people open the card to check. The
 * extension now says hello every 30 seconds (extension/src/background.js), and
 * anything it sends counts as contact: a push is proof as much as a hello, which
 * keeps an extension from before the hello connected while it plays, as it was.
 *
 * Only extension origins count, and the push server is what checks them. The
 * Spicetify client posts to the Spotify path too, so counting the Spotify
 * source, as the card did, showed the browser extension as connected to anyone
 * with Spicetify and no extension at all.
 */

import { asRecord, asText } from './utils.js';

/**
 * How long one contact keeps the extension connected: three hellos.
 *
 * The hello comes every 30 seconds, or every minute on a Chrome older than 120.
 * One late or lost hello must not flip the card, and a browser that has closed
 * should not read as there for much longer than this.
 */
export const EXTENSION_ALIVE_MS = 90_000;

/**
 * How long after the endpoint opens the card says "Checking…" rather than
 * "Not detected": one hello period, and some slack.
 *
 * A browser that was open before the app has said its last hello to a closed
 * port, and its next one is up to 30 seconds away. Saying "Not detected" in the
 * meantime is the very answer the hello exists to stop giving.
 */
export const EXTENSION_FIRST_HELLO_MS = 40_000;

/** The extension's site keys, named as its options page names them. */
const SITE_NAMES: Record<string, string> = {
  spotify: 'Spotify',
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
  bandcamp: 'Bandcamp',
  amazonmusic: 'Amazon Music',
  twitch: 'Twitch',
  kick: 'Kick',
  primevideo: 'Prime Video',
  netflix: 'Netflix',
  disneyplus: 'Disney+',
  paramountplus: 'Paramount+',
  appletv: 'Apple TV',
  crave: 'Crave',
  crunchyroll: 'Crunchyroll',
};

export interface ExtensionHello {
  /** The extension's own version, '' when the hello carried nothing that reads as one. */
  version: string;
  /** Sites switched off in the extension's options, by name. */
  sitesOff: string[];
}

/** Coerce a hello into the shape above, whatever actually arrived. */
export function normalizeExtensionHello(raw: unknown): ExtensionHello {
  const d = asRecord(raw);
  const version = asText(d.version, 32);
  const sites = asRecord(d.sites);
  return {
    version: /^\d{1,5}(\.\d{1,5}){0,3}$/.test(version) ? version : '',
    // Only an explicit false is off, as in the extension itself. A key this
    // app does not know is a site added after it; there is nothing to say.
    sitesOff: Object.keys(SITE_NAMES).filter(k => sites[k] === false).map(k => SITE_NAMES[k]),
  };
}

/** Negative, zero or positive, comparing dotted versions part by part ("2.10.0" is after "2.9.0"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Times are performance.now(), the clock the push sources already use. */
export class ExtensionLink {
  private lastContact = -Infinity;
  /** Push path → when the extension itself last posted there. */
  private lastPush = new Map<string, number>();
  private lastHello: ExtensionHello | null = null;
  private lastHelloAt = -Infinity;

  /** Something arrived from an extension origin, on this path. */
  contact(path: string, now: number): void {
    this.lastContact = now;
    this.lastPush.set(path, now);
  }

  /**
   * Keep a hello. True when it says something the last one did not, or comes
   * after the last one stopped counting, so the log has a line per change
   * rather than one every 30 seconds.
   */
  greet(hello: ExtensionHello, now: number): boolean {
    const prev = this.helloAt(now);
    this.lastHello = hello;
    this.lastHelloAt = now;
    return !prev || prev.version !== hello.version || prev.sitesOff.join() !== hello.sitesOff.join();
  }

  isConnected(now: number): boolean {
    return now - this.lastContact <= EXTENSION_ALIVE_MS;
  }

  /** How long the last contact still counts for, in ms; 0 once it no longer does. */
  msLeft(now: number): number {
    return Math.max(0, this.lastContact + EXTENSION_ALIVE_MS - now);
  }

  /** Whether the extension itself posted to this path recently enough to count. */
  pushedTo(path: string, now: number): boolean {
    const at = this.lastPush.get(path);
    return at !== undefined && now - at <= EXTENSION_ALIVE_MS;
  }

  /**
   * The last hello, while it still counts. Null from an extension that never
   * says hello (older than 2.5.0), which still connects through its pushes;
   * timed on its own so such an extension cannot inherit a newer one's version.
   */
  helloAt(now: number): ExtensionHello | null {
    return now - this.lastHelloAt <= EXTENSION_ALIVE_MS ? this.lastHello : null;
  }
}
