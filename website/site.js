/*
 * Vybecord website: the nav's background, sections fading in, the song that
 * plays in the drawn window, and every download link filled from the latest
 * GitHub release.
 *
 * Everything here is an improvement on a page that already works without it:
 * the download links point at download/, which redirects to the release, and
 * the window shows a fixed moment of the song.
 */
(() => {
  'use strict';

  const REPO = 'TheUnknownMurda/VybecordTS';
  const RELEASES = 'https://github.com/' + REPO + '/releases';
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── Nav gets its background once the page scrolls under it ── */

  const nav = document.getElementById('nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('is-stuck', window.scrollY > 8);
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ── Sections rise in as they arrive ── */

  const reveals = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    reveals.forEach((el) => el.classList.add('in'));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add('in');
          io.unobserve(e.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.06 },
    );
    reveals.forEach((el) => io.observe(el));
  }

  /* ── The song in the drawn window ── */

  // Made up, words and all. Times in seconds, as an .lrc file would give them.
  const SONG_LENGTH = 187;
  const LINES = [
    [62.4, 'Every street we ever walked at three'],
    [66.9, 'Say it once more before the signal drops'],
    [71.3, 'The city hums the rest of it for us'],
    [75.8, 'And I keep the frequency open'],
    [80.2, 'Static on the window, gold on the glass'],
    [84.7, 'Call me when the morning finds the coast'],
    [89.1, "I'll be the light still blinking on the tower"],
    [93.6, 'Midnight signal, bring it home'],
  ];
  const LOOP_START = 67.5;
  const LOOP_END = 98;

  const list = document.getElementById('lyrList');
  const dc = document.getElementById('dc');
  const dcNow = document.querySelector('[data-dc-now]');
  const dcNext = document.querySelector('[data-dc-next]');
  const elapsedEls = document.querySelectorAll('[data-elapsed]');
  const fillEls = document.querySelectorAll('[data-fill]');

  const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

  function lineAt(t) {
    let i = 0;
    while (i + 1 < LINES.length && LINES[i + 1][0] <= t) i++;
    return i;
  }

  if (list && dc && dcNow && dcNext && !reduceMotion) {
    list.replaceChildren(
      ...LINES.map(([, text]) => {
        const li = document.createElement('li');
        li.textContent = text;
        return li;
      }),
    );
    const items = list.children;
    let shown = -1;
    let t = LOOP_START;

    const render = () => {
      elapsedEls.forEach((el) => (el.textContent = clock(t)));
      fillEls.forEach((el) => (el.style.width = ((t / SONG_LENGTH) * 100).toFixed(2) + '%'));

      const i = lineAt(t);
      if (i === shown) return;
      if (shown >= 0) items[shown].classList.remove('on');
      items[i].classList.add('on');
      // Centre the sung line in the view: each row is 36px, the view 156px.
      list.style.transform = 'translateY(' + (156 / 2 - 18 - i * 36) + 'px)';

      // The card swaps its lines the way Discord does: a short blink.
      dc.classList.add('is-swapping');
      setTimeout(() => {
        dcNow.textContent = '\u266A ' + LINES[i][1];
        dcNext.textContent = LINES[i + 1] ? '\u2192 ' + LINES[i + 1][1] + ' \u266A' : '';
        dc.classList.remove('is-swapping');
      }, shown < 0 ? 0 : 250);
      shown = i;
    };

    render();
    // Only while the window is on screen: nobody needs a song played to them
    // from three sections down.
    let timer = 0;
    const play = () => {
      if (timer) return;
      timer = setInterval(() => {
        t += 0.5;
        if (t >= LOOP_END) t = LOOP_START;
        render();
      }, 500);
    };
    const stop = () => {
      clearInterval(timer);
      timer = 0;
    };
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([e]) => (e.isIntersecting && !document.hidden ? play() : stop())).observe(dc);
      document.addEventListener('visibilitychange', () => (document.hidden ? stop() : play()));
    } else {
      play();
    }
  }

  /* ── Download links, from the latest release ── */

  /*
   * The release is the source of truth: publishing one updates this page with
   * no edit and no deploy. The answer is kept for ten minutes, because the API
   * allows 60 unauthenticated requests an hour per address, and a visitor
   * clicking around would otherwise spend one per page.
   */
  const CACHE_KEY = 'vybecord.latestRelease';
  const CACHE_MS = 10 * 60 * 1000;

  async function latestRelease() {
    try {
      const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (cached && Date.now() - cached.at < CACHE_MS) return cached.release;
    } catch {
      /* storage unavailable: just ask */
    }
    const res = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const r = await res.json();
    // Keep only what the page uses; a release body can be long.
    const release = {
      tag: r.tag_name || r.name || '',
      url: r.html_url || RELEASES + '/latest',
      date: r.published_at || '',
      assets: (r.assets || []).map((a) => ({
        name: a.name,
        size: a.size,
        url: a.browser_download_url,
        digest: a.digest || '',
      })),
    };
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release }));
    } catch {
      /* fine without it */
    }
    return release;
  }

  const prettySize = (bytes) => Math.round(bytes / 1048576) + ' MB';
  const prettyDate = (iso) =>
    new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' });

  // download/ is the one page that starts the download itself.
  const isDownloadPage = document.body.dataset.page === 'download';
  const toReleasePage = () => location.replace(RELEASES + '/latest');

  async function fillDownloads() {
    let release;
    try {
      release = await latestRelease();
    } catch {
      // Every link still goes through download/, which falls back to the
      // release page itself.
      if (isDownloadPage) toReleasePage();
      return;
    }

    const find = (re) => release.assets.find((a) => re.test(a.name));
    const installer = find(/-setup\.exe$/i);
    const extFirefox = find(/^vybecord-extension-.*-firefox\.zip$/i);
    const extChromium = release.assets.find((a) => /^vybecord-extension-.*\.zip$/i.test(a.name) && a !== extFirefox);
    const version = release.tag.replace(/^v/i, '');

    if (!installer) {
      if (isDownloadPage) toReleasePage();
      return;
    }

    document.querySelectorAll('[data-dl]').forEach((a) => (a.href = installer.url));
    document.querySelectorAll('[data-version-line]').forEach((el) => {
      el.textContent = isDownloadPage
        ? 'Vybecord ' + (version ? version + ' ' : '') + 'for Windows, ' + prettySize(installer.size)
        : (version ? 'Version ' + version + ' \u00b7 ' : '') + prettySize(installer.size);
    });

    if (isDownloadPage) {
      // A file download leaves this page where it is, showing the next steps.
      location.href = installer.url;
      return;
    }

    const pill = document.getElementById('releasePill');
    const pillText = document.getElementById('releasePillText');
    if (pill && pillText && version) {
      pill.href = release.url;
      pillText.textContent = 'Version ' + version + " is out \u00b7 See what's new";
    }

    const meta = document.getElementById('dlMeta');
    if (meta) {
      const items = [
        release.date && 'Released ' + prettyDate(release.date),
        'Windows 10 and 11, 64-bit',
        'Discord desktop app required',
      ].filter(Boolean);
      meta.replaceChildren(
        ...items.map((text) => {
          const li = document.createElement('li');
          li.textContent = text;
          return li;
        }),
      );
    }

    const hash = document.getElementById('dlHash');
    if (hash && installer.digest.startsWith('sha256:')) {
      hash.textContent = installer.name + '\nSHA-256  ' + installer.digest.slice(7).toUpperCase();
      hash.style.whiteSpace = 'pre-wrap';
    }

    const setExt = (id, asset) => {
      const a = document.getElementById(id);
      if (a && asset) {
        a.href = asset.url;
        a.title = asset.name;
      }
    };
    setExt('extChromium', extChromium);
    setExt('extFirefox', extFirefox);
  }

  fillDownloads();
})();
