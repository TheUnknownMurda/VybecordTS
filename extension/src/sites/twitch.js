/**
 * twitch — playback reporter.
 *
 * Carried over from the Tampermonkey userscript with its scraping logic intact;
 * see src/gm-shim.js for why.
 *
 * What this no longer does, and why
 * ---------------------------------
 * The userscript asked gql.twitch.tv for the stream's exact `createdAt`, so the
 * Discord elapsed timer read "live for 3 hours" rather than "live since you
 * opened the tab". That request is gone: as a content script it never worked
 * (see src/gm-shim.js), and restoring it would make this the one thing the
 * extension contacts besides the desktop app — which is the claim the store
 * listing and the published privacy policy both rest on.
 *
 * What this sends is therefore an estimate, and reportStreamStart() below says
 * so out loud rather than letting a wrong timer look like a right one. The
 * exact value is recovered elsewhere: the desktop app already makes outbound
 * requests to half a dozen music APIs, so src/core/twitch-source.ts runs the
 * gql.twitch.tv query there — at no extension permission at all — and prefers
 * its answer over the estimate below. Keep pushing the estimate regardless:
 * it is what the timer uses until that lookup lands, and if it fails.
 *
 * The same lookup now supplies the channel's name and picture. The page renders
 * the channel a second or more after the URL changes, and until then it holds
 * the sidebar, the chat and the viewer's own avatar in the top bar, which is
 * what the old "first element that matches" reads used to find. So this script
 * reads only what it can tie to the channel in the URL, sends nothing it
 * cannot, and leaves the rest to the app.
 */

(function() {
    'use strict';

    // ── Config ──
    const VYBECORD_URL = 'http://127.0.0.1:8888/api/twitch';

    /*
     * Which tab this is, so the desktop app can keep one entry per tab.
     *
     * Two tabs on two channels are two streams, and the app shows both; but
     * a tab that moves from one channel to the next must replace its own
     * entry rather than leave the old channel on a card until it ages out.
     * sessionStorage is per tab and survives the SPA's own navigation and a
     * reload, which is exactly the lifetime wanted.
     */
    const TAB_ID_KEY = 'vybecord_tab_id';
    let TAB_ID = '';
    try {
        TAB_ID = sessionStorage.getItem(TAB_ID_KEY) || '';
        if (!TAB_ID) {
            TAB_ID = Math.random().toString(36).slice(2, 10);
            sessionStorage.setItem(TAB_ID_KEY, TAB_ID);
        }
    } catch (e) {
        TAB_ID = Math.random().toString(36).slice(2, 10);
    }
    const BASE_INTERVAL_MS = 2500;
    const MAX_INTERVAL_MS = 15000;

    /**
     * First path segments that are Twitch's own pages, not a channel.
     *
     * The username is the first segment of the URL, and an older liveness check
     * read "live" wherever it found no offline marker — which none of these
     * pages has. Together that reported "twitch.tv/directory" as a live channel
     * called `directory`. It also sent the desktop app off to look up a channel
     * that does not exist, per page visited. `videos` is in the list as a first
     * segment only: /videos/<id> is a past broadcast, handled before the list.
     */
    const NOT_A_CHANNEL = new Set([
        'directory', 'settings', 'videos', 'subscriptions', 'following', 'friends',
        'wallet', 'drops', 'prime', 'downloads', 'jobs', 'turbo', 'store', 'search',
        'u', 'moderator', 'popout', 'payments', 'inventory', 'messages', 'broadcast',
        'dashboard', 'activate', 'products', 'bits', 'checkout', 'redeem', 'team',
        'legal', 'p', 'privacy', 'security', 'about', 'login', 'signup', 'collections',
    ]);

    // ── State ──
    let lastStreamerKey = '';
    let pushTimer = null;
    let currentInterval = BASE_INTERVAL_MS;
    let consecutiveFails = 0;
    let streamStartTime = 0; // Track when stream started
    const STREAM_START_KEY = 'vybecord_twitch_stream_start';

    // ── Helpers ──

    /**
     * Recover a persisted stream start time for `username`, if one was saved
     * earlier in this browser (Twitch is a single-page app, so navigating
     * between pages — or a manual reload — would otherwise reset the
     * in-memory streamStartTime and make the Discord elapsed timer jump
     * back to 0 even though the stream never stopped).
     */
    function getPersistedStreamStart(username) {
        try {
            const raw = GM_getValue(STREAM_START_KEY, '');
            if (!raw) return 0;
            const saved = JSON.parse(raw);
            if (saved && saved.username === username && saved.start) {
                return saved.start;
            }
        } catch (e) { /* ignore malformed storage */ }
        return 0;
    }

    function setPersistedStreamStart(username, start) {
        try {
            GM_setValue(STREAM_START_KEY, JSON.stringify({ username, start }));
        } catch (e) { /* ignore */ }
    }

    function clearPersistedStreamStart() {
        try {
            GM_setValue(STREAM_START_KEY, '');
        } catch (e) { /* ignore */ }
    }


    /**
     * Announce, once per stream, that the start time is an estimate.
     *
     * Both ways of arriving at one are wrong in a different direction, and
     * neither is detectable from inside the page — so the alternative to
     * saying this is a timer that is quietly off by hours and looks fine.
     */
    let reportedStartFor = '';
    function reportStreamStart(username, fromPersisted) {
        if (reportedStartFor === username) return;
        reportedStartFor = username;
        const how = fromPersisted
            ? 'restored from an earlier tab, and stale if that stream has since ended and restarted'
            : 'the moment this tab first saw the channel live, so it is late if the stream was already running';
        console.warn(
            `[VybecordTS Twitch] Stream start time is an estimate — ${how}. ` +
            'The desktop app replaces it with the real one from gql.twitch.tv, which this extension does not contact; see the header comment.',
        );
    }

    function pushToVybecord(data) {
        if (!data) return;
        try {
            GM_xmlhttpRequest({
                method: 'POST',
                url: VYBECORD_URL,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(data),
                timeout: 1500,
                onload: function () {
                    if (consecutiveFails > 0) { consecutiveFails = 0; reschedule(BASE_INTERVAL_MS); }
                },
                onerror: function () {
                    console.error('[VybecordTS Twitch] Push failed - connection error');
                    backoff();
                },
                ontimeout: function () {
                    console.error('[VybecordTS Twitch] Push failed - timeout');
                    backoff();
                },
            });
        } catch (e) {
            console.error('[VybecordTS Twitch] Push exception:', e);
            backoff();
        }
    }

    function backoff() {
        consecutiveFails++;
        const next = Math.min(BASE_INTERVAL_MS * Math.pow(1.5, consecutiveFails), MAX_INTERVAL_MS);
        if (next !== currentInterval) reschedule(next);
    }

    function reschedule(ms) {
        currentInterval = ms;
        if (pushTimer) clearInterval(pushTimer);
        pushTimer = setInterval(periodicPush, currentInterval);
    }

    /** `//cdn/...` as `https://cdn/...`; anything else unchanged. */
    function absolute(src) {
        return src && src.startsWith('//') ? `https:${src}` : (src || '');
    }

    /**
     * Which page this is, from the URL alone.
     *
     *   /videos/<id>             a past broadcast (Twitch's French UI: "rediffusion")
     *   /<channel>/clip/<slug>   a clip — clips.twitch.tv/<slug> redirects here
     *   /<channel>[/...]         the channel, live or not
     *
     * A past broadcast used to be ignored outright — `videos` is one of Twitch's
     * own sections, so it was skipped as "not a channel" — and the browser's
     * media session announced it instead, as YouTube.
     */
    function pageFromUrl() {
        const parts = window.location.pathname.split('/').filter(Boolean);
        if (parts[0] === 'videos' && /^\d+$/.test(parts[1] || '')) {
            return { kind: 'vod', username: '', videoId: parts[1], clipSlug: '' };
        }
        if (!parts[0] || NOT_A_CHANNEL.has(parts[0].toLowerCase())) return null;
        if (parts[1] === 'clip' && parts[2]) {
            return { kind: 'clip', username: parts[0], videoId: '', clipSlug: parts[2] };
        }
        // /<channel>/v/<id> is an old spelling of a past broadcast's address.
        if (parts[1] === 'v' && /^\d+$/.test(parts[2] || '')) {
            return { kind: 'vod', username: parts[0], videoId: parts[2], clipSlug: '' };
        }
        return { kind: 'channel', username: parts[0], videoId: '', clipSlug: '' };
    }

    /**
     * The channel's name as the page shows it, once the page shows this channel.
     *
     * The name is the `h1` in the channel's own block. Until Twitch has rendered
     * the channel the URL names, that block is missing or still the previous
     * channel's, so a name that is not the URL's login (ignoring case — that is
     * all a Twitch display name may change) is not this channel's and is not
     * used. A channel whose display name is written in another script never
     * matches; the app asks Twitch for that name instead.
     */
    function channelHeading(login) {
        const h1 = document.querySelector('.channel-root h1, #live-channel-stream-information h1');
        const text = h1 ? h1.textContent.trim() : '';
        if (!text) return '';
        if (login && text.toLowerCase() !== login.toLowerCase()) return '';
        return text;
    }

    /**
     * The channel's picture, only once channelHeading() has confirmed the page.
     *
     * Matched on the image's alt text, which Twitch sets to the channel's name.
     * The first avatar in the document is somebody else's — a followed channel
     * in the sidebar, or the signed-in viewer's own in the top bar — and that is
     * the picture the card used to open on.
     */
    function channelAvatar(name) {
        if (!name) return '';
        for (const img of document.querySelectorAll('.channel-root img.tw-image-avatar, #live-channel-stream-information img')) {
            if ((img.getAttribute('alt') || '').trim().toLowerCase() !== name.toLowerCase()) continue;
            if (img.closest('nav, [class*="side-nav"]')) continue;
            const src = img.getAttribute('src');
            if (src) return absolute(src);
        }
        return '';
    }

    /** The page's video: position and length, for a past broadcast or a clip. */
    function playerState() {
        const v = document.querySelector('.channel-root video, [data-a-target="video-player"] video, video');
        if (!v) return { position_ms: 0, duration_ms: 0, paused: true };
        return {
            position_ms: isFinite(v.currentTime) ? Math.round(v.currentTime * 1000) : 0,
            duration_ms: isFinite(v.duration) ? Math.round(v.duration * 1000) : 0,
            paused: v.paused || v.ended,
        };
    }

    /**
     * What this tab shows, or null when there is nothing to report yet.
     *
     * The name, title and category come only from the channel's own block, and
     * only once channelHeading() says it is this channel's — anything earlier is
     * left empty for the app to fill from Twitch. So is the picture.
     */
    function getStreamerInfo() {
        const page = pageFromUrl();
        if (!page) return null;

        const info = {
            page_kind: page.kind,
            username: page.username,
            display_name: '',
            followers: '',
            category: '',
            stream_title: '',
            profile_url: page.username ? `https://www.twitch.tv/${page.username}` : '',
            is_live: false,
            // Whether the page has rendered this channel yet; until it has,
            // is_live is not a reading, and the app knows not to weigh it.
            page_ready: false,
            thumbnail_url: '',
            profile_picture_url: '',
            stream_start_time_ms: 0,
            video_id: page.videoId,
            clip_slug: page.clipSlug,
            position_ms: 0,
            duration_ms: 0,
            paused: false,
            tab_id: TAB_ID
        };

        // A past broadcast's address carries no channel; the page's heading is
        // the only place it is written, and the app looks it up by id anyway.
        const name = channelHeading(page.username);
        info.display_name = name;
        info.page_ready = !!name;
        info.profile_picture_url = channelAvatar(name);

        if (page.kind !== 'channel') {
            Object.assign(info, playerState());
            if (name) {
                const title = document.querySelector('.channel-root [data-a-target="stream-title"], .channel-root h2[title]');
                if (title) info.stream_title = (title.getAttribute('title') || title.textContent || '').trim();
            }
            return info;
        }

        if (name) {
            /*
             * Live means the live player's layout, which Twitch marks on the
             * channel's root. The old check matched any class containing "live"
             * anywhere on the page — every live channel in the sidebar — and
             * read an offline channel as live. The app checks with Twitch too.
             */
            info.is_live = !!document.querySelector('.channel-root--live, #live-channel-stream-information [data-a-target="animated-channel-viewers-count"]');

            if (info.is_live) {
                const scope = document.querySelector('#live-channel-stream-information') || document.querySelector('.channel-root');
                const titleEl = scope && scope.querySelector('[data-a-target="stream-title"]');
                if (titleEl) info.stream_title = (titleEl.getAttribute('title') || titleEl.textContent || '').trim();
                /*
                 * The category, from the link Twitch itself marks as the game,
                 * inside the channel's own block. A search over the whole page
                 * once found the followed-channels sidebar first and put
                 * "xQcOfflineUse the Right Arrow Key to show more information."
                 * under every stream.
                 */
                const gameEl = scope && scope.querySelector('[data-a-target="stream-game-link"], a[href*="/directory/category/"]');
                const game = gameEl ? gameEl.textContent.trim() : '';
                if (game && game.length <= 64 && !game.includes('\n')) info.category = game;
            }
        }

        // Establish a start time for the Discord elapsed timer. Persisting it
        // matters because Twitch is a single-page app: navigating between pages,
        // or reloading, would otherwise reset the in-memory value and send the
        // timer back to 0 while the stream never stopped.
        if (info.is_live) {
            if (streamStartTime === 0) {
                const persisted = getPersistedStreamStart(info.username);
                streamStartTime = persisted || Date.now();
                setPersistedStreamStart(info.username, streamStartTime);
                reportStreamStart(info.username, !!persisted);
            }
        } else if (name) {
            // Reset when the page shows the stream offline — not merely before
            // the page has rendered, which would throw the estimate away on
            // every navigation.
            streamStartTime = 0;
            clearPersistedStreamStart();
            reportedStartFor = '';
        }
        info.stream_start_time_ms = streamStartTime;

        return info;
    }

    // ── Core loop ──

    /*
     * One push per beat for whatever the tab is on — live, offline, a video.
     *
     * Pushing only while live is what kept an offline channel off the card: the
     * tab said "offline" once, then went quiet and aged out. And a page that
     * has not finished rendering is still pushed, with the URL's login and
     * nothing else: the app holds a new channel back until Twitch has told it
     * who that is, so an empty name costs nothing, where a wrong one used to
     * reach Discord.
     */
    function periodicPush() {
        const data = getStreamerInfo();
        if (!data) return;
        // A different page from the last push resets the start estimate's owner.
        const pageKey = `${data.page_kind}|${data.username}|${data.video_id}|${data.clip_slug}`;
        if (pageKey !== lastStreamerKey) {
            lastStreamerKey = pageKey;
            if (data.page_kind !== 'channel') streamStartTime = 0;
        }
        pushToVybecord(data);
    }

    function init() {
        reschedule(BASE_INTERVAL_MS);
        console.log('[VybecordTS] Twitch integration initialized ✓');

        setTimeout(periodicPush, 500);
    }

    // Wait for page to be ready
    function onReady() {
        init();
        // Twitch SPA: report a new page as soon as the URL changes. The stream
        // start estimate belongs to the previous channel, so it goes too.
        let lastUrl = location.href;
        new MutationObserver(() => {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                lastUrl = currentUrl;
                streamStartTime = 0;
                reportedStartFor = '';
                setTimeout(periodicPush, 500);
            }
        }).observe(document, { subtree: true, childList: true });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        onReady();
    } else {
        document.addEventListener('DOMContentLoaded', onReady);
    }
})();
