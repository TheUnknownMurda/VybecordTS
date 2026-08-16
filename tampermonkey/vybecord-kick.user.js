// ==UserScript==
// @name         VybecordTS — Kick Integration
// @namespace    https://github.com/vybecord
// @version      1.0.0
// @description  Push real-time Kick stream data to VybecordTS for Discord RPC
// @author       VybecordTS
// @match        https://kick.com/*
// @match        http://127.0.0.1:8888/setup*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
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
            document.documentElement.setAttribute('data-vybecord-kick', '1.0.0');
        // @run-at document-start can fire before <html> exists.
        if (document.documentElement) announce();
        else document.addEventListener('DOMContentLoaded', announce, { once: true });
        return;
    }

    // ── Config ──
    const VYBECORD_URL = 'http://127.0.0.1:8888/api/kick';
    const BASE_INTERVAL_MS = 2500;
    const MAX_INTERVAL_MS = 15000;
    const REVERIFY_INTERVAL_MS = 5 * 60 * 1000; // periodically re-confirm the start time against Kick's API

    // ── State ──
    let lastStreamerKey = '';
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

    let fetchingStartFor = ''; // guards against duplicate concurrent fetches
    let activeStreamer = ''; // guards a stale API response from overwriting a newer session
    let startVerified = false; // true once Kick's API has confirmed/corrected the current start time
    let verifyAttempts = 0;
    let verifiedAt = 0;

    /**
     * Ask Kick's own channel API for the livestream's real `created_at` so
     * the Discord elapsed timer is accurate even if the tab was opened
     * mid-stream — not just "time since this tab first noticed it's live".
     * Same-origin request: uses the browser's normal fetch() and the
     * user's existing Kick session, exactly like the page itself does,
     * so no extra permissions are needed for it.
     */
    function fetchKickStreamStart(username) {
        if (!username || fetchingStartFor === username) return;
        if (verifyAttempts >= 8) { startVerified = true; return; } // stop retrying forever on persistent failure
        verifyAttempts++;
        fetchingStartFor = username;
        fetch(`/api/v1/channels/${encodeURIComponent(username)}`, {
            headers: { Accept: 'application/json' },
            credentials: 'same-origin',
        })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                const createdAt = data && data.livestream && data.livestream.created_at;
                if (!createdAt) return;
                if (username !== activeStreamer) return; // session moved on, discard
                // Kick returns "YYYY-MM-DD HH:MM:SS" in UTC.
                const realStart = Date.parse(`${createdAt.replace(' ', 'T')}Z`);
                if (!realStart || isNaN(realStart)) return;
                const now = Date.now();
                // Sanity check — must be in the past and not absurdly old,
                // in case the API ever returns stale/unexpected data.
                if (realStart > now + 60000 || realStart < now - 30 * 24 * 60 * 60 * 1000) return;
                streamStartTime = realStart;
                setPersistedStreamStart(username, streamStartTime);
                startVerified = true;
                verifiedAt = Date.now();
                console.log('[VybecordTS Kick] Corrected stream start time from API ✓', new Date(realStart).toISOString());
            })
            .catch(() => { /* silently keep the estimated start time */ })
            .finally(() => {
                if (fetchingStartFor === username) fetchingStartFor = '';
            });
    }

    function pushToVybecord(data) {
        if (!data) return;
        console.log('[VybecordTS Kick] Pushing data:', data);
        try {
            GM_xmlhttpRequest({
                method: 'POST',
                url: VYBECORD_URL,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(data),
                timeout: 1500,
                onload: function () {
                    console.log('[VybecordTS Kick] Push successful ✓');
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

        // Try to get category/game - try multiple selectors
        let category = '';
        const categorySelectors = [
            '[class*="category"]',
            '[class*="game"]',
            '.stream-tag',
            'a[href*="/category/"]',
            '.game-name',
            '[data-testid*="category"]',
            '[data-testid*="game"]',
        ];
        for (const selector of categorySelectors) {
            const el = document.querySelector(selector);
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

        // Set stream start time when stream goes live — recover it from
        // persistent storage first so a reload/navigation doesn't reset
        // Discord's "time since stream started" display back to 0. A
        // persisted/provisional value is used immediately so the timer
        // isn't blocked on a network round trip, but it's ALWAYS re-verified
        // against Kick's own API (bounded retries) — a persisted value can
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
                fetchKickStreamStart(info.username);
            } else if (Date.now() - verifiedAt > REVERIFY_INTERVAL_MS) {
                // Periodic safety re-check: DOM-based is_live detection can
                // occasionally miss a real offline→online transition (e.g. if
                // the tab wasn't open to see it), so re-confirm against the
                // API every few minutes even once "verified".
                startVerified = false;
                verifyAttempts = 0;
                fetchKickStreamStart(info.username);
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
                console.log('[VybecordTS Kick] Profile picture from meta tag:', profilePicUrl);
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
                        console.log('[VybecordTS Kick] Profile picture from selector:', selector, profilePicUrl);
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
                            console.log('[VybecordTS Kick] Profile picture from general selector:', selector, profilePicUrl);
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
                        console.log('[VybecordTS Kick] Profile picture from fallback:', profilePicUrl);
                        break;
                    }
                }
            }
        }
        
        info.profile_picture_url = profilePicUrl;
        console.log('[VybecordTS Kick] Final profile picture URL:', profilePicUrl);

        console.log('[VybecordTS Kick] Extracted info:', info);
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

    // ── Hide cookie banner ──
    let cookieObserver = null;

    function hideCookieBanner() {
        // Inject CSS to hide cookie banners immediately
        const style = document.createElement('style');
        style.textContent = `
            /* Hide cookie consent banners */
            [id*="cookie"], [class*="cookie"], [id*="consent"], [class*="consent"],
            [id*="banner"], [class*="banner"], .cookie-banner, .consent-banner,
            .cookie-notice, .consent-notice, #onetrust-consent-sdk, #cookie-banner,
            [data-testid*="cookie"], [data-testid*="consent"],
            div[id*="onetrust"], div[class*="onetrust"],
            #ot-sdk-btn-floating, #onetrust-banner-sdk,
            .ot-sdk-container, .ot-floating-button,
            [role="dialog"][aria-label*="cookie"], [role="dialog"][aria-label*="consent"] {
                display: none !important;
                visibility: hidden !important;
                opacity: 0 !important;
                height: 0 !important;
                width: 0 !important;
                position: absolute !important;
                left: -9999px !important;
                pointer-events: none !important;
                z-index: -9999 !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
        console.log('[VybecordTS Kick] Cookie banner CSS injected');

        // Try to remove existing elements immediately
        removeCookieElements();

        // Set up observer when DOM is ready
        if (document.body) {
            startCookieObserver();
        } else {
            document.addEventListener('DOMContentLoaded', startCookieObserver);
        }

        // Also run periodically as fallback
        setInterval(removeCookieElements, 2000);
    }

    function startCookieObserver() {
        if (cookieObserver) return;
        
        cookieObserver = new MutationObserver(() => {
            removeCookieElements();
        });
        cookieObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
        console.log('[VybecordTS Kick] Cookie banner observer started');
    }

    function removeCookieElements() {
        const selectors = [
            '[id*="cookie"]',
            '[class*="cookie"]',
            '[id*="consent"]',
            '[class*="consent"]',
            '#onetrust-consent-sdk',
            '#cookie-banner',
            '#ot-sdk-btn-floating',
            '#onetrust-banner-sdk',
            '.ot-sdk-container',
            '.ot-floating-button',
            '[role="dialog"][aria-label*="cookie"]',
            '[role="dialog"][aria-label*="consent"]',
            'div[id*="onetrust"]',
            'div[class*="onetrust"]',
            // Kick specific selectors
            '[class*="Cookie"]',
            '[class*="cookie-banner"]',
            '[class*="consent-banner"]',
            '[id*="Cookie"]',
            '[id*="cookie-banner"]',
            '[id*="consent-banner"]'
        ];

        selectors.forEach(selector => {
            try {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => {
                    // Check if element is actually a cookie/consent banner by looking at text content
                    const text = el.textContent?.toLowerCase() || '';
                    if (text.includes('cookie') || text.includes('consent') || 
                        text.includes('necessary') || text.includes('functionality') ||
                        text.includes('these cookies') ||
                        selector.includes('cookie') || selector.includes('consent') ||
                        selector.includes('onetrust')) {
                        el.remove();
                        console.log('[VybecordTS Kick] Removed cookie element:', selector);
                    }
                });
            } catch (e) {
                // Ignore errors during DOM manipulation
            }
        });

        // Also check iframes for cookie banners
        try {
            const iframes = document.querySelectorAll('iframe');
            iframes.forEach(iframe => {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (iframeDoc) {
                        const iframeElements = iframeDoc.querySelectorAll('[id*="cookie"], [class*="cookie"], [id*="consent"], [class*="consent"]');
                        iframeElements.forEach(el => {
                            const text = el.textContent?.toLowerCase() || '';
                            if (text.includes('cookie') || text.includes('consent')) {
                                el.remove();
                                console.log('[VybecordTS Kick] Removed cookie element from iframe');
                            }
                        });
                    }
                } catch (e) {
                    // Cross-origin iframe access blocked - ignore
                }
            });
        } catch (e) {
            // Ignore errors
        }
    }

    function init() {
        reschedule(BASE_INTERVAL_MS);
        console.log('[VybecordTS] Kick integration initialized ✓');

        // Hide cookie banner immediately
        hideCookieBanner();

        setTimeout(() => {
            onStateChange();
        }, 500);
    }

    // Wait for page to be ready
    function onReady() {
        init();
        // Kick SPA: re-init on navigation
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
