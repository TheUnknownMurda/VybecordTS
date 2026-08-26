/**
 * Getting Spotify read properly: Spicetify plus the Vybecord extension.
 *
 * Setting it up is three steps, and the usual failure is stopping after one of
 * them — the file copied but never enabled, or enabled but never applied, both
 * of which look exactly like "it does not work". So one button does all three,
 * and the checklist below it exists to show which one is outstanding when
 * something has gone wrong, not as a set of instructions to follow by hand.
 *
 * The manual commands are still here, revealed only when the automatic run
 * fails. That is the moment they are worth reading — offering them upfront just
 * makes a solved problem look like homework.
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
      ...[].concat(body).filter(Boolean),
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
  /** Set when an automatic run fails, so the manual path appears only then. */
  let lastFailure = null;

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
    const ready = info.installed && info.bundled;

    const status = allDone
      ? el('span', { class: 'badge accent', text: 'Connected' })
      : el('span', { class: 'badge', text: info.extensionEnabled ? 'Waiting for Spotify' : 'Not set up' });

    /** The one button. Everything else on this card is explanation or fallback. */
    const setupButton = el('button', {
      class: 'btn btn-primary',
      text: info.extensionEnabled ? 'Run setup again' : 'Set up automatically',
      disabled: !ready,
      title: !info.installed
        ? 'Install Spicetify first — the command is below'
        : !info.bundled ? 'The extension file is missing from this install' : '',
      onclick: async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = 'Working… Spotify will restart';
        lastFailure = null;
        try {
          const res = await api.spicetifySetup();
          if (res.ok) {
            toast('Spicetify is set up — Spotify has been rebuilt', 'ok');
          } else {
            lastFailure = res.steps.find((s) => !s.ok) || null;
            toast(lastFailure ? `${lastFailure.label} failed` : 'Setup failed', 'err');
          }
        } catch (err) {
          lastFailure = { label: 'Setup', detail: err.message };
          toast(err.message, 'err');
        } finally {
          paint();
        }
      },
    });

    card.replaceChildren(
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Spotify via Spicetify' }),
        status,
      ]),

      el('div', { class: 'row-desc', style: 'margin-bottom:14px;max-width:none' },
        'Windows tells Vybecord that Spotify is playing, but not much else. Spicetify reads the Spotify client '
        + 'itself, so the track changes the instant it changes and brings the real album art, every artist, the '
        + 'playlist you are in, exact progress, and Spotify’s own synced lyrics. Spotify works without it — '
        + 'this is what makes it good.'),

      allDone
        ? el('div', { class: 'notice' }, [
            el('b', { text: 'All set. ' }),
            el('span', { text: 'Spicetify is reporting to Vybecord right now — nothing else to do.' }),
          ])
        : info.installed
          ? el('div', { class: 'notice' }, [
              el('span', { text: 'One button. It copies the extension, enables it and rebuilds the Spotify client — ' }),
              el('b', { text: 'Spotify will close and reopen' }),
              el('span', { text: '.' }),
            ])
          : el('div', { class: 'notice is-warn' }, [
              el('b', { text: 'Spicetify is not installed. ' }),
              el('span', { text: 'Run the command below in PowerShell first — it downloads and runs the official installer, so read it before you do.' }),
            ]),

      info.installed ? null : el('div', { style: 'margin:12px 0' }, [command(cmd.install || '')]),

      el('div', { class: 'guide-actions', style: 'margin:14px 0' }, [
        setupButton,
        el('button', { class: 'btn btn-sm', text: 'Check again', onclick: () => paint() }),
      ]),

      // The checklist is a report, not a set of instructions: it says which of
      // the three the button has managed so far.
      el('div', { class: 'guide' }, [
        step(info.installed, 'Spicetify installed',
          el('div', { class: 'guide-desc' },
            info.installed ? 'Found on this machine.' : 'Not found — use the command above.')),
        step(info.extensionCopied, 'Extension file in place',
          el('div', { class: 'guide-desc' },
            info.extensionCopied ? `In ${info.extensionsDir}` : 'Not copied yet.')),
        step(info.extensionEnabled, 'Enabled and applied',
          el('div', { class: 'guide-desc' }, info.extensionEnabled
            ? 'Spicetify loads it. If Spotify was open during setup, it has been restarted.'
            : 'Copying the file is not enough — Spicetify only loads what its config names.')),
      ]),

      // Shown only after a failed run, when it is finally the useful thing.
      lastFailure
        ? el('div', { class: 'notice is-warn', style: 'margin-top:14px' }, [
            el('b', { text: `${lastFailure.label} failed. ` }),
            el('span', { text: lastFailure.detail || 'No detail was reported.' }),
          ])
        : null,
      lastFailure
        ? el('div', { style: 'margin-top:10px' }, [
            el('div', { class: 'row-desc', style: 'max-width:none;margin-bottom:8px' },
              'To do it by hand instead: close Spotify, run both lines in PowerShell, then start Spotify again.'),
            command(cmd.enable || ''),
            command(cmd.apply || ''),
          ])
        : null,

      el('div', { class: 'guide-actions', style: 'margin-top:14px' }, [
        el('button', {
          class: 'btn btn-sm', text: 'Spicetify documentation',
          onclick: () => api.openExternal(SPICETIFY_DOCS),
        }),
        el('button', {
          class: 'btn btn-sm', text: 'Open the Extensions folder',
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

      allDone ? null : el('div', { class: 'row-desc', style: 'margin-top:12px;max-width:none' },
        'If a Spotify update ever undoes the patch, press the button again. '
        + 'Spicetify cannot patch the Microsoft Store build of Spotify — install Spotify from spotify.com if that is what you have.'),
    );
  }

  paint();
  return card;
}
