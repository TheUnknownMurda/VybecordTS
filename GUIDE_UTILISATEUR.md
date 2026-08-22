# Vybecord — Guide de démarrage

Vybecord affiche sur ton profil Discord la musique que tu écoutes, avec les paroles qui défilent en temps réel.

**Rien à installer dans Spotify, rien à installer dans ton navigateur.** L'appli lit directement le lecteur média de Windows.

---

## Ce qu'il te faut

- **Windows 10 version 1809 ou plus récent** (sorti fin 2018 — si ton PC est à jour, c'est bon)
- **Discord installé sur ton PC** et lancé — la version dans le navigateur ne fonctionne pas
- C'est tout.

---

## Installation

1. Télécharge `Vybecord-<version>-setup.exe` depuis la [page des releases](https://github.com/TheUnknownMurda/VybecordTS/releases)
2. Lance-le, choisis un dossier, suis l'installateur
3. Ouvre Vybecord
4. Mets de la musique

Ton statut Discord se met à jour tout seul. Il n'y a aucune étape de configuration.

> **Windows affiche un avertissement SmartScreen ?** L'application n'est pas signée par un certificat payant. Clique sur « Informations complémentaires » puis « Exécuter quand même ».

---

## L'utiliser au quotidien

### Fermer la fenêtre n'arrête pas l'appli

Vybecord continue dans la zone de notification (à côté de l'horloge). Clique sur l'icône pour rouvrir la fenêtre, ou clic droit → **Quit** pour vraiment quitter.

Tu peux changer ça dans **Settings → App → Close to tray**.

### Les pages

| Page | À quoi ça sert |
| --- | --- |
| **Now playing** | Le titre en cours, la pochette, et les paroles qui défilent |
| **Players** | Tous les lecteurs détectés — utile si plusieurs choses jouent en même temps |
| **Stats** | Tes titres et artistes les plus écoutés de la session |
| **History** | Tout ton historique, plus un résumé façon « Wrapped » |
| **Lyrics** | Ta bibliothèque de paroles perso, l'import, et les titres signalés |
| **Settings** | Tous les réglages |
| **Last.fm** | Le scrobbling, si tu veux |

Astuce : les touches **1 à 8** changent de page.

---

## Problèmes courants

### Rien n'est détecté

Va sur la page **Players**. Si elle est vide, c'est que ton lecteur ne communique pas avec Windows.

**Comment vérifier :** appuie sur une touche média (play/pause) de ton clavier. Si l'encart de volume Windows affiche le titre du morceau, Vybecord peut le voir. S'il n'affiche rien, Vybecord ne peut rien voir non plus — c'est une limite du lecteur, pas de l'appli.

### Le statut n'apparaît pas sur Discord

- Discord doit être l'**application de bureau**, et être lancée
- Regarde la barre de titre de Vybecord : si le point à côté de « Discord » est rouge, la connexion n'est pas établie. Relance Discord puis Vybecord.
- Vérifie dans Discord : **Paramètres → Activité → Afficher l'activité en cours** doit être activé

### Pas de paroles

- Vérifie que **Settings → Lyrics → Show lyrics** est activé
- Certains morceaux n'ont tout simplement pas de paroles synchronisées en ligne
- Depuis un onglet de navigateur, le titre publié est souvent le nom de la vidéo (« Artiste - Titre (Official Video) ») plutôt qu'un titre propre, ce qui rend la recherche moins fiable

### Pas de paroles sur une vidéo YouTube

Les sous-titres sont un recours : ils ne servent que si aucune parole synchronisée n'existe pour le morceau. Ils reposent sur **yt-dlp**, désormais livré avec Vybecord — il n'y a rien à installer.

**Settings → Lyrics → YouTube captions** indique quelle copie est utilisée. Pour imposer la tienne, dépose `yt-dlp.exe` dans le dossier que ce panneau ouvre : elle passe avant celle embarquée.

Toutes les vidéos n'ont pas de sous-titres, et la vidéo doit être retrouvable par son titre et sa chaîne : le navigateur dit à Windows ce qui joue, mais pas sur quelle page — Vybecord la cherche donc sur YouTube.

### Les paroles sont décalées

Sur **Now playing**, utilise les boutons **−250 / +250** sous les paroles. Le décalage est mémorisé et s'applique aux morceaux suivants.

### Les paroles sont fausses

Clique sur **Wrong lyrics**. Ce résultat ne sera plus jamais réutilisé pour ce morceau. Tu peux ensuite importer les bonnes paroles dans **Lyrics → Import**, ou annuler le signalement dans **Lyrics → Flagged**.

### Mon statut disparaît pendant les pubs Spotify

C'est voulu. Sans filtre, ton profil Discord annoncerait « Monster Energy » comme si c'était un morceau.

Spotify ne signale pas ses coupures publicitaires : il remplace simplement les métadonnées du morceau par celles de l'annonceur. Vybecord les repère à leur **durée** : toutes les pubs observées font 30 secondes, alors que le plus court de 44 vrais morceaux échantillonnés faisait 83 secondes. Un titre Spotify de moins d'une minute est donc traité comme une pub.

Les interludes et skits d'album sont épargnés : un interlude appartient à l'album en cours de lecture, une pub jamais.

Pendant une pub, la fenêtre affiche « Advertisement » pour que tu saches que ce n'est pas un bug. Tu peux désactiver le filtre dans **Settings → Detection**.

### La pochette s'affiche dans la fenêtre mais pas sur Discord

La fenêtre lit l'image directement sur ton disque. Discord ne peut pas : il lui faut une URL. Vybecord cherche donc l'album sur un CDN musical public et transmet cette URL à Discord.

Si un morceau affiche l'image par défaut, c'est qu'il n'est simplement pas au catalogue — en général un titre non distribué ou un fichier local. **Settings → Presence → Cover images → Test with the current track** te dit dans quel cas tu es.

Envoyer ton propre fichier ne sert à rien : Discord accepte la présence puis refuse de charger l'image, d'où le « ? ». Testé avec un hébergeur public et avec le CDN de Discord lui-même.

### Obtenir plus de détails sur la lecture navigateur

Windows dit à Vybecord ce qui joue, pas sur quel site : un onglet SoundCloud et un onglet YouTube sont identiques.

L'extension optionnelle, dans le dossier `extension/`, corrige ça. Charge-la via `chrome://extensions` → Mode développeur → **Charger l'extension non empaquetée**, et choisis ce dossier. Son icône ouvre une page de réglages avec un interrupteur par site — Spotify, YouTube, SoundCloud, Bandcamp, Twitch, Kick — tous actifs par défaut.

Avec elle, chaque site est correctement identifié, la présence pointe directement vers le morceau, et la barre de progression lit l'élément audio de la page au lieu de la position système, plus grossière. Sans elle, tout ce qui suit reste valable.

### SoundCloud apparaît comme un navigateur, pas comme SoundCloud

Windows indique à Vybecord ce qui joue, pas sur quel site : un onglet SoundCloud et un onglet YouTube sont identiques. Seuls les scripts Tampermonkey savaient les distinguer, et ils ont disparu.

Ce qui fonctionne quand même : le titre et l'artiste sont analysés avec les conventions de SoundCloud, donc un upload intitulé « Artiste - Titre (prod. Machin) » donne le bon artiste plutôt que le compte qui a mis en ligne. Les paroles, la pochette et la présence elle-même ne sont pas affectées — elles se basent sur le morceau et l'artiste, pas sur le site.

Ce qui ne fonctionne pas : l'interrupteur par site dans Settings → Detection. La lecture navigateur est régie par **Browser tabs** à la place.

### Deux choses jouent en même temps

Va dans **Players** et clique sur le lecteur que tu veux afficher. Il reste épinglé jusqu'à ce que tu cliques sur **Automatic**.

---

## Questions fréquentes

**Est-ce que ça marche sans Spotify Premium ?**
Oui. Vybecord ne parle jamais à l'API de Spotify — il lit ce que Windows sait déjà.

**Faut-il installer Spicetify ou une extension de navigateur ?**
Non. Les anciennes versions le demandaient, plus celle-ci.

**Ça marche avec quoi ?**
Tout ce qui apparaît dans l'encart média de Windows : Spotify, les onglets de navigateur (YouTube, SoundCloud, Deezer…), VLC, foobar2000, MusicBee, AIMP, Apple Music, Tidal, Amazon Music.

**Est-ce que mes données sortent de mon PC ?**
Les titres et artistes sont envoyés aux services de paroles (LRCLib, Netease, Musixmatch) pour chercher les paroles, et à Discord pour le statut. Si tu actives Last.fm, ils vont aussi à Last.fm. L'historique et les paroles importées restent en local.

**Où sont mes fichiers ?**
Dans `%APPDATA%\Vybecord` — colle ce chemin dans l'explorateur.

**Je viens de VybecordTS 1.x, je perds quelque chose ?**
Ta configuration, ta base de paroles et ton historique sont conservés. En revanche, la playlist en cours, le mode aléatoire/répétition et les liens cliquables vers le morceau ne sont plus disponibles : Windows ne les expose pas. Tu peux désinstaller l'extension Spicetify et les scripts Tampermonkey.

---

## Support

Un souci ? Utilise la page **Report** dans l'appli, ou ouvre un ticket sur [GitHub](https://github.com/TheUnknownMurda/VybecordTS/issues).
