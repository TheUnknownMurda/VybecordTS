/** History — the persistent listening log, plus an aggregate "wrapped" view. */

import { el, artUrl, fmtDate, fmtDuration, platformInfo, toast, BLANK_ART } from '../util.js';

const api = window.vybecord;
const PAGE_SIZE = 50;

export function render(root) {
  const body = el('div');
  let tab = 'log';

  const tabs = el('div', { class: 'tabs' }, [
    tabBtn('Log', 'log'),
    tabBtn('Wrapped', 'wrapped'),
  ]);

  root.replaceChildren(
    el('div', { class: 'page-head' }, [
      el('h1', { text: 'History' }),
      el('div', { class: 'sub', text: 'Every track the app has seen, with how long you actually listened.' }),
    ]),
    tabs,
    body,
  );

  function tabBtn(label, id) {
    return el('button', {
      class: `tab ${id === 'log' ? 'active' : ''}`.trim(),
      text: label,
      onclick: (e) => {
        tab = id;
        [...tabs.children].forEach((c) => c.classList.toggle('active', c === e.target));
        show();
      },
    });
  }

  function show() {
    body.replaceChildren(el('div', { class: 'empty', text: 'Loading…' }));
    (tab === 'log' ? renderLog : renderWrapped)(body);
  }
  show();
}

async function renderLog(body) {
  let offset = 0;
  let total = 0;
  // Pins every page to the log as it stood on the first call. Without it, a
  // track finishing mid-scroll shifts the whole log down by one and the next
  // page repeats the row already on screen.
  let anchor;
  const list = el('div', { class: 'list' });
  const more = el('button', {
    class: 'btn', text: 'Load more', style: 'margin-top:12px',
    onclick: () => load(),
  });
  const counter = el('div', { class: 'muted' });

  body.replaceChildren(el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [el('h2', { text: 'Recently played' }), counter]),
    list,
    more,
  ]));

  async function load() {
    more.disabled = true;
    more.textContent = 'Loading…';
    try {
      const res = await api.getHistory(PAGE_SIZE, offset, anchor);
      const entries = res?.entries || [];
      anchor = res?.anchor ?? anchor;
      total = res?.total ?? total;
      offset += entries.length;

      if (!entries.length && offset === 0) {
        list.replaceChildren(el('div', { class: 'empty', text: 'Nothing listened to yet.' }));
      } else {
        list.append(...entries.map(row));
      }
      counter.textContent = total ? `${offset} of ${total}` : '';
      more.style.display = offset >= total ? 'none' : '';
    } catch (e) {
      toast(`Could not load history: ${e.message}`, 'err');
    } finally {
      more.disabled = false;
      more.textContent = 'Load more';
    }
  }
  await load();
}

function row(e) {
  const [label, glyph] = platformInfo(e.source);
  const src = artUrl(e.art);
  return el('div', { class: 'item' }, [
    el('img', { class: 'item-art', src: src || BLANK_ART, alt: '' }),
    el('div', { class: 'item-body' }, [
      el('div', { class: 'item-title', text: e.track }),
      el('div', { class: 'item-sub', text: `${e.artist}${e.album ? ` · ${e.album}` : ''}` }),
    ]),
    el('div', { class: 'item-meta', title: `${label} · listened ${fmtDuration(e.listenedMs)}` },
      `${glyph} ${fmtDate(e.startedAt)}`),
  ]);
}

async function renderWrapped(body) {
  let days = 0;
  // Ranges differ by an order of magnitude in how long they take to crunch, so
  // clicking two in a row can land the slower answer last. The token makes the
  // range that was picked last the one that paints, not the one that finishes last.
  let token = 0;
  const content = el('div');

  const picker = el('div', { class: 'card-head' }, [
    el('h2', { text: 'Wrapped' }),
    el('div', { class: 'item-actions' }, [
      rangeBtn('7 days', 7), rangeBtn('30 days', 30), rangeBtn('1 year', 365), rangeBtn('All time', 0),
    ]),
  ]);

  body.replaceChildren(el('div', { class: 'card' }, [picker, content]));

  function rangeBtn(label, value) {
    return el('button', {
      class: `btn btn-sm ${value === 0 ? 'btn-primary' : ''}`.trim(),
      text: label,
      onclick: (e) => {
        days = value;
        [...e.target.parentElement.children].forEach((c) => c.classList.toggle('btn-primary', c === e.target));
        load();
      },
    });
  }

  async function load() {
    const mine = ++token;
    content.replaceChildren(el('div', { class: 'empty', text: 'Crunching…' }));
    let w;
    try {
      w = await api.getWrapped(days || undefined);
    } catch (e) {
      if (mine !== token) return;
      content.replaceChildren(el('div', { class: 'empty', text: `Could not compute: ${e.message}` }));
      return;
    }
    if (mine !== token) return;
    if (!w || !w.totalTracks) {
      content.replaceChildren(el('div', { class: 'empty', text: 'Not enough history for this range yet.' }));
      return;
    }

    content.replaceChildren(
      el('div', { class: 'grid grid-3', style: 'margin-bottom:20px' }, [
        tile(fmtDuration(w.totalListenedMs), 'Time listened'),
        tile(String(w.totalTracks), 'Tracks played'),
        tile(String(w.uniqueTracks), 'Unique tracks'),
        tile(String(w.uniqueArtists), 'Unique artists'),
        tile(String(w.activeDays), 'Active days'),
        tile(fmtDuration(w.avgDailyMs), 'Daily average'),
      ]),
      el('div', { class: 'grid grid-2' }, [
        el('div', {}, [
          el('div', { class: 'muted', style: 'margin-bottom:8px', text: 'Top tracks' }),
          el('div', { class: 'list' }, (w.topTracks || []).map((t, i) => el('div', { class: 'item' }, [
            el('div', { class: 'item-rank', text: String(i + 1) }),
            el('img', { class: 'item-art', src: artUrl(t.art) || BLANK_ART, alt: '' }),
            el('div', { class: 'item-body' }, [
              el('div', { class: 'item-title', text: t.name }),
              el('div', { class: 'item-sub', text: t.artist }),
            ]),
            el('div', { class: 'item-meta', text: fmtDuration(t.totalMs) }),
          ]))),
        ]),
        el('div', {}, [
          el('div', { class: 'muted', style: 'margin-bottom:8px', text: 'Top artists' }),
          el('div', { class: 'list' }, (w.topArtists || []).map((a, i) => el('div', { class: 'item' }, [
            el('div', { class: 'item-rank', text: String(i + 1) }),
            el('div', { class: 'item-body' }, [
              el('div', { class: 'item-title', text: a.name }),
              el('div', { class: 'item-sub', text: `${a.plays} plays` }),
            ]),
            el('div', { class: 'item-meta', text: fmtDuration(a.totalMs) }),
          ]))),
        ]),
      ]),
    );
  }
  await load();
}

function tile(value, label) {
  return el('div', { class: 'tile' }, [
    el('div', { class: 'tile-value', text: value }),
    el('div', { class: 'tile-label', text: label }),
  ]);
}
