# Serveur Pause — équipes de prière

API et tableau de bord web des équipes (vocabulaire : [GLOSSARY.md](../GLOSSARY.md), décisions : [docs/adr](../docs/adr)).
Node 24 + TypeScript (Fastify, Prisma 7), MySQL 8.4, tableau de bord React servi par le même conteneur.

- `/api/app/*` : application Windows (identité du membre = clé de l'appareil)
- `/api/admin/*` : tableau de bord (session par cookie, 2FA obligatoire pour le super admin)
- `/` : tableau de bord web

Routes, objets JSON et évènements temps réel : [contrat des phases 2 et 3](../docs/contrat-api-phases-2-3.md).

## Discussion, temps réel et statistiques

- **Discussion** : un canal par catégorie (`cat:<id>`) et un canal des admins (`admins:<teamId>`). Un membre ne voit que sa catégorie, plus `admins:` s'il a un rôle. Chaque publication d'horaires (application ou tableau de bord) ajoute une carte `SCHEDULE` dans le canal de la catégorie.
- **Temps réel** : WebSocket `/api/app/ws` (premier message `{ "type": "auth", "token": "<clé>" }`) et `/api/admin/ws` (cookie de session). Ping toutes les 30 s, connexion fermée après 2 ping sans réponse ; clé ou session refusée : code `4401`. Derrière un proxy, l'en-tête `Upgrade` doit être relayé (c'est le cas avec Coolify/Traefik).
- **Limites** : 20 messages par minute et par auteur (compté en mémoire, remis à zéro au redémarrage), 2000 caractères par message.
- **Conservation** : les messages de plus de 90 jours sont supprimés chaque jour, comme le journal d'activité au-delà d'un an.
- **Statistiques** : `GET /api/admin/teams/:id/stats` (92 jours au plus, 30 derniers jours par défaut) et `GET /api/admin/stats/global` (super admin, 7 derniers jours). Les effectifs sont estimés avec le groupe habituel **actuel** des membres sans choix explicite.

## Déployer sur Coolify (serveur Oracle)

1. Dans Coolify : **New Resource → Docker Compose**, dépôt Git de ce projet, **Base Directory** `/server`, fichier `docker-compose.yml`.
2. **Domains** du service `app` : `https://pause.8hqi.com` (port 3000). Le DNS `pause.8hqi.com` doit pointer vers l'IP du serveur Oracle ; Coolify obtient le certificat HTTPS.
3. **Environment Variables** :
   - `SUPERADMIN_EMAIL` : votre email
   - `SUPERADMIN_PASSWORD` : 12 caractères minimum (utilisé seulement au premier démarrage)
   - `SERVICE_PASSWORD_MYSQL`, `SERVICE_PASSWORD_MYSQLROOT` : générés par Coolify
4. **Deploy**. Au démarrage, le conteneur applique les migrations puis crée le super admin.
5. Ouvrez `https://pause.8hqi.com`, connectez-vous et activez la double authentification (QR code).
6. Sur Oracle Cloud, ouvrez les ports 80 et 443 (liste de sécurité du VCN **et** pare-feu de l'instance).

Sauvegardes : le volume `pause-mysql-data` contient toutes les données ; programmez une sauvegarde MySQL dans Coolify (**Backups**).

## Développement

```bash
docker run -d --name pause-mysql-dev -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=pause -p 3307:3306 mysql:8.4
cp .env.example .env            # puis renseignez SUPERADMIN_*
npm ci
DATABASE_URL=mysql://root:root@localhost:3307/pause npx prisma migrate deploy
npm run dev                                             # API sur http://localhost:3100 (lit .env)
cd web && npm ci && npm run dev                         # tableau de bord sur http://localhost:5173
```

Application Windows contre ce serveur local : lancer avec `PAUSE_SERVER_URL=http://127.0.0.1:3100`.

Tests (base `pause_test` dédiée, vidée à chaque lancement) :

```bash
TEST_DATABASE_URL=mysql://root:root@localhost:3307/pause_test npx vitest run
```

Sous Windows, lancez les tests depuis un chemin avec la lettre de lecteur en majuscule (`E:\…`) : sinon Vitest charge deux fois ses modules.

## Modifier le schéma

```bash
DATABASE_URL=mysql://root:root@localhost:3307/pause npx prisma migrate dev --name <changement>
```

Commitez le dossier `prisma/migrations` : la production l'applique au démarrage.
