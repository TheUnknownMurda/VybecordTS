# 🎵 VybecordTS v1.0.0

**Discord Rich Presence with real-time synced lyrics — Initial Release**

---

## ✨ What's New

### Core Features
- 🎵 **Discord Rich Presence** — Display song, artist, album art, and synced lyrics on your Discord profile
- 📱 **Multi-Source Support** — Spotify, YouTube, YouTube Music, SoundCloud, Bandcamp, and any SMTC-compatible player
- 🎤 **Synced Lyrics** — Real-time lyrics from LRCLib, Netease Cloud Music, YouTube CC
- ⚡ **High-Precision Sync** — Sub-millisecond accurate lyrics timing
- 🖥️ **Web Dashboard** — Beautiful glassmorphism UI with live lyrics, stats, and theming

### Spotify Integration (Two Options)

#### 🌟 Option 1: Spotify Premium (Official API) — **RECOMMENDED**
- No third-party tools required
- Full metadata via official Spotify API
- Most reliable and safe
- OAuth-based authentication

#### ⚠️ Option 2: Spotify Free + Spicetify
- For users without Spotify Premium
- **WARNING:** Spicetify violates Spotify's Terms of Service
- Using it incorrectly (ad blockers, etc.) may result in account suspension
- We are **NOT responsible** for any account bans
- Use responsibly: only for theming, never for blocking ads or unlocking premium features

### Additional Integrations
- 📺 **YouTube/Tampermonkey** — Precise video sync with userscript
- 🎧 **SoundCloud/Bandcamp** — Dedicated Tampermonkey userscripts
- 🖥️ **Windows SMTC** — Universal support for any media player

### Security
- 🔒 **Secure Bug Report Webhook** — Rate-limited, content-sanitized
- 🛡️ **No Hardcoded Secrets** — All configuration via environment or config files
- 🔐 **SSRF Protection** — Webhook URL validation

---

## 📦 Downloads

| File | Size | Description |
|------|------|-------------|
| `VybecordTS-v1.0.0.zip` | ~22 MB | **Ready-to-use Windows executable** — Just extract and run! |

### Contents of the ZIP
```
VybecordTS/
├── VybecordTS.exe          ← Main application (double-click to start)
├── smtc-reader.ps1         ← Windows media detection script
├── dashboard.html          ← Legacy web dashboard
├── dashboard-v2.html       ← Modern glassmorphism dashboard
├── config.json             ← Configuration file (auto-created)
├── README.txt              ← Quick start guide
├── tampermonkey/           ← Userscripts for YouTube/SoundCloud
├── spicetify-extension/    ← Spicetify extension (Spotify Free)
└── envs/                   ← Environment templates
```

---

## 🚀 Quick Start for Beginners

### Prerequisites
- ✅ Windows 10/11
- ✅ Discord Desktop App (not web version)
- ✅ Spotify account (Premium recommended)

### Installation Steps

1. **Create Discord Application** (2 min)
   - Go to [discord.com/developers/applications](https://discord.com/developers/applications)
   - Click "New Application" → Name it → Copy the **Application ID**

2. **Download & Extract**
   - Download `VybecordTS-v1.0.0.zip` from this release
   - Extract anywhere (Desktop, Documents, etc.)

3. **First Launch**
   - Double-click `VybecordTS.exe`
   - Browser opens automatically to setup wizard
   - Follow the on-screen instructions

4. **For Spotify Premium Users**
   - Select "Premium" in the wizard
   - Get Spotify credentials from [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
   - Add redirect URI: `http://127.0.0.1:8888/callback`

5. **Enjoy!**
   - Play music on Spotify
   - Your Discord status updates automatically with synced lyrics

📖 **Full User Guide:** See `GUIDE_UTILISATEUR.md` in the repository for detailed instructions.

---

## 🛠️ System Requirements

| Requirement | Minimum |
|-------------|---------|
| OS | Windows 10/11 |
| RAM | 512 MB |
| Disk Space | 100 MB |
| Node.js | 20.0+ (for development only) |
| Discord | Desktop app required |

---

## 📚 Documentation

- **User Guide (FR):** `GUIDE_UTILISATEUR.md`
- **Developer README:** `README.md`
- **License:** MIT License (see `LICENSE` file)

---

## 🐛 Known Issues & Troubleshooting

### Discord not showing presence?
- Make sure you're using **Discord Desktop** (not web/browser)
- Check Discord Settings → Activity Privacy → "Share detected activities" is ON

### No lyrics found?
- Some songs don't have synced lyrics available
- You can import custom `.lrc` files via the dashboard

### Spotify auth fails?
- Premium users: Make sure your app is created at [Spotify Dashboard](https://developer.spotify.com/dashboard)
- Check that redirect URI is exactly: `http://127.0.0.1:8888/callback`

### More help?
- See `GUIDE_UTILISATEUR.md` for detailed troubleshooting
- Use the Bug Report button in the dashboard

---

## 🔮 Roadmap

- [ ] macOS/Linux support (limited)
- [ ] Mobile companion app
- [ ] More lyrics sources
- [ ] Custom Discord buttons
- [ ] Playlist/queue display

---

## 🙏 Credits

- **Developer:** TheUnknownMurda
- **Lyrics Sources:** LRCLib, Netease Cloud Music, YouTube
- **Built with:** TypeScript, Node.js, SQLite

---

**⭐ Star this repository if you enjoy VybecordTS!**

**🐛 Found a bug?** Use the Bug Report button in the dashboard or open an issue.

---

## ⚖️ Disclaimer

VybecordTS is an independent project and is not affiliated with Discord, Spotify, or any other mentioned service.

Using third-party modifications (Spicetify, ad blockers, etc.) may violate Terms of Service of respective platforms. Users assume full responsibility for any consequences.
