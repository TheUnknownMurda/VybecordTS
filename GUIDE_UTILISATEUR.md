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

Vybecord continue dans la zone de notification (à côté de l'horloge). Clique sur l'icône pour rouvrir la fenêtre, ou clic droit → **Quit** pour vraiment quitter. Le même menu du clic droit marche sans ouvrir la fenêtre : il affiche la chanson en cours, ouvre n'importe quelle page (**Go to**) et a des interrupteurs pour **Show on Discord**, **Show lyrics** (un par présence quand il y en a plusieurs), **Translate lyrics on Discord**, le nombre de présences (**Presences**), les plateformes détectées (**Detection**, une case par plateforme comme dans Settings), **Hide when paused**, **Hide when I’m away**, **Hide during Spotify ads** et **Launch at sign-in**, plus **Check for updates**. Ce sont les mêmes réglages que dans la fenêtre.

Tu peux changer ça dans **Settings → App & window → Close to tray**. La même page a **Theme** (sombre ou clair) et **Accent colour**, le vert des boutons, des interrupteurs et des liens : choisis une pastille ou n'importe quelle couleur. Ta carte Discord garde les couleurs de Discord.

### Après une mise à jour

Les mises à jour se téléchargent toutes seules et s'installent quand tu quittes l'appli. La première fois que tu ouvres la fenêtre sur la nouvelle version, **What's new** montre ce qui a changé, avec un lien vers les notes de version complètes. Il ne s'affiche qu'une fois ; **Settings → About → What's new** le rouvre.

### Les pages

| Page | À quoi ça sert |
| --- | --- |
| **Now playing** | Deux côtés, comme un miroir. **On your screen**, à gauche : le morceau en cours (pochette, titre, artiste, album, lecteur et progression ; en pause, il reste affiché avec sa barre arrêtée, jusqu'à ce que tu fermes le lecteur ou que tu coupes sa détection) et les paroles qui défilent (clique dessus pour voir tout le morceau, ou sur **Big lyrics** pour les afficher en grand dans toute la fenêtre, comme Spotify ; **Échap** ferme). Des paroles trouvées sans minutage s'affichent en texte simple à faire défiler, marquées **Words only**. **On Discord**, à droite : ta carte telle que tes amis la voient, avec son menu **Source**, qui choisit le lecteur suivi. **Clique sur n'importe quelle partie de la carte** (ou sur **Customize**) pour la modifier : ce qu'affichent les lignes, le verbe, l'icône sur la pochette, ton bouton… Au milieu, des interrupteurs avec une flèche vers le côté qu'ils changent : **Visible** retire ton statut de Discord ou le remet, **Lyrics** active ou coupe les paroles des deux côtés, **Romanise** et l'un des deux **Translate** agissent sur Discord, l'autre **Translate** sur la fenêtre, et **Hide on Discord when** gère les pauses, l'absence et les pubs Spotify. **Why?** dit ce qui empêche ta carte d'apparaître sur Discord, avec un bouton pour corriger. |
| **Lyrics** | Ta bibliothèque de paroles perso : **My lyrics**, **Blocked** (les paroles signalées comme fausses) et le dump **LRCLIB** hors ligne. **Add lyrics** sert à importer ou écrire de nouvelles paroles. |
| **Activity** | Ce que tu as écouté sur 7 jours, 30 jours, 12 mois ou depuis toujours : temps d'écoute, graphique, top artistes et titres, et tes dernières écoutes (**See all** ouvre tout l'historique). La page se met à jour toute seule à la fin de chaque morceau. |
| **Settings** | Discord presence, Lyrics & translation, Detection, Integrations (extension navigateur, Spotify par Spicetify ou ta propre app Spotify, Last.fm), App & window et About. La barre de recherche trouve n'importe quel réglage. |
| **Help & setup** | La liste de configuration, en bas de la barre latérale. |

Le bas de la barre latérale indique aussi si Discord est connecté et ce qui est détecté.

Astuce : les touches **1 à 4** passent de Now playing à Lyrics, Activity et Settings. **Ctrl+Q** quitte l'appli.

---

## Problèmes courants

### Rien n'est détecté

Sur **Now playing**, ouvre le menu **Source**. Il liste tous les lecteurs que Windows signale ; s'il est vide, c'est que ton lecteur ne communique pas avec Windows.

**Comment vérifier :** appuie sur une touche média (play/pause) de ton clavier. Si l'encart de volume Windows affiche le titre du morceau, Vybecord peut le voir. S'il n'affiche rien, Vybecord ne peut rien voir non plus — c'est une limite du lecteur, pas de l'appli.

### Le statut n'apparaît pas sur Discord

- Sur **Now playing**, clique sur **Why?**, en haut à droite : il vérifie tout ce qu'il y a entre la chanson et ta carte, dit ce qui bloque et propose un bouton pour corriger.
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

Une vidéo **à âge restreint** affiche « 🔞 CC unavailable » : YouTube ne donne ses sous-titres qu'à un compte connecté dont l'âge est vérifié. Si tu la regardes dans un navigateur avec l'extension, active **Share my YouTube sign-in for captions** dans les options de l'extension (désactivé par défaut ; ton navigateur demande la permission). L'extension passe alors tes cookies YouTube à Vybecord, seulement pour les vidéos à âge restreint, et les sous-titres remplacent la ligne 🔞 quelques secondes plus tard. Vybecord garde les cookies en mémoire seulement. Un navigateur qui n'est pas connecté à YouTube n'a rien à prêter.

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

### Sans musique, ma carte affiche « Nothing playing »

Quand aucun lecteur ne joue quoi que ce soit, la présence 1 affiche **Listening to Vybecord · Nothing playing** avec le logo de Vybecord. Pendant ses cinq premières secondes, la liste Active Now de Discord montre encore l'icône du dernier lecteur à côté ; ensuite la carte passe sur l'application de Vybecord et l'icône suit. Pour ne rien afficher du tout à la place, active **Hide when paused**.

### La pochette s'affiche dans la fenêtre mais pas sur Discord

La fenêtre lit l'image directement sur ton disque. Discord ne peut pas : il lui faut une URL. Vybecord publie donc la pochette que montre ton lecteur (celle de Spotify, d'Apple Music, ou celle d'un fichier local) sur son propre stockage de pochettes, et Discord la charge de là : jamais l'audio, et les infos d'appareil photo et de localisation sont retirées avant. C'est **Settings → Integrations → Cover images → Publish the player's cover**, activé par défaut.

Seulement quand il n'y a pas de telle pochette — l'option est coupée, ou le lecteur n'en donne pas — Vybecord cherche l'album dans un catalogue musical public (Deezer, puis iTunes d'Apple) à la place.

Une image par défaut sur Discord veut donc dire l'une de deux choses : cette option est coupée et le morceau n'est dans aucun catalogue, ou c'est un live, qui n'est jamais recherché.

### Obtenir plus de détails sur la lecture navigateur

Windows dit à Vybecord ce qui joue, pas sur quel site : un onglet SoundCloud et un onglet YouTube sont identiques.

L'extension navigateur optionnelle corrige ça. **Settings → Integrations → Browser extension** te guide :

- **Chrome, Edge, Brave, Opera, Vivaldi** — clique sur **Open the extension folder**, ouvre la page des extensions de ton navigateur (le panneau copie son adresse pour toi), active le **Mode développeur**, clique sur **Charger l'extension non empaquetée** et choisis ce dossier.
- **Firefox 140 ou plus récent** (aussi Zen, LibreWolf, Waterfox, Floorp) — télécharge `vybecord-extension-<version>-firefox.zip` depuis la [page des releases](https://github.com/TheUnknownMurda/VybecordTS/releases/latest), ouvre `about:debugging#/runtime/this-firefox`, clique sur **Charger un module complémentaire temporaire** et choisis le zip. Firefox retire les modules temporaires à sa fermeture.
- **Safari** n'est pas pris en charge : Safari n'existe pas sur Windows.

Son icône ouvre une page de réglages avec un interrupteur par site — Spotify, YouTube, SoundCloud, Bandcamp, Twitch, Kick — tous actifs par défaut, et l'interrupteur optionnel **Share my YouTube sign-in for captions** (désactivé par défaut, voir la section sur les sous-titres plus haut).

Avec elle, chaque site est correctement identifié, la présence pointe directement vers le morceau, et la barre de progression lit l'élément audio de la page au lieu de la position système, plus grossière. Sans elle, tout ce qui suit reste valable.

### Les détails de Spotify sans Spicetify

Spicetify est la façon la plus complète de lire Spotify, mais il modifie l'appli Spotify. Si tu as **Spotify Premium** et que tu préfères t'en passer, Vybecord peut interroger l'API de Spotify à la place, avec une app Spotify à toi. **Settings → Integrations → Spotify → Spotify without Spicetify** te guide :

1. Sur le [tableau de bord développeur de Spotify](https://developer.spotify.com/dashboard), crée une app (n'importe quel nom et description). À la question sur les API que tu comptes utiliser, coche **Web API**.
2. Dans les réglages de l'app, ajoute ce Redirect URI, exactement : `http://127.0.0.1:8889/callback`. Le panneau a un bouton **Copy** pour ça.
3. Colle le **Client ID** de l'app dans le panneau et clique sur **Save**. Il n'y a pas de secret à copier.
4. Clique sur **Sign in with Spotify** et approuve la page qui s'ouvre dans ton navigateur. Elle permet seulement à l'app de voir ce que tu écoutes.

Tu as alors la vraie pochette, tous les artistes, la playlist, l'aléatoire et la répétition et la position exacte, sur n'importe quel appareil où tu joues (le PC, le lecteur web, ton téléphone). Les paroles officielles de Spotify sont la seule chose qu'elle ne peut pas donner : les paroles viennent des sources habituelles. Un changement de morceau apparaît en quelques secondes plutôt qu'instantanément. Pendant que Spicetify rapporte, ce mode se met en veille.

Spotify ne fait tourner une telle app que si son propriétaire (toi) a Premium. Si le panneau dit que Spotify a refusé, ajoute ton courriel Spotify dans **User Management** dans les réglages de l'app. Spotify met fin à la connexion six mois après que tu t'es connecté, donc le panneau te prévient deux semaines avant ; reconnecte-toi à ce moment-là. Si la page de Spotify affiche **INVALID_CLIENT: Invalid redirect URI**, le Redirect URI de ton app n'est pas exactement celui ci-dessus.

### SoundCloud apparaît comme un navigateur, pas comme SoundCloud

Sans l'extension navigateur, Windows indique à Vybecord ce qui joue, mais pas sur quel site : un onglet SoundCloud et un onglet YouTube sont identiques. Installe l'extension (voir plus haut) et SoundCloud est annoncé comme SoundCloud, avec un lien vers le morceau.

Même sans elle, le titre et l'artiste sont analysés avec les conventions de SoundCloud, donc un upload intitulé « Artiste - Titre (prod. Machin) » donne le bon artiste plutôt que le compte qui a mis en ligne. Les paroles, la pochette et la présence elle-même ne sont pas affectées — elles se basent sur le morceau et l'artiste, pas sur le site. Tant que le site n'est pas identifié, cet onglet dépend de l'interrupteur **Other browser tabs** dans **Settings → Detection**, et non de **SoundCloud**.

### Twitch et Kick

Avec l'extension, un onglet Twitch ou Kick a une carte pour ce qu'il affiche :

- **Une chaîne en direct** — la chaîne, le titre du stream, la catégorie et depuis combien de temps il est en ligne.
- **Une chaîne hors ligne** — la chaîne et **Offline**, avec le titre de son dernier stream sur la pochette. Elle ne prend qu'une carte que rien d'autre ne veut, donc la musique passe toujours avant. Pour qu'un tel onglet n'affiche rien du tout, désactive **Offline channels** dans **Settings → Detection**.
- **Une rediffusion ou un clip** — la chaîne, le titre de la vidéo et une barre de progression. Avant, ils s'affichaient comme YouTube.

Le nom et la photo de la chaîne viennent de Twitch lui‑même (et du site de Kick sur Kick) : la carte ne s'ouvre plus sur le nom de quelqu'un d'autre ni sur ton propre avatar pendant que la page charge. L'image reste celle de la chaîne, la catégorie s'affiche quand on la survole, et un clic dessus ouvre la page de la catégorie (Just Chatting, le jeu en cours…). Sur Kick, ce lien demande l'extension 2.2.3 ou plus récente ; avant, l'image ouvre la chaîne. Après une mise à jour de Vybecord, clique sur la flèche de rechargement de l'extension dans la page des extensions de ton navigateur pour qu'elle prenne la nouvelle version.

**Les sous-titres de Kick comme paroles.** Active les sous-titres (**CC**) dans le lecteur de Kick et, sur une chaîne en direct ou une rediffusion, ce qui se dit s'affiche sur la carte comme les paroles d'une chanson : la ligne d'avant en haut et, en dessous, la ligne en train d'être dite, qui s'allonge mot à mot à mesure que le lecteur les affiche. La fenêtre **Now playing** les marque **Live captions** (simplement **Captions** sur une rediffusion). Ça marche avec les deux sortes que Kick propose : les sous-titres fournis avec le stream, et ceux que Chrome tire du son du stream. L'extension les lit sur le lecteur, donc elle ne les voit que s'ils sont activés, et la carte revient au titre du stream quand personne n'a parlé depuis 25 secondes. Si tu avances ou recules dans une rediffusion, les lignes repartent de là où tu arrives. Avec la traduction activée, chaque ligne est traduite une fois complète. Quand ça parle vite, le lecteur de Kick saute lui-même des lignes faute de place, et celles-là ne peuvent pas arriver sur la carte non plus. L'interrupteur **Lyrics** les coupe comme n'importe quelles paroles. Les streams et rediffusions Twitch, et les clips des deux sites, n'ont pas de paroles.

### Shorts YouTube

Avec l'extension (2.2.2 ou plus récente), un Short a sa propre carte au lieu de passer pour un onglet de navigateur :

- **[Shorts]** devant le titre du Short, et ses hashtags après, où que le titre les ait mis (#shorts lui-même disparaît : [Shorts] le dit déjà) ;
- sa chaîne, qui mène à la page de la chaîne. Quand l'extension ne peut pas lire le lien sur la page, Vybecord le demande à YouTube, alors le lien peut arriver quelques secondes après le Short ;
- l'image du Short, à la verticale, plutôt qu'une bande entre deux zones floues ;
- **YouTube Shorts** en troisième ligne, et la barre de progression du Short lui-même, de son début à sa fin, qui repart à chaque boucle ;
- **Watching**, ou **Listening to** si tu préfères : c'est **Settings → Discord presence → Activity type for Shorts**, aussi à un clic sur le verbe de la carte dans **Now playing**. Ça vaut pour toutes les cartes, et tout ce qui n'est pas un Short garde son propre verbe ;
- le bouton ouvre le Short.

Un Short n'est jamais cherché comme une chanson : son titre n'est pas le nom d'une chanson, et une chanson qui joue dessous en est un extrait de quelques secondes, que les minutages d'une chanson ne suivraient pas. Si le Short a des sous-titres sur YouTube, ce qui se dit s'affiche sur la carte, comme pour une vidéo. Les Shorts restent hors de l'historique d'écoute, d'**Activity** et de Last.fm, comme une chaîne hors ligne. Sans l'extension, Windows ne voit qu'un onglet de navigateur et un Short s'affiche comme avant.

### Deux choses jouent en même temps

Sur **Now playing**, ouvre le menu **Source** et choisis le lecteur que tu veux afficher. Il reste épinglé jusqu'à ce que tu choisisses **Automatic**.

Ou affiche-les toutes. **Settings → Discord presence → Several presences** met jusqu'à cinq cartes sur ton profil : la chanson Spotify en présence 1, la vidéo du navigateur en présence 2, un stream dans un autre onglet en présence 3, par exemple. Ce qui joue avec le rang le plus élevé devient la présence 1 (une appli de musique passe avant une vidéo, une vidéo avant un onglet anonyme), ce qui suit la présence 2, et ainsi de suite. Avec plus d'une carte :

- Les onglets d'un même site sont des choses distinctes : quatre streams Twitch ouverts côte à côte prennent quatre cartes. Une application Discord ne porte qu'une carte, donc une fois les applications de la plateforme prises, les autres en empruntent une — l'application Vybecord par défaut, puis l'application d'une plateforme que rien n'occupe — et la carte nomme sa plateforme dans l'en‑tête de toute façon. La liste **Active Now** de Discord affiche par contre le logo de l'application empruntée, donc une carte retourne sur l'application de sa plateforme dès qu'il y en a une de libre.
- **Lyrics on presence N** choisit quelles cartes affichent les paroles — n'importe quelle combinaison.
- **Activity type on presence N** donne à chaque carte son propre verbe : *Listening* pour la chanson, *Watching* pour le stream. Les cartes 2 à 5 disent la même chose que la présence 1 tant que tu ne les changes pas.
- **Now playing** montre toutes les cartes du côté **On Discord** ; clique sur une petite carte pour voir ses paroles et l'afficher en grand. Son menu **Source** épingle cette présence à un lecteur, pour qu'elle ne s'échange jamais avec une autre, et un clic sur ses parties les modifie.
- L'historique d'écoute (et donc **Activity**) et Last.fm ne suivent que la présence 1.
- Avec les paroles sur deux cartes ou plus, les cartes peuvent changer de place sur ton profil à chaque ligne : Discord met en haut la carte qui vient de changer, et Vybecord ne peut pas imposer l'ordre. La fenêtre te prévient quand les paroles s'activent sur une deuxième carte. Une carte *Playing* passe toujours au-dessus des cartes *Listening* et *Watching*.

Chaque carte est une application Discord à part. Spotify, SoundCloud et Apple Music en ont une chacun, YouTube trois, et Kick et Twitch cinq chacun : jusqu'à cinq streams Kick ou Twitch gardent tous leur logo. Une carte dont la plateforme n'a plus d'application libre en emprunte une autre. Avec celle par défaut, ça fait dix-sept applications pour cinq cartes au maximum : il n'y a rien à configurer.

---

## Questions fréquentes

**Est-ce que ça marche sans Spotify Premium ?**
Oui. Vybecord lit ce que Windows sait déjà, et Spicetify marche aussi avec un compte gratuit. Premium ne compte que si tu choisis de lire Spotify par son API plutôt que par Spicetify (voir *Les détails de Spotify sans Spicetify*).

**Faut-il installer Spicetify ou une extension de navigateur ?**
Non. Les anciennes versions le demandaient, plus celle-ci. Ce sont deux bonus optionnels : Spicetify apporte les changements de morceau instantanés, les paroles officielles de Spotify et le DJ (la carte l'indique, et la voix du DJ entre les chansons n'a ni paroles ni historique) (à configurer dans **Settings → Integrations → Spotify**), et l'extension navigateur indique à Vybecord sur quel site joue un onglet. Avec Premium, ta propre app Spotify donne presque tout ce que donne Spicetify, sans toucher à Spotify.

**Ça marche avec quoi ?**
Tout ce qui apparaît dans l'encart média de Windows : Spotify, les onglets de navigateur (YouTube, SoundCloud, Deezer…), VLC, foobar2000, MusicBee, AIMP, Apple Music, Tidal, Amazon Music.

**Est-ce que mes données sortent de mon PC ?**
Les titres et artistes sont envoyés aux services de paroles (LRCLib, Netease, Musixmatch, Genius) pour chercher les paroles, à Deezer et iTunes d'Apple pour trouver la pochette (et, pour Apple Music, la page de l'album que la pochette ouvre sur Discord, comme celle de Spotify), et à Discord pour le statut. La pochette que montre ton lecteur (celle de Spotify, d'Apple Music, d'un fichier local) est publiée sur le stockage de pochettes de Vybecord, sans ses métadonnées, et un catalogue n'est consulté que s'il n'y en a pas — désactivable dans **Settings → Integrations → Cover images**. Pour une chaîne Twitch, le nom de la chaîne part chez Twitch pour obtenir son titre, son image et l'heure de début du stream. Si tu actives la traduction, les lignes de paroles partent au service de traduction ; si tu actives Last.fm, tes écoutes y vont aussi ; si tu te connectes avec ta propre app Spotify, Vybecord demande à Spotify ce que tu écoutes. L'historique, les réglages et les paroles importées restent en local. La liste complète est dans la [politique de confidentialité](https://theunknownmurda.github.io/VybecordTS/privacy/).

**Où sont mes fichiers ?**
Dans `%APPDATA%\Vybecord` — colle ce chemin dans l'explorateur.

**Je viens de VybecordTS 1.x, je perds quelque chose ?**
Ta configuration, ta base de paroles et ton historique sont conservés. Windows seul n'expose ni la playlist en cours, ni le mode aléatoire/répétition, ni les liens cliquables vers le morceau ; les extensions optionnelles Spicetify et navigateur les rétablissent. Désinstalle l'ancienne extension Spicetify 1.x et les scripts Tampermonkey — la nouvelle extension Spicetify s'installe depuis les Settings.

---

## Support

Un souci ? Utilise **Settings → About → Report a problem** dans l'appli (aussi sur **Help & setup**), ou ouvre un ticket sur [GitHub](https://github.com/TheUnknownMurda/VybecordTS/issues).
