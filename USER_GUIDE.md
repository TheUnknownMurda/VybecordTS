# 🎵 VybecordTS - User Guide for Beginners

> **Discord Rich Presence with real-time synced lyrics**

---

## 📋 What You Need BEFORE Starting

### Required (No Exceptions)
- ✅ **Windows 10 or 11**
- ✅ **Discord** (desktop app, NOT the web version)

### Optional
- 🌐 **[Tampermonkey](https://www.tampermonkey.net/)** → for YouTube, SoundCloud, Bandcamp, Twitch, Kick
- 🎵 **Spotify Premium** → richer Spotify data through the official API
- 🛠️ **Spotify Free, desktop app** → [Spicetify](https://spicetify.app/) (see warning below)

**You do not need a Discord developer account.** VybecordTS ships with a
working application ID, so it displays your activity out of the box.

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

### Step 1: Download and run the installer

1. Go to the [GitHub Releases page](https://github.com/TheUnknownMurda/VybecordTS/releases)
2. Download **VybecordTS-Setup.exe**
3. Run it — no administrator rights needed

It installs to `%APPDATA%\VybecordTS` by default. You may pick another folder,
but it has to be one you can write to: VybecordTS stores its settings, logs and
lyrics database next to the program. The installer refuses protected locations
like `C:\Program Files` and tells you why.

---

### Step 2: The Spotify page (optional)

The wizard asks whether to install **Spicetify + the Vybecord extension**.

- **You use the Spotify desktop app** → tick it, and **close Spotify first**
  (Spicetify cannot patch a running Spotify). Read the warning above.
- **You listen to Spotify in your browser** → leave it unticked, the
  Tampermonkey script at step 4 covers you.
- **You don't use Spotify** → leave it unticked.

If anything goes wrong here, the installation carries on regardless: only the
Spotify desktop integration is affected.

---

### Step 3: First launch

VybecordTS starts and opens **http://127.0.0.1:8888/setup** in your browser.
This page only shows up on the first run; afterwards you land on the dashboard.

---

### Step 4: Add the browser scripts

On the setup page:

1. **Install Tampermonkey** — pick your browser from the buttons in step 1
2. **Click *Install*** next to each platform you actually use
   (Spotify web, YouTube, SoundCloud, Bandcamp, Twitch, Kick)
3. Tampermonkey shows its install screen → confirm

Each entry has a status dot. It turns **green** as soon as VybecordTS receives
data from that platform — play something to check.

**📝 Nothing happens when you click?** Tampermonkey probably isn't installed yet,
or your browser is showing the code instead of intercepting it. Redo step 1 and
reload the page.

---

### Step 5: Play something

That's it. Windows also detects most desktop players automatically, so many
apps work with no script at all.

---

### Optional: Spotify Premium via the official API

Richer Spotify data, no third-party tools:

1. Open the dashboard → **Settings**
2. Set the tier to **Premium**
3. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
   - Copy **Client ID** and **Client Secret** into the settings
   - Add `http://127.0.0.1:8888/callback` to **Redirect URIs**
4. Authorize Spotify when the page opens

### Optional: your own Discord app name

The activity name shown on Discord comes from the application ID. To use your
own:

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. **New Application** → name it → **Create**
3. Copy the **Application ID** and paste it in the dashboard settings

No bot, no extra permission required.

---

## 🎵 Daily Usage

### Starting VybecordTS

1. Use the **VybecordTS** shortcut (Desktop or Start Menu)
2. Let it run in the background
3. Play music — Spotify, YouTube, or anything else
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

### "A browser script does nothing"

- Reopen **http://127.0.0.1:8888/setup** and check the status dot for that platform
- The dot only turns green while something is actually playing on that site
- Make sure Tampermonkey is enabled for the site (its toolbar icon shows the
  active scripts)

### "I want to see the setup page again"

Open **http://127.0.0.1:8888/setup** directly — it stays available at all times.

### "VybecordTS can't write its configuration"

You installed it in a folder Windows protects. Reinstall into the suggested
location (`%APPDATA%\VybecordTS`) or any folder you own.

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
