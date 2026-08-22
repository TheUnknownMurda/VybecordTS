/** Settings — everything in config.json that is worth a control. */

import { el, toggleRow, selectRow, inputRow, toast, modal } from '../util.js';
import { state, subscribe, saveConfig } from '../state.js';
import { spicetifyCard } from './spicetify-card.js';
import { updateCard } from './update-card.js';

const api = window.vybecord;

const ACTIVITY_TYPES = [[2, 'Listening to'], [0, 'Playing'], [3, 'Watching'], [5, 'Competing in']];
const STATUS_DISPLAY = [
  ['app', 'App name'], ['title', 'Track title'], ['title_artist', 'Title — Artist'],
  ['artist_title', 'Artist — Title'], ['artist', 'Artist'], ['album', 'Album'],
  ['details', 'Details field'], ['state', 'State field'], ['custom', 'Custom template'],
];
const URL_TARGETS = [['auto', 'Automatic'], ['track', 'Track'], ['artist', 'Artist'], ['album', 'Album'], ['context', 'Playlist / context']];

/**
 * Small-icon styles. They are stored as separate booleans rather than one enum,
 * but only one can sensibly be on, so the UI presents them as a single choice
 * and clears the rest on change.
 */
const ICON_MODES = [
  ['', 'Platform default'], ['dance_mode', 'Dance'], ['radiate_mode', 'Radiate'],
  ['purple_rad_mode', 'Purple'], ['blue_rad_mode', 'Blue'], ['rouge_mode', 'Red'],
  ['bleeding_mode', 'Bleeding'], ['random_icon_mode', 'Random each track'],
  ['hide_small_icon', 'No small icon'],
];
const ICON_KEYS = ICON_MODES.map(([k]) => k).filter(Boolean);

let langs = null;

export function render(root) {
  const body = el('div');
  let tab = 'presence';

  const tabs = el('div', { class: 'tabs' }, [
    tabBtn('Presence', 'presence', true),
    tabBtn('Lyrics', 'lyrics'),
    tabBtn('Detection', 'detection'),
    tabBtn('App', 'app'),
  ]);

  root.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('h1', { text: 'Settings' }),
      el('div', { class: 'sub', text: 'Changes apply immediately — there is nothing to save.' }),
    ]),
    tabs,
    body,
  );

  function tabBtn(label, id, active = false) {
    return el('button', {
      class: `tab ${active ? 'active' : ''}`.trim(),
      text: label,
      onclick: (e) => {
        tab = id;
        [...tabs.children].forEach((c) => c.classList.toggle('active', c === e.target));
        show();
      },
    });
  }

  let disposeTab = null;

  function show() {
    if (disposeTab) {
      try { disposeTab(); } catch (e) { console.error('settings tab cleanup failed', e); }
      disposeTab = null;
    }
    body.replaceChildren();
    const result = ({ presence: presenceTab, lyrics: lyricsTab, detection: detectionTab, app: appTab }[tab])(body, show);
    disposeTab = typeof result === 'function' ? result : null;
  }
  show();

  // A config change from anywhere else (the tray, another control) should be
  // reflected here, but only redraw when this page is still mounted.
  const offConfig = subscribe('config', () => show());
  return () => {
    offConfig();
    if (disposeTab) { try { disposeTab(); } catch { /* already gone */ } }
  };
}

const cfg = (key, fallback) => state.config[key] ?? fallback;
const put = (key, value) => saveConfig({ [key]: value });

// ── Presence ──────────────────────────────────────────────────────────────────

function presenceTab(body) {
  const iconMode = ICON_KEYS.find((k) => cfg(k) === true) || '';

  body.replaceChildren(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Discord presence' }),
      el('div', { style: 'margin-top:8px' }, [
        toggleRow('Show Rich Presence', 'Master switch. Off clears your Discord status entirely.',
          cfg('rpc_enabled', true) !== false, (v) => put('rpc_enabled', v)),
        toggleRow('Hide when paused', 'Remove the status as soon as playback stops, instead of leaving the last track up.',
          cfg('rpc_only_when_playing') === true, (v) => put('rpc_only_when_playing', v)),
        selectRow('Activity type', 'The verb Discord shows before the activity.',
          cfg('rpc_activity_type', 2), ACTIVITY_TYPES, (v) => put('rpc_activity_type', Number(v))),
        selectRow('Status line', 'What the one-line status in the member list shows.',
          cfg('rpc_status_display', 'app'), STATUS_DISPLAY, (v) => put('rpc_status_display', v)),
        cfg('rpc_status_display') === 'custom'
          ? inputRow('Status template', 'Placeholders: {title} {artist} {album} {platform}',
              cfg('rpc_status_template', ''), (v) => put('rpc_status_template', v))
          : null,
      ]),
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: 'Small icon' }),
      el('div', { style: 'margin-top:8px' }, [
        selectRow('Icon style', 'The little badge in the corner of the album art.', iconMode, ICON_MODES, (v) => {
          // Exactly one mode may be set, so clear them all and set the chosen one.
          const patch = Object.fromEntries(ICON_KEYS.map((k) => [k, false]));
          if (v) patch[v] = true;
          saveConfig(patch);
        }),
      ]),
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: 'Clickable links' }),
      el('div', { class: 'row-desc', style: 'margin-top:6px;max-width:none' },
        'The OS media session does not expose track, album or playlist URLs, so most of these only resolve '
        + 'when the lyrics provider supplies a link. Buttons with an empty label are omitted.'),
      el('div', { style: 'margin-top:8px' }, [
        selectRow('Title links to', null, cfg('rpc_details_url', 'auto'), URL_TARGETS, (v) => put('rpc_details_url', v)),
        selectRow('Artist links to', null, cfg('rpc_state_url', 'auto'), URL_TARGETS, (v) => put('rpc_state_url', v)),
        selectRow('Cover links to', null, cfg('rpc_large_url', 'auto'), URL_TARGETS, (v) => put('rpc_large_url', v)),
        inputRow('Button 1 label', 'Leave empty to hide.', cfg('rpc_button1_label', ''), (v) => put('rpc_button1_label', v)),
        inputRow('Button 1 URL', null, cfg('rpc_button1_url', ''), (v) => put('rpc_button1_url', v), { placeholder: 'https://…' }),
        inputRow('Button 2 label', 'Supports {platform}.', cfg('rpc_button2_label', ''), (v) => put('rpc_button2_label', v)),
      ]),
    ]),

    coverImagesCard(),

    el('div', { class: 'card' }, [
      el('h2', { text: 'Advanced' }),
      el('div', { style: 'margin-top:8px' }, [
        inputRow('Discord application ID', 'Overrides the built-in per-platform IDs. Leave empty unless you run your own Discord app.',
          cfg('discord_app_id', ''), (v) => put('discord_app_id', v.trim())),
      ]),
    ]),
  );
}

/**
 * Cover art on Discord.
 *
 * Two tiers, and the order is the point. Released music is looked up on a music
 * CDN, which needs no configuration and sends nothing but a track name. Only
 * music that is in no catalogue at all — local rips, demos, DJ sets — falls
 * through to publishing the file itself, which is what the switch here governs.
 */
function coverImagesCard() {
  return el('div', { class: 'card' }, [
    el('h2', { text: 'Cover images' }),
    el('div', { class: 'row-desc', style: 'margin-top:6px;max-width:none' },
      'Discord needs a URL for the artwork, and Windows only gives Vybecord a file on disk. '
      + 'For anything that was ever released the album is looked up on a public music CDN — Deezer, then Apple. '
      + 'Nothing leaves your machine but the track and artist name, and Discord loads those covers without trouble.'),
    el('div', { class: 'row-desc', style: 'margin-top:12px;max-width:none' },
      'That covers released music. Your own rips, demos and DJ sets are in no catalogue, so their artwork exists '
      + 'nowhere but this machine and Discord has nothing to show. For those — and only those — the artwork itself '
      + 'is published, never the audio and never anything already found above, so Discord can display it. '
      + 'Covers are stored by their content, which means the same artwork is one shared file rather than one per '
      + 'listener, and identifying metadata such as camera and GPS tags is stripped before anything is sent.'),
    el('div', { style: 'margin-top:8px' }, [
      toggleRow('Publish artwork that exists only on this PC',
        'Turn this off and local-only tracks fall back to the default placeholder.',
        cfg('art_upload_enabled', true) !== false, (v) => put('art_upload_enabled', v)),
      inputRow('Cover store', 'Leave as provided, or point this at your own if you would rather host it yourself.',
        cfg('art_upload_url', ''), (v) => put('art_upload_url', v.trim()),
        { placeholder: 'https://vybecord-art.vybecord.workers.dev' }),
    ]),
  ]);
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
  const card = el('div', { class: 'card' }, [
    el('h2', { text: 'Browser extension' }),
    el('div', { class: 'row-desc', style: 'margin-top:6px;max-width:none' },
      'Windows tells Vybecord what is playing but never which site a tab is on — a SoundCloud tab and a YouTube '
      + 'tab are indistinguishable to it. The optional extension reads the page itself and adds the site, the track '
      + 'link, the exact position, and live stream uptime. Everything works without it; this only adds detail.'),
    body,
  ]);

  const paint = async () => {
    let info;
    try {
      info = await api.extensionInfo();
    } catch (e) {
      body.replaceChildren(el('div', { class: 'row-desc', text: `Could not read the extension folder: ${e.message}` }));
      return;
    }

    const status = info.connected
      ? el('span', { class: 'badge accent', text: 'Connected' })
      : el('span', { class: 'badge', text: info.enabled ? 'Not detected' : 'Turned off' });

    const chromium = info.browsers.filter(b => b.family === 'chromium');
    const firefox = info.browsers.filter(b => b.family === 'firefox');

    body.replaceChildren(
      el('div', { style: 'display:flex;align-items:center;gap:10px;margin-top:12px' }, [
        el('span', { class: 'row-label', text: 'Status' }), status,
      ]),

      !info.available
        ? el('div', { class: 'row-desc', style: 'margin-top:10px', text: 'The extension folder is missing from this install.' })
        : el('div', {}, [
            el('div', { class: 'row-desc', style: 'margin-top:14px;max-width:none' },
              'A browser will not let an app install an extension for you, so this takes three steps. '
              + 'It stays installed afterwards.'),

            el('ol', { style: 'margin:12px 0 0 18px;font-size:12.5px;color:var(--text-tertiary);line-height:1.9' }, [
              el('li', { text: 'Open your browser’s extensions page and turn on Developer mode.' }),
              el('li', { text: 'Choose "Load unpacked".' }),
              el('li', { text: 'Pick the Vybecord extension folder.' }),
            ]),

            el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:14px' }, [
              el('button', {
                class: 'btn btn-primary', text: 'Open the extension folder',
                onclick: async () => { await api.revealExtension(); toast('Folder opened — pick it in "Load unpacked"', 'ok'); },
              }),
              el('button', {
                class: 'btn btn-sm', text: 'Copy the folder path',
                onclick: async () => { await api.copyExtensionPath(); toast('Path copied', 'ok'); },
              }),
            ]),

            chromium.length || firefox.length
              ? el('div', { style: 'margin-top:16px' }, [
                  el('div', { class: 'row-desc', style: 'max-width:none' },
                    'Browsers cannot be sent to their own settings pages from outside, so copy the address and paste it '
                    + 'into the address bar:'),
                  el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' },
                    info.browsers.map(b => el('button', {
                      class: 'btn btn-sm',
                      text: `Copy ${b.extensionsUrl}`,
                      title: `For ${b.name}`,
                      onclick: async () => { await api.copyExtensionsUrl(b.extensionsUrl); toast(`Copied — paste it into ${b.name}`, 'ok'); },
                    }))),
                ])
              : el('div', { class: 'row-desc', style: 'margin-top:14px' },
                  'No browser detected. Open yours, go to its extensions page, and load the folder above.'),

            firefox.length
              ? el('div', { class: 'row-desc', style: 'margin-top:12px;max-width:none' },
                  'Firefox loads it as a temporary add-on and drops it when it closes — pick manifest.json rather '
                  + 'than the folder there.')
              : null,
          ]),

      el('div', { style: 'margin-top:16px' }, [
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

// ── Lyrics ────────────────────────────────────────────────────────────────────

async function lyricsTab(body) {
  if (!langs) {
    try {
      langs = await api.translateLangs();
    } catch {
      langs = { en: 'English' };
    }
  }
  const langOptions = Object.entries(langs).map(([code, name]) => [code, name]);

  body.replaceChildren(
    el('div', { class: 'card' }, [
      el('h2', { text: 'Lyrics' }),
      el('div', { style: 'margin-top:8px' }, [
        toggleRow('Show lyrics', 'Off keeps the presence but stops fetching and displaying lyrics.',
          cfg('show_lyrics', true) !== false, (v) => put('show_lyrics', v)),
        toggleRow('Romanise Japanese / Korean', 'Converts kana and hangul to Latin script.',
          cfg('romanize_lyrics') === true, (v) => put('romanize_lyrics', v)),
        inputRow('Timing offset (ms)', 'Negative shows lines earlier, positive later.',
          cfg('lyrics_offset_ms', 0), (v) => put('lyrics_offset_ms', Math.max(-60000, Math.min(60000, v))), { type: 'number', min: -60000, max: 60000 }),
        inputRow('LRCLIB dump path', 'Optional offline database. Leave empty to use only online providers.',
          cfg('lrclib_dump_path', ''), (v) => put('lrclib_dump_path', v.trim()), { placeholder: 'C:\\…\\lrclib-dump.sqlite3' }),
      ]),
    ]),

    captionsCard(langOptions),

    el('div', { class: 'card' }, [
      el('h2', { text: 'Translation' }),
      el('div', { style: 'margin-top:8px' }, [
        toggleRow('Translate in the window', null, cfg('translate_lyrics') === true, (v) => put('translate_lyrics', v)),
        toggleRow('Translate on Discord', 'Sends the translated line to your presence too.',
          cfg('rpc_translate_lyrics') === true, (v) => put('rpc_translate_lyrics', v)),
        selectRow('Target language', null, cfg('translate_target_lang', 'en'), langOptions,
          (v) => put('translate_target_lang', v)),
      ]),
      el('div', { style: 'display:flex;gap:8px;margin-top:14px' }, [
        el('button', {
          class: 'btn btn-sm', text: 'Clear translation cache',
          onclick: async () => { await api.clearTranslationCache(); toast('Translation cache cleared', 'ok'); },
        }),
        el('button', {
          class: 'btn btn-sm', text: 'Clear lyrics cache',
          onclick: async () => {
            const res = await api.clearCache();
            toast(`Cleared ${res?.cleared ?? 0} cached tracks`, 'ok');
          },
        }),
      ]),
    ]),
  );
}

/**
 * YouTube captions, including whether they can actually run.
 *
 * Captions need yt-dlp, and without it the feature silently does nothing while
 * its switch still reads as on — indistinguishable from a bug. So the card leads
 * with whether the tool is present, and if it is not, offers the folder to drop
 * it into rather than asking the user to edit their PATH.
 */
function captionsCard(langOptions) {
  const state = el('div');
  const card = el('div', { class: 'card' }, [
    el('h2', { text: 'YouTube captions' }),
    el('div', { class: 'row-desc', style: 'margin-top:6px;max-width:none' },
      'A fallback for YouTube playback, used only when no synced lyrics exist for the track. '
      + 'With the browser extension the exact video is used; without it, the video is found by searching its title.'),
    state,
    el('div', { style: 'margin-top:8px' }, [
      toggleRow('Use captions as lyrics', null, cfg('cc_enabled', true) !== false, (v) => put('cc_enabled', v)),
      selectRow('Caption language', 'Automatic follows your system language, then English.',
        cfg('cc_lang', 'auto'), [['auto', 'Automatic'], ...langOptions], (v) => put('cc_lang', v)),
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
      state.replaceChildren(el('div', { style: 'display:flex;align-items:center;gap:10px;margin-top:12px' }, [
        el('span', { class: 'badge accent', text: 'yt-dlp ready' }),
        el('span', { class: 'row-desc', style: 'margin:0', text:
          st.source === 'bundled' ? 'Bundled with Vybecord — nothing to install'
          : st.source === 'PATH' ? 'Found on your PATH'
          : `Your own copy: ${st.command}` }),
      ]));
      return;
    }
    state.replaceChildren(
      el('div', {
        style: 'margin-top:12px;padding:11px 13px;border-radius:var(--r-sm);'
          + 'background:rgba(251,191,36,0.10);border:1px solid rgba(251,191,36,0.30);'
          + 'color:var(--amber);font-size:12.5px;line-height:1.55',
      }, 'yt-dlp is not installed, so captions cannot be fetched — the switch below has no effect until it is. '
        + 'It is a single file and needs no installer.'),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' }, [
        el('button', {
          class: 'btn btn-sm', text: 'Get yt-dlp',
          onclick: () => api.openExternal('https://github.com/yt-dlp/yt-dlp/releases/latest'),
        }),
        el('button', {
          class: 'btn btn-sm', text: 'Open the folder to put it in',
          onclick: async () => {
            const r = await api.revealCaptionsDir();
            toast(`Drop yt-dlp.exe here, then restart Vybecord`, 'ok');
            console.info('captions dir', r.dir);
          },
        }),
      ]),
      el('div', { class: 'row-desc', style: 'margin-top:8px;max-width:none' },
        'Download "yt-dlp.exe", put it in that folder, and restart Vybecord. Adding it to your PATH works too.'),
    );
  })();

  return card;
}

// ── Detection ─────────────────────────────────────────────────────────────────

function detectionTab(body) {
  const all = cfg('detect_all_media', true) !== false;

  body.replaceChildren(
    el('div', { class: 'card' }, [
      el('h2', { text: 'What to detect' }),
      el('div', { class: 'row-desc', style: 'margin-top:6px;max-width:none' },
        'Vybecord sees any app that publishes to the Windows media session API. These switches decide which of '
        + 'those it will announce.'),
      el('div', { style: 'margin-top:8px' }, [
        toggleRow('Detect everything', 'Off restricts detection to dedicated music apps (Spotify, Apple Music, Deezer, Tidal, Amazon Music).',
          all, (v) => put('detect_all_media', v)),
        toggleRow('Spotify', null, cfg('detect_spotify', true) !== false, (v) => put('detect_spotify', v)),
        toggleRow('Apple Music', null, cfg('detect_apple_music', true) !== false, (v) => put('detect_apple_music', v)),
        toggleRow('YouTube / YouTube Music', null, cfg('detect_youtube', true) !== false, (v) => put('detect_youtube', v)),
        toggleRow('SoundCloud', null, cfg('detect_soundcloud', true) !== false, (v) => put('detect_soundcloud', v)),
        toggleRow('Browser tabs', 'Anything else playing in Chrome, Firefox, Edge, Brave, Opera…',
          cfg('detect_browser', true) !== false, (v) => put('detect_browser', v)),
        toggleRow('Twitch', 'Live streams, reported by the extension.',
          cfg('detect_twitch', true) !== false, (v) => put('detect_twitch', v)),
        toggleRow('Kick', 'Live streams, reported by the extension.',
          cfg('detect_kick', true) !== false, (v) => put('detect_kick', v)),
        toggleRow('Other desktop apps', 'VLC, foobar2000, MusicBee, Deezer, Tidal, Bandcamp and friends.',
          cfg('detect_other_apps', true) !== false, (v) => put('detect_other_apps', v)),
      ]),
    ]),

    spicetifyCard(),

    extensionCard(),

    el('div', { class: 'card' }, [
      el('h2', { text: 'Spotify advertisements' }),
      el('div', { class: 'row-desc', style: 'margin-top:6px;max-width:none' },
        'Spotify does not mark ad breaks — it just swaps the track metadata for the advertiser’s. '
        + 'Every ad observed ran 30 seconds, while the shortest of 44 real tracks sampled ran 83, so Vybecord '
        + 'treats a Spotify track under a minute as an ad. A short track that belongs to the album already '
        + 'playing is left alone, so album interludes and skits still show. '
        + 'It depends on how Spotify fills these fields, so it may need adjusting if Spotify changes them.'),
      el('div', { style: 'margin-top:8px' }, [
        toggleRow('Hide the presence during ads', 'Your Discord status clears for the length of the ad, then comes back.',
          cfg('filter_spotify_ads', true) !== false, (v) => put('filter_spotify_ads', v)),
      ]),
    ]),
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

function appTab(body) {
  const updates = updateCard();

  body.replaceChildren(
    updates.card,

    el('div', { class: 'card' }, [
      el('h2', { text: 'Window' }),
      el('div', { style: 'margin-top:8px' }, [
        selectRow('Theme', null, cfg('theme', 'dark'), [['dark', 'Dark'], ['light', 'Light']], (v) => {
          document.documentElement.dataset.theme = v;
          put('theme', v);
        }),
        toggleRow('Close to tray', 'Closing the window hides it instead of quitting, so the presence keeps running.',
          cfg('minimize_to_tray', true) !== false, (v) => put('minimize_to_tray', v)),
        toggleRow('Show tray icon', 'Takes effect on the next start.',
          cfg('tray_enabled', true) !== false, (v) => put('tray_enabled', v)),
        toggleRow('Start hidden', 'Launch straight to the tray without showing the window.',
          cfg('start_minimized') === true, (v) => put('start_minimized', v)),
        toggleRow('Launch at sign-in', null, cfg('launch_on_startup') === true, (v) => put('launch_on_startup', v)),
      ]),
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: 'Performance' }),
      el('div', { style: 'margin-top:8px' }, [
        inputRow('Update interval (ms)', 'Track changes arrive instantly by event; this only paces progress updates. '
          + 'Lower is smoother, higher is lighter.',
          cfg('poll_interval_ms', 1000), (v) => put('poll_interval_ms', Math.max(400, Math.min(60000, v))),
          { type: 'number', min: 400, max: 60000 }),
      ]),
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: 'About' }),
      el('div', { class: 'muted', style: 'margin-top:10px;line-height:1.7' }, [
        el('div', { text: `Vybecord ${state.version || ''}`.trim() }),
        el('div', { text: 'Discord Rich Presence with real-time synced lyrics.' }),
      ]),
      el('div', { style: 'display:flex;gap:8px;margin-top:14px' }, [
        el('button', {
          class: 'btn btn-sm', text: 'Project page',
          onclick: () => api.openExternal('https://github.com/TheUnknownMurda/VybecordTS'),
        }),
      ]),
    ]),
  );

  return updates.dispose;
}
