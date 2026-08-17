// Register Vybecord in the Spicetify Marketplace "Installed" tab.
//
// The Marketplace only lists what it installed itself — it tracks that in
// localStorage, not in config-xpui.ini. An extension enabled with
// `spicetify config extensions vybecord.js` therefore never shows up there.
// This script writes the same localStorage entries the Marketplace writes,
// so the card appears under Marketplace → Installed → Extensions.
//
// How to run it:
//   1. spicetify enable-devtools      (once, then restart Spotify)
//   2. In Spotify press Ctrl+Shift+I → Console tab
//   3. Paste the whole file, press Enter, then reload Spotify (Ctrl+R)
//
// To remove the card again, run:
//   ["marketplace:installed:TheUnknownMurda/VybecordTS/spicetify-extension/vybecord.js"]
//     .forEach(k => { localStorage.removeItem(k);
//       localStorage.setItem("marketplace:installed-extensions",
//         JSON.stringify(JSON.parse(localStorage.getItem("marketplace:installed-extensions") || "[]")
//           .filter(x => x !== k))); });

(() => {
  const USER = 'TheUnknownMurda';
  const REPO = 'VybecordTS';
  const BRANCH = 'main';

  // Keep this in sync with manifest.json at the repo root.
  const manifest = {
    name: 'Vybecord',
    description:
      'Sends the track you are playing to VybecordTS for real-time Discord Rich Presence: '
      + 'instant track changes, accurate progress, album art and full Spotify metadata.',
    preview: 'assets/spicetify-preview.png',
    main: 'spicetify-extension/vybecord.js',
    readme: 'README.md',
    authors: [{ name: USER, url: `https://github.com/${USER}` }],
    tags: ['discord', 'rich presence', 'integration', 'now playing'],
  };

  const raw = path => `https://raw.githubusercontent.com/${USER}/${REPO}/${BRANCH}/${path}`;

  const INDEX_KEY = 'marketplace:installed-extensions';
  const cardKey = `marketplace:installed:${USER}/${REPO}/${manifest.main}`;
  const now = new Date().toISOString();

  localStorage.setItem(cardKey, JSON.stringify({
    manifest,
    type: 'extension',
    title: manifest.name,
    subtitle: manifest.description,
    authors: manifest.authors,
    user: USER,
    repo: REPO,
    branch: BRANCH,
    imageURL: raw(manifest.preview),
    extensionURL: raw(manifest.main),
    readmeURL: raw(manifest.readme),
    stars: 0,
    lastUpdated: now,
    created: now,
  }));

  const index = JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
  if (!index.includes(cardKey)) {
    index.push(cardKey);
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  }

  console.log('[VybecordTS] Registered in Marketplace →', cardKey);
  console.log('[VybecordTS] Reload Spotify (Ctrl+R) to see it under Installed.');
})();
