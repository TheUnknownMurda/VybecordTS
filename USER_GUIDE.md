# 🎵 VybecordTS - User Guide for Beginners

> **Discord Rich Presence with real-time synced lyrics**

---

## 📋 What You Need BEFORE Starting

### Required (No Exceptions)
- ✅ **Windows 10 or 11**
- ✅ **Discord** (desktop app, NOT the web version)
- ✅ **A Spotify account** (Premium OR Free)

### Optional
- 🎵 **Spotify Premium** → Best experience, no additional tools needed
- 🛠️ **Spotify Free** → Requires [Spicetify](https://spicetify.app/) (see warning below)

---

## ⚠️ IMPORTANT WARNING - Spicetify

**If you use Spotify Free with Spicetify:**

- Spicetify **violates Spotify's Terms of Service**
- Used incorrectly (ad blockers, etc.) → **risk of account ban**
- **We are not responsible** for account suspensions
- **Recommendation:** Use Spicetify ONLY for theming/customization, NOT for blocking ads

**Safer Alternative:** Upgrade to Spotify Premium or use the Tampermonkey userscript for the Spotify web player.

---

## 🚀 Installation - STEP BY STEP

### Step 1: Create a Discord Application (2 minutes)

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **"New Application"** (blue button, top right)
3. Name it (e.g., "Vybecord") → Click **Create**
4. In the left menu, click **OAuth2** → **General**
5. Copy the **Application ID** (numbers at the top, keep it safe)

**📝 Note:** You do NOT need to create a bot or enable anything else.

---

### Step 2: Download VybecordTS

1. Go to the [GitHub Releases page](https://github.com/TheUnknownMurda/VybecordTS/releases)
2. Download **VybecordTS-v1.0.0.zip** (latest version)
3. Extract the ZIP anywhere (Desktop, Documents, etc.)

**📁 Structure after extraction:**
```
VybecordTS/
├── VybecordTS.exe    ← Run this!
├── config.json       ← Auto-created
└── ...
```

---

### Step 3: Launch the Setup Wizard

1. Double-click **VybecordTS.exe**
2. Your browser opens automatically at `http://127.0.0.1:8888`
3. The **Setup Wizard** appears:

#### Option A - Spotify Premium (Recommended)

1. Check **"Premium"**
2. Paste your **Discord Application ID**
3. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
   - Create an app
   - Copy **Client ID** and **Client Secret**
   - In **Redirect URIs**, add: `http://127.0.0.1:8888/callback`
4. Paste these details in the wizard
5. Click **"Start"**

#### Option B - Spotify Free

1. Check **"Free"**
2. Paste your **Discord Application ID**
3. Install [Spicetify](https://spicetify.app/) (if not already done)
4. Follow the instructions to install the VybecordTS extension in Spicetify
5. Click **"Start"**

**⚠️ See the Spicetify warning at the top of this guide**

---

### Step 4: Authorize Spotify

If you chose **Premium**:

1. A Spotify page opens asking for authorization
2. Click **"Agree"**
3. Redirect to `http://127.0.0.1:8888/callback`
4. **Done!** ✅

---

## 🎵 Daily Usage

### Starting VybecordTS

1. Double-click `VybecordTS.exe`
2. Let it run in the background
3. Open Spotify and play music
4. **Your Discord displays:**
   - 🎵 Track + Artist
   - 📝 Synced lyrics (if available)
   - ⏱️ Elapsed time
   - 🔄 Shuffle / Repeat (if enabled)

### Web Dashboard

Access `http://127.0.0.1:8888` in your browser to:

- 📊 View statistics
- 🎨 Change theme (colors)
- 📝 Import custom lyrics
- 📱 Display QR code for mobile
- ⚙️ Modify configuration

---

## 🔧 Troubleshooting

### "Discord not showing"

- ❌ Discord Web does NOT work
- ✅ You must use the **Discord desktop app**
- Check: Discord Settings → Activity Privacy → **"Share your activity"** must be ON

### "No lyrics found"

- VybecordTS searches multiple sources (LRCLib, Netease, YouTube)
- Some songs don't have synced lyrics available
- You can import your own `.lrc` files via the Dashboard

### "Spotify won't connect"

- Check that your **Redirect URI** is exactly: `http://127.0.0.1:8888/callback`
- Check that you copied the correct **Client ID** and **Client Secret**
- For Spotify Premium: your account must be added as a "test user" in the Spotify Dashboard

### "Spicetify not working"

- Make sure Spicetify is installed: `spicetify --version` in PowerShell
- Check that the VybecordTS extension is copied to the Extensions folder
- Completely restart Spotify after installation

### "Error: Missing DISCORD_CLIENT_ID"

- Relaunch the wizard from the Dashboard
- Or manually edit `config.json`:
  ```json
  {
    "discord_app_id": "YOUR_ID_HERE"
  }
  ```

---

## ❓ Frequently Asked Questions (FAQ)

**Q: Is it free?**
A: Yes, VybecordTS is 100% free and open source.

**Q: Is it safe?**
A: Yes, everything runs locally on your PC. Your data never leaves your machine (except normal API requests to Discord/Spotify).

**Q: Can I use it without Spotify?**
A: Yes! "Free" mode detects any Windows player (YouTube, SoundCloud, etc.) via SMTC.

**Q: Can I use it on Mac/Linux?**
A: No, VybecordTS requires Windows for SMTC detection.

**Q: Lyrics are out of sync, what to do?**
A: In the Dashboard, adjust "Lyrics Offset" (negative = earlier, positive = later).

---

## 📞 Support

- 🐛 **Bug report:** Via the Dashboard → "Bug Report" button
- 💬 **Discord:** [Your Discord server here]

---

**Enjoy your synced lyrics on Discord! 🎶**
