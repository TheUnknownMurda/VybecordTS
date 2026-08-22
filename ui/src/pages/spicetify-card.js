/**
 * Getting Spotify read properly: Spicetify plus the Vybecord extension.
 *
 * Written as a checklist rather than prose because the install has three steps
 * and the usual failure is stopping after one of them — the file copied but
 * never enabled, or enabled but never applied, both of which look exactly like
 * "it does not work". Each step reports its own state, so it is obvious which
 * one is outstanding.
 */

import { el, toast } from '../util.js';

const api = window.vybecord;

const SPICETIFY_DOCS = 'https://spicetify.app/docs/getting-started';

/** A step in the checklist, with its own done/pending marker. */
function step(done, title, body) {
  return el('div', { class: `guide-step ${done ? 'is-done' : ''}`.trim() }, [
    el('div', { class: 'guide-mark', text: done ? '✓' : '' }),
    el('div', { class: 'guide-body' }, [
      el('div', { class: 'guide-title', text: title }),
      ...[].concat(body),
    ]),
  ]);
}

/** A command line with a copy button — nobody should retype these. */
function command(text) {
  return el('div', { class: 'guide-cmd' }, [
    el('code', { text }),
    el('button', {
      class: 'btn btn-sm', text: 'Copy',
      onclick: async () => {
        try {
          await api.spicetifyCopy(text);
          toast('Copied', 'ok');
        } catch (e) {
          toast(e.message, 'err');
        }
      },
    }),
  ]);
}

export function spicetifyCard() {
  const card = el('div', { class: 'card' });

  async function paint() {
    let info;
    try {
      info = await api.spicetifyInfo();
    } catch (e) {
      card.replaceChildren(
        el('div', { class: 'card-head' }, [el('h2', { text: 'Spotify via Spicetify' })]),
        el('div', { class: 'notice is-warn', text: `Could not check Spicetify: ${e.message}` }),
      );
      return;
    }

    const cmd = info.commands || {};
    const allDone = info.connected;

    const status = allDone
      ? el('span', { class: 'badge accent', text: 'Connected' })
      : el('span', { class: 'badge', text: info.extensionEnabled ? 'Waiting for Spotify' : 'Not set up' });

    card.replaceChildren(
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Spotify via Spicetify' }),
        status,
      ]),

      el('div', { class: 'row-desc', style: 'margin-bottom:14px;max-width:none' },
        'Windows tells Vybecord that Spotify is playing, but not much else. Spicetify reads the Spotify client '
        + 'itself, so the track changes the instant it changes and brings the real album art, every artist, the '
        + 'playlist you are in, and exact progress. Spotify works without it — this is what makes it good.'),

      allDone
        ? el('div', { class: 'notice' }, [
            el('b', { text: 'All set. ' }),
            el('span', { text: 'Spicetify is reporting to Vybecord right now — nothing else to do.' }),
          ])
        : el('div', { class: 'notice' }, [
            el('span', { text: 'Three steps, once. Run the commands in ' }),
            el('b', { text: 'PowerShell' }),
            el('span', { text: ', with Spotify closed for the last one.' }),
          ]),

      el('div', { class: 'guide' }, [
        step(info.installed, 'Install Spicetify', [
          el('div', { class: 'guide-desc' }, info.installed
            ? 'Found on this machine.'
            : 'Paste this into PowerShell. It is the official installer from spicetify.app.'),
          info.installed ? null : command(cmd.install || ''),
        ].filter(Boolean)),

        step(info.extensionCopied, 'Add the Vybecord extension', [
          el('div', { class: 'guide-desc' }, info.extensionCopied
            ? `Copied into ${info.extensionsDir}`
            : 'Vybecord ships the extension file — this drops it into Spicetify’s Extensions folder for you.'),
          el('div', { class: 'guide-actions' }, [
            el('button', {
              class: `btn btn-sm ${info.extensionCopied ? '' : 'btn-primary'}`.trim(),
              text: info.extensionCopied ? 'Copy it again' : 'Add the extension',
              disabled: !info.bundled,
              title: info.bundled ? '' : 'The extension file is missing from this install',
              onclick: async (e) => {
                e.target.disabled = true;
                try {
                  await api.spicetifyInstall();
                  toast('Extension added — now enable it below', 'ok');
                } catch (err) {
                  toast(err.message, 'err');
                } finally {
                  paint();
                }
              },
            }),
            el('button', {
              class: 'btn btn-sm', text: 'Open the folder',
              onclick: async () => {
                try {
                  const r = await api.spicetifyReveal();
                  toast(`Opened ${r.dir}`, 'ok');
                } catch (err) {
                  toast(err.message, 'err');
                }
              },
            }),
          ]),
        ]),

        step(info.extensionEnabled, 'Turn it on and rebuild Spotify', [
          el('div', { class: 'guide-desc' }, info.extensionEnabled
            ? 'Spicetify is set to load it. If Spotify was open, restart it.'
            : 'Copying the file is not enough — Spicetify only loads what its config names. '
              + 'Close Spotify, run both lines, then start Spotify again.'),
          info.extensionEnabled ? null : command(cmd.enable || ''),
          info.extensionEnabled ? null : command(cmd.apply || ''),
        ].filter(Boolean)),
      ]),

      el('div', { class: 'guide-actions', style: 'margin-top:14px' }, [
        el('button', { class: 'btn btn-sm', text: 'Check again', onclick: () => paint() }),
        el('button', {
          class: 'btn btn-sm', text: 'Spicetify documentation',
          onclick: () => api.openExternal(SPICETIFY_DOCS),
        }),
      ]),

      allDone ? null : el('div', { class: 'row-desc', style: 'margin-top:12px;max-width:none' },
        'If a Spotify update ever undoes the patch, run the last two commands again. '
        + 'Spicetify cannot patch the Microsoft Store build of Spotify — install Spotify from spotify.com if that is what you have.'),
    );
  }

  paint();
  return card;
}
