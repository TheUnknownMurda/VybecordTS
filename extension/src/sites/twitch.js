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
 */

(function() {
    'use strict';

    // ── Config ──
    const VYBECORD_URL = 'http://127.0.0.1:8888/api/twitch';
    const BASE_INTERVAL_MS = 2500;
    const MAX_INTERVAL_MS = 15000;

    /**
     * First path segments that are Twitch's own pages, not a channel.
     *
     * The username is the first segment of the URL, and is_live below defaults
     * to true when it finds no offline marker — which none of these pages has.
     * Together that reported "twitch.tv/directory" as a live channel called
     * `directory`. It also sent the desktop app off to look up a stream start
     * for a channel that does not exist, once a minute, per page visited.
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

    /**
     * Extract streamer information from the page.
     */
    function getStreamerInfo() {
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
            stream_start_time_ms: 0
        };

        // Try to get username from URL, unless the page is one of Twitch's own
        // (see NOT_A_CHANNEL) — leaving it empty makes the push a no-op rather
        // than a stream named after the section you are browsing.
        const urlMatch = window.location.pathname.match(/^\/([^\/]+)/);
        if (urlMatch && urlMatch[1] && !NOT_A_CHANNEL.has(urlMatch[1].toLowerCase())) {
            info.username = urlMatch[1];
            info.profile_url = `https://www.twitch.tv/${info.username}`;
        }

        // Try to get display name from page
        const displayNameEl = document.querySelector('[class*="channel-header"], [class*="display-name"], h1, .streamer-name, [data-a-target="channel-header-user"]');
        if (displayNameEl) {
            info.display_name = displayNameEl.textContent.trim();
        }

        // Try to get follower count
        const followerEl = document.querySelector('[class*="follower"], [class*="follow-count"], [data-a-target="channel-followers-count"]');
        if (followerEl) {
            info.followers = followerEl.textContent.trim();
        }

        // Try to get category/game - try multiple selectors
        let category = '';
        const categorySelectors = [
            '[class*="category"]',
            '[class*="game"]',
            '.stream-tag',
            'a[href*="/directory/game/"]',
            '.game-name',
            '[data-a-target="stream-game-link"]',
            '[data-a-target="game-title"]',
        ];
        for (const selector of categorySelectors) {
            const el = document.querySelector(selector);
            if (el && el.textContent.trim()) {
                category = el.textContent.trim();
                break;
            }
        }
        info.category = category;

        // Try to get stream title - more specific selectors to avoid picking up category or "For You"
        let streamTitle = '';
        const titleSelectors = [
            '[data-a-target="channel-stream-title"]',
            '[data-a-target="stream-title"]',
            '[class*="stream-title"]',
            '[class*="broadcast-title"]',
            '.stream-title',
        ];
        for (const selector of titleSelectors) {
            const el = document.querySelector(selector);
            if (el && el.textContent.trim()) {
                // Avoid picking up category text or "For You"
                const text = el.textContent.trim();
                if (text && text !== info.category && text !== 'For You' && text.length > 5) {
                    streamTitle = text;
                    break;
                }
            }
        }
        info.stream_title = streamTitle;

        // Detect if stream is live. A page with no channel (see NOT_A_CHANNEL)
        // can never be, and has to be excluded explicitly: the fallback below
        // reads "live" whenever it finds no offline marker, and Twitch's own
        // pages have none.
        info.is_live = !!info.username && (
            !!document.querySelector('[class*="live"], [class*="online"], [data-a-target="live-status"], [data-a-target="channel-status-text"]') ||
            !document.querySelector('[class*="offline"], [data-a-target="offline-status"]')
        );

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
        } else {
            // Reset when stream goes offline
            streamStartTime = 0;
            clearPersistedStreamStart();
            reportedStartFor = '';
        }
        info.stream_start_time_ms = streamStartTime;

        // Try to get thumbnail
        const thumbnailEl = document.querySelector('video') ||
                           document.querySelector('[class*="thumbnail"] img') ||
                           document.querySelector('img[src*="twitch"]');
        if (thumbnailEl) {
            const src = thumbnailEl.getAttribute('src') || thumbnailEl.getAttribute('poster');
            if (src) info.thumbnail_url = src;
        }

        // Try to get profile picture - target the main streamer's avatar specifically
        let profilePicUrl = '';
        
        // First, try to find the avatar within the main streamer section (not in sidebar/lists)
        const mainStreamerSelectors = [
            // Avatar in the main channel header/section
            '[class*="channel-header"] img[class*="avatar"]',
            '[class*="streamer-header"] img[class*="avatar"]',
            '[data-a-target="channel-header-user"] img',
            '[data-a-target="user-avatar"] img',
            '.channel-header__avatar img',
            // Avatar in the main stream card
            '[class*="stream-card"][class*="main"] img[class*="avatar"]',
            '[class*="streamer-card"][class*="main"] img[class*="avatar"]',
            // Avatar near the streamer name in the main content area
            'main img[class*="avatar"]',
            '[class*="channel-info"] img[class*="avatar"]',
            '[class*="streamer-info"] img[class*="avatar"]',
        ];
        
        for (const selector of mainStreamerSelectors) {
            const el = document.querySelector(selector);
            if (el && el.getAttribute('src')) {
                const src = el.getAttribute('src');
                // Only use if it looks like a real profile picture
                if (src && !src.includes('thumbnail') && !src.includes('preview') && !src.includes('placeholder')) {
                    profilePicUrl = src.startsWith('//') ? `https:${src}` : src;
                    break;
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
                'img.tw-avatar',
            ];
            
            for (const selector of generalSelectors) {
                const els = document.querySelectorAll(selector);
                for (const el of els) {
                    const src = el.getAttribute('src');
                    if (src && !src.includes('thumbnail') && !src.includes('preview') && !src.includes('placeholder')) {
                        // Check if this avatar is in a main content area (not sidebar/footer)
                        const parent = el.closest('aside, footer, [class*="sidebar"], [class*="recommended"], [class*="browse"], [class*="directory"]');
                        if (!parent) {
                            profilePicUrl = src.startsWith('//') ? `https:${src}` : src;
                            break;
                        }
                    }
                }
                if (profilePicUrl) break;
            }
        }
        
        // Final fallback: any image from Twitch CDN that's not a thumbnail
        if (!profilePicUrl) {
            const allImages = document.querySelectorAll('img[src*="static-cdn.jtvnw.net"], img[src*="twitch"]');
            for (const img of allImages) {
                const src = img.getAttribute('src');
                if (src && !src.includes('thumbnail') && !src.includes('preview')) {
                    const parent = img.closest('aside, footer, [class*="sidebar"], [class*="recommended"], [class*="browse"], [class*="directory"]');
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

    function onStateChange() {
        const data = getStreamerInfo();
        if (!data || !data.username) return;

        const streamerKey = `${data.username}|${data.is_live}`;

        if (streamerKey !== lastStreamerKey) {
            lastStreamerKey = streamerKey;
            pushToVybecord(data);
        }
    }

    function periodicPush() {
        // Detect state changes
        onStateChange();
        // Always push when live (for status updates). No username means the page
        // is not a channel at all, so there is nothing to report.
        const data = getStreamerInfo();
        if (data && data.is_live && data.username) {
            pushToVybecord(data);
        }
    }

    function init() {
        reschedule(BASE_INTERVAL_MS);
        console.log('[VybecordTS] Twitch integration initialized ✓');

        setTimeout(() => {
            onStateChange();
        }, 500);
    }

    // Wait for page to be ready
    function onReady() {
        init();
        // Twitch SPA: re-init on navigation
        let lastUrl = location.href;
        new MutationObserver(() => {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                lastUrl = currentUrl;
                setTimeout(onStateChange, 500);
            }
        }).observe(document, { subtree: true, childList: true });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        onReady();
    } else {
        document.addEventListener('DOMContentLoaded', onReady);
    }
})();
