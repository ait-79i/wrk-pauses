# Pause

Pause aide une équipe de bureau au Maroc à suivre sa journée de travail et à **prier ensemble**.

- **Pour chacun** : heure d'arrivée, pauses, heure de sortie, horaires officiels de prière et rappel plein écran.
- **Pour l'équipe** : chaque jour, un admin publie les horaires de Dhuhr et d'Asr par groupe (G1 à 12:26, G2 à 12:36…). Chacun choisit son groupe dans l'application, et le rappel se cale sur l'heure de ce groupe. Une discussion par catégorie remplace les messages d'horaires postés jusqu'ici à la main.

Le vocabulaire (Équipe, Catégorie, Groupe, Horaire du jour, Choix de groupe…) est défini dans [GLOSSARY.md](GLOSSARY.md).

---

## Sommaire

1. [Les trois parties](#les-trois-parties)
2. [Utiliser Pause](#utiliser-pause)
3. [Développer](#développer)
4. [Déployer](#déployer)
5. [Données et confidentialité](#données-et-confidentialité)
6. [Sécurité](#sécurité)
7. [Organisation du dépôt](#organisation-du-dépôt)
8. [Documentation](#documentation)

---

## Les trois parties

```
┌──────────────────────────┐        HTTPS + WebSocket         ┌──────────────────────────────┐
│ Application Windows      │ ───────────────────────────────▶ │ Serveur (Docker sur Coolify) │
│ Electron · src/          │   /api/app/*   (clé d'appareil)  │ Fastify + Prisma · server/   │
│ - journée et pauses      │                                  │ - équipes, horaires, choix   │
│ - rappel de prière       │                                  │ - discussion, temps réel     │
│ - prière en groupe       │                                  │ - statistiques, journal      │
└──────────────────────────┘                                  └───────────┬──────────────────┘
                                                                          │ MySQL 8.4
┌──────────────────────────┐        HTTPS + WebSocket                     │
│ Tableau de bord web      │ ───────────────────────────────▶  /api/admin/* (session + 2FA)
│ React · server/web/      │   servi par le même serveur sur https://pause.8hqi.com
└──────────────────────────┘
```

| Partie | Technologies | Pour qui |
|---|---|---|
| Application Windows (`src/`) | Electron 44, TypeScript 7, SQLite (sql.js) | chaque membre |
| Serveur (`server/`) | Node 24, Fastify 5, Prisma 7, MySQL 8.4, WebSocket | hébergé sur le serveur Oracle via Coolify |
| Tableau de bord (`server/web/`) | React 19, Vite | super admin et admins d'équipe |

L'application fonctionne aussi **seule**, sans rejoindre d'équipe : tout le suivi personnel reste local.

---

## Utiliser Pause

### Membre (application Windows)

1. **Journée** : saisissez l'heure d'arrivée, démarrez et terminez vos pauses. Pause calcule la pause disponible et l'heure de sortie selon les règles de la journée (réglables, mode Ramadan inclus).
2. **Rappel personnel** : dans le bandeau de prière, choisissez l'heure du rappel. Le rappel couvre tout l'écran ; son message se règle dans **Réglages › Prière**.
3. **Rejoindre une équipe** : panneau « Prière en groupe » › **Rejoindre**, puis le code d'accès donné par l'admin (ex. `K7P-2QW`) et votre prénom. Le code détermine votre catégorie (Hommes, Femmes…).
4. **Choisir son groupe** : dès que les horaires du jour sont publiés, un écran **« Avec quel groupe priez-vous ? »** couvre tous les moniteurs tant que vous n'avez pas de groupe. Touchez un groupe, ou **« Je ne prie pas avec un groupe »** pour le fermer. Il ne s'affiche pas si votre groupe habituel est publié, ni pendant une pause. Vous pouvez aussi choisir dans le panneau d'équipe (G1 12:26). Le chiffre indique combien de personnes y sont inscrites. Vous pouvez changer d'avis jusqu'à l'heure du groupe. **« Choisir G1 chaque jour »** en fait votre groupe habituel.
5. **Rappel de groupe** : il s'affiche 5 minutes avant l'heure de votre groupe et remplace votre rappel personnel pour cette prière. Hors ligne, les derniers horaires reçus restent utilisés.
6. **Vendredi** : dans une catégorie où Jumu'a est activée, Dhuhr est remplacée par un créneau unique de Jumu'a.
7. **Discussion** : bouton « Discussion » du panneau d'équipe ; elle s'ouvre à droite de la fenêtre principale, qui s'élargit (✕ ou Échap pour la refermer). Réponses, `@mentions`, réactions (👍 ❤️ 🤲 ✅ 😂 😮). Notifications Windows pour les horaires publiés ou modifiés, les mentions et les annonces (désactivables dans **Réglages › Prière en groupe**).
8. **Changer d'ordinateur** : demandez un **code de transfert** à un admin, puis « J'ai un code de transfert » dans le panneau d'équipe.

### Admin d'équipe, admin de catégorie, responsable horaires

- **Publier les horaires du jour** : depuis l'application (panneau d'équipe) ou le tableau de bord (onglet **Horaires du jour**). Le formulaire est prérempli avec les derniers horaires. Chaque publication crée une carte dans la discussion et prévient les membres.
- **Publication automatique** : si personne n'a publié une prière **20 minutes avant son heure officielle** (Aladhan, ville de l'équipe), le serveur republie à l'identique la dernière publication de cette prière. Sans publication antérieure : G1 à l'heure officielle, puis un groupe toutes les **10 minutes** (G1, G2). Jumu'a reprend sa dernière heure. Une publication faite par un admin n'est jamais remplacée.
- **Modifier** un horaire déjà publié : les membres gardent leur choix et sont prévenus (« G2 déplacé à 12:40 ») ; retirer un groupe efface les choix qui le visaient.
- **Discussion** : publier une **annonce**, supprimer un message, réduire un membre au silence (1 h, 24 h, 7 jours).
- **Membres** (admin d'équipe) : valider, bloquer, changer de catégorie, donner un rôle, générer un code de transfert, créer un accès au tableau de bord.
- **Catégories et groupes** : ajouter un groupe (G3…), régler la limite (10 par défaut), activer Jumu'a, régénérer un code d'accès (avec expiration optionnelle).

| Rôle | Peut… |
|---|---|
| Super admin | tout, sur toutes les équipes ; crée les équipes et nomme les admins d'équipe |
| Admin d'équipe | gérer son équipe : codes, catégories, membres, rôles, horaires, modération |
| Admin de catégorie | gérer sa catégorie : groupes, limite, Jumu'a, horaires, modération |
| Responsable horaires | publier les horaires de sa catégorie et des annonces |
| Membre | choisir son groupe, discuter dans sa catégorie |

### Super admin (tableau de bord)

- **Vue d'ensemble** : toutes les équipes, horaires publiés ou non aujourd'hui, statistiques globales sur 7 jours.
- **Statistiques** par équipe : taux de publication, participation par catégorie, effectif moyen par groupe (7, 30 ou 90 jours).
- **Comptes admin** : ajouter un super admin, désactiver un compte, réinitialiser un mot de passe ou la double authentification.
- **Journal d'activité** : toutes les actions d'administration, conservées un an.

---

## Développer

### Prérequis

- Windows, Node.js 24, Docker Desktop.
- npm 11 bloque les scripts d'installation non approuvés : ceux qui sont nécessaires sont déjà listés dans `allowScripts` des `package.json`.

### Application Windows

```bash
npm install
npm run typecheck   # vérification stricte des types
npm start           # compile puis lance Electron
npm run dist        # installateur Windows dans release/
```

Pour la relier à un serveur local plutôt qu'à `https://pause.8hqi.com` :

```powershell
$env:PAUSE_SERVER_URL = "http://127.0.0.1:3100"; npm start
```

> Lancée depuis un terminal VS Code, Electron hérite de `ELECTRON_RUN_AS_NODE=1` et se ferme aussitôt : supprimez cette variable avant de lancer l'application (`Remove-Item Env:ELECTRON_RUN_AS_NODE`).

### Serveur et tableau de bord

```bash
docker run -d --name pause-mysql-dev -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=pause -p 3308:3306 mysql:8.4

cd server
cp .env.example .env                 # renseignez SUPERADMIN_EMAIL et SUPERADMIN_PASSWORD
npm ci
DATABASE_URL=mysql://root:root@localhost:3308/pause npx prisma migrate deploy
npm run dev                          # API + tableau de bord compilé sur http://localhost:3100

cd web && npm ci && npm run dev      # tableau de bord avec rechargement sur http://localhost:5173
```

Détails, modification du schéma et dépannage : [server/README.md](server/README.md).

### Tests

```powershell
# Base dédiée, vidée à chaque lancement
docker exec pause-mysql-dev mysql -uroot -proot -e "CREATE DATABASE IF NOT EXISTS pause_test"
Set-Location "E:\…\server"            # lettre de lecteur en MAJUSCULE, sinon Vitest charge ses modules deux fois
$env:DATABASE_URL = "mysql://root:root@localhost:3308/pause_test"; npx prisma migrate deploy
$env:TEST_DATABASE_URL = "mysql://root:root@localhost:3308/pause_test"; npx vitest run
```

57 tests : règles métier (jours, Jumu'a, choix de groupe), parcours complet de l'API, discussion et temps réel (vraie connexion WebSocket), statistiques.

---

## Déployer

### Serveur (Coolify sur le serveur Oracle)

1. DNS : `pause.8hqi.com` → IP du serveur Oracle. Ouvrez les ports 80 et 443 (liste de sécurité du VCN **et** pare-feu de l'instance).
2. Coolify : **New Resource › Docker Compose**, ce dépôt, **Base Directory** `/server`.
3. Domaine du service `app` : `https://pause.8hqi.com`. Variables : `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` (12 caractères minimum).
4. **Deploy** : le conteneur applique les migrations, crée le super admin et sert l'API et le tableau de bord.
5. Connectez-vous sur `https://pause.8hqi.com/admin` et activez la double authentification. La racine `https://pause.8hqi.com` est la page d'accueil publique (présentation et installation).
6. Publiez l'application Windows : **/admin › Application Windows**, déposez `release\Pause-Setup-x.y.z.exe` (envoyé par morceaux de 16 Mo, compatible avec la limite de 100 Mo de Cloudflare). Le lien direct `https://pause.8hqi.com/telecharger/windows` propose toujours la dernière version ; les fichiers sont gardés dans le volume `pause-downloads`. Variante : définir `DESKTOP_DOWNLOAD_URL` (ex. une release GitHub/GitLab) vers laquelle ce lien redirige tant qu'aucun fichier n'a été envoyé.
7. Programmez une sauvegarde de MySQL dans Coolify (**Backups**).

Guide complet : [server/README.md](server/README.md).

### Application Windows

Le workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) compile l'installateur et publie une release GitHub à chaque tag de version :

```bash
npm run release:patch    # 1.0.1 → 1.0.2, crée le tag et pousse
```

Les notes de version sont générées par [`scripts/generate-changelog.js`](scripts/generate-changelog.js) à partir des commits.

**Tout est ensuite automatique** :
- **Site** : le lien direct `https://pause.8hqi.com/telecharger/windows` (bouton de la page d'accueil) redirige vers l'installateur de la **dernière release GitHub** (`DESKTOP_GITHUB_REPO`, par défaut `ait-79i/wrk-pauses`, vérifiée toutes les 10 min). Aucun envoi manuel ; un fichier envoyé depuis **/admin › Application Windows** reste possible et l'emporte s'il est plus récent.
- **Application installée** : elle vérifie les releases au démarrage puis toutes les 4 h (`electron-updater`, fichier `latest.yml` de la release), télécharge la nouvelle version en arrière-plan et l'installe à la fermeture ; la notification « Pause x.y.z est prête » permet de redémarrer tout de suite. Menu de la zone de notification : **Rechercher une mise à jour**.
- Les ordinateurs encore en 1.0.1 (sans mise à jour automatique) doivent installer une fois la version suivante ; ensuite, les mises à jour se font seules.

---

## Données et confidentialité

| Où | Quoi |
|---|---|
| `%APPDATA%\Pause\state.json` | journée en cours, réglages, horaires du jour, données d'équipe reçues |
| `%APPDATA%\Pause\history.sqlite` | historique des journées |
| `%APPDATA%\Pause\team-key.bin` | clé de l'appareil, chiffrée par Windows (DPAPI) |
| Dossier de synchronisation choisi (Google Drive…) | copie de l'historique et des réglages, si la synchronisation est activée |
| Serveur MySQL | équipes, catégories, groupes, membres (prénom), horaires, choix de groupe, discussions, journal d'activité |

- **Le serveur ne connaît pas les pauses** ni les heures d'arrivée et de sortie : personne, pas même le super admin, ne voit le temps de pause d'un membre ([ADR 0002](docs/adr/0002-serveur-equipes-sans-donnees-de-pause.md)).
- Un membre ne voit que la discussion et les horaires de **sa** catégorie.
- Les messages sont supprimés après **90 jours**, le journal d'activité après **un an**.

---

## Sécurité

- **Membres** : pas de mot de passe ; l'identité est une clé secrète propre à l'ordinateur, stockée chiffrée et jamais exposée aux fenêtres de l'application ([ADR 0001](docs/adr/0001-membres-identifies-par-appareil.md)). Noms uniques par équipe, validation optionnelle des nouveaux membres, code de transfert à usage unique (24 h).
- **Tableau de bord** : email et mot de passe (scrypt), session en cookie `httpOnly` `SameSite=Strict`, double authentification obligatoire pour le super admin.
- **Serveur** : validation de toutes les entrées (zod), limites de débit (connexion, adhésion, messages, réactions, connexions WebSocket), en-têtes de sécurité (CSP, HSTS en production), contrôle de l'origine sur le WebSocket du tableau de bord, conteneur sans droits root.
- **Application** : la fenêtre de discussion, seule à afficher le texte d'autres personnes, est isolée (`contextIsolation`, `sandbox`, CSP stricte) ; tout texte reçu est inséré comme texte, jamais comme HTML.
- **Journal d'activité** : publications, modération, codes, rôles, comptes.

---

## Organisation du dépôt

```
.
├── GLOSSARY.md                     # vocabulaire du domaine
├── docs/
│   ├── adr/                        # décisions d'architecture
│   └── contrat-api-phases-2-3.md   # routes, objets JSON et évènements temps réel
├── src/                            # APPLICATION WINDOWS
│   ├── main/
│   │   ├── main.ts                 # fenêtres, zone de notification, rappels, IPC
│   │   ├── team.ts                 # équipe : API, WebSocket, notifications Windows
│   │   ├── preload.ts              # pont des fenêtres principales
│   │   ├── chat-preload.ts         # pont réduit de la fenêtre de discussion (isolée)
│   │   └── store.ts, history.ts, sync.ts, exporter.ts, types.ts, shared.ts
│   ├── shared/                     # règles partagées : salat-core (horaires, rappels), day-core (journée), salat-card
│   └── renderer/                   # fenêtres : popup (+ team-panel, reminder-picker), chat, alert, pause, settings, history
├── server/                         # SERVEUR + TABLEAU DE BORD
│   ├── prisma/                     # schéma MySQL et migrations
│   ├── src/
│   │   ├── routes/                 # app-api, admin-api, chat-api, stats-api, validation
│   │   ├── services/               # rules (règles pures), schedule, access, chat, realtime, stats
│   │   └── lib/                    # sécurité, heure locale, journal, erreurs, session admin
│   ├── test/                       # Vitest (unitaires + intégration MySQL)
│   ├── web/                        # tableau de bord React
│   ├── Dockerfile, docker-compose.yml, .env.example
│   └── README.md                   # déploiement et développement du serveur
├── scripts/generate-changelog.js
├── .github/workflows/release.yml
└── package.json                    # application Windows et configuration electron-builder
```

---

## Documentation

| Document | Contenu |
|---|---|
| [GLOSSARY.md](GLOSSARY.md) | définition de chaque terme du domaine |
| [docs/adr/](docs/adr/) | décisions difficiles à défaire et leurs raisons |
| [docs/contrat-api-phases-2-3.md](docs/contrat-api-phases-2-3.md) | API de discussion, temps réel et statistiques |
| [server/README.md](server/README.md) | déploiement Coolify, développement et tests du serveur |
