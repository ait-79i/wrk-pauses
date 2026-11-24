// Discussion, modération et temps réel (phase 2). Contrat : docs/contrat-api-phases-2-3.md §1–5.
// Application : /api/app/channels|messages|read|ws (clé d'appareil). Tableau de bord : /api/admin/…/channels|messages|mute|ws (cookie).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { audit } from '../lib/audit.js';
import { forbidden, HttpError, notFound, unauthorized } from '../lib/errors.js';
import { assert, canManageCategory } from '../services/access.js';
import {
    activeMute, ADMIN_COOKIE, actorKey, adminFromToken, adminTeamChannels, BODY_MAX, canAnnounce, canModerate, canPost,
    CHANNEL_RE, checkRate, deleteMessage, listMessages, markRead, memberChannels, memberFromToken, postMessage,
    requireChannel, toDTO, toggleReaction, unreadCount, type Actor, type AdminActor, type MemberActor
} from '../services/chat.js';
import { CLOSE_UNAUTHORIZED, type RealtimeHub } from '../services/realtime.js';
import { idParam, parse } from './validation.js';

const channelSchema = z.string().regex(CHANNEL_RE, 'Discussion inconnue.');
const listQuery = z.object({
    channel: channelSchema,
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50)
});
const postBody = z.object({
    channel: channelSchema,
    body: z.string().trim().min(1, 'Écrivez un message avant d\'envoyer.').max(BODY_MAX, `Message trop long : ${BODY_MAX} caractères au plus.`),
    kind: z.enum(['TEXT', 'ANNOUNCEMENT']).default('TEXT'),
    replyToId: z.number().int().positive().nullable().optional()
});
/** Silence : 1 minute à 30 jours ; null lève le silence */
const muteBody = z.object({
    minutes: z.number().int().min(1, 'Durée d\'au moins 1 minute.').max(30 * 24 * 60, 'Durée de 30 jours au plus.').nullable()
});

const DAY_MS = 24 * 3600_000;

/**
 * Limites par acteur (clé d'appareil ou compte admin), en appels par minute.
 * Pas de limite par adresse IP : tout un bureau partage souvent la même.
 */
const LIMITS = {
    reaction: { max: 60, message: 'Trop de réactions d\'affilée. Attendez une minute avant de réessayer.' },
    read: { max: 120, message: 'Trop de demandes d\'affilée. Attendez une minute avant de réessayer.' },
    list: { max: 240, message: 'Trop de demandes d\'affilée. Attendez une minute avant de réessayer.' },
    moderate: { max: 60, message: 'Trop d\'actions de modération d\'affilée. Attendez une minute avant de réessayer.' }
} as const;

function limit(kind: keyof typeof LIMITS, actor: Actor): void {
    checkRate(kind, actorKey(actor), LIMITS[kind].max, LIMITS[kind].message);
}

/** Connexions WebSocket : par adresse IP (avant authentification), assez large pour un bureau entier */
const wsUpgradeLimit = { websocket: true, config: { rateLimit: { max: 300, timeWindow: '1 minute' } } } as const;

export async function registerChatApi(
    app: FastifyInstance, { db, config, hub }: { db: Db; config: Config; hub: RealtimeHub }
): Promise<void> {
    hub.start();
    app.addHook('onClose', async () => hub.stop());

    /** Membre actif identifié par « Authorization: Bearer <clé> » */
    async function requireMember(req: FastifyRequest): Promise<MemberActor> {
        const header = req.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        if (!token) throw unauthorized('Cet ordinateur n\'est relié à aucune équipe.');
        const member = await memberFromToken(db, token);
        if (!member) throw unauthorized('Cet ordinateur n\'est plus relié à l\'équipe. Rejoignez-la à nouveau.');
        if (member.status === 'BLOCKED') throw forbidden('Votre accès à l\'équipe a été suspendu par un admin.');
        if (member.status === 'PENDING') throw forbidden('Votre demande attend la validation d\'un admin de l\'équipe.');
        return member;
    }

    async function requireAdmin(req: FastifyRequest): Promise<AdminActor> {
        const result = await adminFromToken(db, req.cookies[ADMIN_COOKIE]);
        if (result instanceof HttpError) throw result;
        return result;
    }

    const actorLabel = (a: Actor) => (a.type === 'member' ? `membre:${a.name}` : a.label);

    /** Envoi commun (application et tableau de bord) */
    async function post(actor: Actor, raw: unknown) {
        const body = parse(postBody, raw);
        const ch = await requireChannel(db, actor, body.channel);
        const { row, mentioned } = await postMessage(db, actor, ch, body, config.LOCAL_OFFSET_HOURS);
        void hub.broadcastMessage('message.created', row, ch).then(() => hub.notifyMentions(row, ch, mentioned));
        return toDTO(row, actor.type === 'member' ? `m:${actor.id}` : null);
    }

    /** Suppression commune ; tracée dans le journal quand c'est une modération */
    async function remove(actor: Actor, id: number) {
        limit('moderate', actor);
        const result = await deleteMessage(db, actor, id);
        if (!result) return { ok: true };
        void hub.broadcastMessage('message.updated', result.row, result.ch);
        if (result.moderated) {
            // Seulement des métadonnées : le texte supprimé ne survit pas dans le journal (conservé 1 an)
            await audit(db, {
                actor: actorLabel(actor), action: 'message.delete', teamId: result.ch.teamId,
                target: `${result.ch.key} #${id}`,
                details: { messageId: id, author: result.row.authorName, length: result.previousBody.length }
            });
        }
        return { ok: true };
    }

    // ------------------------------------------------------------------ Application

    app.get('/api/app/channels', async (req) => {
        const member = await requireMember(req);
        limit('list', member);
        const channels = await memberChannels(db, member);
        const muted = activeMute(member);
        return {
            channels: await Promise.all(channels.map(async (ch) => ({
                key: ch.key,
                name: ch.name,
                unread: await unreadCount(db, member.id, ch.key),
                canPost: canPost(member),
                canAnnounce: canAnnounce(member, ch),
                canModerate: canModerate(member, ch),
                mutedUntil: muted ? muted.toISOString() : null
            })))
        };
    });

    app.get('/api/app/messages', async (req) => {
        const member = await requireMember(req);
        limit('list', member);
        const q = parse(listQuery, req.query);
        const ch = await requireChannel(db, member, q.channel);
        return listMessages(db, ch.key, q, `m:${member.id}`);
    });

    app.post('/api/app/messages', async (req, reply) => {
        const member = await requireMember(req);
        const dto = await post(member, req.body);
        reply.code(201);
        return dto;
    });

    app.delete('/api/app/messages/:id', async (req) => {
        const member = await requireMember(req);
        const { id } = parse(idParam, req.params);
        return remove(member, id);
    });

    app.put('/api/app/messages/:id/reactions', async (req) => {
        const member = await requireMember(req);
        limit('reaction', member);
        const { id } = parse(idParam, req.params);
        const body = parse(z.object({ emoji: z.string().min(1).max(16) }), req.body);
        const row = await toggleReaction(db, member, id, body.emoji);
        void hub.broadcastMessage('message.updated', row, { key: row.channel, teamId: row.teamId, categoryId: row.categoryId, name: '' });
        return toDTO(row, `m:${member.id}`);
    });

    app.post('/api/app/read', async (req) => {
        const member = await requireMember(req);
        limit('read', member);
        const body = parse(z.object({ channel: channelSchema, lastMessageId: z.number().int().min(0) }), req.body);
        const ch = await requireChannel(db, member, body.channel);
        await markRead(db, member.id, ch.key, body.lastMessageId);
        return { ok: true };
    });

    // Temps réel de l'application : authentification par le premier message
    app.get('/api/app/ws', wsUpgradeLimit, (socket, req) => {
        hub.attachMember(socket, req.ip);
    });

    // ------------------------------------------------------------------ Tableau de bord

    app.get('/api/admin/teams/:id/channels', async (req) => {
        const admin = await requireAdmin(req);
        limit('list', admin);
        const { id } = parse(idParam, req.params);
        const channels = await adminTeamChannels(db, admin, id);
        if (!channels.length) throw notFound('Équipe introuvable.');
        const keys = channels.map((c) => c.key);
        const [recent, last] = await Promise.all([
            db.message.groupBy({
                by: ['channel'], _count: { _all: true },
                where: { channel: { in: keys }, deletedAt: null, createdAt: { gte: new Date(Date.now() - 7 * DAY_MS) } }
            }),
            db.message.groupBy({ by: ['channel'], _max: { createdAt: true }, where: { channel: { in: keys }, deletedAt: null } })
        ]);
        return {
            channels: channels.map((ch) => ({
                key: ch.key,
                name: ch.name,
                messages7d: recent.find((r) => r.channel === ch.key)?._count._all ?? 0,
                lastMessageAt: last.find((r) => r.channel === ch.key)?._max.createdAt?.toISOString() ?? null
            }))
        };
    });

    app.get('/api/admin/messages', async (req) => {
        const admin = await requireAdmin(req);
        limit('list', admin);
        const q = parse(listQuery, req.query);
        const ch = await requireChannel(db, admin, q.channel);
        return listMessages(db, ch.key, q, null);
    });

    app.post('/api/admin/messages', async (req, reply) => {
        const admin = await requireAdmin(req);
        const dto = await post(admin, req.body);
        reply.code(201);
        return dto;
    });

    app.delete('/api/admin/messages/:id', async (req) => {
        const admin = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        return remove(admin, id);
    });

    app.post('/api/admin/members/:id/mute', async (req) => {
        const admin = await requireAdmin(req);
        limit('moderate', admin);
        const { id } = parse(idParam, req.params);
        const body = parse(muteBody, req.body);
        const member = await db.member.findUnique({ where: { id }, include: { category: true } });
        if (!member) throw notFound('Membre introuvable.');
        assert(canManageCategory(admin.scope, member.category), 'Seuls les admins d\'équipe et de catégorie réduisent un membre au silence.');
        const mutedUntil = body.minutes === null ? null : new Date(Date.now() + body.minutes * 60_000);
        await db.member.update({ where: { id }, data: { mutedUntil } });
        await audit(db, {
            actor: admin.label, action: mutedUntil ? 'member.mute' : 'member.unmute', teamId: member.teamId, target: member.name,
            details: mutedUntil ? { minutes: body.minutes, until: mutedUntil.toISOString() } : undefined
        });
        void hub.memberStatus(id);
        return { mutedUntil: mutedUntil ? mutedUntil.toISOString() : null };
    });

    /**
     * Origine autorisée pour le WebSocket du tableau de bord : celle de PUBLIC_URL.
     * Le cookie SameSite=Strict ne sépare pas deux sous-domaines du même site.
     * Hors production, les origines locales (serveur Vite) sont aussi acceptées.
     */
    const publicOrigin = new URL(config.PUBLIC_URL).origin;
    function originAllowed(origin: string | undefined): boolean {
        if (!origin) return true; // client hors navigateur : pas de détournement possible par une page
        if (origin === publicOrigin) return true;
        if (config.NODE_ENV === 'production') return false;
        try {
            return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
        } catch {
            return false;
        }
    }

    // Temps réel du tableau de bord : session du cookie (mêmes règles que les autres routes)
    app.get('/api/admin/ws', wsUpgradeLimit, async (socket, req) => {
        if (!originAllowed(req.headers.origin)) {
            socket.close(CLOSE_UNAUTHORIZED, 'Origine refusée');
            return;
        }
        try {
            const result = await adminFromToken(db, req.cookies[ADMIN_COOKIE]);
            if (result instanceof HttpError) {
                socket.close(CLOSE_UNAUTHORIZED, 'Session refusée');
                return;
            }
            hub.attachAdmin(socket, result);
        } catch (err) {
            req.log.error(err);
            socket.close(1011, 'Erreur du serveur');
        }
    });
}
