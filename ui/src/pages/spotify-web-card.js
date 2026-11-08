/**
 * Spotify through the Web API — for people who will not install Spicetify.
 *
 * The user brings a Spotify app of their own: Spotify only runs a developer
 * app for five accounts and only while its owner has Premium, so one shared
 * Client ID could never serve everybody. Setting it up is four small steps,
 * listed in order; the card folds them away once they are done.
 *
 * Everything shown comes from the backend's status, never from what this card
 * last did. Settings redraws the whole panel on any config change, saving the
 * Client ID included, so a sign-in started from one copy of this card is often
 * finished on another. It polls while it is on screen, which is also how it
 * shows the device the account is playing on.
 */

import { el, toast } from '../util.js';
import { state, saveConfig } from '../state.js';

const api = window.vybecord;

const DASHBOARD = 'https://developer.spotify.com/dashboard';
const ACCOUNT_APPS = 'https://www.spotify.com/account/apps/';
const CLIENT_ID = /^[0-9a-f]{32}$/i;
const REFRESH_MS = 4000;
/** Warn this long before Spotify ends the sign-in. */
const ENDING_SOON_MS = 14 * 24 * 3600_000;

/** Electron wraps a handler's error in its own sentence; the handler's is the useful part. */
const plainError = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

/** A step in the set-up list, ticked once it is done. */
function step(done, title, body) {
  return el('div', { class: `guide-step ${done ? 'is-done' : ''}`.trim() }, [
    el('div', { class: 'guide-mark', text: done ? '✓' : '' }),
    el('div', { class: 'guide-body' }, [
      el('div', { class: 'guide-title', text: title }),
      ...[].concat(body).filter(Boolean),
    ]),
  ]);
}

export function spotifyWebCard() {
  const card = el('div', { class: 'card' });
  let timer = null;
  /** Only the newest refresh paints and schedules the next, so two never run in step. */
  let seq = 0;
  /** What was painted last: a repaint that changes nothing only loses a hover or a click. */
  let lastPainted = '';
  /** Kept across repaints, so a refresh does not throw away a half-typed ID. */
  let draftId = null;
  /** The set-up list's fold as the user left it; null follows the default. */
  let setupOpen = null;

  async function refresh() {
    const mine = ++seq;
    clearTimeout(timer);
    let info;
    try {
      info = await api.spotifyWebStatus();
    } catch (e) {
      if (mine !== seq || (card.dataset.painted && !card.isConnected)) return;
      paintFailure(plainError(e));
      lastPainted = '';
      return;
    }
    if (mine !== seq) return;
    // Drawn over by a Settings redraw: a newer copy of this card has taken over.
    if (card.dataset.painted && !card.isConnected) return;
    const snapshot = JSON.stringify(info);
    // Not while the Client ID is being typed: a repaint would take the field away.
    const typing = card.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT';
    if (snapshot !== lastPainted && !typing) {
      paint(info);
      lastPainted = snapshot;
      card.dataset.painted = '1';
    }
    timer = setTimeout(refresh, REFRESH_MS);
  }

  function paintFailure(message) {
    card.replaceChildren(
      el('div', { class: 'card-head' }, [el('h2', { text: 'Spotify without Spicetify' })]),
      el('div', { class: 'notice is-warn', text: `Could not check the Spotify sign-in: ${message}` }),
    );
  }

  function paint(info) {
    const pb = info.playback || { state: 'off', device: '', error: '' };
    const badge = info.signingIn ? el('span', { class: 'badge', text: 'Waiting for Spotify…' })
      : !info.configured ? el('span', { class: 'badge', text: 'Not set up' })
      : !info.signedIn ? el('span', { class: 'badge', text: 'Not connected' })
      : pb.state === 'standby' ? el('span', { class: 'badge', text: 'Standing by' })
      : pb.state === 'error' ? el('span', { class: 'badge', text: 'Needs attention' })
      : el('span', { class: 'badge accent', text: 'Connected' });

    const idInput = el('input', {
      type: 'text',
      value: draftId ?? info.clientId ?? state.config.spotify_client_id ?? '',
      placeholder: '32 letters and digits',
      spellcheck: 'false',
      autocomplete: 'off',
      oninput: (e) => { draftId = e.target.value; },
    });
    const saveId = async () => {
      const id = idInput.value.trim();
      if (!CLIENT_ID.test(id)) {
        toast('That is not a Client ID — it is 32 letters and digits, on your app’s page', 'err');
        return;
      }
      draftId = null;
      if (id.toLowerCase() === info.clientId) { toast('Already saved', 'ok'); return; }
      // Saving redraws Settings; the new card picks up from the backend.
      await saveConfig({ spotify_client_id: id });
      toast(info.signedIn ? 'Saved — sign in again with this app' : 'Saved — you can sign in now', 'ok');
    };

    const signInButton = (label, cls) => el('button', {
      type: 'button', class: cls, text: label,
      disabled: !info.configured,
      title: info.configured ? '' : 'Save your Client ID first',
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        // The call stays open until the browser answers, so show the waiting
        // state now rather than at the next refresh.
        setTimeout(refresh, 300);
        try {
          const res = await api.spotifyWebSignIn();
          if (res.ok) toast(res.user ? `Connected to Spotify as ${res.user}` : 'Connected to Spotify', 'ok');
        } catch (err) {
          toast(plainError(err), 'err');
        } finally {
          refresh();
        }
      },
    });
    const cancelButton = () => el('button', {
      type: 'button', class: 'btn', text: 'Cancel',
      onclick: async () => { await api.spotifyWebCancel(); refresh(); },
    });

    const steps = el('div', { class: 'guide' }, [
      step(info.configured, '1. Create a Spotify app', [
        el('div', { class: 'guide-desc' },
          'On Spotify’s developer dashboard, create an app. Any name and description will do. '
          + 'Where it asks which APIs you plan to use, tick Web API.'),
        el('div', { class: 'guide-actions', style: 'margin-top:8px' }, [
          el('button', { type: 'button', class: 'btn btn-sm', text: 'Open the dashboard', onclick: () => api.openExternal(DASHBOARD) }),
        ]),
      ]),
      step(info.configured, '2. Add this Redirect URI to it', [
        el('div', { class: 'guide-desc' }, 'Exactly as written — Spotify compares it character for character.'),
        el('div', { class: 'guide-cmd' }, [
          el('code', { text: info.redirectUri }),
          el('button', {
            type: 'button', class: 'btn btn-sm', text: 'Copy',
            onclick: async () => {
              try {
                // The app's clipboard call; it sits with Spicetify's for history.
                await api.spicetifyCopy(info.redirectUri);
                toast('Copied', 'ok');
              } catch (e) {
                toast(plainError(e), 'err');
              }
            },
          }),
        ]),
      ]),
      step(info.configured, '3. Paste its Client ID', [
        el('div', { class: 'guide-desc' }, 'On the app’s page, under Basic Information. There is no secret to copy — none is needed.'),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px' }, [
          el('div', { style: 'flex:1 1 240px;min-width:0' }, [idInput]),
          el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Save', onclick: saveId }),
          info.configured
            ? el('button', {
                type: 'button', class: 'btn btn-sm btn-danger', text: 'Remove',
                onclick: async () => {
                  draftId = null;
                  await api.spotifyWebSignOut();
                  await saveConfig({ spotify_client_id: '' });
                  toast('Client ID removed', 'ok');
                },
              })
            : null,
        ]),
      ]),
      step(info.signedIn, '4. Sign in', [
        el('div', { class: 'guide-desc' }, info.signedIn
          ? 'Done. To use a different app, save its Client ID above — you will be asked to sign in again.'
          : 'Press the button below. Spotify opens in your browser and asks whether this app may see what you '
            + 'are playing — that is all it can see.'),
      ]),
    ]);

    const premiumNote = el('div', { class: 'row-desc', style: 'margin-top:12px;max-width:none' },
      'Spotify only runs an app like this while its owner has Premium, and for up to five accounts — '
      + 'yours is the only one it needs. If Spotify refuses, add your Spotify e-mail under User Management '
      + 'in the app’s settings.');

    const head = [
      el('div', { class: 'card-head' }, [el('h2', { text: 'Spotify without Spicetify' }), badge]),
      el('div', { class: 'row-desc', style: 'margin-bottom:14px;max-width:none' },
        'No Spicetify? With Premium, Vybecord can read Spotify through Spotify’s API instead, using a Spotify app '
        + 'of your own. You get the real cover, every artist, the playlist, shuffle and repeat and the exact '
        + 'position, on any device you play on. Not Spotify’s own lyrics: only Spicetify can read those, so they '
        + 'come from the usual sources. While Spicetify is reporting, this stands by.'),
      statusNotice(info, pb),
    ];

    if (!info.signedIn) {
      // Setting up is the whole card: the steps in order, and the button
      // where step 4 says to press it.
      card.replaceChildren(...[
        ...head,
        el('div', { style: info.error || info.signingIn ? 'margin-top:14px' : '' }, [steps]),
        el('div', { class: 'guide-actions', style: 'margin-top:14px' }, [
          info.signingIn ? cancelButton() : signInButton('Sign in with Spotify', 'btn btn-primary'),
        ]),
        premiumNote,
      ].filter(Boolean));
      return;
    }

    // Signed in: the steps are done with, and folded away until the app's
    // Client ID needs changing.
    const setup = el('details', { style: 'margin-top:14px', open: setupOpen || null }, [
      el('summary', {
        class: 'row-label', style: 'cursor:pointer', text: 'Your Spotify app',
        onclick: () => { setupOpen = !setup.open; },
      }),
      el('div', { style: 'margin-top:10px' }, [steps]),
      premiumNote,
    ]);
    const ending = info.endsAt && info.endsAt - Date.now() < ENDING_SOON_MS;
    card.replaceChildren(...[
      ...head,
      el('div', { class: 'guide-actions', style: 'margin-top:14px' }, [
        // Signing in again is only the main action when it is needed: the
        // session is running out, or Spotify has stopped answering it.
        info.signingIn ? cancelButton()
          : ending || pb.state === 'error' ? signInButton('Sign in again', 'btn btn-primary')
          : null,
        el('button', {
          type: 'button', class: 'btn btn-sm', text: 'Manage access on Spotify',
          title: 'Spotify lists every app you have signed in to; removing this one there ends its access.',
          onclick: () => api.openExternal(ACCOUNT_APPS),
        }),
        el('button', {
          type: 'button', class: 'btn btn-sm btn-danger', text: 'Sign out',
          onclick: async () => {
            await api.spotifyWebSignOut();
            toast('Signed out of Spotify', 'ok');
            refresh();
          },
        }),
      ]),
      setup,
    ].filter(Boolean));
  }

  refresh();
  return card;
}

/** The one line that says where things stand, or what to do about it. */
function statusNotice(info, pb) {
  if (info.signingIn) {
    return el('div', { class: 'notice' }, [
      el('b', { text: 'Approve Vybecord on the page that opened in your browser. ' }),
      el('span', { text: 'If Spotify shows “INVALID_CLIENT: Invalid redirect URI”, the Redirect URI in your app is not exactly the one in step 2.' }),
    ]);
  }
  if (info.error) {
    return el('div', { class: 'notice is-warn' }, [el('span', { text: info.error })]);
  }
  if (!info.signedIn) return null;

  const who = info.user ? `Signed in as ${info.user}. ` : 'Signed in. ';
  const ends = info.endsAt ? new Date(info.endsAt) : null;
  const endsText = ends
    ? `Spotify ends the sign-in on ${ends.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}, six months after it began.`
    : '';
  const endingSoon = ends && ends.getTime() - Date.now() < ENDING_SOON_MS;

  let line;
  if (pb.state === 'standby') {
    line = info.standbyReason === 'detection_off'
      ? 'Spotify detection is switched off in Settings → Detection, so nothing is asked.'
      : 'Spicetify is reporting, and it says all of this and Spotify’s lyrics too. This takes over if it stops.';
  } else if (pb.state === 'playing') {
    line = pb.device ? `Reading Spotify — playing on ${pb.device}.` : 'Reading Spotify — playing.';
  } else if (pb.state === 'paused') {
    line = pb.device ? `Reading Spotify — paused on ${pb.device}.` : 'Reading Spotify — paused.';
  } else if (pb.state === 'error') {
    return el('div', { class: 'notice is-warn' }, [
      el('b', { text: who }),
      el('span', { text: pb.error || 'Spotify is not answering right now.' }),
    ]);
  } else {
    line = 'Nothing is playing on your Spotify account right now.';
  }

  return el('div', { class: `notice${endingSoon ? ' is-warn' : ''}` }, [
    el('b', { text: who }),
    el('span', { text: `${line} ` }),
    endsText ? el('span', { class: endingSoon ? '' : 'muted', text: endingSoon ? `${endsText} Sign in again before then.` : endsText }) : null,
  ]);
}
