// VybecordTS — Spicetify Extension
// Sends real-time track data to VybecordTS via HTTP POST.
// Install: spicetify config extensions vybecord.js && spicetify apply
//
// Advantages over SMTC:
//   - Event-driven (instant track change detection, no 400ms poll)
//   - Full metadata: Spotify ID, album art URL, all artists, Spotify URIs
//   - Accurate progress_ms (no SMTC delay compensation)
//   - Eliminates need for Deezer/iTunes metadata enrichment
//   - Spotify's own timed lyrics, which only the client itself can read

(async function vybecord() {
  // Guard against a double load — the native install (spicetify config extensions)
  // and the Marketplace "Installed" entry both inject this file. First one wins.
  if (window.__vybecordLoaded) {
    console.log('[VybecordTS] Already loaded — skipping duplicate instance.');
    return;
  }
  window.__vybecordLoaded = true;

  // ── The card in Marketplace → Installed ──────────────────────────────────
  //
  // The Marketplace lists only what it installed itself, from its own store,
  // so an extension enabled with `spicetify config extensions` never shows up
  // there: adblock had a card and Vybecord did not. This writes the record the
  // Marketplace's own Install button writes, and the card appears like any
  // other. (The Marketplace then also injects the copy from GitHub on each
  // start — that is what the double-load guard above is for.)
  //
  // Where the record lives depends on the Marketplace version. Up to 1.0.8 it
  // was localStorage; since 1.0.9 (July 2026) it is an IndexedDB database, and
  // marketplace:* keys left in localStorage are migrated once, then deleted
  // unread. So: the database when it exists, localStorage otherwise — a
  // Marketplace that upgrades later migrates the entry with everything else.
  //
  // Keyed on the index, not on the card record: the Marketplace rewrites the
  // index from a snapshot it took at startup whenever something else is
  // installed, and a card added after that snapshot drops out of the list
  // while its record survives. Checking the index heals that next start. It
  // also means removing the card from the Marketplace brings it back next
  // start — which is right, the extension is still installed. Remove it from
  // Spicetify to be rid of the card.

  const MP_USER = 'TheUnknownMurda';
  const MP_REPO = 'VybecordTS';
  const MP_BRANCH = 'main';
  /** Keep this in sync with manifest.json at the repo root. */
  const MP_MANIFEST = {
    name: 'Vybecord',
    description:
      'Sends the track you are playing to VybecordTS for real-time Discord Rich Presence: '
      + 'instant track changes, accurate progress, album art and full Spotify metadata.',
    preview: 'assets/spicetify-preview.png',
    main: 'spicetify-extension/vybecord.js',
    readme: 'README.md',
    authors: [{ name: MP_USER, url: `https://github.com/${MP_USER}` }],
    tags: ['discord', 'rich presence', 'integration', 'now playing'],
  };
  const MP_INDEX_KEY = 'marketplace:installed-extensions';
  const MP_CARD_KEY = `marketplace:installed:${MP_USER}/${MP_REPO}/${MP_MANIFEST.main}`;
  const MP_DB = 'spicetify-marketplace';
  const MP_STORE = 'settings';

  /** The record the Marketplace stores per installed extension. */
  function marketplaceRecord() {
    const raw = p => `https://raw.githubusercontent.com/${MP_USER}/${MP_REPO}/${MP_BRANCH}/${p}`;
    const now = new Date().toISOString();
    return JSON.stringify({
      manifest: MP_MANIFEST,
      type: 'extension',
      title: MP_MANIFEST.name,
      subtitle: MP_MANIFEST.description,
      authors: MP_MANIFEST.authors,
      user: MP_USER,
      repo: MP_REPO,
      branch: MP_BRANCH,
      imageURL: raw(MP_MANIFEST.preview),
      extensionURL: raw(MP_MANIFEST.main),
      readmeURL: raw(MP_MANIFEST.readme),
      stars: 0,
      lastUpdated: now,
      created: now,
    });
  }

  /** The index with this card appended, or null when it is already listed. */
  function indexWithCard(json) {
    let list;
    try { list = JSON.parse(json || '[]'); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    return list.includes(MP_CARD_KEY) ? null : JSON.stringify([...list, MP_CARD_KEY]);
  }

  /**
   * The Marketplace database, or null when there is none.
   *
   * Opening without a version creates the database if it is missing, which
   * would then look to the Marketplace like a store it had already migrated
   * to — aborting the upgrade leaves nothing behind.
   */
  function openMarketplaceDb() {
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(MP_DB); } catch { resolve(null); return; }
      req.onupgradeneeded = () => { req.transaction.abort(); };
      req.onerror = (e) => { e.preventDefault(); resolve(null); };
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(MP_STORE)) { db.close(); resolve(null); return; }
        resolve(db);
      };
    });
  }

  function registerInDb(db) {
    return new Promise((resolve, reject) => {
      db.onversionchange = () => db.close();
      const tx = db.transaction(MP_STORE, 'readwrite');
      const store = tx.objectStore(MP_STORE);
      let added = false;
      const get = store.get(MP_INDEX_KEY);
      get.onsuccess = () => {
        const index = indexWithCard(get.result?.value);
        if (!index) return;
        store.put({ key: MP_CARD_KEY, value: marketplaceRecord() });
        store.put({ key: MP_INDEX_KEY, value: index });
        added = true;
      };
      tx.oncomplete = () => { db.close(); resolve(added); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  function registerInLocalStorage() {
    const index = indexWithCard(localStorage.getItem(MP_INDEX_KEY));
    if (!index) return false;
    localStorage.setItem(MP_CARD_KEY, marketplaceRecord());
    localStorage.setItem(MP_INDEX_KEY, index);
    return true;
  }

  /** Never awaited by the rest: the card is a courtesy, the presence is not. */
  async function registerInMarketplace() {
    try {
      const db = await openMarketplaceDb();
      const added = db ? await registerInDb(db) : registerInLocalStorage();
      if (added) console.log('[VybecordTS] Added the card to Marketplace → Installed.');
    } catch (e) {
      console.log('[VybecordTS] Could not add the Marketplace card:', e?.message || e);
    }
  }
  void registerInMarketplace();

  // Wait for Spicetify API to be available
  while (!(Spicetify?.Player?.addEventListener && Spicetify?.Player?.data)) {
    await new Promise(r => setTimeout(r, 200));
  }

  const ENDPOINT = 'http://127.0.0.1:8888/api/spicetify';
  const LYRICS_ENDPOINT = 'http://127.0.0.1:8888/api/spotify-lyrics';
  const PROGRESS_INTERVAL_MS = 2000; // Sync progress every 2s (for drift correction)

  // Spotify's own lyrics endpoint — the one the client's lyrics panel uses.
  // Reachable only from inside the client, which is the whole reason this lives
  // in a Spicetify extension: CosmosAsync signs the request with the client's
  // own token, so there is no auth to obtain or refresh here.
  const LYRICS_API = 'https://spclient.wg.spotify.com/color-lyrics/v2/track/';

  let progressTimer = null;
  let lastSentUri = '';
  let lastSentPlaying = null;
  let lastLyricsTrackId = '';

  /** Extract full track data from Spicetify Player. */
  function getTrackData() {
    const data = Spicetify.Player.data;
    if (!data?.item) return null;

    const item = data.item;
    const uri = item.uri || '';
    const trackId = uri.startsWith('spotify:track:') ? uri.slice(14) : '';
    // Local files detection: URI starts with spotify:local: OR no track ID OR context is local playlist
    const playerCtx = Spicetify.Player.data.context;
    const ctxUri = playerCtx?.uri || '';
    const isLocalFile = uri.startsWith('spotify:local:');
    const isLocal = isLocalFile || !trackId || ctxUri.includes(':local:') || ctxUri.includes('local-files');

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
        contextName = 'Liked Songs';
      } else if (parts[1] === 'local') {
        // Local Files playlist
        contextType = 'local';
        contextUrl = 'https://open.spotify.com/collection/local-files';
        contextName = 'Local Files';
      } else if (['playlist', 'album', 'artist'].includes(parts[1]) && parts[2]) {
        contextType = parts[1];
        contextUrl = `https://open.spotify.com/${parts[1]}/${parts[2]}`;
      } else {
        contextType = parts[1] || '';
        // No reliable web URL for station, search, etc.
      }
      // Context name from Spicetify metadata (if not already set, e.g., for Liked Songs)
      if (!contextName) {
        contextName = ctx.metadata?.context_description
          || ctx.metadata?.['context_description']
          || '';
      }
      // Detect Local Files playlist by name (English or French) - fallback if empty
      if (!contextName && contextType === 'local') {
        contextName = 'Local Files';
      }
      // If context name contains "local" or "fichiers", treat as Local Files
      if (!contextName && contextType === 'internal' && 
          (ctx.metadata?.context_description?.toLowerCase().includes('local') ||
           ctx.metadata?.context_description?.toLowerCase().includes('fichiers'))) {
        contextType = 'local';
        contextName = 'Local Files';
      }
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
      is_local: isLocal,
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

  /**
   * Fetch Spotify's own timed lyrics for a track and forward them.
   *
   * Only LINE_SYNCED is sent: Vybecord schedules lines against the clock, and an
   * unsynced blob has every line stamped at 0, which would show the whole song
   * at once. A track with no lyrics answers 404 — that is the normal case for a
   * good part of the catalogue, not an error worth reporting.
   *
   * Deliberately never awaited by the track push: lyrics are a bonus, and a slow
   * or failed call must not delay the presence.
   */
  async function pushLyrics(trackId) {
    if (!trackId || trackId === lastLyricsTrackId) return;
    if (!Spicetify?.CosmosAsync?.get) return;  // older Spicetify
    lastLyricsTrackId = trackId;

    let body;
    try {
      body = await Spicetify.CosmosAsync.get(
        `${LYRICS_API}${trackId}?format=json&vocalRemoval=false&market=from_token`,
      );
    } catch (e) {
      // 404 = this track simply has no lyrics. Anything else is Spotify moving
      // the endpoint, which is worth a line but not a retry loop.
      const msg = String(e?.message || e);
      if (!msg.includes('404')) console.log('[VybecordTS] Lyrics lookup failed:', msg);
      return;
    }

    const lyrics = body?.lyrics;
    if (!lyrics || lyrics.syncType !== 'LINE_SYNCED' || !Array.isArray(lyrics.lines)) return;

    const lines = lyrics.lines
      .map(l => ({ time: Number(l.startTimeMs) || 0, text: String(l.words || '').trim() }))
      .filter(l => l.text);
    if (!lines.length) return;

    // The track may have changed while the request was in flight; sending anyway
    // is harmless — Vybecord keys these by track id and only injects on a match.
    fetch(LYRICS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track_id: trackId, lines }),
    }).catch(() => { /* VybecordTS not running — ignore */ });
  }

  /** Handle song change — immediate push. */
  function onSongChange() {
    const data = getTrackData();
    if (!data) return;
    lastSentUri = data.uri;
    lastSentPlaying = data.is_playing;
    send(data);
    void pushLyrics(data.track_id);
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

  /**
   * Periodic progress sync (for lyrics drift correction), and the heartbeat
   * that proves the extension is still loaded.
   *
   * A paused Spotify used to send nothing at all. Vybecord treats ten seconds
   * of silence as the extension being gone, so pausing for that long dropped it
   * back to the Windows media session — and the settings card, which reads the
   * same signal, went on saying "Waiting for Spotify" over a green checklist
   * however many times you pressed Check again. Pausing is not disconnecting,
   * so the push keeps going; `is_playing` already carries the difference, and
   * every reader downstream gates on it.
   */
  function startProgressSync() {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(() => {
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
    void pushLyrics(initial.track_id);
  }

  console.log('[VybecordTS] Spicetify extension loaded ✓');
})();
