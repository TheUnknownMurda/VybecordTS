# 🎵 VybecordTS - Guide pour Débutants

> **Discord Rich Presence avec paroles synchronisées en temps réel**

---

## 📋 Ce dont vous avez besoin AVANT de commencer

### Obligatoire (sans exception)
- ✅ **Windows 10 ou 11**
- ✅ **Discord** (application de bureau, PAS la version web)

### Facultatif
- 🌐 **[Tampermonkey](https://www.tampermonkey.net/)** → pour YouTube, SoundCloud, Bandcamp, Twitch, Kick et le lecteur web Spotify
- 🛠️ **Application Spotify de bureau** → [Spicetify](https://spicetify.app/) (voir mise en garde ci-dessous)

**Aucun compte développeur n'est nécessaire.** VybecordTS embarque un ID
d'application Discord fonctionnel, et n'utilise pas l'API Web de Spotify : ni
Client ID, ni Client Secret, ni connexion à configurer.

---

## ⚠️ AVERTISSEMENT IMPORTANT - Spicetify

**Si vous utilisez Spicetify :**

- Spicetify **viole les Conditions d'Utilisation de Spotify**
- Utilisé incorrectement (bloqueur de pubs, etc.) → **risque de ban de compte**
- **Nous ne sommes pas responsables** des suspensions de compte
- **Recommandation :** Utilisez Spicetify UNIQUEMENT pour le thème/personnalisation, PAS pour bloquer les pubs

**Alternative plus sûre :** Utilisez le lecteur web Spotify avec le script Tampermonkey — aucune modification du client, aucun risque vis-à-vis des CGU.

---

## 🚀 Installation - ÉTAPE PAR ÉTAPE

### Étape 1 : Créer une Application Discord (2 minutes)

1. Allez sur [discord.com/developers/applications](https://discord.com/developers/applications)
2. Cliquez **"New Application"** (bouton bleu en haut à droite)
3. Donnez un nom (ex: "Vybecord") → Cliquez **Create**
4. Dans le menu de gauche, cliquez **OAuth2** → **General**
5. Copiez l'**Application ID** (numéros en haut, gardez-le précieusement)

**📝 Note :** Vous n'avez PAS besoin de créer un bot ou d'activer quoi que ce soit d'autre.

---

### Étape 2 : Télécharger VybecordTS

1. Allez sur la page [Releases GitHub](https://github.com/TheUnknownMurda/VybecordTS/releases)
2. Téléchargez **VybecordTS.zip** (dernière version)
3. Extrayez le ZIP où vous voulez (Bureau, Documents, etc.)

**📁 Structure après extraction :**
```
VybecordTS/
├── VybecordTS.exe    ← Lancez celui-ci !
├── config.json       ← Se crée automatiquement
└── ...
```

---

### Étape 3 : Lancer l'Assistant de Configuration

1. Double-cliquez sur **VybecordTS.exe**
2. Votre navigateur s'ouvre automatiquement sur `http://127.0.0.1:8888`
3. **L'Assistant de Configuration** apparaît :

#### Option A - Spotify, application de bureau

1. Installez [Spicetify](https://spicetify.app/) (si ce n'est pas déjà fait)
2. Installez l'extension VybecordTS dans Spicetify — l'installateur peut le faire pour vous
3. Relancez Spotify

**⚠️ Voir l'avertissement Spicetify en haut de ce guide**

#### Option B - Navigateur (YouTube, SoundCloud, Spotify web…)

1. Installez [Tampermonkey](https://www.tampermonkey.net/)
2. Sur la page de configuration, cliquez **Installer** pour chaque plateforme que vous utilisez

#### Option C - Tout le reste

Rien à faire : Windows détecte automatiquement la plupart des lecteurs
(Apple Music, VLC, foobar2000…).

---

## 🎵 Utilisation Quotidienne

### Démarrer VybecordTS

1. Double-cliquez sur `VybecordTS.exe`
2. Laissez-le tourner en arrière-plan
3. Lancez Spotify et jouez de la musique
4. **Votre Discord affiche :**
   - 🎵 Titre + Artiste
   - 📝 Paroles synchronisées (si disponibles)
   - ⏱️ Temps écoulé
   - 🔄 Shuffle / Repeat (si activé)

### Dashboard Web

Accédez à `http://127.0.0.1:8888` dans votre navigateur pour :

- 📊 Voir les statistiques
- 🎨 Changer le thème (couleurs)
- 📝 Importer des paroles personnalisées
- 📱 Afficher un QR code pour le mobile
- ⚙️ Modifier la configuration

---

## 🔧 Résolution des Problèmes

### "Discord ne s'affiche pas"

- ❌ Discord Web ne fonctionne PAS
- ✅ Vous devez utiliser l'**application Discord de bureau**
- Vérifiez : Paramètres Discord → Confidentialité & Sécurité → **"Afficher l'activité en cours"** doit être ACTIVÉ

### "Pas de paroles"

- VybecordTS cherche sur plusieurs sources (LRCLib, Netease, YouTube)
- Certaines chansons n'ont pas de paroles synchronisées disponibles
- Vous pouvez importer vos propres fichiers `.lrc` via le Dashboard

### "Spotify ne se connecte pas"

- Application de bureau : vérifiez que l'extension Spicetify est bien installée (voir ci-dessous)
- Lecteur web : vérifiez que le script Tampermonkey est installé et activé
- Sans l'un des deux, Spotify reste détecté via les contrôles média de Windows,
  mais avec moins d'informations (pas de nom de playlist, pas d'aléatoire/répétition)

### "Spicetify ne marche pas"

- Assurez-vous que Spicetify est bien installé : `spicetify --version` dans PowerShell
- Vérifiez que l'extension VybecordTS est bien copiée dans le dossier Extensions
- Redémarrez complètement Spotify après l'installation

### "Erreur Missing DISCORD_CLIENT_ID"

- Relancez l'assistant via le Dashboard
- Ou éditez manuellement `config.json` :
  ```json
  {
    "discord_app_id": "VOTRE_ID_ICI"
  }
  ```

---

## ❓ Questions Fréquentes (FAQ)

**Q : Est-ce que c'est gratuit ?**
R : Oui, VybecordTS est 100% gratuit et open source.

**Q : Est-ce que c'est sûr ?**
R : Oui, tout se passe localement sur votre PC. Vos données ne quittent jamais votre machine (sauf les requêtes API normales à Discord/Spotify).

**Q : Puis-je l'utiliser sans Spotify ?**
R : Oui ! Le mode "Free" détecte n'importe quel lecteur Windows (YouTube, SoundCloud, etc.) via SMTC.

**Q : Puis-je l'utiliser sur Mac/Linux ?**
R : Non, VybecordTS nécessite Windows pour la détection SMTC.

**Q : Les paroles sont décalées, que faire ?**
R : Dans le Dashboard, ajustez "Lyrics Offset" (négatif = plus tôt, positif = plus tard).

---

## 📞 Support

- 🐛 **Bug report** : Via le Dashboard → bouton "Bug Report"
- 💬 **Discord** : [Votre serveur Discord ici]

---

**Amusez-vous bien avec vos paroles synchronisées sur Discord ! 🎶**
