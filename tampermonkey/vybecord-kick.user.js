// ==UserScript==
// @name         VybecordTS — Kick Integration
// @namespace    https://github.com/vybecord
// @version      1.0.0
// @description  Push real-time Kick stream data to VybecordTS for Discord RPC
// @author       VybecordTS
// @match        https://kick.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ── Config ──
    const VYBECORD_URL = 'http://127.0.0.1:8888/api/kick';
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
            profile_picture_url: ''
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
            '[data-testid*="stream-title"]',
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
        info.is_live = !!document.querySelector('[class*="live"], [class*="online"]') ||
                       !document.querySelector('[class*="offline"]');

        // Try to get thumbnail
        const thumbnailEl = document.querySelector('video') ||
                           document.querySelector('[class*="thumbnail"] img') ||
                           document.querySelector('img[src*="kick"]');
        if (thumbnailEl) {
            const src = thumbnailEl.getAttribute('src') || thumbnailEl.getAttribute('poster');
            if (src) info.thumbnail_url = src;
        }

        // Try to get profile picture - more specific Kick selectors
        let profilePicUrl = '';
        const profilePicSelectors = [
            'img[class*="avatar"]',
            'img[alt*="avatar"]',
            'img[src*="kick.com"]',
            'img[src*="profile"]',
            '[class*="user-avatar"] img',
            '[class*="streamer-avatar"] img',
            'img[src*="cdn.kick.com"]',
        ];
        for (const selector of profilePicSelectors) {
            const el = document.querySelector(selector);
            if (el && el.getAttribute('src')) {
                const src = el.getAttribute('src');
                // Prefer images that look like profile pictures (not thumbnails)
                if (src && !src.includes('thumbnail') && !src.includes('preview')) {
                    profilePicUrl = src;
                    break;
                }
                // Fallback to any image if no better match
                if (!profilePicUrl && src) {
                    profilePicUrl = src;
                }
            }
        }
        info.profile_picture_url = profilePicUrl;

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

    function init() {
        reschedule(BASE_INTERVAL_MS);
        console.log('[VybecordTS] Kick integration initialized ✓');

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
