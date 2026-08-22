/**
 * Greasemonkey compatibility layer.
 *
 * The six site scripts are the Tampermonkey userscripts, carried over with their
 * scraping logic untouched. That logic is the valuable part — it is what knows
 * where SoundCloud hides the real artist and how to tell a YouTube live edge
 * from a rewind — and rewriting it would have meant re-deriving all of it and
 * re-introducing its bugs. Instead this provides the three Greasemonkey APIs
 * they use, so the scripts run unmodified as content scripts.
 *
 *   GM_xmlhttpRequest → relayed through the service worker, because a content
 *     script shares the page's origin and cannot reach 127.0.0.1 itself.
 *   GM_getValue / GM_setValue → localStorage, which matches their synchronous
 *     signature. chrome.storage is async and would have required touching every
 *     call site. What they hold is a stream's start time, per site: losing it
 *     costs an elapsed counter, not correctness.
 *
 * This is a narrower thing than GM_xmlhttpRequest was, in two ways that matter
 * to anyone porting more userscript code into this extension:
 *
 *   1. It reaches 127.0.0.1 and nothing else. Under Tampermonkey the same call
 *      was a genuine cross-origin request, and the ported scripts used it to
 *      reach Spotify and Twitch. Those calls are gone — see the header comments
 *      in sites/spotify.js and sites/twitch.js for why they were not restored —
 *      and anything aimed elsewhere now fails loudly instead of quietly.
 *
 *   2. It does not return a response body. The relay reports whether the push
 *      landed, not what came back, so a handler cannot parse a reply out of it.
 *      Every removed call did exactly that, and got a synthesised body that
 *      always said `{"ok":true}` — which is how they failed without a sound.
 *
 * The same isolated-world boundary that stops a content script reaching
 * 127.0.0.1 also stops it seeing the page's own JavaScript: patching
 * `window.fetch` here patches this world's copy, not the page's, and there is
 * no `unsafeWindow`. Userscript code that sniffs the page's requests or reads
 * its globals will run without error and simply never observe anything.
 */

(() => {
  'use strict';

  const PREFIX = 'vybecord:';
  const APP_ORIGIN = 'http://127.0.0.1:8888';

  /**
   * Is this a push to the desktop app, or something the shim cannot do?
   *
   * Checked here rather than left to the service worker so the complaint names
   * the file that made the call. The service worker sees a URL with no idea
   * which script sent it, and its rejection reads as an ordinary failed push —
   * which is exactly how the ported external calls stayed broken unnoticed.
   */
  function isAppUrl(url) {
    try {
      return new URL(url, location.href).origin === APP_ORIGIN;
    } catch {
      return false;
    }
  }

  /**
   * Post to the desktop app via the service worker.
   *
   * Only the fields the scripts actually pass are honoured. `onload` is called
   * with a status and no body: the relay reports delivery, not content. See the
   * file header before reaching for this to call anything but the app.
   */
  globalThis.GM_xmlhttpRequest = function GM_xmlhttpRequest(opts) {
    const done = { called: false };
    const finish = (fn, arg) => {
      if (done.called) return;
      done.called = true;
      // console.error, not debug: a throw in here is a bug in a site script,
      // and at debug level it is invisible in a default console.
      try { fn?.(arg); } catch (e) { console.error('[Vybecord] GM_xmlhttpRequest handler threw', e); }
    };

    if (!isAppUrl(opts.url)) {
      // Loud, and on the error channel, because the failure is a programming
      // mistake rather than a runtime condition: no retry or backoff will ever
      // clear it. Silence here is the bug this guard exists to prevent.
      console.error(
        `[Vybecord] GM_xmlhttpRequest refused "${opts.url}". This shim only reaches the ` +
        `desktop app at ${APP_ORIGIN}; it is not a cross-origin request the way ` +
        `Tampermonkey's was. Fetch it from the desktop app instead, or read it out of the ` +
        `page. See src/gm-shim.js.`,
      );
      finish(opts.onerror, { error: 'blocked: not the desktop app' });
      return;
    }

    // The scripts set their own timeout and expect ontimeout to fire.
    const timer = opts.timeout
      ? setTimeout(() => finish(opts.ontimeout, { error: 'timeout' }), opts.timeout)
      : null;

    try {
      chrome.runtime.sendMessage(
        { type: 'vybecord-push', url: opts.url, body: opts.data },
        (reply) => {
          if (timer) clearTimeout(timer);
          // A missing reply means the service worker was asleep or the
          // extension was reloaded — a transient failure, so let the script
          // back off rather than treating it as fatal.
          if (chrome.runtime.lastError || !reply?.ok) {
            finish(opts.onerror, { error: chrome.runtime.lastError?.message || reply?.error || 'unreachable' });
            return;
          }
          // Deliberately no `responseText`. It used to be a hardcoded
          // `{"ok":true}`, which meant a handler that parsed the reply got a
          // plausible-looking lie instead of an error. Leaving it undefined
          // makes any such handler throw, and the catch in `finish` reports it.
          finish(opts.onload, { status: 200 });
        },
      );
    } catch (e) {
      if (timer) clearTimeout(timer);
      finish(opts.onerror, { error: String(e) });
    }
  };

  globalThis.GM_getValue = function GM_getValue(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : raw;
    } catch {
      return fallback;  // storage blocked by the site's own settings
    }
  };

  globalThis.GM_setValue = function GM_setValue(key, value) {
    try {
      localStorage.setItem(PREFIX + key, String(value));
    } catch {
      /* not worth failing a push over */
    }
  };
})();
