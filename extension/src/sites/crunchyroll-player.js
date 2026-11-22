/**
 * crunchyroll-player — the half of the Crunchyroll script that runs inside
 * the player's frame.
 *
 * Crunchyroll's older player plays in a frame from static.crunchyroll.com,
 * which the watch page around it cannot look into, the two being different
 * sites. This runs in that frame and tells the watch page's script
 * (sites/crunchyroll.js) what the video is doing and what its subtitles say,
 * four times a second, by a message to that page and nowhere else. It sends
 * nothing to the app itself: the watch page knows the episode, and reports
 * for both.
 *
 * Others' code looks for the video in the page first and in the frame after,
 * which player is current not being certain. With the player drawn in the
 * page itself, there is no such frame and this never runs.
 */

(function () {
  'use strict';

  // In the player's frame only, and only under Crunchyroll's own watch page.
  if (window.top === window) return;
  const PARENT_ORIGIN = 'https://www.crunchyroll.com';
  const LOOK_MS = 250;

  const { playerVideo, playerSubtitles, nativeSubtitles } = vybecordFilmPage.util;

  /*
   * The video: the largest with media, which is how others' code finds it
   * among the names the player has had (#player0, #player_html5_api,
   * #bitmovinplayer-video-null).
   */
  function look() {
    try {
      const video = playerVideo(document);
      if (video) {
        const subtitle = playerSubtitles(document) || nativeSubtitles(video);
        window.parent.postMessage({
          type: 'vybecord-crunchyroll-player',
          paused: video.paused,
          ended: video.ended,
          currentTime: isFinite(video.currentTime) ? video.currentTime : 0,
          duration: isFinite(video.duration) && video.duration > 0 ? video.duration : 0,
          subtitle: subtitle.slice(0, 400),
        }, PARENT_ORIGIN);
      }
    } catch (e) {
      // A player halfway through loading: look again next time.
    } finally {
      setTimeout(look, LOOK_MS);
    }
  }

  look();
})();
