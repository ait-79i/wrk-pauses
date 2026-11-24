# Contrat d'API — phases 2 et 3 (discussion, notifications, statistiques)

Référence commune au serveur (`server/`), au tableau de bord (`server/web/`) et à l'application Windows (`src/`).
Vocabulaire : [GLOSSARY.md](../GLOSSARY.md). Textes d'interface en français, ton direct, phrases courtes.
Les API de la phase 1 (`server/src/routes/app-api.ts`, `admin-api.ts`) restent compatibles.

## 1. Canaux de discussion

Clé de canal (`channel`) :
- `cat:<categoryId>` — discussion d'une catégorie : ses membres actifs, les admins de l'équipe, l'admin et les responsables horaires de cette catégorie.
- `admins:<teamId>` — discussion des admins de l'équipe : tout membre ayant au moins un rôle dans l'équipe, et le super admin.

Un membre ne voit que la discussion de **sa** catégorie (+ `admins:` s'il a un rôle). Jamais celle d'une autre catégorie.

Droits :
- `canPost` : membre actif, non réduit au silence (`mutedUntil` passé ou nul). Les admins du tableau de bord peuvent toujours écrire.
- `canAnnounce` (message de type `ANNOUNCEMENT`) : TEAM_ADMIN de l'équipe, CATEGORY_ADMIN ou SCHEDULER de la catégorie, super admin.
- `canModerate` (supprimer le message d'un autre, réduire au silence) : TEAM_ADMIN, CATEGORY_ADMIN de la catégorie, super admin.
- Chacun peut supprimer ses propres messages.

## 2. Objet `Message` (JSON)

```ts
interface MessageDTO {
  id: number;
  channel: string;                        // 'cat:12' | 'admins:3'
  kind: 'TEXT' | 'ANNOUNCEMENT' | 'SCHEDULE';
  author: { type: 'member' | 'admin' | 'system'; id: number | null; name: string };
  body: string;                           // vide si deleted ; texte brut (jamais de HTML), 1..2000 caractères
  replyTo: { id: number; authorName: string; excerpt: string } | null;   // excerpt : 80 caractères max
  schedule: {                             // uniquement pour kind = 'SCHEDULE' (carte de publication)
    date: string;                         // AAAA-MM-JJ
    prayer: 'DHUHR' | 'ASR' | 'JUMUA';
    change: 'published' | 'updated';
    slots: { groupId: number | null; groupName: string | null; timeMins: number }[];
    movedGroupIds: number[];
    removedGroupIds: number[];
    addedGroupIds?: number[];             // groupes ajoutés par une mise à jour (absent des cartes anciennes)
  } | null;
  mentions: { memberId: number; name: string }[];
  reactions: { emoji: string; count: number; mine: boolean }[];
  deleted: boolean;
  createdAt: string;                      // ISO 8601
}
```

- Les messages `SCHEDULE` sont créés par le serveur (`author.type = 'system'`, `name = 'Horaires'`) à chaque publication ou mise à jour des horaires (application **et** tableau de bord) dans le canal `cat:<categoryId>`. Republier exactement les mêmes horaires ne crée ni carte ni `schedule.changed`.
- Mentions : `@Prénom` dans le texte, comparé (sans casse, sans accents) aux noms des membres qui ont accès au canal. Le plus long nom correspondant gagne.
- Réactions autorisées : `👍 ❤️ 🤲 ✅ 😂 😮`. Une réaction par emoji et par personne (bascule).
- Conservation : 90 jours (purge quotidienne côté serveur).

## 3. API de l'application (`Authorization: Bearer <clé>`)

| Méthode | Route | Corps / requête | Réponse |
|---|---|---|---|
| GET | `/api/app/channels` | — | `{ channels: { key, name, unread, canPost, canAnnounce, canModerate, mutedUntil }[] }` |
| GET | `/api/app/messages` | `?channel=&before=<id>&limit=<1..100, 50>` | `{ messages: MessageDTO[] /* ordre croissant */, hasMore }` |
| POST | `/api/app/messages` | `{ channel, body, kind?: 'TEXT'\|'ANNOUNCEMENT', replyToId?: number }` | `201 MessageDTO` ; `403` si silence (`message` indique jusqu'à quand) ; limite 20/min |
| DELETE | `/api/app/messages/:id` | — | `{ ok: true }` |
| PUT | `/api/app/messages/:id/reactions` | `{ emoji }` | `MessageDTO` (bascule) ; limite 60/min |
| POST | `/api/app/read` | `{ channel, lastMessageId }` | `{ ok: true }` |
| GET (WebSocket) | `/api/app/ws` | 1er message du client : `{ "type": "auth", "token": "<clé>" }` | voir §5 |

`name` d'un canal : nom de la catégorie (`Hommes`) ou `Admins de l'équipe`. `unread` : messages d'autres auteurs après la dernière lecture (l'historique d'avant l'accès au canal compte comme lu). Limites par membre : 120/min pour `read`, 240/min pour les lectures ; `429` au-delà.

## 4. API du tableau de bord (cookie de session)

| Méthode | Route | Corps / requête | Réponse |
|---|---|---|---|
| GET | `/api/admin/teams/:id/channels` | — | `{ channels: { key, name, messages7d, lastMessageAt }[] }` (canaux visibles par l'acteur) |
| GET | `/api/admin/messages` | `?channel=&before=&limit=` | `{ messages: MessageDTO[], hasMore }` (`mine` toujours `false`) |
| POST | `/api/admin/messages` | `{ channel, body, kind?, replyToId? }` | `201 MessageDTO` (auteur `admin`, nom = nom du membre lié ou « Super admin ») |
| DELETE | `/api/admin/messages/:id` | — | `{ ok: true }` (modération) |
| POST | `/api/admin/members/:id/mute` | `{ minutes: number \| null }` (null = lever) | `{ mutedUntil: string \| null }` |
| GET | `/api/admin/teams/:id/stats` | `?from=AAAA-MM-JJ&to=AAAA-MM-JJ` (92 jours max, défaut : 30 derniers jours) | voir §6 |
| GET | `/api/admin/stats/global` | — (super admin) | voir §6 |
| GET (WebSocket) | `/api/admin/ws` | authentifié par le cookie | voir §5 |

Toute modération (suppression, silence) est tracée dans le journal d'activité (`message.delete`, `member.mute`, `member.unmute`). `message.delete` ne garde que des métadonnées (id, auteur, longueur), jamais le texte supprimé.
`GET /api/admin/teams/:id` (phase 1) renvoie en plus `mutedUntil` pour chaque membre.

## 5. Temps réel (WebSocket)

Le serveur envoie des objets JSON `{ type, ... }` :

| type | Champs | Destinataires |
|---|---|---|
| `ready` | — | après authentification |
| `message.created` | `message: MessageDTO` | tous ceux qui voient le canal (`mine`/`reactions` calculés pour chacun) |
| `message.updated` | `message: MessageDTO` | idem (suppression, réactions) |
| `schedule.changed` | `categoryId, date, prayer, change, movedGroupIds, removedGroupIds, addedGroupIds` | membres de la catégorie + admins qui la voient |
| `mention` | `message: MessageDTO` | le membre mentionné |
| `member.status` | `status: 'ACTIVE'\|'BLOCKED'\|'PENDING', mutedUntil` | le membre concerné (aussi après un changement de catégorie, de nom ou de rôles : l'application relit son profil) |

Le serveur envoie `{ "type": "ping" }` toutes les 30 s ; le client répond `{ "type": "pong" }` (connexion fermée après 2 ping sans réponse). Le client se reconnecte avec un délai croissant (1 s → 30 s). Une clé refusée ferme la connexion avec le code `4401`, y compris quand la clé est remplacée (transfert) ou le membre supprimé. Au plus 3 connexions par membre ou par session (les plus anciennes sont fermées avec `4000`). `/api/admin/ws` refuse (`4401`) une origine différente de `PUBLIC_URL`.

## 6. Statistiques

Le nombre de membres d'un groupe un jour donné = choix explicites ce jour-là + membres sans choix explicite dont le groupe habituel **actuel** est ce groupe (approximation indiquée dans l'interface).

`GET /api/admin/teams/:id/stats` :
```ts
{
  from: string; to: string;
  categories: {
    id: number; name: string; members: number;
    activeMembers7d: number;            // vus ces 7 derniers jours
    publicationRate: number;            // 0..1 : prières publiées / prières attendues (jours ouvrés passés ou du jour)
    participationRate: number;          // 0..1 : moyenne (inscrits / membres actifs) sur les prières publiées avec choix de groupe (Jumu'a exclue)
  }[];
  days: { date: string; categoryId: number; prayer: 'DHUHR'|'ASR'|'JUMUA'; published: boolean;
          publishedAt: string | null; total: number;
          slots: { groupId: number | null; groupName: string | null; timeMins: number; count: number }[] }[];
  groups: { groupId: number; name: string; categoryId: number; averageCount: number; averageTimeMins: number | null }[];
}
```

`GET /api/admin/stats/global` :
```ts
{ totals: { teams: number; members: number; activeMembers7d: number; messages7d: number };
  teams: { id: number; name: string; members: number; activeMembers7d: number;
           publicationRate7d: number; participationRate7d: number; messages7d: number }[] }
```

## 7. Application Windows

- Le processus principal (`TeamManager`) garde la connexion WebSocket et actualise `teamDay` à chaque `schedule.changed`.
- Notifications Windows (`Notification` d'Electron) : horaires publiés ou modifiés dans ma catégorie (« G2 déplacé à 12:40 »), mention, annonce, accès suspendu ou validé. Les messages ordinaires ne notifient pas : seulement un compteur non lu.
- Fenêtre « Discussion » (nouvelle `BrowserWindow`, `chat.html`) ouverte depuis le panneau d'équipe.
- Les membres qui peuvent publier le font depuis le panneau d'équipe (formulaire compact).
