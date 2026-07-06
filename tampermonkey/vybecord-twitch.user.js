// ==UserScript==
// @name         VybecordTS — Twitch Integration
// @namespace    https://github.com/vybecord
// @version      1.0.0
// @description  Push real-time Twitch stream data to VybecordTS for Discord RPC
// @author       VybecordTS
// @match        https://www.twitch.tv/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ── Config ──
    const VYBECORD_URL = 'http://127.0.0.1:8888/api/twitch';
    const BASE_INTERVAL_MS = 2500;
    const MAX_INTERVAL_MS = 15000;

    // ── State ──
    let lastStreamerKey = '';
    let pushTimer = null;
    let currentInterval = BASE_INTERVAL_MS;
    let consecutiveFails = 0;

    // ── Helpers ──

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
            profile_picture_url: ''
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

        // Try to get stream title - more specific selectors to avoid picking up category
        let streamTitle = '';
        const titleSelectors = [
            '[class*="stream-title"]',
            '[class*="broadcast-title"]',
            'h2',
            '.stream-title',
            '[data-a-target="stream-title"]',
            '[data-a-target="channel-stream-title"]',
        ];
        for (const selector of titleSelectors) {
            const el = document.querySelector(selector);
            if (el && el.textContent.trim()) {
                // Avoid picking up category text
                const text = el.textContent.trim();
                if (text && text !== info.category) {
                    streamTitle = text;
                    break;
                }
            }
        }
        info.stream_title = streamTitle;

        // Detect if stream is live
        info.is_live = !!document.querySelector('[class*="live"], [class*="online"], [data-a-target="live-status"]') ||
                       !document.querySelector('[class*="offline"], [data-a-target="offline-status"]');

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
