// Discussion : canaux, droits, messages, mentions, réactions (contrat : docs/contrat-api-phases-2-3.md §1–2).
// Le temps réel (WebSocket) est dans realtime.ts ; les routes dans routes/chat-api.ts.

import type { Db } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors.js';
import { hashToken } from '../lib/security.js';
import { minsToHHMM } from '../lib/time.js';
import { canManageCategory, canManageTeam, canPublish, hasAnyRole, scopeFrom, type RoleRow, type Scope } from './access.js';
import type { PublishResult } from './schedule.js';

export const ADMIN_COOKIE = 'pause_admin';
export const BODY_MAX = 2000;
const EXCERPT_MAX = 80;
const RETENTION_MS = 90 * 24 * 3600_000;
const POST_LIMIT = 20;
const POST_WINDOW_MS = 60_000;

/**
 * Réactions autorisées. En base on stocke la clé ASCII : la collation utf8mb4_unicode_ci
 * confond la plupart des emoji entre eux (l'unicité par emoji ne tiendrait pas).
 */
const REACTIONS: { key: string; emoji: string }[] = [
    { key: 'thumbs', emoji: '👍' },
    { key: 'heart', emoji: '❤️' },
    { key: 'dua', emoji: '🤲' },
    { key: 'check', emoji: '✅' },
    { key: 'laugh', emoji: '😂' },
    { key: 'wow', emoji: '😮' }
];
const EMOJI_BY_KEY = new Map(REACTIONS.map((r) => [r.key, r.emoji]));
const KEY_BY_EMOJI = new Map(REACTIONS.map((r) => [r.emoji, r.key]));
KEY_BY_EMOJI.set('❤', 'heart'); // cœur sans sélecteur de variante

const PRAYER_LABEL: Record<string, string> = { DHUHR: 'Dhuhr', ASR: 'Asr', JUMUA: 'Jumu\'a' };

export const CHANNEL_RE = /^(cat|admins):([1-9]\d{0,9})$/;

// ------------------------------------------------------------------ Acteurs

/** Membre identifié par sa clé d'appareil */
export interface MemberActor {
    type: 'member';
    id: number;
    name: string;
    status: 'PENDING' | 'ACTIVE' | 'BLOCKED';
    teamId: number;
    categoryId: number;
    mutedUntil: Date | null;
    roles: RoleRow[];
    scope: Scope;
}

/** Admin du tableau de bord (session vérifiée) */
export interface AdminActor {
    type: 'admin';
    id: number;
    sessionId: number;
    superAdmin: boolean;
    roles: RoleRow[];
    scope: Scope;
    label: string;
    displayName: string;
}

export type Actor = MemberActor | AdminActor;

/** Clé d'un acteur pour les réactions */
export const actorKey = (a: Actor): string => (a.type === 'member' ? `m:${a.id}` : `a:${a.id}`);

export async function memberFromToken(db: Db, token: string): Promise<MemberActor | null> {
    if (!token) return null;
    const m = await db.member.findUnique({ where: { deviceTokenHash: hashToken(token) }, include: { roles: true } });
    return m ? toMemberActor(m) : null;
}

export function toMemberActor(m: {
    id: number; name: string; status: MemberActor['status']; teamId: number; categoryId: number;
    mutedUntil: Date | null; roles: RoleRow[];
}): MemberActor {
    return {
        type: 'member', id: m.id, name: m.name, status: m.status, teamId: m.teamId, categoryId: m.categoryId,
        mutedUntil: m.mutedUntil, roles: m.roles, scope: scopeFrom(m.roles)
    };
}

type SessionWithAdmin = Prisma.AdminSessionGetPayload<{ include: { admin: { include: { member: { include: { roles: true } } } } } }>;

export const adminSessionInclude = { admin: { include: { member: { include: { roles: true } } } } } as const;

/**
 * Mêmes règles que requireAdmin (admin-api.ts) : session vérifiée, 2FA du super admin, au moins un rôle.
 * Renvoie un message d'erreur si la session ne convient pas.
 */
export function adminFromSession(session: SessionWithAdmin | null): AdminActor | HttpError {
    if (!session || session.expiresAt < new Date() || session.admin.disabled) return new HttpError(401, 'Session expirée. Reconnectez-vous.', 'unauthorized');
    const admin = session.admin;
    if (!session.verified) return new HttpError(401, 'Saisissez le code de votre application d\'authentification.', 'unauthorized');
    if (admin.isSuperAdmin && !admin.totpEnabled) return forbidden('Activez la double authentification pour continuer.');
    const memberActive = admin.member && admin.member.status === 'ACTIVE';
    const roles = memberActive ? admin.member!.roles : [];
    const scope = scopeFrom(roles, admin.isSuperAdmin);
    if (!hasAnyRole(scope)) return forbidden('Ce compte n\'a plus de rôle d\'administration.');
    return {
        type: 'admin', id: admin.id, sessionId: session.id, superAdmin: admin.isSuperAdmin, roles, scope,
        label: `admin:${admin.email}`, displayName: admin.member?.name ?? 'Super admin'
    };
}

export async function adminFromToken(db: Db, token: string | undefined): Promise<AdminActor | HttpError> {
    if (!token) return new HttpError(401, 'Session expirée. Reconnectez-vous.', 'unauthorized');
    const session = await db.adminSession.findUnique({ where: { tokenHash: hashToken(token) }, include: adminSessionInclude });
    return adminFromSession(session);
}

// ------------------------------------------------------------------ Canaux

export interface ChannelRef {
    key: string;
    teamId: number;
    /** null : discussion des admins de l'équipe */
    categoryId: number | null;
    name: string;
}

export function parseChannel(key: string): { kind: 'cat' | 'admins'; id: number } | null {
    const m = CHANNEL_RE.exec(key);
    return m ? { kind: m[1] as 'cat' | 'admins', id: Number(m[2]) } : null;
}

export const ADMINS_CHANNEL_NAME = 'Admins de l\'équipe';

/** Résout une clé de canal ; null si la catégorie ou l'équipe n'existe pas */
export async function resolveChannel(db: Db, key: string): Promise<ChannelRef | null> {
    const parsed = parseChannel(key);
    if (!parsed) return null;
    if (parsed.kind === 'cat') {
        const c = await db.category.findUnique({ where: { id: parsed.id }, select: { id: true, teamId: true, name: true } });
        return c ? { key: `cat:${c.id}`, teamId: c.teamId, categoryId: c.id, name: c.name } : null;
    }
    const t = await db.team.findUnique({ where: { id: parsed.id }, select: { id: true } });
    return t ? { key: `admins:${t.id}`, teamId: t.id, categoryId: null, name: ADMINS_CHANNEL_NAME } : null;
}

/** Un acteur voit-il ce canal ? Un membre ne voit que sa catégorie (+ les admins s'il a un rôle). */
export function canView(a: Actor, ch: ChannelRef): boolean {
    if (a.type === 'member') {
        if (a.status !== 'ACTIVE') return false;
        if (ch.categoryId !== null) return a.categoryId === ch.categoryId;
        return a.teamId === ch.teamId && a.roles.some((r) => r.teamId === ch.teamId);
    }
    if (a.superAdmin) return true;
    if (ch.categoryId !== null) return canPublish(a.scope, { id: ch.categoryId, teamId: ch.teamId });
    return a.roles.some((r) => r.teamId === ch.teamId);
}

/** Annonce : TEAM_ADMIN, CATEGORY_ADMIN ou SCHEDULER de la catégorie, super admin */
export function canAnnounce(a: Actor, ch: ChannelRef): boolean {
    if (ch.categoryId !== null) return canPublish(a.scope, { id: ch.categoryId, teamId: ch.teamId });
    return canManageTeam(a.scope, ch.teamId);
}

/** Modération : TEAM_ADMIN, CATEGORY_ADMIN de la catégorie, super admin */
export function canModerate(a: Actor, ch: ChannelRef): boolean {
    if (ch.categoryId !== null) return canManageCategory(a.scope, { id: ch.categoryId, teamId: ch.teamId });
    return canManageTeam(a.scope, ch.teamId);
}

/** Date de fin du silence si elle est future, sinon null */
export const activeMute = (m: { mutedUntil: Date | null }, now = new Date()): Date | null =>
    m.mutedUntil && m.mutedUntil > now ? m.mutedUntil : null;

export function canPost(a: Actor, now = new Date()): boolean {
    if (a.type === 'admin') return true;
    return a.status === 'ACTIVE' && activeMute(a, now) === null;
}

/** Canal visible ou 404 (on ne révèle pas l'existence d'un canal interdit) */
export async function requireChannel(db: Db, a: Actor, key: string): Promise<ChannelRef> {
    const ch = await resolveChannel(db, key);
    if (!ch || !canView(a, ch)) throw notFound('Discussion introuvable.');
    return ch;
}

/** Canaux visibles par un membre dans l'application : sa catégorie, puis les admins s'il a un rôle */
export async function memberChannels(db: Db, m: MemberActor): Promise<ChannelRef[]> {
    if (m.status !== 'ACTIVE') return [];
    const category = await db.category.findUnique({ where: { id: m.categoryId }, select: { id: true, name: true, teamId: true } });
    const out: ChannelRef[] = [];
    if (category) out.push({ key: `cat:${category.id}`, teamId: category.teamId, categoryId: category.id, name: category.name });
    if (m.roles.some((r) => r.teamId === m.teamId)) {
        out.push({ key: `admins:${m.teamId}`, teamId: m.teamId, categoryId: null, name: ADMINS_CHANNEL_NAME });
    }
    return out;
}

/** Canaux d'une équipe visibles par un admin du tableau de bord */
export async function adminTeamChannels(db: Db, a: AdminActor, teamId: number): Promise<ChannelRef[]> {
    const categories = await db.category.findMany({
        where: { teamId }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, name: true }
    });
    const all: ChannelRef[] = [
        ...categories.map((c) => ({ key: `cat:${c.id}`, teamId, categoryId: c.id, name: c.name })),
        { key: `admins:${teamId}`, teamId, categoryId: null, name: ADMINS_CHANNEL_NAME }
    ];
    return all.filter((ch) => canView(a, ch));
}

// ------------------------------------------------------------------ Messages (DTO)

export interface ScheduleCard {
    date: string;
    prayer: 'DHUHR' | 'ASR' | 'JUMUA';
    change: 'published' | 'updated';
    slots: { groupId: number | null; groupName: string | null; timeMins: number }[];
    movedGroupIds: number[];
    removedGroupIds: number[];
    /** Groupes ajoutés par une mise à jour (absent des cartes plus anciennes) */
    addedGroupIds?: number[];
}

export interface MessageDTO {
    id: number;
    channel: string;
    kind: 'TEXT' | 'ANNOUNCEMENT' | 'SCHEDULE';
    author: { type: 'member' | 'admin' | 'system'; id: number | null; name: string };
    body: string;
    replyTo: { id: number; authorName: string; excerpt: string } | null;
    schedule: ScheduleCard | null;
    mentions: { memberId: number; name: string }[];
    reactions: { emoji: string; count: number; mine: boolean }[];
    deleted: boolean;
    createdAt: string;
}

export const messageInclude = {
    reactions: { select: { emoji: true, actorKey: true } },
    mentions: { select: { memberId: true, member: { select: { name: true } } } },
    replyTo: { select: { id: true, authorName: true, body: true, deletedAt: true } }
} as const;

export type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

export function excerpt(body: string): string {
    const flat = body.replace(/\s+/g, ' ').trim();
    return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX - 1)}…`;
}

/** Message tel que le voit un lecteur (viewerKey : clé de réaction du lecteur, null pour « jamais à moi ») */
export function toDTO(row: MessageRow, viewerKey: string | null): MessageDTO {
    const deleted = row.deletedAt !== null;
    const reactions: MessageDTO['reactions'] = [];
    if (!deleted) {
        for (const r of REACTIONS) {
            const rows = row.reactions.filter((x) => x.emoji === r.key);
            if (rows.length) reactions.push({ emoji: r.emoji, count: rows.length, mine: viewerKey !== null && rows.some((x) => x.actorKey === viewerKey) });
        }
    }
    const authorType = row.authorType === 'MEMBER' ? 'member' : row.authorType === 'ADMIN' ? 'admin' : 'system';
    return {
        id: row.id,
        channel: row.channel,
        kind: row.kind,
        author: {
            type: authorType,
            id: authorType === 'member' ? row.memberId : authorType === 'admin' ? row.adminId : null,
            name: row.authorName
        },
        body: deleted ? '' : row.body,
        replyTo: row.replyTo
            ? { id: row.replyTo.id, authorName: row.replyTo.authorName, excerpt: row.replyTo.deletedAt ? '' : excerpt(row.replyTo.body) }
            : null,
        schedule: !deleted && row.kind === 'SCHEDULE' ? (row.schedule as unknown as ScheduleCard) : null,
        mentions: deleted ? [] : row.mentions.map((m) => ({ memberId: m.memberId, name: m.member.name })),
        reactions,
        deleted,
        createdAt: row.createdAt.toISOString()
    };
}

export async function loadMessage(db: Db, id: number): Promise<MessageRow | null> {
    return db.message.findUnique({ where: { id }, include: messageInclude });
}

/** Page de messages d'un canal, en ordre croissant */
export async function listMessages(
    db: Db, channel: string, opts: { before?: number; limit: number }, viewerKey: string | null
): Promise<{ messages: MessageDTO[]; hasMore: boolean }> {
    const rows = await db.message.findMany({
        where: { channel, ...(opts.before ? { id: { lt: opts.before } } : {}) },
        orderBy: { id: 'desc' },
        take: opts.limit + 1,
        include: messageInclude
    });
    const hasMore = rows.length > opts.limit;
    return { messages: rows.slice(0, opts.limit).reverse().map((r) => toDTO(r, viewerKey)), hasMore };
}

// ------------------------------------------------------------------ Mentions

/** Minuscules sans accents, caractère par caractère (même longueur que l'original dans la plupart des cas) */
function fold(s: string): string {
    let out = '';
    for (const ch of s) out += ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    return out;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Membres mentionnés par « @Nom » : comparaison sans casse ni accents, le plus long nom correspondant gagne,
 * et le nom doit se terminer à une frontière de mot.
 */
export function findMentions(body: string, candidates: { id: number; name: string }[]): number[] {
    const text = fold(body);
    const names = candidates
        .map((c) => ({ id: c.id, folded: fold(c.name) }))
        .filter((c) => c.folded.length > 0)
        .sort((a, b) => b.folded.length - a.folded.length);
    const found = new Set<number>();
    for (let i = text.indexOf('@'); i !== -1; i = text.indexOf('@', i + 1)) {
        if (i > 0 && WORD_CHAR.test(text[i - 1])) continue; // adresse email, pas une mention
        const rest = text.slice(i + 1);
        const hit = names.find((n) => rest.startsWith(n.folded) && !WORD_CHAR.test(rest.charAt(n.folded.length)));
        if (hit) found.add(hit.id);
    }
    return [...found];
}

/** Membres pouvant être mentionnés : ceux qui voient le canal dans l'application */
export async function mentionCandidates(db: Db, ch: ChannelRef): Promise<{ id: number; name: string }[]> {
    if (ch.categoryId !== null) {
        return db.member.findMany({ where: { categoryId: ch.categoryId, status: 'ACTIVE' }, select: { id: true, name: true } });
    }
    return db.member.findMany({
        where: { teamId: ch.teamId, status: 'ACTIVE', roles: { some: { teamId: ch.teamId } } },
        select: { id: true, name: true }
    });
}

// ------------------------------------------------------------------ Écriture

const recentCalls = new Map<string, number[]>();

/**
 * Limite par acteur (et non par adresse IP : tout un bureau partage souvent la même adresse).
 * bucket : nature de l'action ; key : actorKey().
 */
export function checkRate(bucket: string, key: string, limit: number, message: string, windowMs = POST_WINDOW_MS, now = Date.now()): void {
    const id = `${bucket}|${key}`;
    const times = (recentCalls.get(id) ?? []).filter((t) => now - t < windowMs);
    if (times.length >= limit) {
        recentCalls.set(id, times);
        throw new HttpError(429, message, 'rate_limited');
    }
    times.push(now);
    recentCalls.set(id, times);
    // Ménage occasionnel des acteurs inactifs
    if (recentCalls.size > 20_000) {
        for (const [k, v] of recentCalls) if (!v.some((t) => now - t < windowMs)) recentCalls.delete(k);
    }
}

/** 20 messages par minute et par auteur */
function checkPostRate(key: string, now = Date.now()): void {
    checkRate('post', key, POST_LIMIT, 'Vous envoyez trop de messages. Attendez une minute avant de réessayer.', POST_WINDOW_MS, now);
}

export interface PostInput {
    body: string;
    kind: 'TEXT' | 'ANNOUNCEMENT';
    replyToId?: number | null;
}

/** Texte lisible d'une date de silence : « 14:30 le 25/11 » (heure locale de l'équipe) */
export function formatLocal(d: Date, offsetHours: number): string {
    const local = new Date(d.getTime() + offsetHours * 3600_000);
    const dd = String(local.getUTCDate()).padStart(2, '0');
    const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
    return `${minsToHHMM(local.getUTCHours() * 60 + local.getUTCMinutes())} le ${dd}/${mm}`;
}

export async function postMessage(
    db: Db, actor: Actor, ch: ChannelRef, input: PostInput, offsetHours: number
): Promise<{ row: MessageRow; mentioned: number[] }> {
    if (actor.type === 'member') {
        if (actor.status !== 'ACTIVE') throw forbidden('Votre accès à l\'équipe n\'est pas actif.');
        const muted = activeMute(actor);
        if (muted) {
            throw forbidden(`Un admin vous a réduit au silence : vous pourrez écrire à nouveau à ${formatLocal(muted, offsetHours)}.`);
        }
    }
    if (input.kind === 'ANNOUNCEMENT' && !canAnnounce(actor, ch)) {
        throw forbidden('Seuls les admins et responsables horaires publient des annonces.');
    }
    const body = input.body.trim();
    if (!body) throw badRequest('Écrivez un message avant d\'envoyer.');
    if (body.length > BODY_MAX) throw badRequest(`Message trop long : ${BODY_MAX} caractères au plus.`);

    let replyToId: number | null = null;
    if (input.replyToId) {
        const target = await db.message.findUnique({ where: { id: input.replyToId }, select: { id: true, channel: true } });
        if (!target || target.channel !== ch.key) throw badRequest('Le message auquel vous répondez n\'existe plus.');
        replyToId = target.id;
    }
    checkPostRate(actorKey(actor));

    const mentioned = findMentions(body, await mentionCandidates(db, ch));
    const created = await db.message.create({
        data: {
            teamId: ch.teamId, categoryId: ch.categoryId, channel: ch.key, kind: input.kind,
            authorType: actor.type === 'member' ? 'MEMBER' : 'ADMIN',
            memberId: actor.type === 'member' ? actor.id : null,
            adminId: actor.type === 'admin' ? actor.id : null,
            authorName: (actor.type === 'member' ? actor.name : actor.displayName).slice(0, 80),
            body, replyToId,
            mentions: { create: mentioned.map((memberId) => ({ memberId })) }
        },
        include: messageInclude
    });
    return { row: created, mentioned: mentioned.filter((id) => !(actor.type === 'member' && actor.id === id)) };
}

/** L'acteur est-il l'auteur du message ? */
export function isAuthor(a: Actor, row: { authorType: string; memberId: number | null; adminId: number | null }): boolean {
    return a.type === 'member' ? row.authorType === 'MEMBER' && row.memberId === a.id : row.authorType === 'ADMIN' && row.adminId === a.id;
}

/** Supprime un message (le sien, ou celui d'un autre si l'acteur modère le canal) */
export async function deleteMessage(db: Db, actor: Actor, id: number): Promise<{ row: MessageRow; ch: ChannelRef; moderated: boolean; previousBody: string } | null> {
    const row = await loadMessage(db, id);
    const ch = row ? await resolveChannel(db, row.channel) : null;
    if (!row || !ch || !canView(actor, ch)) throw notFound('Message introuvable.');
    if (row.deletedAt) return null; // déjà supprimé
    const own = isAuthor(actor, row);
    if (!own && !canModerate(actor, ch)) throw forbidden('Vous ne pouvez supprimer que vos propres messages.');
    await db.$transaction([
        db.message.update({ where: { id }, data: { deletedAt: new Date(), body: '' } }),
        db.messageReaction.deleteMany({ where: { messageId: id } }),
        db.messageMention.deleteMany({ where: { messageId: id } })
    ]);
    const updated = (await loadMessage(db, id))!;
    return { row: updated, ch, moderated: !own, previousBody: row.body };
}

/** Ajoute ou retire une réaction (bascule) */
export async function toggleReaction(db: Db, actor: Actor, id: number, emoji: string): Promise<MessageRow> {
    const key = KEY_BY_EMOJI.get(emoji.trim());
    if (!key) throw badRequest(`Réaction non disponible. Choisissez parmi ${REACTIONS.map((r) => r.emoji).join(' ')}.`);
    const row = await db.message.findUnique({ where: { id }, select: { channel: true, deletedAt: true } });
    const ch = row ? await resolveChannel(db, row.channel) : null;
    if (!row || !ch || !canView(actor, ch)) throw notFound('Message introuvable.');
    if (row.deletedAt) throw badRequest('Ce message a été supprimé.');
    const who = actorKey(actor);
    const { count } = await db.messageReaction.deleteMany({ where: { messageId: id, actorKey: who, emoji: key } });
    if (count === 0) {
        try {
            await db.messageReaction.create({ data: { messageId: id, actorKey: who, emoji: key } });
        } catch (err) {
            // Double clic : la réaction existe déjà, l'état voulu est atteint
            if ((err as { code?: string }).code !== 'P2002') throw err;
        }
    }
    return (await loadMessage(db, id))!;
}

export { EMOJI_BY_KEY };

// ------------------------------------------------------------------ Lecture et non lus

export async function markRead(db: Db, memberId: number, channel: string, lastMessageId: number): Promise<void> {
    const existing = await db.channelRead.findUnique({ where: { memberId_channel: { memberId, channel } } });
    if (existing) {
        if (lastMessageId > existing.lastReadId) {
            await db.channelRead.update({ where: { id: existing.id }, data: { lastReadId: lastMessageId } });
        }
        return;
    }
    try {
        await db.channelRead.create({ data: { memberId, channel, lastReadId: lastMessageId } });
    } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
        await db.channelRead.updateMany({ where: { memberId, channel, lastReadId: { lt: lastMessageId } }, data: { lastReadId: lastMessageId } });
    }
}

/**
 * Messages d'autres auteurs après la dernière lecture.
 * Sans lecture enregistrée : seulement les messages arrivés depuis l'adhésion du membre
 * (l'historique d'avant n'est pas « non lu »).
 */
export async function unreadCount(db: Db, memberId: number, channel: string): Promise<number> {
    const read = await db.channelRead.findUnique({ where: { memberId_channel: { memberId, channel } } });
    const since = read ? null : (await db.member.findUnique({ where: { id: memberId }, select: { createdAt: true } }))?.createdAt ?? null;
    return db.message.count({
        where: {
            channel, deletedAt: null,
            id: { gt: read?.lastReadId ?? 0 },
            ...(since ? { createdAt: { gte: since } } : {}),
            OR: [{ memberId: null }, { memberId: { not: memberId } }]
        }
    });
}

/**
 * Début d'accès à un canal (adhésion, changement de catégorie, premier rôle) :
 * l'historique existant compte comme lu.
 */
export async function markChannelSeen(db: Db, memberId: number, channel: string): Promise<void> {
    const last = await db.message.aggregate({ where: { channel }, _max: { id: true } });
    const lastReadId = last._max.id ?? 0;
    await db.channelRead.upsert({
        where: { memberId_channel: { memberId, channel } },
        create: { memberId, channel, lastReadId },
        update: { lastReadId }
    });
}

// ------------------------------------------------------------------ Publication des horaires

/** Résumé lisible d'une publication (corps du message SCHEDULE) */
export function scheduleSummary(card: ScheduleCard): string {
    const prayer = PRAYER_LABEL[card.prayer] ?? card.prayer;
    const [, mm, dd] = card.date.split('-');
    const label = (s: { groupName: string | null }) => s.groupName ?? prayer;
    if (card.change === 'published') {
        const list = card.slots.map((s) => `${label(s)} ${minsToHHMM(s.timeMins)}`).join(', ');
        return `Horaires de ${prayer} publiés pour le ${dd}/${mm} : ${list}.`;
    }
    const added = card.addedGroupIds ?? [];
    const parts: string[] = [];
    for (const s of card.slots) {
        if (s.groupId === null) continue;
        if (card.movedGroupIds.includes(s.groupId)) parts.push(`${label(s)} déplacé à ${minsToHHMM(s.timeMins)}`);
        else if (added.includes(s.groupId)) parts.push(`${label(s)} ajouté à ${minsToHHMM(s.timeMins)}`);
    }
    if (card.removedGroupIds.length) parts.push(`${card.removedGroupIds.length} groupe(s) retiré(s)`);
    if (!parts.length) parts.push(card.slots.map((s) => `${label(s)} ${minsToHHMM(s.timeMins)}`).join(', '));
    return `Horaires de ${prayer} modifiés pour le ${dd}/${mm} : ${parts.join(', ')}.`;
}

/** Crée le message SCHEDULE d'une publication dans la discussion de la catégorie */
export async function createScheduleMessage(
    db: Db,
    input: { categoryId: number; date: string; prayer: 'DHUHR' | 'ASR' | 'JUMUA'; slots: { groupId: number | null; timeMins: number }[]; result: PublishResult }
): Promise<{ row: MessageRow; card: ScheduleCard }> {
    const category = await db.category.findUniqueOrThrow({ where: { id: input.categoryId }, include: { groups: true } });
    const order = new Map(category.groups.map((g) => [g.id, g.sortOrder * 1e6 + g.id]));
    const names = new Map(category.groups.map((g) => [g.id, g.name]));
    const card: ScheduleCard = {
        date: input.date,
        prayer: input.prayer,
        change: input.result.created ? 'published' : 'updated',
        slots: input.slots
            .slice()
            .sort((a, b) => (order.get(a.groupId ?? -1) ?? -1) - (order.get(b.groupId ?? -1) ?? -1))
            .map((s) => ({ groupId: s.groupId, groupName: s.groupId === null ? null : names.get(s.groupId) ?? null, timeMins: s.timeMins })),
        movedGroupIds: input.result.movedGroupIds,
        removedGroupIds: input.result.removedGroupIds,
        addedGroupIds: input.result.addedGroupIds
    };
    const row = await db.message.create({
        data: {
            teamId: category.teamId, categoryId: category.id, channel: `cat:${category.id}`, kind: 'SCHEDULE',
            authorType: 'SYSTEM', authorName: 'Horaires', body: scheduleSummary(card), schedule: card as never
        },
        include: messageInclude
    });
    return { row, card };
}

// ------------------------------------------------------------------ Conservation

/** Supprime les messages de plus de 90 jours */
export async function purgeMessages(db: Db): Promise<number> {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    const { count } = await db.message.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return count;
}
