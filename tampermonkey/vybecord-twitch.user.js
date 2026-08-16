// ==UserScript==
// @name         VybecordTS — Twitch Integration
// @namespace    https://github.com/vybecord
// @version      1.0.0
// @description  Push real-time Twitch stream data to VybecordTS for Discord RPC
// @author       VybecordTS
// @match        https://www.twitch.tv/*
// @match        http://127.0.0.1:8888/setup*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @connect      gql.twitch.tv
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ── Setup-page handshake ──
    // Announce ourselves to the VybecordTS setup page so it can confirm this
    // script is installed without the user having to go open a stream first.
    // None of the logic below applies to that page, so stop right here.
    if (location.hostname === '127.0.0.1' && location.pathname === '/setup') {
        const announce = () =>
            document.documentElement.setAttribute('data-vybecord-twitch', '1.0.0');
        // @run-at document-start can fire before <html> exists.
        if (document.documentElement) announce();
        else document.addEventListener('DOMContentLoaded', announce, { once: true });
        return;
    }

    // ── Config ──
    const VYBECORD_URL = 'http://127.0.0.1:8888/api/twitch';
    const BASE_INTERVAL_MS = 2500;
    const MAX_INTERVAL_MS = 15000;
    const REVERIFY_INTERVAL_MS = 5 * 60 * 1000; // periodically re-confirm the start time against Twitch's API

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

    let fetchingStartFor = ''; // guards against duplicate concurrent fetches
    let activeStreamer = ''; // guards a stale API response from overwriting a newer session
    let startVerified = false; // true once Twitch's API has confirmed/corrected the current start time
    let verifyAttempts = 0;
    let verifiedAt = 0;

    // Client-ID Twitch's own website (www.twitch.tv) bakes into its page
    // HTML and sends with every request to gql.twitch.tv — it's the public
    // identifier for unauthenticated, read-only queries (the same one used
    // by tools like Streamlink), not a private credential.
    const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

    /**
     * Ask Twitch's own public GraphQL API for the stream's real `createdAt`
     * so the Discord elapsed timer is accurate even if the tab was opened
     * mid-stream — not just "time since this tab first noticed it's live".
     * Uses GM_xmlhttpRequest to avoid CORS friction, same as the push to
     * the local VybecordTS server.
     */
    function fetchTwitchStreamStart(username) {
        if (!username || fetchingStartFor === username) return;
        if (verifyAttempts >= 8) { startVerified = true; return; } // stop retrying forever on persistent failure
        verifyAttempts++;
        fetchingStartFor = username;
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://gql.twitch.tv/gql',
            headers: {
                'Content-Type': 'application/json',
                'Client-Id': TWITCH_WEB_CLIENT_ID,
            },
            data: JSON.stringify({
                query: `query { user(login: "${username}") { stream { createdAt } } }`,
            }),
            timeout: 4000,
            onload: function (res) {
                if (fetchingStartFor === username) fetchingStartFor = '';
                try {
                    const body = JSON.parse(res.responseText);
                    const createdAt = body && body.data && body.data.user && body.data.user.stream && body.data.user.stream.createdAt;
                    if (!createdAt) return;
                    if (username !== activeStreamer) return; // session moved on, discard
                    const realStart = Date.parse(createdAt);
                    if (!realStart || isNaN(realStart)) return;
                    const now = Date.now();
                    // Sanity check — must be in the past and not absurdly old,
                    // in case the API ever returns stale/unexpected data.
                    if (realStart > now + 60000 || realStart < now - 30 * 24 * 60 * 60 * 1000) return;
                    streamStartTime = realStart;
                    setPersistedStreamStart(username, streamStartTime);
                    startVerified = true;
                    verifiedAt = Date.now();
                    console.log('[VybecordTS Twitch] Corrected stream start time from API ✓', new Date(realStart).toISOString());
                } catch (e) { /* silently keep the estimated start time */ }
            },
            onerror: function () { if (fetchingStartFor === username) fetchingStartFor = ''; },
            ontimeout: function () { if (fetchingStartFor === username) fetchingStartFor = ''; },
        });
    }

    function pushToVybecord(data) {
        if (!data) return;
        console.log('[VybecordTS Twitch] Pushing data:', data);
        try {
            GM_xmlhttpRequest({
                method: 'POST',
                url: VYBECORD_URL,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(data),
                timeout: 1500,
                onload: function () {
                    console.log('[VybecordTS Twitch] Push successful ✓');
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

        // Try to get username from URL
        const urlMatch = window.location.pathname.match(/^\/([^\/]+)/);
        if (urlMatch && urlMatch[1]) {
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

        // Detect if stream is live
        info.is_live = !!document.querySelector('[class*="live"], [class*="online"], [data-a-target="live-status"], [data-a-target="channel-status-text"]') ||
                       !document.querySelector('[class*="offline"], [data-a-target="offline-status"]');

        // Discord's "time since stream started" display back to 0. A
        // persisted/provisional value is used immediately so the timer
        // isn't blocked on a network round trip, but it's ALWAYS re-verified
        // against Twitch's own API (bounded retries) — a persisted value can
        // be from a previous, already-ended stream if this tab was closed
        // while the streamer went offline and later came back live, and we
        // would otherwise never notice the stream actually restarted.
        if (info.is_live) {
            activeStreamer = info.username;
            if (streamStartTime === 0) {
                streamStartTime = getPersistedStreamStart(info.username) || Date.now();
                setPersistedStreamStart(info.username, streamStartTime);
                startVerified = false;
                verifyAttempts = 0;
            }
            if (!startVerified) {
                fetchTwitchStreamStart(info.username);
            } else if (Date.now() - verifiedAt > REVERIFY_INTERVAL_MS) {
                // Periodic safety re-check: DOM-based is_live detection can
                // occasionally miss a real offline→online transition (e.g. if
                // the tab wasn't open to see it), so re-confirm against the
                // API every few minutes even once "verified".
                startVerified = false;
                verifyAttempts = 0;
                fetchTwitchStreamStart(info.username);
            }
        } else {
            // Reset when stream goes offline
            streamStartTime = 0;
            clearPersistedStreamStart();
            fetchingStartFor = '';
            activeStreamer = '';
            startVerified = false;
            verifyAttempts = 0;
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

        console.log('[VybecordTS Twitch] Extracted info:', info);
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
        // Always push when live (for status updates)
        const data = getStreamerInfo();
        if (data && data.is_live) {
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
