/**
 * kick — playback reporter.
 *
 * Carried over from the Tampermonkey userscript; see src/gm-shim.js for why.
 *
 * Why it asks Kick's API from the page
 * ------------------------------------
 * The requests below to Kick's API (kick.com/api, and web.kick.com/api for a
 * past broadcast) are the only ones this extension makes to anything other
 * than the desktop app, and they are the reason the README and
 * the privacy policy both carry an explicit Kick exception rather than a flat
 * "contacts only 127.0.0.1". The obvious tidy-up is to move them into the
 * desktop app, the way the equivalent Twitch lookup was moved to
 * src/core/twitch-source.ts.
 *
 * It does not work. Kick sits behind bot protection that answers HTTP 403
 * ("Request blocked by security policy") to every server-side request —
 * /api/v1 and /api/v2 alike, with any User-Agent, and for the plain channel
 * page HTML too. The official api.kick.com endpoint answers 401 without OAuth
 * credentials this project does not have. What makes the calls below work is
 * exactly what cannot be reproduced from Node: they come from a real browser,
 * from a Kick page the user already has open — same-origin, or, for
 * web.kick.com, let through by Kick's own CORS headers, as they are for the
 * page itself.
 *
 * They used to ask for the stream's start time and nothing else, while the
 * name, picture, title and liveness were read off the page — the first
 * element whose class contained "username", "avatar" or "live". That is
 * whatever the page renders first: a chatter, the sidebar, the viewer's own
 * picture. The same answer already carried all of it, so it is now the
 * source, and the page is read only if Kick stops answering.
 *
 * So they stay, and the docs tell the truth about them instead. Before moving
 * them, re-run those requests — if Kick ever serves them, the move is worth
 * making.
 */

(function() {
    'use strict';

    // ── Config ──
    const VYBECORD_URL = 'http://127.0.0.1:8888/api/kick';

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

    // ── State ──
    let pushTimer = null;
    let currentInterval = BASE_INTERVAL_MS;
    let consecutiveFails = 0;
    let streamStartTime = 0; // Track when stream started
    const STREAM_START_KEY = 'vybecord_kick_stream_start';

    // ── Helpers ──

    /**
     * Recover a persisted stream start time for `username`, if one was saved
     * earlier in this browser (Kick is a single-page app, so navigating
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

    // ── Kick's API ──

    /** First path segments that are Kick's own pages, not a channel. */
    const NOT_A_CHANNEL = new Set([
        'browse', 'categories', 'category', 'following', 'search', 'dashboard', 'settings',
        'subscriptions', 'messages', 'notifications', 'clips', 'videos', 'video', 'terms-of-service',
        'privacy-policy', 'community-guidelines', 'dmca-policy', 'about', 'login', 'signup',
        'kick-gift', 'contact', 'brand-assets', 'careers', 'help', 'drops', 'stream-key', 'vod',
    ]);

    const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const RE_CLIP = /^clip_[A-Za-z0-9]+$/;

    /** How long a channel's answer stands: a stream starting or ending shows within this. */
    const CHANNEL_TTL_MS = 45 * 1000;
    /** How long a failed request waits before it is tried again. */
    const RETRY_MS = 60 * 1000;
    /**
     * How long a new page waits for Kick's answer before the page itself is
     * read instead. The answer takes a fraction of this; the page, read any
     * sooner, is still the previous channel's.
     */
    const API_WAIT_MS = 3000;

    /**
     * Which page this is, from the URL alone.
     *
     *   /<channel>/videos/<id>     a past broadcast
     *   /<channel>/clips/<id>      a clip, as is /<channel>?clip=<id>
     *   /<channel>                 the channel, live or not
     */
    function pageFromUrl() {
        const parts = window.location.pathname.split('/').filter(Boolean);
        if (!parts[0] || NOT_A_CHANNEL.has(parts[0].toLowerCase()) || !/^[A-Za-z0-9_-]+$/.test(parts[0])) return null;
        const slug = parts[0];
        if (parts[1] === 'videos' && RE_UUID.test(parts[2] || '')) return { kind: 'vod', slug, id: parts[2] };
        const clip = parts[1] === 'clips' ? parts[2] : new URLSearchParams(window.location.search).get('clip');
        if (clip && RE_CLIP.test(clip)) return { kind: 'clip', slug, id: clip };
        return { kind: 'channel', slug, id: '' };
    }

    function channelUrl(slug) {
        return `/api/v1/channels/${encodeURIComponent(slug)}`;
    }

    function videoUrl(channelNumber, id) {
        return `https://web.kick.com/api/v1/channels/${encodeURIComponent(channelNumber)}/videos/${encodeURIComponent(id)}`;
    }

    /**
     * Kick's answer about what the tab shows: { status: 'ok' | 'missing' |
     * 'error', data }, or undefined while it is on its way.
     *
     * A past broadcast takes two. Kick's site now links them by ids that
     * /api/v1/video/<id> answers 404 to ("No query results"), and the site
     * itself no longer opens the ids that endpoint knows (October 2026). The
     * API Kick's own pages now use, on web.kick.com, does know them, filed
     * under the channel's number, which is in the channel's own answer. So
     * the channel is asked first, as it is on its page, and then the video.
     * The channel's answer alone is enough to show the video, without its
     * title, if that API does not answer: it is not the page's own origin,
     * and a browser may refuse the request.
     */
    function pageAnswer(page) {
        if (page.kind === 'clip') return apiAnswer(`/api/v2/clips/${encodeURIComponent(page.id)}`, page);
        const channel = apiAnswer(channelUrl(page.slug), page);
        if (page.kind === 'channel' || !channel || channel.status !== 'ok') return channel;
        const number = channel.data && channel.data.id;
        const video = number ? apiAnswer(videoUrl(number, page.id), page) : { status: 'error', data: null };
        if (!video || video.status === 'missing') return video;
        const found = video.status === 'ok' && video.data ? video.data.data : null;
        return { status: 'ok', data: { channel: channel.data, video: found || {} } };
    }

    /**
     * Answers per API URL: { at, status: 'ok' | 'missing' | 'error', data }.
     * A channel is asked again every CHANNEL_TTL_MS for its liveness and title;
     * a video or a clip does not change, so it is asked once.
     */
    const apiCache = new Map();
    const apiInFlight = new Set();

    /** A page as one string, to tell one page from another. */
    function pageId(page) {
        return page ? `${page.kind}|${page.slug}|${page.id}` : '';
    }

    function apiAnswer(url, page) {
        const cached = apiCache.get(url);
        const age = cached ? Date.now() - cached.at : Infinity;
        const due = !cached
            || (cached.status === 'error' && age > RETRY_MS)
            || (cached.status === 'ok' && url.startsWith('/api/v1/channels/') && age > CHANNEL_TTL_MS);
        if (due && !apiInFlight.has(url)) {
            apiInFlight.add(url);
            fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
                .then((res) => {
                    if (res.status === 404) return { status: 'missing', data: null };
                    if (!res.ok) return { status: 'error', data: null };
                    return res.json().then((data) => ({ status: data ? 'ok' : 'missing', data }));
                })
                .catch(() => ({ status: 'error', data: null }))
                .then((answer) => {
                    // A refresh that failed keeps the last good answer rather than
                    // throwing it away; it is retried after RETRY_MS like any other.
                    const prev = apiCache.get(url);
                    if (answer.status === 'error' && prev && prev.status === 'ok') prev.at = Date.now() - CHANNEL_TTL_MS + RETRY_MS;
                    else apiCache.set(url, { at: Date.now(), ...answer });
                    if (apiCache.size > 32) apiCache.delete(apiCache.keys().next().value);
                    apiInFlight.delete(url);
                    // Report the answer now rather than at the next beat; for a
                    // past broadcast's channel, that asks for the video now.
                    if (pageId(pageFromUrl()) === pageId(page)) periodicPush();
                });
        }
        return cached;
    }

    /** Kick writes times as "YYYY-MM-DD HH:MM:SS" in UTC; 0 for anything unusable. */
    function kickTime(s) {
        if (!s || typeof s !== 'string') return 0;
        const ms = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
        const now = Date.now();
        if (!ms || isNaN(ms) || ms > now + 60000 || ms < now - 30 * 24 * 60 * 60 * 1000) return 0;
        return ms;
    }

    function firstCategory(list) {
        return Array.isArray(list) && list[0] && list[0].name ? String(list[0].name) : '';
    }

    /** The page's video: position and length, for a past broadcast or a clip. */
    function playerState() {
        const v = document.querySelector('video');
        if (!v) return { position_ms: 0, duration_ms: 0, paused: true };
        return {
            position_ms: isFinite(v.currentTime) ? Math.round(v.currentTime * 1000) : 0,
            duration_ms: isFinite(v.duration) ? Math.round(v.duration * 1000) : 0,
            paused: v.paused || v.ended,
        };
    }

    /** What Kick's answer says this page is, in the shape the app takes. */
    function infoFromApi(page, data) {
        const info = {
            page_kind: page.kind,
            username: page.slug,
            display_name: '',
            followers: '',
            category: '',
            stream_title: '',
            profile_url: `https://kick.com/${page.slug}`,
            is_live: false,
            thumbnail_url: '',
            profile_picture_url: '',
            stream_start_time_ms: 0,
            last_title: '',
            video_id: page.kind === 'vod' ? page.id : '',
            clip_id: page.kind === 'clip' ? page.id : '',
            position_ms: 0,
            duration_ms: 0,
            paused: false,
            tab_id: TAB_ID
        };
        if (page.kind === 'channel') {
            const user = data.user || {};
            const live = data.livestream;
            info.username = data.slug || page.slug;
            info.profile_url = `https://kick.com/${info.username}`;
            info.display_name = user.username || '';
            info.profile_picture_url = user.profile_pic || '';
            info.is_live = !!(live && live.is_live !== false);
            if (info.is_live) {
                info.stream_title = live.session_title || '';
                info.category = firstCategory(live.categories);
                info.stream_start_time_ms = kickTime(live.start_time) || kickTime(live.created_at);
            } else {
                const last = Array.isArray(data.previous_livestreams) ? data.previous_livestreams[0] : null;
                info.last_title = (last && last.session_title) || '';
            }
            return info;
        }
        Object.assign(info, playerState());
        if (page.kind === 'vod') {
            // The channel's answer, and the video's from Kick's newer API: see pageAnswer.
            const channel = data.channel || {};
            const user = channel.user || {};
            const video = data.video || {};
            const ch = video.channel || {};
            info.username = ch.slug || channel.slug || page.slug;
            info.display_name = ch.username || user.username || '';
            info.profile_picture_url = user.profile_pic || '';
            info.stream_title = video.title || '';
            info.category = (video.category && video.category.name) || '';
            // In seconds here, where the old API gave milliseconds.
            if (!info.duration_ms && video.duration > 0) info.duration_ms = video.duration * 1000;
        } else {
            const clip = data.clip || {};
            const ch = clip.channel || {};
            info.username = ch.slug || page.slug;
            info.display_name = ch.username || '';
            info.profile_picture_url = ch.profile_picture || '';
            info.stream_title = clip.title || '';
            info.category = (clip.category && clip.category.name) || '';
            if (!info.duration_ms && clip.duration > 0) info.duration_ms = clip.duration * 1000;
        }
        info.profile_url = `https://kick.com/${info.username}`;
        return info;
    }

    // ── Captions ──

    /*
     * Kick's captions, read off the player the way the viewer sees them.
     *
     * Kick has two kinds, drawn in the same overlay, `[data-caption-source]`:
     * "manifest", captions the stream itself carries, and "browser", Chrome's
     * on-device speech recognition run on the stream's sound. Reading the
     * overlay covers both, and it is in step with the picture by construction.
     *
     * The stream's caption tracks could be fetched directly — they are WebVTT
     * playlists listed in the stream's own manifest — but they sit on another
     * host (live-video.net), which this extension would then be contacting and
     * the privacy policy would have to name, they run seconds ahead of the
     * delayed picture, and they would miss the speech-recognition kind
     * altogether. So nothing is fetched: with captions off in Kick's player
     * there is no overlay, and nothing is sent.
     *
     * The overlay is a window — the last words heard, rewritten as the
     * recogniser changes its mind — not a line. Turning it into lines is the
     * app's job (src/core/live-captions.ts); this only reports what it says,
     * when it changes, and once more when it has gone still.
     */
    const CAPTION_POLL_MS = 250;
    /** Fastest a change is reported: the app needs every few words, not every one. */
    const CAPTION_PUSH_MIN_MS = 500;
    /** Report once more after this long unchanged: the app takes a still overlay as final. */
    const CAPTION_SETTLE_MS = 1300;

    let captionText = '';
    let captionSource = '';
    let captionAt = 0;
    let lastPushAt = 0;
    let soonTimer = null;
    let settleTimer = null;

    /** The overlay's text, its lines joined by spaces; '' when there is none. */
    function readCaption() {
        const box = document.querySelector('[data-caption-source]');
        if (!box) return { text: '', source: '' };
        // One span per line for stream captions: textContent would run the
        // last word of one line into the first of the next.
        const parts = [];
        const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.nodeValue);
        return {
            text: parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400),
            source: box.getAttribute('data-caption-source') || '',
        };
    }

    /** Report soon, but never more often than CAPTION_PUSH_MIN_MS. */
    function pushSoon() {
        // While the app is not answering, the regular beat is enough.
        if (soonTimer || consecutiveFails > 0) return;
        const wait = Math.max(0, lastPushAt + CAPTION_PUSH_MIN_MS - Date.now());
        soonTimer = setTimeout(() => { soonTimer = null; periodicPush(); }, wait);
    }

    function watchCaptions() {
        setInterval(() => {
            const { text, source } = readCaption();
            if (text === captionText) return;
            captionText = text;
            if (source) captionSource = source;
            captionAt = Date.now();
            pushSoon();
            clearTimeout(settleTimer);
            settleTimer = setTimeout(pushSoon, CAPTION_SETTLE_MS);
        }, CAPTION_POLL_MS);
    }

    /**
     * The caption fields of a push: what the overlay says, and since when.
     *
     * Nothing from before this page opened: moving to another channel leaves
     * the last one's caption on screen until Kick's player switches over, and
     * it would go out under the new channel's name.
     */
    function captionFields() {
        const current = captionAt > 0 && captionAt >= pageSince;
        return {
            caption: current ? captionText : '',
            caption_source: captionSource,
            caption_at: current ? captionAt : 0,
            caption_age_ms: current ? Date.now() - captionAt : 0,
        };
    }

    function pushToVybecord(data) {
        if (!data) return;
        lastPushAt = Date.now();
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
                    console.error('[VybecordTS Kick] Push failed - connection error');
                    backoff();
                },
                ontimeout: function () {
                    console.error('[VybecordTS Kick] Push failed - timeout');
                    backoff();
                },
            });
        } catch (e) {
            console.error('[VybecordTS Kick] Push exception:', e);
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

    /**
     * Read the channel off the page, for when Kick's API does not answer.
     *
     * This is the old way, and it is a guess: each field is the first element
     * whose class looks right. It is kept only so that Kick refusing the API
     * costs a less reliable card rather than none.
     */
    function scrapeChannelFromDom() {
        const info = {
            username: '',
            display_name: '',
            followers: '',
            category: '',
            stream_title: '',
            profile_url: '',
            is_live: false,
            thumbnail_url: '',
            profile_picture_url: '',
            stream_start_time_ms: 0,
            page_kind: 'channel',
            tab_id: TAB_ID
        };

        // Try to get username from URL
        const urlMatch = window.location.pathname.match(/^\/([^\/]+)/);
        if (urlMatch && urlMatch[1]) {
            info.username = urlMatch[1];
            info.profile_url = `https://kick.com/${info.username}`;
        }

        // Try to get display name from page
        const displayNameEl = document.querySelector('[class*="username"], [class*="display-name"], h1, .streamer-name');
        if (displayNameEl) {
            info.display_name = displayNameEl.textContent.trim();
        }

        // Try to get follower count
        const followerEl = document.querySelector('[class*="follower"], [class*="follow-count"]');
        if (followerEl) {
            info.followers = followerEl.textContent.trim();
        }

        // Try to get category/game - the specific selectors first, and only
        // in the main column: a generic class match ran over the whole page
        // and could land on a sidebar card instead of the stream (see the
        // same block in twitch.js for what that looked like).
        let category = '';
        const categorySelectors = [
            'a[href*="/category/"]',
            '[data-testid*="category"]',
            '[data-testid*="game"]',
            '.game-name',
            '.stream-tag',
            '[class*="category"]',
            '[class*="game"]',
        ];
        const channelScope = document.querySelector('main') || document;
        for (const selector of categorySelectors) {
            const el = [...channelScope.querySelectorAll(selector)]
                .find(e => !e.closest('nav, aside, [class*="sidebar"], [class*="side-nav"]'));
            if (el && el.textContent.trim()) {
                const text = el.textContent.trim();
                // Filter out cookie/consent banner text
                if (!text.toLowerCase().includes('cookie') && 
                    !text.toLowerCase().includes('consent') &&
                    !text.toLowerCase().includes('necessary') &&
                    !text.toLowerCase().includes('functionality') &&
                    !text.toLowerCase().includes('these cookies') &&
                    text.length < 50) { // Categories are usually short
                    category = text;
                    break;
                }
            }
        }
        info.category = category;

        // Try to get stream title - more specific selectors to avoid picking up category or pin messages.
        // Kick doesn't expose one single reliable data-attribute for the title (unlike Twitch's
        // data-a-target="channel-stream-title"), so instead of stopping at the first element that
        // matches ANY selector — which can grab a shorter preview/echo of the title elsewhere on the
        // page (e.g. a recommended-channel card) — check every match across every selector and keep
        // the longest plausible one. Also check the `title`/`aria-label` attribute, since a
        // CSS-truncated (ellipsis) element still has the full text there even when textContent doesn't.
        let streamTitle = '';
        const titleSelectors = [
            '[class*="stream-title"]',
            '[class*="broadcast-title"]',
            '[class*="streamer-title"]',
            '.stream-title',
            '[data-testid*="stream-title"]',
            '[data-testid*="broadcast-title"]',
            'h1[class*="title"]',
            'h2[class*="title"]',
        ];

        // Also try to find title in specific container structures
        const containerSelectors = [
            '[class*="stream-info"]',
            '[class*="streamer-info"]',
            '[class*="broadcast-info"]',
        ];

        function isPlausibleTitle(text) {
            return !!text &&
                text !== info.category &&
                !text.toLowerCase().includes('log in') &&
                !text.toLowerCase().includes('pin') &&
                !text.toLowerCase().includes('earn') &&
                !text.toLowerCase().includes('jungle') &&
                text.length > 5;
        }

        function considerTitleCandidate(el) {
            const text = (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '').trim();
            if (isPlausibleTitle(text) && text.length > streamTitle.length) {
                streamTitle = text;
            }
        }

        for (const selector of titleSelectors) {
            document.querySelectorAll(selector).forEach(considerTitleCandidate);
        }

        // Fallback: try to find title within stream info containers
        if (!streamTitle) {
            for (const containerSel of containerSelectors) {
                const container = document.querySelector(containerSel);
                if (container) {
                    container.querySelectorAll('h1, h2, [class*="title"]').forEach(considerTitleCandidate);
                }
            }
        }

        info.stream_title = streamTitle;

        // Detect if stream is live
        info.is_live = !!document.querySelector('[class*="live"], [class*="online"]') ||
                       !document.querySelector('[class*="offline"]');

        // A start time for the Discord elapsed timer: when this tab first saw
        // the channel live, persisted so a reload or navigation keeps it.
        if (info.is_live) {
            if (streamStartTime === 0) {
                streamStartTime = getPersistedStreamStart(info.username) || Date.now();
                setPersistedStreamStart(info.username, streamStartTime);
            }
        } else {
            streamStartTime = 0;
            clearPersistedStreamStart();
        }
        info.stream_start_time_ms = streamStartTime;

        // Try to get thumbnail
        const thumbnailEl = document.querySelector('video') ||
                           document.querySelector('[class*="thumbnail"] img') ||
                           document.querySelector('img[src*="kick"]');
        if (thumbnailEl) {
            const src = thumbnailEl.getAttribute('src') || thumbnailEl.getAttribute('poster');
            if (src) {
                // Fix URLs that start with //
                info.thumbnail_url = src.startsWith('//') ? `https:${src}` : src;
            }
        }

        // Try to get profile picture - target the main streamer's avatar specifically
        let profilePicUrl = '';
        
        // Try to get profile picture from page metadata first
        const metaImage = document.querySelector('meta[property="og:image"]') || 
                         document.querySelector('meta[name="twitter:image"]');
        if (metaImage && metaImage.getAttribute('content')) {
            const metaSrc = metaImage.getAttribute('content');
            if (metaSrc && !metaSrc.includes('logo') && !metaSrc.includes('kick-logo')) {
                profilePicUrl = metaSrc.startsWith('//') ? `https:${metaSrc}` : metaSrc;
            }
        }
        
        // If not from meta, try to find the avatar within the main streamer section
        if (!profilePicUrl) {
            const mainStreamerSelectors = [
                // Avatar in the main channel header/section
                '[class*="channel-header"] img[class*="avatar"]',
                '[class*="streamer-header"] img[class*="avatar"]',
                '[class*="profile-header"] img[class*="avatar"]',
                // Avatar in the main stream card
                '[class*="stream-card"][class*="main"] img[class*="avatar"]',
                '[class*="streamer-card"][class*="main"] img[class*="avatar"]',
                // Avatar near the streamer name in the main content area
                'main img[class*="avatar"]',
                '[class*="channel-info"] img[class*="avatar"]',
                '[class*="streamer-info"] img[class*="avatar"]',
                // Kick-specific selectors for profile pictures
                'img[src*="cdn.kick.com"][alt*="avatar"]',
                'img[src*="cdn.kick.com"][class*="user"]',
                '[data-testid*="avatar"] img',
                '[class*="user-avatar"] img',
                '[class*="profile-picture"] img',
                '[class*="streamer-avatar"] img',
                // More specific Kick selectors
                'img[src*="cdn.kick.com"][class*="profile"]',
                'img[src*="cdn.kick.com"][class*="channel"]',
                'img.rounded-full',
                'img[class*="rounded"]',
            ];
            
            for (const selector of mainStreamerSelectors) {
                const el = document.querySelector(selector);
                if (el && el.getAttribute('src')) {
                    const src = el.getAttribute('src');
                    // Only use if it looks like a real profile picture
                    if (src && !src.includes('thumbnail') && !src.includes('preview') && !src.includes('placeholder') && !src.includes('logo')) {
                        profilePicUrl = src.startsWith('//') ? `https:${src}` : src;
                        break;
                    }
                }
            }
        }
        
        // Fallback: try more general selectors but avoid sidebar/lists
        if (!profilePicUrl) {
            const generalSelectors = [
                'img[class*="avatar"]',
                'img[alt*="avatar"]',
                '[class*="user-avatar"] img',
                '[class*="streamer-avatar"] img',
            ];
            
            for (const selector of generalSelectors) {
                const els = document.querySelectorAll(selector);
                for (const el of els) {
                    const src = el.getAttribute('src');
                    if (src && !src.includes('thumbnail') && !src.includes('preview') && !src.includes('placeholder') && !src.includes('logo')) {
                        // Check if this avatar is in a main content area (not sidebar/footer)
                        const parent = el.closest('aside, footer, [class*="sidebar"], [class*="recommended"], [class*="sidebar"]');
                        if (!parent) {
                            profilePicUrl = src.startsWith('//') ? `https:${src}` : src;
                            break;
                        }
                    }
                }
                if (profilePicUrl) break;
            }
        }
        
        // Final fallback: any image from cdn.kick.com that's not a thumbnail or logo
        if (!profilePicUrl) {
            const allImages = document.querySelectorAll('img[src*="cdn.kick.com"]');
            for (const img of allImages) {
                const src = img.getAttribute('src');
                if (src && !src.includes('thumbnail') && !src.includes('preview') && !src.includes('logo')) {
                    const parent = img.closest('aside, footer, [class*="sidebar"], [class*="recommended"], [class*="sidebar"]');
                    if (!parent) {
                        profilePicUrl = src.startsWith('//') ? `https:${src}` : src;
                        break;
                    }
                }
            }
        }
        
        info.profile_picture_url = profilePicUrl;

        return info;
    }

    // ── Core loop ──

    let pageKey = '';
    let pageSince = 0;

    /**
     * What this tab shows, or null when there is nothing to report (yet).
     *
     * Kick's answer when there is one. While it is on its way the tab reports
     * nothing — the page is still the previous channel's — and only if Kick
     * does not answer within API_WAIT_MS is the page read instead.
     */
    function getStreamerInfo() {
        const page = pageFromUrl();
        if (!page) return null;
        const key = pageId(page);
        if (key !== pageKey) {
            pageKey = key;
            pageSince = Date.now();
            streamStartTime = 0;
        }
        const answer = pageAnswer(page);
        if (answer && answer.status === 'ok') return infoFromApi(page, answer.data);
        // Kick says there is no such channel or video: not a page to report.
        if (answer && answer.status === 'missing') return null;
        if (Date.now() - pageSince < API_WAIT_MS) return null;
        if (page.kind === 'channel') return scrapeChannelFromDom();
        return Object.assign(infoFromApi(page, {}), { username: page.slug });
    }

    /*
     * One push per beat for whatever the tab is on — live, offline, a video.
     * Pushing only while live is what kept an offline channel off the card:
     * the tab said "offline" once, then went quiet and aged out.
     */
    function periodicPush() {
        const data = getStreamerInfo();
        if (!data || !data.username) return;
        pushToVybecord(Object.assign(data, captionFields()));
    }

    function init() {
        reschedule(BASE_INTERVAL_MS);
        watchCaptions();
        console.log('[VybecordTS] Kick integration initialized ✓');

        setTimeout(periodicPush, 500);
    }

    // Wait for page to be ready
    function onReady() {
        init();
        // Kick SPA: report a new page as soon as the URL changes.
        let lastUrl = location.href;
        new MutationObserver(() => {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                lastUrl = currentUrl;
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
