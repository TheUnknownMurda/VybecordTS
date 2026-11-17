/**
 * LRCLIB's address, and the one way every request to it goes out.
 *
 * Vybecord is registered with LRCLIB as a client-side application
 * (lrclib.net/developers, 2026-11-17), and announces it in the `Lrclib-App-Id`
 * header of every request. A registered app gets about twice the per-IP
 * allowance of a client that only sets a User-Agent (LRCLIB's docs: ~180
 * requests a minute against ~90), an allowance of its own on top, and gives
 * LRCLIB a way to reach whoever runs it. The ID is public by design — LRCLIB
 * calls it self-asserted and safe to ship in a client, which is why it sits in
 * the source — and it goes to lrclib.net only, never to the other providers.
 *
 * An ID LRCLIB no longer recognises (the registration deleted, the ID rotated)
 * gets a 401 for every request. Shipped in every installed copy, that would cut
 * LRCLIB off for everybody until the next update, so the first 401 drops the
 * header for the rest of the run and the same request goes again without it:
 * an unregistered client is rate-limited sooner, but it still gets lyrics.
 * Resending is safe for a publish too. LRCLIB checks the ID at its edge — the
 * name of the 401 (InvalidAppIdError) is nowhere in its open-source server —
 * so a request turned away there never reached the code that publishes, and
 * its token was never spent.
 */

import { createLogger } from './logger.js';

const log = createLogger('LrclibApi');

export const LRCLIB_BASE = 'https://lrclib.net';

/** Vybecord's registered client-side application. Public, not a credential. */
export const LRCLIB_APP_ID = 'kqmg3IWZsZ01s-mcCQyKXPWE0E-yQ7cIaWsY-ZJi2CE';

/** LRCLIB turned the ID down once this run; every later request goes without it. */
let appIdRefused = false;

type LrclibInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

/**
 * fetch(), for LRCLIB: the same request, with the application ID added.
 *
 * `fetchImpl` is for tests; the app uses the global fetch.
 */
export async function lrclibFetch(url: string, init: LrclibInit = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const send = (withId: boolean) => fetchImpl(url, {
    ...init,
    headers: { ...init.headers, ...(withId ? { 'Lrclib-App-Id': LRCLIB_APP_ID } : {}) },
  });
  if (appIdRefused) return send(false);
  const res = await send(true);
  if (res.status !== 401) return res;
  appIdRefused = true;
  log.warn('LRCLIB does not recognise Vybecord’s application ID any more (401) — sending without it for the rest of this run');
  return send(false);
}

/** The harness test's way back to a fresh run; nothing in the app calls it. */
export function resetLrclibAppIdRefusal(): void {
  appIdRefused = false;
}
