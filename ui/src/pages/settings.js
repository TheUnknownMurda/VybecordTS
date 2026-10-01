/**
 * Settings — everything in config.json that is worth a control.
 *
 * Six categories down the side, a search over all of them, and every setting
 * in a named group. The Discord category opens on a live preview of the card,
 * because "what does this switch actually change?" is the question every one
 * of those switches raises.
 */

import { el, toggleRow, selectRow, inputRow, toast } from '../util.js';
import { state, subscribe, saveConfig } from '../state.js';
import { goto } from '../router.js';
import { discordPreview } from '../discord-card.js';
import { spicetifyCard } from './spicetify-card.js';
import { updateCard } from './update-card.js';
import { lastfmCard } from './lastfm-card.js';

const api = window.vybecord;

const ACTIVITY_TYPES = [[2, 'Listening to'], [0, 'Playing'], [3, 'Watching'], [5, 'Competing in']];
const STATUS_DISPLAY = [
  ['app', 'App name'], ['title', 'Track title'], ['title_artist', 'Title — Artist'],
  ['artist_title', 'Artist — Title'], ['artist', 'Artist'], ['album', 'Album'],
  ['details', 'Details field'], ['state', 'State field'], ['custom', 'Custom template'],
];
const AWAY_DELAYS = [
  [5, 'After 5 minutes'], [10, 'After 10 minutes (Discord)'], [15, 'After 15 minutes'],
  [30, 'After 30 minutes'], [60, 'After 1 hour'],
];
const PRESENCE_COUNTS = [[1, 'One'], [2, 'Two'], [3, 'Three'], [4, 'Four'], [5, 'Five']];
/**
 * Which cards carry lyrics. One switch per card — presence 1 keeps the
 * `show_lyrics` switch it always had, the others have their own.
 */
const LYRICS_KEYS = ['show_lyrics', 'show_lyrics_2', 'show_lyrics_3', 'show_lyrics_4', 'show_lyrics_5'];
const APP_ID_KEYS = ['discord_app_id_2', 'discord_app_id_3', 'discord_app_id_4', 'discord_app_id_5'];
const presenceCount = () => Math.max(1, Math.min(5, Number(cfg('presence_count', 1)) || 1));

/**
 * Small-icon styles. They are stored as separate booleans rather than one enum,
 * but only one can sensibly be on, so the UI presents them as a single choice
 * and clears the rest on change.
 */
const ICON_MODES = [
  ['', 'Platform default'], ['dance_mode', 'Dance'], ['radiate_mode', 'Radiate'],
  ['purple_rad_mode', 'Purple'], ['blue_rad_mode', 'Blue'], ['rouge_mode', 'Red'],
  ['bleeding_mode', 'Bleeding'], ['random_icon_mode', 'Random each track'],
  // The engine has always known this mode; the list simply never listed it, so
  // it was the one icon nobody could pick.
  ['lrc_off_mode', 'LRC off'],
  ['hide_small_icon', 'No small icon'],
];
const ICON_KEYS = ICON_MODES.map(([k]) => k).filter(Boolean);

const GUIDE_EN = 'https://github.com/TheUnknownMurda/VybecordTS/blob/main/USER_GUIDE.md';
const GUIDE_FR = 'https://github.com/TheUnknownMurda/VybecordTS/blob/main/GUIDE_UTILISATEUR.md';

let langs = null;

/** The categories, in order. Each builder appends its groups and may return a disposer. */
const CATS = [
  { id: 'presence', label: 'Discord presence', desc: 'What appears on your Discord profile, and when.', build: presenceCat },
  { id: 'lyrics', label: 'Lyrics & translation', desc: 'Where lyrics come from and how they are shown.', build: lyricsCat },
  { id: 'detection', label: 'Detection', desc: 'Which players Vybecord listens to.', build: detectionCat },
  { id: 'integrations', label: 'Integrations', desc: 'Optional add-ons that make detection and lyrics better.', build: integrationsCat },
  { id: 'app', label: 'App & window', desc: 'How Vybecord starts, closes and updates.', build: appCat },
  { id: 'about', label: 'About', desc: 'Version, help and feedback.', build: aboutCat },
];

/** The category looked at last, so coming back to Settings lands where you were. */
let lastCat = 'presence';

/**
 * @param params optional `{ cat }` — another page sending the user to one
 *   category, as Now playing's "Customize" does.
 */
export function render(root, params) {
  let cat = CATS.some((c) => c.id === params?.cat) ? params.cat : lastCat;
  lastCat = cat;
  let query = '';
  let disposers = [];
  void loadLangs();

  const panel = el('div', { class: 'set-panel' });
  const catList = el('div', { style: 'display:flex;flex-direction:column;gap:4px' });
  const searchInput = el('input', {
    type: 'search', placeholder: 'Search settings', 'aria-label': 'Search settings',
    oninput: debounce((e) => { query = e.target.value.trim().toLowerCase(); paintCats(); show(); }, 150),
  });
  const searchBox = el('label', { class: 'search' }, [searchInput]);
  searchBox.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>');

  root.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Settings' }),
        el('div', { class: 'sub', text: 'Changes apply instantly — there is nothing to save.' }),
      ]),
    ]),
    el('div', { class: 'set-layout' }, [
      el('nav', { class: 'set-cats', 'aria-label': 'Settings categories' }, [searchBox, catList]),
      panel,
    ]),
  );

  function paintCats() {
    catList.replaceChildren(...CATS.map((c) => el('button', {
      type: 'button',
      class: `set-cat${!query && c.id === cat ? ' active' : ''}`,
      'aria-current': !query && c.id === cat ? 'page' : null,
      text: c.label,
      onclick: () => {
        cat = c.id;
        lastCat = c.id;
        if (query) { query = ''; searchInput.value = ''; }
        paintCats();
        show();
        document.getElementById('content').scrollTop = 0;
      },
    })));
  }

  function dispose() {
    disposers.forEach((fn) => { try { fn(); } catch (e) { console.error('settings cleanup failed', e); } });
    disposers = [];
  }

  function show() {
    dispose();
    // A config change redraws the panel; it must not throw the reader back to
    // the top of a long category.
    const content = document.getElementById('content');
    const scroll = content?.scrollTop ?? 0;
    const keep = (fn) => { if (typeof fn === 'function') disposers.push(fn); };

    if (query) {
      const sections = CATS.map((c) => {
        const sec = el('div', { class: 'set-panel', dataset: { cat: c.id } }, [
          el('div', { class: 'set-panel-head' }, [el('h2', { text: c.label })]),
        ]);
        keep(c.build(sec, { search: true }));
        return sec;
      });
      panel.replaceChildren(...sections);
      const any = filter(sections, query);
      if (!any) panel.append(el('div', { class: 'empty', text: `No setting matches “${query}”.` }));
    } else {
      const c = CATS.find((x) => x.id === cat) || CATS[0];
      panel.replaceChildren(el('div', { class: 'set-panel-head' }, [
        el('h2', { text: c.label }),
        el('div', { class: 'sub', text: c.desc }),
      ]));
      keep(c.build(panel, { search: false }));
    }
    if (content) content.scrollTop = scroll;
  }

  paintCats();
  show();

  // A config change from anywhere else (the tray, another control) should be
  // reflected here, but only redraw when this page is still mounted.
  const offConfig = subscribe('config', () => show());
  return () => {
    offConfig();
    dispose();
  };
}

/**
 * Hide everything in the search results that does not mention the query.
 *
 * A group whose own title matches keeps all its rows — searching "lyrics"
 * should show the lyrics settings, not only the rows that repeat the word.
 * Returns whether anything is left on screen.
 */
function filter(sections, q) {
  let any = false;
  for (const sec of sections) {
    let secAny = false;
    for (const group of sec.querySelectorAll('.set-group')) {
      const title = (group.querySelector('.eyebrow')?.textContent || '').toLowerCase();
      const rows = [...group.querySelectorAll('.row')];
      let visible;
      if (title.includes(q)) {
        visible = true;
      } else if (rows.length) {
        rows.forEach((r) => { r.hidden = !r.textContent.toLowerCase().includes(q); });
        visible = rows.some((r) => !r.hidden);
      } else {
        visible = group.textContent.toLowerCase().includes(q);
      }
      group.hidden = !visible;
      secAny ||= visible;
    }
    sec.hidden = !secAny;
    any ||= secAny;
  }
  return any;
}

const cfg = (key, fallback) => state.config[key] ?? fallback;
const put = (key, value) => saveConfig({ [key]: value });

/** A titled group of rows in one card. */
function group(title, rows, desc) {
  return el('section', { class: 'set-group', 'aria-label': title }, [
    el('div', { class: 'eyebrow', text: title }),
    desc ? el('div', { class: 'set-group-desc', text: desc }) : null,
    el('div', { class: 'card rows' }, rows.filter(Boolean)),
  ]);
}

/** A titled group around a card that lays itself out. */
function cardGroup(title, card, desc) {
  return el('section', { class: 'set-group', 'aria-label': title }, [
    el('div', { class: 'eyebrow', text: title }),
    desc ? el('div', { class: 'set-group-desc', text: desc }) : null,
    card,
  ]);
}

/** A row whose control is a set of buttons. */
function actionRow(label, desc, buttons) {
  return el('div', { class: 'row' }, [
    el('div', {}, [
      el('div', { class: 'row-label', text: label }),
      desc ? el('div', { class: 'row-desc', text: desc }) : null,
    ]),
    el('div', { class: 'row-control', style: 'display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end' }, buttons),
  ]);
}

function btn(text, onclick, cls = 'btn btn-sm') {
  return el('button', { type: 'button', class: cls, text, onclick });
}

/**
 * Save the LRCLIB dump path, and say what still has to happen.
 *
 * Everything else on this page takes effect as it is typed, so a setting that
 * changes nothing until the next launch has to say so. The stored value is
 * compared rather than the typed one: the backend strips the quotes Explorer's
 * "Copy as path" wraps a path in, so what was typed and what was kept are not
 * always the same string.
 */
async function saveDumpPath(value) {
  const before = cfg('lrclib_dump_path', '');
  const fresh = await put('lrclib_dump_path', value);
  const after = fresh?.lrclib_dump_path ?? '';
  if (after === before) return;
  toast(after
    ? 'Dump path saved — restart Vybecord to load it'
    : 'Dump path cleared — restart Vybecord to apply', 'ok');
}

// ── Discord presence ──────────────────────────────────────────────────────────

function presenceCat(body, { search }) {
  const iconMode = ICON_KEYS.find((k) => cfg(k) === true) || '';
  const multi = presenceCount() > 1;
  const preview = search ? null : discordPreview({
    title: multi ? `Live preview — presence ${(state.focus || 0) + 1}` : 'Live preview',
  });

  body.append(...[
    preview?.node,

    group('Visibility', [
      toggleRow('Show my activity on Discord', 'Master switch. Off clears your Discord status right away.',
        cfg('rpc_enabled', true) !== false, (v) => put('rpc_enabled', v)),
      toggleRow('Hide when paused', 'Take the status down as soon as playback stops, instead of leaving the last track up.',
        cfg('rpc_only_when_playing') === true, (v) => put('rpc_only_when_playing', v)),
      toggleRow('Hide when I’m away', 'Hidden while Discord marks you idle, back the moment you touch the keyboard — the way Spotify behaves.',
        cfg('rpc_hide_when_away', true) !== false, (v) => put('rpc_hide_when_away', v)),
      cfg('rpc_hide_when_away', true) !== false
        ? selectRow('Away after', 'Inactivity before the status is hidden. Discord itself goes idle after 10 minutes.',
            cfg('away_after_minutes', 10), AWAY_DELAYS, (v) => put('away_after_minutes', Number(v)))
        : null,
      toggleRow('Hide during Spotify ads', 'Your status clears for the length of the ad, then comes back.',
        cfg('filter_spotify_ads', true) !== false, (v) => put('filter_spotify_ads', v)),
    ]),

    group('What your card shows', [
      multi ? null : toggleRow('Lyrics on the card',
        'The line being sung and the next one, in time with the song. The title, artist and album move to the line under them.',
        cfg('show_lyrics', true) !== false, (v) => put('show_lyrics', v)),
      toggleRow('Name the playlist', 'Name the playlist, radio or Liked Songs the track is playing from — on the card and in the status line. Off, that line shows the artist instead.',
        cfg('rpc_show_playlist', true) !== false, (v) => put('rpc_show_playlist', v)),
      selectRow('Activity type', 'The verb Discord shows before the activity.',
        cfg('rpc_activity_type', 2), ACTIVITY_TYPES, (v) => put('rpc_activity_type', Number(v))),
      selectRow('Status line', 'What the one-line status in the member list shows.',
        cfg('rpc_status_display', 'app'), STATUS_DISPLAY, (v) => put('rpc_status_display', v)),
      cfg('rpc_status_display') === 'custom'
        ? inputRow('Status template', 'Placeholders: {title} {artist} {album} {platform}',
            cfg('rpc_status_template', ''), (v) => put('rpc_status_template', v))
        : null,
      selectRow('Small icon', 'The little badge in the corner of the album art.', iconMode, ICON_MODES, (v) => {
        // Exactly one mode may be set, so clear them all and set the chosen one.
        const patch = Object.fromEntries(ICON_KEYS.map((k) => [k, false]));
        if (v) patch[v] = true;
        saveConfig(patch);
      }),
    ]),

    group('Buttons', [
      inputRow('Your button’s label', 'Leave empty to hide it. The second button is fixed: it opens what is playing, on its platform.',
        cfg('rpc_button1_label', ''), (v) => put('rpc_button1_label', v)),
      inputRow('Your button’s link', null, cfg('rpc_button1_url', ''), (v) => put('rpc_button1_url', v), { placeholder: 'https://…' }),
    ], 'The title, artist and cover are already links, each pointing at what it names.'),

    group('Several presences', [
      selectRow('Presences at once', 'Up to five cards — the song in Spotify on one, a stream in a browser tab on another. One is how the app always behaved.',
        presenceCount(), PRESENCE_COUNTS, (v) => put('presence_count', Number(v))),
      ...(multi
        ? LYRICS_KEYS.slice(0, presenceCount()).map((key, i) => toggleRow(
            `Lyrics on presence ${i + 1}`,
            i === 0 ? 'The line being sung and the next one; the title, artist and album move to the line under them.' : 'Off shows the track without lyrics on that card.',
            cfg(key, true) !== false, (v) => put(key, v)))
        : []),
      ...(multi
        ? APP_ID_KEYS.slice(0, presenceCount() - 1).map((key, i) => inputRow(
            `Spare application ID ${i + 1}`,
            i === 0
              ? 'Optional. A Discord application carries one card, so a card whose own application is taken '
                + 'borrows one: the default, then these spares, then a platform application nothing is on. '
                + 'Create an application at discord.com/developers and paste its Application ID.'
              : 'Another spare, borrowed after the one above.',
            cfg(key, ''), (v) => put(key, v.trim()), { placeholder: 'Optional' }))
        : []),
    ], multi
      ? 'The highest-ranked thing playing goes on presence 1, the next on presence 2, and so on. Pin one to a player with the Source menu on Now playing. Stats, history and Last.fm follow presence 1.'
      : null),
  ].filter(Boolean));

  return preview ? preview.dispose : null;
}

// ── Lyrics & translation ──────────────────────────────────────────────────────

function lyricsCat(body) {
  // Languages arrive over IPC; the groups that need them fill in when they do.
  // Settings asks for them as it opens, so by the time this category is shown
  // they are nearly always here already — which matters to search, since a
  // group that turns up late is not one the filter has seen.
  let translation = el('div');
  let captions = el('div');
  if (langs) {
    const langOptions = Object.entries(langs);
    translation = translationGroup(langOptions);
    captions = captionsGroup(langOptions);
  }

  body.append(
    group('Display', [
      presenceCount() > 1
        ? null
        : toggleRow('Show lyrics', 'Off keeps the presence but stops fetching and showing lyrics.',
            cfg('show_lyrics', true) !== false, (v) => put('show_lyrics', v)),
      toggleRow('Romanise Japanese and Korean', 'Converts kana and hangul to Latin script.',
        cfg('romanize_lyrics') === true, (v) => put('romanize_lyrics', v)),
      inputRow('Default timing offset (ms)', 'Negative shows lines earlier, positive later. '
        + 'A track corrected on Now playing keeps its own offset instead.',
        cfg('lyrics_offset_ms', 0), (v) => put('lyrics_offset_ms', Math.max(-60000, Math.min(60000, v))), { type: 'number', min: -60000, max: 60000 }),
    ]),
    translation,
    captions,
    group('Offline lyrics', [
      inputRow('LRCLIB dump path',
        'Optional offline database. Leave empty to use the folder Vybecord looks in. '
        + 'The file is opened once at startup — restart Vybecord after changing this.',
        cfg('lrclib_dump_path', ''), saveDumpPath, { placeholder: 'C:\\…\\lrclib-dump.sqlite3' }),
      actionRow('Get or search a dump', 'How to download one, where to put it, and a search box.', [
        btn('Open LRCLIB dump', () => goto('library', { tab: 'dump' })),
      ]),
      actionRow('Caches', 'Forget fetched lyrics or translations, so the next play looks them up again.', [
        btn('Clear lyrics cache', async () => {
          const res = await api.clearCache();
          toast(`Cleared ${res?.cleared ?? 0} cached tracks`, 'ok');
        }),
        btn('Clear translation cache', async () => { await api.clearTranslationCache(); toast('Translation cache cleared', 'ok'); }),
      ]),
    ]),
  );

  if (!langs) {
    loadLangs().then(() => {
      const langOptions = Object.entries(langs);
      translation.replaceWith(translationGroup(langOptions));
      captions.replaceWith(captionsGroup(langOptions));
    });
  }
}

/** The translation languages, asked for once per window. */
async function loadLangs() {
  if (langs) return langs;
  try {
    langs = await api.translateLangs();
  } catch {
    langs = { en: 'English' };
  }
  return langs;
}

function translationGroup(langOptions) {
  return group('Translation', [
    toggleRow('Translate in this window', null, cfg('translate_lyrics') === true, (v) => put('translate_lyrics', v)),
    toggleRow('Translate on Discord too', 'Sends the translated lines to your presence.',
      cfg('rpc_translate_lyrics') === true, (v) => put('rpc_translate_lyrics', v)),
    selectRow('Translate to', null, cfg('translate_target_lang', 'en'), langOptions,
      (v) => put('translate_target_lang', v)),
  ]);
}

/**
 * YouTube captions, including whether they can actually run.
 *
 * Captions need yt-dlp, and without it the feature silently does nothing while
 * its switch still reads as on — indistinguishable from a bug. So the group
 * leads with whether the tool is present, and if it is not, offers the folder
 * to drop it into rather than asking the user to edit their PATH.
 */
function captionsGroup(langOptions) {
  const status = el('div');
  const card = el('div', { class: 'card' }, [
    status,
    el('div', {}, [
      toggleRow('Use captions as lyrics', null, cfg('cc_enabled', true) !== false, (v) => put('cc_enabled', v)),
      selectRow('Caption language', 'Automatic follows your system language, then English.',
        cfg('cc_lang', 'auto'), [['auto', 'Automatic'], ...langOptions], (v) => put('cc_lang', v)),
      inputRow('Cookies file',
        'YouTube will not give captions for an age-restricted video to a signed-out viewer. '
        + 'Export your cookies to a cookies.txt with a browser extension and point this at it. '
        + 'Leave empty if you do not watch age-restricted videos.',
        cfg('cc_cookies_file', ''), (v) => put('cc_cookies_file', v),
        { placeholder: 'C:\\Users\\you\\cookies.txt' }),
    ]),
  ]);

  (async () => {
    let st;
    try {
      st = await api.captionsStatus();
    } catch {
      return;
    }
    if (st.available) {
      status.replaceChildren(el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px' }, [
        el('span', { class: 'badge accent', text: 'yt-dlp ready' }),
        el('span', { class: 'row-desc', style: 'margin:0', text:
          st.source === 'bundled' ? 'Bundled with Vybecord — nothing to install'
          : st.source === 'PATH' ? 'Found on your PATH'
          : `Your own copy: ${st.command}` }),
      ]));
      return;
    }
    status.replaceChildren(
      el('div', { class: 'notice is-warn' },
        'yt-dlp is not installed, so captions cannot be fetched — the switch below has no effect until it is. '
        + 'Download "yt-dlp.exe", put it in the folder below, and restart Vybecord. It needs no installer.'),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px' }, [
        btn('Get yt-dlp', () => api.openExternal('https://github.com/yt-dlp/yt-dlp/releases/latest')),
        btn('Open the folder to put it in', async () => {
          await api.revealCaptionsDir();
          toast('Drop yt-dlp.exe here, then restart Vybecord', 'ok');
        }),
      ]),
    );
  })();

  return cardGroup('YouTube captions', card,
    'A fallback for YouTube, used only when no synced lyrics exist for the track. With the browser extension the exact video is used; without it, the video is found by its title.');
}

// ── Detection ─────────────────────────────────────────────────────────────────

function detectionCat(body) {
  const all = cfg('detect_all_media', true) !== false;
  body.append(group('Players', [
    toggleRow('Detect everything', 'Off restricts detection to dedicated music apps (Spotify, Apple Music, Deezer, Tidal, Amazon Music).',
      all, (v) => put('detect_all_media', v)),
    toggleRow('Spotify', null, cfg('detect_spotify', true) !== false, (v) => put('detect_spotify', v)),
    toggleRow('Apple Music', null, cfg('detect_apple_music', true) !== false, (v) => put('detect_apple_music', v)),
    toggleRow('YouTube and YouTube Music', null, cfg('detect_youtube', true) !== false, (v) => put('detect_youtube', v)),
    toggleRow('SoundCloud', null, cfg('detect_soundcloud', true) !== false, (v) => put('detect_soundcloud', v)),
    toggleRow('Other browser tabs', 'Anything else playing in Chrome, Firefox, Edge, Brave, Opera…',
      cfg('detect_browser', true) !== false, (v) => put('detect_browser', v)),
    toggleRow('Twitch', 'Live streams, reported by the browser extension.',
      cfg('detect_twitch', true) !== false, (v) => put('detect_twitch', v)),
    toggleRow('Kick', 'Live streams, reported by the browser extension.',
      cfg('detect_kick', true) !== false, (v) => put('detect_kick', v)),
    toggleRow('Other desktop apps', 'VLC, foobar2000, MusicBee, Deezer, Tidal, Bandcamp and friends.',
      cfg('detect_other_apps', true) !== false, (v) => put('detect_other_apps', v)),
  ], 'Vybecord sees any app that publishes to the Windows media session API — the same one the volume overlay uses. These switches decide which of those it announces.'));
}

// ── Integrations ──────────────────────────────────────────────────────────────

function integrationsCat(body) {
  body.append(
    cardGroup('Browser extension', extensionCard(),
      'Windows says what is playing but never which site a tab is on. The extension adds the site, the track link, the exact position and live stream uptime. Everything works without it.'),
    cardGroup('Spotify', spicetifyCard()),
    cardGroup('Last.fm', lastfmCard()),
    group('Cover images', [
      toggleRow('Publish artwork that exists only on this PC',
        'Released albums are looked up in a public catalogue, which sees nothing but the track and artist. '
        + 'Your own rips, demos and DJ sets are in no catalogue — with this on, that artwork alone is published '
        + 'for Discord to fetch. Never the audio, and camera and location tags are stripped first. '
        + 'Off, those tracks show the default placeholder.',
        cfg('art_upload_enabled', true) !== false, (v) => put('art_upload_enabled', v)),
    ]),
  );
}

/**
 * Browser extension: install guidance and live status.
 *
 * There is no install button because there cannot be one — browsers refuse to
 * let a desktop app add an extension, and every workaround is worse than the
 * manual path (see electron/extension-install.ts). So this does the next best
 * thing: name the browsers actually installed, put the folder one click away,
 * and copy the address that cannot be opened for them.
 */
function extensionCard() {
  const body = el('div');
  const card = el('div', { class: 'card' }, [body]);

  const paint = async () => {
    let info;
    try {
      info = await api.extensionInfo();
    } catch (e) {
      body.replaceChildren(el('div', { class: 'row-desc', text: `Could not read the extension folder: ${e.message}` }));
      return;
    }

    /*
     * "Not detected" used to cover two unrelated problems. One is the extension
     * not being installed, which the steps below fix. The other is the app not
     * having been able to open the port the extension pushes to, which they
     * cannot fix — and following them anyway is a loop that never closes.
     */
    const status = info.connected
      ? el('span', { class: 'badge accent', text: 'Connected' })
      : !info.enabled
        ? el('span', { class: 'badge', text: 'Turned off' })
        : info.portBlocked
          ? el('span', { class: 'badge', style: 'color:var(--red)', text: 'Port 8888 unavailable' })
          : el('span', { class: 'badge', text: 'Not detected' });

    const chromium = info.browsers.filter((b) => b.family === 'chromium');
    const firefox = info.browsers.filter((b) => b.family === 'firefox');

    // Once it is connected the install steps are noise; they fold away.
    const steps = el('details', { open: !info.connected }, [
      el('summary', { class: 'row-label', style: 'cursor:pointer;margin-top:14px', text: 'Install it' }),
      !info.available
        ? el('div', { class: 'row-desc', style: 'margin-top:10px', text: 'The extension folder is missing from this install.' })
        : el('div', {}, [
            el('div', { class: 'row-desc', style: 'margin-top:10px;max-width:none' },
              'A browser will not let an app install an extension for you, so this takes three steps. '
              + 'It stays installed afterwards.'),
            el('ol', { class: 'steps', style: 'margin:10px 0 0' }, [
              el('li', { text: 'Open your browser’s extensions page and turn on Developer mode.' }),
              el('li', { text: 'Choose "Load unpacked".' }),
              el('li', { text: 'Pick the Vybecord extension folder.' }),
            ]),
            el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px' }, [
              el('button', {
                type: 'button', class: 'btn btn-primary btn-sm', text: 'Open the extension folder',
                onclick: async () => { await api.revealExtension(); toast('Folder opened — pick it in "Load unpacked"', 'ok'); },
              }),
              btn('Copy the folder path', async () => { await api.copyExtensionPath(); toast('Path copied', 'ok'); }),
            ]),
            chromium.length || firefox.length
              ? el('div', { style: 'margin-top:14px' }, [
                  el('div', { class: 'row-desc', style: 'max-width:none' },
                    'Browsers cannot be sent to their own settings pages from outside, so copy the address and paste it '
                    + 'into the address bar:'),
                  el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' },
                    info.browsers.map((b) => el('button', {
                      type: 'button',
                      class: 'btn btn-sm',
                      text: `Copy ${b.extensionsUrl}`,
                      title: `For ${b.name}`,
                      onclick: async () => { await api.copyExtensionsUrl(b.extensionsUrl); toast(`Copied — paste it into ${b.name}`, 'ok'); },
                    }))),
                ])
              : el('div', { class: 'row-desc', style: 'margin-top:12px' },
                  'No browser detected. Open yours, go to its extensions page, and load the folder above.'),
            /*
             * Not this folder for Firefox. Its manifest is the Chromium one,
             * whose background is a Manifest V3 service worker — which Firefox
             * does not run, so the add-on loads and then does nothing. The
             * Firefox package (scripts/pack-extension.mjs) declares the same
             * code as an event page, and ships with every release.
             */
            firefox.length
              ? el('div', { style: 'margin-top:12px' }, [
                  el('div', { class: 'row-desc', style: 'max-width:none' },
                    'Firefox needs its own package: download vybecord-extension-…-firefox.zip from the latest '
                    + 'release, then pick that zip under "Load Temporary Add-on". Firefox drops temporary add-ons '
                    + 'when it closes.'),
                  btn('Get the Firefox package', () => api.openExternal('https://github.com/TheUnknownMurda/VybecordTS/releases/latest')),
                ])
              : null,
          ]),
    ]);

    // An open section stays open across the 4s refresh.
    const prev = body.querySelector('details');
    if (prev) steps.open = prev.open;

    body.replaceChildren(
      el('div', { class: 'card-head', style: 'margin-bottom:0' }, [
        el('div', { class: 'row-label', text: 'Vybecord for Chrome and Edge' }),
        status,
      ]),

      // '' rather than null: replaceChildren turns null into the text "null".
      info.portBlocked
        ? el('div', { class: 'notice is-warn', style: 'margin:12px 0 0' },
            'Another program is holding 127.0.0.1:8888, so the extension has nowhere to send to. '
            + 'A second copy of Vybecord is the usual cause — close it, then reopen this app. '
            + 'Installing the extension again will not help.')
        : '',

      steps,

      el('div', { style: 'margin-top:6px' }, [
        toggleRow('Accept data from the extension', 'Opens 127.0.0.1 for the extension only. Off closes the port entirely.',
          info.enabled, (v) => put('extension_enabled', v)),
      ]),
    );
  };

  paint();
  // The status only becomes "Connected" once something plays, so keep looking.
  const timer = setInterval(() => {
    if (!card.isConnected) { clearInterval(timer); return; }
    paint();
  }, 4000);

  return card;
}

// ── App & window ──────────────────────────────────────────────────────────────

function appCat(body) {
  const updates = updateCard();

  body.append(
    group('Window', [
      selectRow('Theme', null, cfg('theme', 'dark'), [['dark', 'Dark'], ['light', 'Light']], (v) => {
        document.documentElement.dataset.theme = v;
        put('theme', v);
      }),
      toggleRow('Close to tray', 'Closing the window hides it instead of quitting, so the presence keeps running.',
        cfg('minimize_to_tray', true) !== false, (v) => put('minimize_to_tray', v)),
      toggleRow('Show tray icon', 'The icon in the notification area. Without it, opening Vybecord again brings a hidden window back.',
        cfg('tray_enabled', true) !== false, (v) => put('tray_enabled', v)),
      toggleRow('Start hidden', 'Launch straight to the tray without showing the window.',
        cfg('start_minimized') === true, (v) => put('start_minimized', v)),
      toggleRow('Launch at sign-in', 'Starts with Windows, without opening the window — the presence runs in the background.',
        cfg('launch_on_startup') === true, (v) => put('launch_on_startup', v)),
    ]),
    cardGroup('Updates', updates.card),
    group('Performance', [
      inputRow('Update interval (ms)', 'Track changes arrive instantly; this only paces progress updates. '
        + 'Lower is smoother, higher is lighter.',
        cfg('poll_interval_ms', 1000), (v) => put('poll_interval_ms', Math.max(400, Math.min(60000, v))),
        { type: 'number', min: 400, max: 60000 }),
    ]),
  );

  return updates.dispose;
}

// ── About ─────────────────────────────────────────────────────────────────────

function aboutCat(body) {
  body.append(
    group('Vybecord', [
      actionRow(`Version ${state.version || ''}`.trim(), 'Discord Rich Presence with real-time synced lyrics.', [
        btn('Project page', () => api.openExternal('https://github.com/TheUnknownMurda/VybecordTS')),
      ]),
      actionRow('User guide', 'Every feature, step by step.', [
        btn('English', () => api.openExternal(GUIDE_EN)),
        btn('Français', () => api.openExternal(GUIDE_FR)),
      ]),
      actionRow('Setup checklist', 'Discord, a player, and the optional add-ons — what is done and what is left.', [
        btn('Open', () => goto('welcome')),
      ]),
      actionRow('Something wrong?', 'Goes straight to the maintainer, with the current track if you allow it.', [
        btn('Report a problem', () => goto('report')),
      ]),
      actionRow('Keyboard', '1 to 4 jump between sections. Ctrl+Q quits.', []),
      actionRow('Quit Vybecord', 'Closes the app and takes your status down. Closing the window only hides it while Close to tray is on.', [
        btn('Quit', () => api.quit(), 'btn btn-sm btn-danger'),
      ]),
    ]),
  );
}

function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
