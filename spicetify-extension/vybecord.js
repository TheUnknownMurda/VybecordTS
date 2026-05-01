// VybecordTS — Spicetify Extension
// Sends real-time track data to VybecordTS via HTTP POST.
// Install: spicetify config extensions vybecord.js && spicetify apply
//
// Advantages over SMTC:
//   - Event-driven (instant track change detection, no 400ms poll)
//   - Full metadata: Spotify ID, album art URL, all artists, Spotify URIs
//   - Accurate progress_ms (no SMTC delay compensation)
//   - Eliminates need for Deezer/iTunes/Last.fm metadata enrichment

(async function vybecord() {
  // Wait for Spicetify API to be available
  while (!(Spicetify?.Player?.addEventListener && Spicetify?.Player?.data)) {
    await new Promise(r => setTimeout(r, 200));
  }

  const ENDPOINT = 'http://127.0.0.1:8888/api/spicetify';
  const PROGRESS_INTERVAL_MS = 2000; // Sync progress every 2s (for drift correction)

  let progressTimer = null;
  let lastSentUri = '';
  let lastSentPlaying = null;

  /** Extract full track data from Spicetify Player. */
  function getTrackData() {
    const data = Spicetify.Player.data;
    if (!data?.item) return null;

    const item = data.item;
    const uri = item.uri || '';
    const trackId = uri.startsWith('spotify:track:') ? uri.slice(14) : '';

    // Collect all artists with their URIs
    const artists = (item.artists || []).map(a => ({
      name: a.name || '',
      uri: a.uri || '',
    }));
    const artistName = artists.map(a => a.name).join(', ') || item.metadata?.artist_name || '';
    const artistUri = artists[0]?.uri || '';

    // Album art: prefer largest available
    const images = item.images || [];
    let albumArtUrl = '';
    if (images.length > 0) {
      // Images are typically sorted smallest-first; take the last (largest)
      albumArtUrl = images[images.length - 1]?.url || images[0]?.url || '';
    }
    // Fallback to metadata image fields
    if (!albumArtUrl && item.metadata) {
      albumArtUrl = item.metadata.image_xlarge_url
        || item.metadata.image_large_url
        || item.metadata.image_url
        || '';
    }
    // Convert Spotify internal URIs to HTTPS URLs
    // Spicetify returns "spotify:image:ab67616d..." which Discord can't render
    if (albumArtUrl.startsWith('spotify:image:')) {
      albumArtUrl = 'https://i.scdn.co/image/' + albumArtUrl.slice(14);
    }

    // Build direct Spotify URLs (no search redirects)
    const spotifyUrl = trackId ? `https://open.spotify.com/track/${trackId}` : '';
    let artistUrl = '';
    if (artistUri.startsWith('spotify:artist:')) {
      artistUrl = `https://open.spotify.com/artist/${artistUri.slice(15)}`;
    }

    // Album direct URL
    const albumUri = item.album?.uri || '';
    const albumUrl = albumUri.startsWith('spotify:album:')
      ? `https://open.spotify.com/album/${albumUri.slice(14)}`
      : '';

    // Artist image — Spicetify exposes it in item.metadata
    let artistArtUrl = item.metadata?.artist_image
      || item.metadata?.['artist_image']
      || '';
    // Convert Spotify internal URI to HTTPS URL
    if (artistArtUrl.startsWith('spotify:image:')) {
      artistArtUrl = 'https://i.scdn.co/image/' + artistArtUrl.slice(14);
    }

    // Playback context (playlist, album, artist radio, etc.)
    const ctx = Spicetify.Player.data.context;
    let contextName = '';
    let contextUrl = '';
    let contextType = '';
    if (ctx?.uri) {
      const parts = ctx.uri.split(':');
      // Determine context type and build URL based on URI structure
      // Common patterns:
      //   spotify:playlist:{id}          → /playlist/{id}
      //   spotify:album:{id}             → /album/{id}
      //   spotify:artist:{id}            → /artist/{id}
      //   spotify:user:{uid}:collection  → /collection/tracks (Liked Songs)
      //   spotify:station:{id}           → no web URL
      //   spotify:search:{query}         → no stable URL
      if (parts[1] === 'user' && parts[3] === 'collection') {
        contextType = 'collection';
        contextUrl = 'https://open.spotify.com/collection/tracks';
      } else if (['playlist', 'album', 'artist'].includes(parts[1]) && parts[2]) {
        contextType = parts[1];
        contextUrl = `https://open.spotify.com/${parts[1]}/${parts[2]}`;
      } else {
        contextType = parts[1] || '';
        // No reliable web URL for station, search, etc.
      }
      // Context name from Spicetify metadata
      contextName = ctx.metadata?.context_description
        || ctx.metadata?.['context_description']
        || '';
    }

    return {
      track_id: trackId,
      uri: uri,
      track_name: item.name || item.metadata?.title || '',
      artist_name: artistName,
      album_name: item.album?.name || item.metadata?.album_title || '',
      album_art_url: albumArtUrl,
      album_url: albumUrl,
      duration_ms: item.duration?.milliseconds || Spicetify.Player.getDuration() || 0,
      progress_ms: Spicetify.Player.getProgress() || 0,
      is_playing: !Spicetify.Player.data.isPaused,
      spotify_url: spotifyUrl,
      artist_url: artistUrl,
      context_name: contextName,
      context_url: contextUrl,
      context_type: contextType,
      artist_art_url: artistArtUrl,
      is_shuffle: !!Spicetify.Player.getShuffle?.(),
      repeat_mode: [0, 1, 2].includes(Spicetify.Player.getRepeat?.())
        ? ['off', 'context', 'track'][Spicetify.Player.getRepeat()]
        : 'off',
    };
  }

  /** POST track data to VybecordTS. Fire-and-forget. */
  function send(data) {
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(() => { /* VybecordTS not running — ignore */ });
  }

  /** Handle song change — immediate push. */
  function onSongChange() {
    const data = getTrackData();
    if (!data) return;
    lastSentUri = data.uri;
    lastSentPlaying = data.is_playing;
    send(data);
  }

  /** Handle play/pause toggle — immediate push. */
  function onPlayPause() {
    const data = getTrackData();
    if (!data) return;
    // Only send if state actually changed (Spicetify may fire duplicates)
    const playing = data.is_playing;
    if (playing === lastSentPlaying && data.uri === lastSentUri) return;
    lastSentPlaying = playing;
    send(data);
  }

  /** Periodic progress sync (for lyrics drift correction). */
  function startProgressSync() {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      if (Spicetify.Player.data?.isPaused) return; // Skip when paused
      const data = getTrackData();
      if (data) send(data);
    }, PROGRESS_INTERVAL_MS);
  }

  // ── Wire events ──
  Spicetify.Player.addEventListener('songchange', onSongChange);
  Spicetify.Player.addEventListener('onplaypause', onPlayPause);
  startProgressSync();

  // ── Initial push (extension loaded while music is already playing) ──
  const initial = getTrackData();
  if (initial) {
    lastSentUri = initial.uri;
    lastSentPlaying = initial.is_playing;
    send(initial);
  }

  console.log('[VybecordTS] Spicetify extension loaded ✓');
})();
