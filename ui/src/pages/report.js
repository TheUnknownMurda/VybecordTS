/**
 * Report — send a bug report to the maintainer.
 *
 * The destination is compiled into the build, not something each user sets up:
 * the point is that problems reach whoever can fix them. The renderer never
 * holds the webhook URL — it asks whether reporting is switched on and posts
 * through IPC.
 */

import { el, toast } from '../util.js';
import { state } from '../state.js';

const api = window.vybecord;

const CATEGORIES = [
  ['lyrics', 'Wrong or missing lyrics'],
  ['detection', 'A player is not detected'],
  ['presence', 'Discord presence problem'],
  ['ui', 'Window / interface'],
  ['crash', 'Crash or freeze'],
  ['other', 'Something else'],
];

const ISSUES_URL = 'https://github.com/TheUnknownMurda/VybecordTS/issues';

export function render(root) {
  const body = el('div', {}, [el('div', { class: 'empty', text: 'Loading…' })]);

  root.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('h1', { text: 'Report a problem' }),
      el('div', { class: 'sub', text: 'Goes straight to the maintainer. Nothing is attached beyond what you type and, if you leave it on, the track playing right now.' }),
    ]),
    body,
  );

  // Whether reporting works is a property of the build, so it is asked once.
  api.bugReportAvailable()
    .then((ok) => body.replaceChildren(ok ? formCard() : unavailableCard()))
    .catch(() => body.replaceChildren(unavailableCard()));
}

function formCard() {
  const summary = el('input', { type: 'text', placeholder: 'One line: what went wrong?', maxlength: 256 });
  const category = el('select', {}, CATEGORIES.map(([v, t]) => el('option', { value: v, text: t })));
  const details = el('textarea', { rows: 8, maxlength: 2000, placeholder: 'What were you doing? What did you expect instead?' });
  const includeTrack = el('input', { type: 'checkbox', checked: true });
  const send = el('button', { class: 'btn btn-primary', text: 'Send report' });

  send.addEventListener('click', async () => {
    if (!summary.value.trim()) return toast('A summary is required', 'err');
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      const t = state.track;
      await api.sendBugReport({
        summary: summary.value.trim(),
        category: category.value,
        details: details.value.trim() || undefined,
        track: includeTrack.checked && t
          ? { name: t.track_name, artist: t.artist_name, album: t.album_name, platform: t.media_source }
          : null,
        lang: navigator.language,
        timestamp: new Date().toISOString(),
      });
      toast('Report sent — thank you', 'ok');
      summary.value = '';
      details.value = '';
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      send.disabled = false;
      send.textContent = 'Send report';
    }
  });

  return el('div', { class: 'card' }, [
    el('label', { class: 'field' }, [el('span', { text: 'Summary' }), summary]),
    el('label', { class: 'field' }, [el('span', { text: 'Category' }), category]),
    el('label', { class: 'field' }, [el('span', { text: 'Details (optional)' }), details]),
    el('div', { class: 'row' }, [
      el('div', {}, [
        el('div', { class: 'row-label', text: 'Include the current track' }),
        el('div', { class: 'row-desc', text: 'Attaches the title, artist, album and platform — usually the fastest way to reproduce a lyrics bug.' }),
      ]),
      el('label', { class: 'switch' }, [includeTrack, el('span', { class: 'track' }), el('span', { class: 'thumb' })]),
    ]),
    el('div', { style: 'margin-top:14px' }, [send]),
  ]);
}

/**
 * Shown when the build carries no webhook — a copy built from source without
 * BUG_REPORT_WEBHOOK set. GitHub is the fallback rather than a dead end.
 */
function unavailableCard() {
  return el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h2', { text: 'In-app reporting is off in this build' })]),
    el('div', { class: 'row-desc', style: 'margin-bottom:14px;max-width:none' },
      'This copy of Vybecord was built without a reporting endpoint, so the form is not available here. '
      + 'Opening an issue on GitHub reaches the same place.'),
    el('button', {
      class: 'btn btn-primary', text: 'Open GitHub issues',
      onclick: () => api.openExternal(ISSUES_URL),
    }),
  ]);
}
