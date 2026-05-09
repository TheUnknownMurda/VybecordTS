# 🎵 VybecordTS - Guide pour Débutants

> **Discord Rich Presence avec paroles synchronisées en temps réel**

---

## 📋 Ce dont vous avez besoin AVANT de commencer

### Obligatoire (sans exception)
- ✅ **Windows 10 ou 11**
- ✅ **Discord** (application de bureau, PAS la version web)
- ✅ **Un compte Spotify** (Premium OU Gratuit)

### Facultatif
- 🎵 **Spotify Premium** → Meilleure expérience, aucun outil supplémentaire requis
- 🛠️ **Spotify Gratuit** → Nécessite [Spicetify](https://spicetify.app/) (voir mise en garde ci-dessous)

---

## ⚠️ AVERTISSEMENT IMPORTANT - Spicetify

**Si vous utilisez Spotify Gratuit avec Spicetify :**

- Spicetify **viole les Conditions d'Utilisation de Spotify**
- Utilisé incorrectement (bloqueur de pubs, etc.) → **risque de ban de compte**
- **Nous ne sommes pas responsables** des suspensions de compte
- **Recommandation :** Utilisez Spicetify UNIQUEMENT pour le thème/personnalisation, PAS pour bloquer les pubs

**Alternative plus sûre :** Passez à Spotify Premium ou utilisez le script Tampermonkey pour le lecteur web Spotify.

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

#### Option A - Spotify Premium (Recommandé)

1. Cochez **"Premium"**
2. Collez votre **Discord Application ID**
3. Allez sur [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
   - Créez une app
   - Copiez **Client ID** et **Client Secret**
   - Dans **Redirect URIs**, ajoutez : `http://127.0.0.1:8888/callback`
4. Collez ces informations dans l'assistant
5. Cliquez **"Démarrer"**

#### Option B - Spotify Gratuit

1. Cochez **"Free"**
2. Collez votre **Discord Application ID**
3. Installez [Spicetify](https://spicetify.app/) (si pas encore fait)
4. Suivez les instructions pour installer l'extension VybecordTS dans Spicetify
5. Cliquez **"Démarrer"**

**⚠️ Voir l'avertissement Spicetify en haut de ce guide**

---

### Étape 4 : Autoriser Spotify

Si vous avez choisi **Premium** :

1. Une page Spotify s'ouvre demandant l'autorisation
2. Cliquez **"Agree"** ou **"Accepter"**
3. Redirection vers `http://127.0.0.1:8888/callback`
4. **C'est bon !** ✅

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

- Vérifiez que votre **Redirect URI** est exactement : `http://127.0.0.1:8888/callback`
- Vérifiez que vous avez copié le bon **Client ID** et **Client Secret**
- Pour Spotify Premium : votre compte doit être ajouté comme "test user" dans le Dashboard Spotify

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
