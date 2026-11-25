// API de l'application Windows (identité du membre : clé d'appareil, ADR 0001).
// Préfixe : /api/app

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, unauthorized } from '../lib/errors.js';
import { hashToken, newToken, normalizeCode } from '../lib/security.js';
import { DATE_RE, localNow } from '../lib/time.js';
import { assert, canPublish, scopeFrom } from '../services/access.js';
import { markChannelSeen } from '../services/chat.js';
import type { RealtimeHub } from '../services/realtime.js';
import { choose, getDayView, publish, setUsualGroup } from '../services/schedule.js';
import { parse, prayerSchema, slotsSchema, toMins } from './validation.js';

export interface MemberAuth {
    id: number;
    name: string;
    status: 'PENDING' | 'ACTIVE' | 'BLOCKED';
    teamId: number;
    categoryId: number;
}

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .'-]{1,59}$/u;
const nameSchema = z.string().trim().min(2, 'Votre nom doit faire au moins 2 caractères.').max(60)
    .regex(NAME_RE, 'Utilisez seulement des lettres, chiffres, espaces, apostrophes ou tirets.');
const dateSchema = z.string().regex(DATE_RE, 'Date attendue au format AAAA-MM-JJ.');

export function registerAppApi(app: FastifyInstance, { db, config, hub }: { db: Db; config: Config; hub: RealtimeHub }): void {
    /** Identifie le membre à partir de « Authorization: Bearer <clé de l'appareil> » */
    async function requireMember(req: FastifyRequest, { allowPending = false } = {}): Promise<MemberAuth> {
        const header = req.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        if (!token) throw unauthorized('Cet ordinateur n\'est relié à aucune équipe.');
        const member = await db.member.findUnique({ where: { deviceTokenHash: hashToken(token) } });
        if (!member) throw unauthorized('Cet ordinateur n\'est plus relié à l\'équipe. Rejoignez-la à nouveau.');
        if (member.status === 'BLOCKED') throw forbidden('Votre accès à l\'équipe a été suspendu par un admin.');
        if (member.status === 'PENDING' && !allowPending) {
            throw forbidden('Votre demande attend la validation d\'un admin de l\'équipe.');
        }
        // lastSeenAt : au plus une écriture par minute
        if (!member.lastSeenAt || Date.now() - member.lastSeenAt.getTime() > 60_000) {
            await db.member.update({ where: { id: member.id }, data: { lastSeenAt: new Date() } });
        }
        return { id: member.id, name: member.name, status: member.status, teamId: member.teamId, categoryId: member.categoryId };
    }

    // Toute une équipe peut rejoindre depuis la même adresse IP (bureau) : limite large.
    // Les codes (6 caractères parmi 31) restent impossibles à deviner à ce rythme.
    const joinLimit = { config: { rateLimit: { max: 60, timeWindow: '15 minutes' } } };
    const transferLimit = { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } };

    // Rejoindre une équipe avec un code d'accès
    app.post('/api/app/join', joinLimit, async (req, reply) => {
        const body = parse(z.object({ code: z.string().min(4).max(20), name: nameSchema }), req.body);
        const code = await db.accessCode.findUnique({
            where: { code: normalizeCode(body.code) },
            include: { category: { include: { team: true } } }
        });
        const now = new Date();
        if (!code || code.revokedAt || (code.expiresAt && code.expiresAt < now)) {
            throw badRequest('Ce code n\'est pas valide. Vérifiez-le auprès de l\'admin de votre équipe.', 'invalid_code');
        }
        const team = code.category.team;
        const taken = await db.member.findUnique({ where: { teamId_name: { teamId: team.id, name: body.name } } });
        if (taken) {
            throw conflict(`« ${body.name} » est déjà utilisé dans cette équipe. Ajoutez l'initiale de votre nom, par exemple « ${body.name} B. ».`, 'name_taken');
        }
        const token = newToken();
        const member = await db.member.create({
            data: {
                teamId: team.id,
                categoryId: code.categoryId,
                name: body.name,
                deviceTokenHash: hashToken(token),
                status: team.requireApproval ? 'PENDING' : 'ACTIVE',
                lastSeenAt: now
            }
        });
        // L'historique de la discussion d'avant l'adhésion n'est pas « non lu »
        await markChannelSeen(db, member.id, `cat:${code.categoryId}`);
        await audit(db, {
            actor: `membre:${member.name}`, action: 'member.join', teamId: team.id,
            target: code.category.name, details: { memberId: member.id, code: code.code }
        });
        reply.code(201);
        return {
            token,
            status: member.status,
            team: { id: team.id, name: team.name },
            category: { id: code.categoryId, name: code.category.name }
        };
    });

    // Retrouver son compte sur un autre ordinateur avec un code de transfert
    app.post('/api/app/transfer', transferLimit, async (req) => {
        const body = parse(z.object({ code: z.string().min(4).max(20) }), req.body);
        const transfer = await db.transferCode.findUnique({ where: { code: normalizeCode(body.code) }, include: { member: true } });
        if (!transfer || transfer.usedAt || transfer.expiresAt < new Date()) {
            throw badRequest('Ce code de transfert n\'est pas valide ou a expiré. Demandez-en un nouveau à un admin.', 'invalid_code');
        }
        const token = newToken();
        await db.$transaction([
            db.member.update({ where: { id: transfer.memberId }, data: { deviceTokenHash: hashToken(token), lastSeenAt: new Date() } }),
            db.transferCode.update({ where: { id: transfer.id }, data: { usedAt: new Date() } })
        ]);
        // L'ancien ordinateur perd tout de suite le temps réel
        hub.closeMember(transfer.memberId);
        await audit(db, { actor: `membre:${transfer.member.name}`, action: 'member.transfer', teamId: transfer.member.teamId });
        return { token };
    });

    // Profil du membre et de son équipe
    app.get('/api/app/me', async (req) => {
        const auth = await requireMember(req, { allowPending: true });
        const member = await db.member.findUniqueOrThrow({
            where: { id: auth.id },
            include: { team: true, category: true, roles: true }
        });
        // Code d'accès actuel de sa catégorie, pour inviter des collègues (membres actifs seulement)
        const now = new Date();
        const code = member.status === 'ACTIVE'
            ? await db.accessCode.findFirst({
                where: { categoryId: member.categoryId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
                orderBy: { createdAt: 'desc' }
            })
            : null;
        return {
            member: { id: member.id, name: member.name, status: member.status },
            team: { id: member.team.id, name: member.team.name, city: member.team.city, country: member.team.country },
            category: { id: member.category.id, name: member.category.name, jumuaEnabled: member.category.jumuaEnabled },
            canPublish: canPublish(scopeFrom(member.roles), member.category),
            accessCode: code ? { code: code.code, expiresAt: code.expiresAt ? code.expiresAt.toISOString() : null } : null
        };
    });

    // Journée : horaires publiés, effectifs et choix du membre
    app.get('/api/app/day', async (req) => {
        const auth = await requireMember(req);
        const q = parse(z.object({ date: dateSchema.optional() }), req.query);
        const now = localNow(config.LOCAL_OFFSET_HOURS);
        const day = await getDayView(db, auth.categoryId, q.date ?? now.date, auth.id);
        return { ...day, today: now.date, nowMins: now.nowMins };
    });

    // Choisir son groupe (groupId null : aucun groupe ce jour-là)
    app.put('/api/app/choice', async (req) => {
        const auth = await requireMember(req);
        const body = parse(z.object({
            date: dateSchema,
            prayer: prayerSchema,
            groupId: z.number().int().positive().nullable()
        }), req.body);
        const now = localNow(config.LOCAL_OFFSET_HOURS);
        await choose(db, { memberId: auth.id, categoryId: auth.categoryId, ...body, today: now.date, nowMins: now.nowMins });
        const day = await getDayView(db, auth.categoryId, body.date, auth.id);
        return { ...day, today: now.date, nowMins: now.nowMins };
    });

    // Groupe habituel (Dhuhr ou Asr)
    app.put('/api/app/usual', async (req) => {
        const auth = await requireMember(req);
        const body = parse(z.object({ prayer: z.enum(['DHUHR', 'ASR']), groupId: z.number().int().positive().nullable() }), req.body);
        await setUsualGroup(db, { id: auth.id, categoryId: auth.categoryId }, body.prayer, body.groupId);
        return { ok: true };
    });

    // Publier les horaires du jour depuis l'application (admins et responsables horaires)
    app.post('/api/app/publish', async (req) => {
        const auth = await requireMember(req);
        const body = parse(z.object({ date: dateSchema.optional(), prayer: prayerSchema, slots: slotsSchema }), req.body);
        const member = await db.member.findUniqueOrThrow({ where: { id: auth.id }, include: { roles: true, category: true } });
        assert(canPublish(scopeFrom(member.roles), member.category), 'Seuls les admins et responsables horaires publient les horaires.');
        const now = localNow(config.LOCAL_OFFSET_HOURS);
        const date = body.date ?? now.date;
        if (date < now.date) throw badRequest('On ne peut pas publier les horaires d\'un jour passé.');
        const slots = body.slots.map((s) => ({ groupId: s.groupId, timeMins: toMins(s.time) }));
        const result = await publish(db, { categoryId: auth.categoryId, date, prayer: body.prayer, by: auth.name, slots });
        // Carte de publication dans la discussion + événements temps réel
        await hub.schedulePublished({ categoryId: auth.categoryId, date, prayer: body.prayer, slots, result });
        await audit(db, {
            actor: `membre:${auth.name}`, action: result.created ? 'schedule.publish' : 'schedule.update', teamId: auth.teamId,
            target: `${member.category.name} ${body.prayer} ${date}`, details: { slots: body.slots, ...result }
        });
        const day = await getDayView(db, auth.categoryId, date, auth.id);
        return { ...day, today: now.date, nowMins: now.nowMins };
    });

    // Quitter l'équipe
    app.post('/api/app/leave', async (req) => {
        const auth = await requireMember(req, { allowPending: true });
        await db.member.delete({ where: { id: auth.id } });
        hub.closeMember(auth.id);
        await audit(db, { actor: `membre:${auth.name}`, action: 'member.leave', teamId: auth.teamId });
        return { ok: true };
    });
}
