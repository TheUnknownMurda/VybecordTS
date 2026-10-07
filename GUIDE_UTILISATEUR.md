# Vybecord — Guide de démarrage

Vybecord affiche sur ton profil Discord la musique que tu écoutes, avec les paroles qui défilent en temps réel.

**Rien à installer dans Spotify, rien à installer dans ton navigateur.** L'appli lit directement le lecteur média de Windows. Deux extensions optionnelles — une pour Spotify, une pour ton navigateur — ajoutent des détails, mais tout fonctionne sans elles.

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

Ton statut Discord se met à jour tout seul. La première fois, Vybecord s'ouvre sur **Help & setup**, une courte liste qui se coche toute seule : Discord est ouvert, et quelque chose joue. Les ajouts optionnels sont listés en dessous.

> **Windows affiche un avertissement SmartScreen ?** L'application n'est pas signée par un certificat payant. Clique sur « Informations complémentaires » puis « Exécuter quand même ».

---

## L'utiliser au quotidien

### Fermer la fenêtre n'arrête pas l'appli

Vybecord continue dans la zone de notification (à côté de l'horloge). Clique sur l'icône pour rouvrir la fenêtre, ou clic droit → **Quit** pour vraiment quitter.

Tu peux changer ça dans **Settings → App & window → Close to tray**.

### Les pages

| Page | À quoi ça sert |
| --- | --- |
| **Now playing** | Le morceau en cours (pochette, titre, artiste, album, lecteur et progression ; en pause, il reste affiché avec sa barre arrêtée), juste en dessous un aperçu de ta carte Discord telle que tes amis la voient, et les paroles qui défilent (clique dessus pour voir tout le morceau, ou sur **Big lyrics** pour les afficher en grand dans toute la fenêtre, comme Spotify ; **Échap** ferme). Des paroles trouvées sans minutage s'affichent en texte simple à faire défiler, marquées **Words only**. Le menu **Source** choisit le lecteur suivi. |
| **Lyrics** | Ta bibliothèque de paroles perso : **My lyrics**, **Blocked** (les paroles signalées comme fausses) et le dump **LRCLIB** hors ligne. **Add lyrics** sert à importer ou écrire de nouvelles paroles. |
| **Activity** | Ce que tu as écouté sur 7 jours, 30 jours, 12 mois ou depuis toujours : temps d'écoute, graphique, top artistes et titres, et tes dernières écoutes (**See all** ouvre tout l'historique). La page se met à jour toute seule à la fin de chaque morceau. |
| **Settings** | Discord presence, Lyrics & translation, Detection, Integrations (extension navigateur, Spotify, Last.fm), App & window et About. La barre de recherche trouve n'importe quel réglage. |
| **Help & setup** | La liste de configuration, en bas de la barre latérale. |

Le bas de la barre latérale indique aussi si Discord est connecté et ce qui est détecté.

Astuce : les touches **1 à 4** passent de Now playing à Lyrics, Activity et Settings. **Ctrl+Q** quitte l'appli.

---

## Problèmes courants

### Rien n'est détecté

Sur **Now playing**, ouvre le menu **Source**. Il liste tous les lecteurs que Windows signale ; s'il est vide, c'est que ton lecteur ne communique pas avec Windows.

**Comment vérifier :** appuie sur une touche média (play/pause) de ton clavier. Si l'encart de volume Windows affiche le titre du morceau, Vybecord peut le voir. S'il n'affiche rien, Vybecord ne peut rien voir non plus — c'est une limite du lecteur, pas de l'appli.

### Le statut n'apparaît pas sur Discord

- Discord doit être l'**application de bureau**, et être lancée
- Regarde le bas de la barre latérale de Vybecord : s'il affiche **Discord not found**, la connexion n'est pas établie. Relance Discord puis Vybecord. Si Discord est connecté mais que rien ne s'affiche, la ligne en dessous dit pourquoi (Rich Presence coupée, masqué pendant ton absence, une pub…).
- Vérifie dans Discord : **Paramètres → Activité → Afficher l'activité en cours** doit être activé

### Pas de paroles

- Vérifie que **Settings → Lyrics & translation → Show lyrics** est activé
- Certains morceaux n'ont tout simplement pas de paroles synchronisées en ligne
- Depuis un onglet de navigateur, le titre publié est souvent le nom de la vidéo (« Artiste - Titre (Official Video) ») plutôt qu'un titre propre, ce qui rend la recherche moins fiable

### Pas de paroles sur une vidéo YouTube

Les sous-titres sont un recours : ils ne servent que si aucune parole synchronisée n'existe pour le morceau. Ils reposent sur **yt-dlp**, désormais livré avec Vybecord — il n'y a rien à installer.

**Settings → Lyrics & translation → YouTube captions** indique quelle copie est utilisée. Pour imposer la tienne, dépose `yt-dlp.exe` dans le dossier que ce panneau ouvre : elle passe avant celle embarquée.

Toutes les vidéos n'ont pas de sous-titres, et la vidéo doit être retrouvable par son titre et sa chaîne : le navigateur dit à Windows ce qui joue, mais pas sur quelle page — Vybecord la cherche donc sur YouTube.

### Les paroles sont décalées

Sur **Now playing**, utilise les boutons **−250 / +250** sous les paroles. Le décalage est enregistré pour ce morceau uniquement : il sera juste la prochaine fois que la chanson repassera, sans décaler toutes les autres. Les morceaux que tu n'as jamais corrigés utilisent la valeur par défaut de **Settings → Lyrics & translation → Default timing offset**.

### Les paroles sont fausses

Sur **Now playing**, clique sur **Wrong lyrics?** sous les paroles et indique le problème :

- **The words are wrong** — ce résultat ne sera plus jamais réutilisé pour ce morceau, et la source suivante prend le relais. Tu peux annuler le signalement dans **Lyrics → Blocked** (**Allow again**).
- **The timing is off** — les lignes sont reprises dans l'éditeur de paroles, où **Sync while playing** te permet de les recaler sur la chanson et d'enregistrer ta propre version. Ta version passe avant tout ce qui vient d'Internet.

### Mon statut disparaît pendant les pubs Spotify

C'est voulu. Sans filtre, ton profil Discord annoncerait « Monster Energy » comme si c'était un morceau.

Spotify ne signale pas ses coupures publicitaires : il remplace simplement les métadonnées du morceau par celles de l'annonceur. Vybecord les repère à leur **durée** : toutes les pubs observées font 30 secondes, alors que le plus court de 44 vrais morceaux échantillonnés faisait 83 secondes. Un titre Spotify de moins d'une minute est donc traité comme une pub.

Les interludes et skits d'album sont épargnés : un interlude appartient à l'album en cours de lecture, une pub jamais.

Pendant une pub, la fenêtre affiche « Advertisement » pour que tu saches que ce n'est pas un bug. Tu peux désactiver le filtre dans **Settings → Discord presence → Hide during Spotify ads**.

### Mon statut disparaît quand je m'absente

C'est voulu, et c'est réglable. Au bout de dix minutes sans clavier ni souris — le délai au bout duquel Discord te passe lui-même en « Absent » — Vybecord retire ta présence, exactement comme le fait l'intégration Spotify de Discord. Dès que tu touches la machine, elle revient sur la ligne où la chanson en est.

La musique, elle, n'est jamais interrompue : seule la publication vers Discord est suspendue. La page **Now playing** l'indique pendant ce temps, pour que tu saches pourquoi ton profil est vide.

Le délai se change dans **Settings → Discord presence → Away after**, et l'option se coupe juste au-dessus avec **Hide when I'm away**.

### La pochette s'affiche dans la fenêtre mais pas sur Discord

La fenêtre lit l'image directement sur ton disque. Discord ne peut pas : il lui faut une URL. Vybecord cherche donc l'album dans un catalogue musical public (Deezer, puis iTunes d'Apple) et transmet cette URL à Discord.

La musique absente de tout catalogue — tes rips, démos, DJ sets — n'a de pochette que dans ton fichier. Pour celle-là, Vybecord publie cette seule image sur son propre stockage de pochettes pour que Discord puisse la charger : jamais l'audio, et les infos d'appareil photo et de localisation sont retirées avant. C'est **Settings → Integrations → Cover images → Publish artwork that exists only on this PC**, activé par défaut.

Une image par défaut sur Discord veut donc dire l'une de deux choses : le morceau n'est dans aucun catalogue et cette option est coupée, ou c'est un live, qui n'est jamais recherché.

### Obtenir plus de détails sur la lecture navigateur

Windows dit à Vybecord ce qui joue, pas sur quel site : un onglet SoundCloud et un onglet YouTube sont identiques.

L'extension navigateur optionnelle corrige ça. **Settings → Integrations → Browser extension** te guide :

- **Chrome, Edge, Brave, Opera, Vivaldi** — clique sur **Open the extension folder**, ouvre la page des extensions de ton navigateur (le panneau copie son adresse pour toi), active le **Mode développeur**, clique sur **Charger l'extension non empaquetée** et choisis ce dossier.
- **Firefox 121 ou plus récent** — télécharge `vybecord-extension-<version>-firefox.zip` depuis la [page des releases](https://github.com/TheUnknownMurda/VybecordTS/releases/latest), ouvre `about:debugging#/runtime/this-firefox`, clique sur **Charger un module complémentaire temporaire** et choisis le zip. Firefox retire les modules temporaires à sa fermeture.

Son icône ouvre une page de réglages avec un interrupteur par site — Spotify, YouTube, SoundCloud, Bandcamp, Twitch, Kick — tous actifs par défaut.

Avec elle, chaque site est correctement identifié, la présence pointe directement vers le morceau, et la barre de progression lit l'élément audio de la page au lieu de la position système, plus grossière. Sans elle, tout ce qui suit reste valable.

### SoundCloud apparaît comme un navigateur, pas comme SoundCloud

Sans l'extension navigateur, Windows indique à Vybecord ce qui joue, mais pas sur quel site : un onglet SoundCloud et un onglet YouTube sont identiques. Installe l'extension (voir plus haut) et SoundCloud est annoncé comme SoundCloud, avec un lien vers le morceau.

Même sans elle, le titre et l'artiste sont analysés avec les conventions de SoundCloud, donc un upload intitulé « Artiste - Titre (prod. Machin) » donne le bon artiste plutôt que le compte qui a mis en ligne. Les paroles, la pochette et la présence elle-même ne sont pas affectées — elles se basent sur le morceau et l'artiste, pas sur le site. Tant que le site n'est pas identifié, cet onglet dépend de l'interrupteur **Other browser tabs** dans **Settings → Detection**, et non de **SoundCloud**.

### Deux choses jouent en même temps

Sur **Now playing**, ouvre le menu **Source** et choisis le lecteur que tu veux afficher. Il reste épinglé jusqu'à ce que tu choisisses **Automatic**.

Ou affiche-les toutes. **Settings → Discord presence → Several presences** met jusqu'à cinq cartes sur ton profil : la chanson Spotify en présence 1, la vidéo du navigateur en présence 2, un stream dans un autre onglet en présence 3, par exemple. Ce qui joue avec le rang le plus élevé devient la présence 1 (une appli de musique passe avant une vidéo, une vidéo avant un onglet anonyme), ce qui suit la présence 2, et ainsi de suite. Avec plus d'une carte :

- Les onglets d'un même site sont des choses distinctes : quatre streams Twitch ouverts côte à côte prennent quatre cartes. Une application Discord ne porte qu'une carte, donc les autres en empruntent une — l'application Vybecord par défaut, puis un ID de réserve si tu en as mis, puis l'application d'une plateforme que rien n'occupe — et la carte nomme sa plateforme dans l'en‑tête de toute façon.
- **Lyrics on presence N** choisit quelles cartes affichent les paroles — n'importe quelle combinaison.
- **Now playing** montre toutes les cartes ; clique sur l'une pour voir ses paroles, son aperçu Discord et ses réglages. Son menu **Source** épingle cette présence à un lecteur, pour qu'elle ne s'échange jamais avec une autre.
- L'historique d'écoute (et donc **Activity**) et Last.fm ne suivent que la présence 1.

Chaque carte est une application Discord à part, et Spotify, YouTube, SoundCloud, Apple Music, Kick et Twitch ont chacun la leur ; avec celle par défaut, ça fait sept, et une carte dont l'application est déjà prise en emprunte une libre. Les **Spare application ID** ne servent qu'au‑delà de sept cartes — ou si tu préfères ne pas emprunter (à créer sur discord.com/developers ; jusqu'à quatre).

---

## Questions fréquentes

**Est-ce que ça marche sans Spotify Premium ?**
Oui. Vybecord ne parle jamais à l'API de Spotify — il lit ce que Windows sait déjà.

**Faut-il installer Spicetify ou une extension de navigateur ?**
Non. Les anciennes versions le demandaient, plus celle-ci. Ce sont deux bonus optionnels : Spicetify apporte les changements de morceau instantanés et les paroles officielles de Spotify (à configurer dans **Settings → Integrations → Spotify**), et l'extension navigateur indique à Vybecord sur quel site joue un onglet.

**Ça marche avec quoi ?**
Tout ce qui apparaît dans l'encart média de Windows : Spotify, les onglets de navigateur (YouTube, SoundCloud, Deezer…), VLC, foobar2000, MusicBee, AIMP, Apple Music, Tidal, Amazon Music.

**Est-ce que mes données sortent de mon PC ?**
Les titres et artistes sont envoyés aux services de paroles (LRCLib, Netease, Musixmatch, Genius) pour chercher les paroles, à Deezer et iTunes d'Apple pour trouver la pochette, et à Discord pour le statut. Une pochette qui n'existe que dans tes fichiers est publiée sur le stockage de pochettes de Vybecord, sans ses métadonnées — désactivable dans **Settings → Integrations → Cover images**. Si tu actives la traduction, les lignes de paroles partent au service de traduction ; si tu actives Last.fm, tes écoutes y vont aussi. L'historique, les réglages et les paroles importées restent en local. La liste complète est dans la [politique de confidentialité](https://theunknownmurda.github.io/VybecordTS/privacy/).

**Où sont mes fichiers ?**
Dans `%APPDATA%\Vybecord` — colle ce chemin dans l'explorateur.

**Je viens de VybecordTS 1.x, je perds quelque chose ?**
Ta configuration, ta base de paroles et ton historique sont conservés. Windows seul n'expose ni la playlist en cours, ni le mode aléatoire/répétition, ni les liens cliquables vers le morceau ; les extensions optionnelles Spicetify et navigateur les rétablissent. Désinstalle l'ancienne extension Spicetify 1.x et les scripts Tampermonkey — la nouvelle extension Spicetify s'installe depuis les Settings.

---

## Support

Un souci ? Utilise **Settings → About → Report a problem** dans l'appli (aussi sur **Help & setup**), ou ouvre un ticket sur [GitHub](https://github.com/TheUnknownMurda/VybecordTS/issues).
