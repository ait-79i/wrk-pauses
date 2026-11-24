// API du tableau de bord web (super admin et admins). Session par cookie httpOnly.
// Préfixe : /api/admin

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { Role } from '../generated/prisma/enums.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { hashPassword, hashToken, newReadableCode, newToken, verifyPassword } from '../lib/security.js';
import { DATE_RE, localNow, toDbDate } from '../lib/time.js';
import {
    assert, canManageCategory, canManageTeam, canPublish, hasAnyRole, scopeFrom, type Scope
} from '../services/access.js';
import { markChannelSeen } from '../services/chat.js';
import type { RealtimeHub } from '../services/realtime.js';
import { getDayView, publish } from '../services/schedule.js';
import { idParam, parse, prayerSchema, slotsSchema, toMins } from './validation.js';

const COOKIE = 'pause_admin';
const DEFAULT_CATEGORIES = [
    { name: 'Hommes', jumuaEnabled: true },
    { name: 'Femmes', jumuaEnabled: false }
];
const DEFAULT_GROUPS = ['G1', 'G2'];
const TRANSFER_CODE_HOURS = 24;

interface AdminCtx {
    id: number;
    email: string;
    superAdmin: boolean;
    scope: Scope;
    /** Libellé pour le journal d'activité */
    label: string;
    /** Nom affiché pour les publications */
    displayName: string;
}

const passwordSchema = z.string().min(12, 'Le mot de passe doit faire au moins 12 caractères.').max(200);
const emailSchema = z.string().trim().toLowerCase().email('Adresse email invalide.').max(190);
const teamBody = z.object({
    name: z.string().trim().min(2, 'Nom d\'équipe trop court.').max(80),
    city: z.string().trim().min(2).max(80).optional(),
    country: z.string().trim().length(2, 'Code pays sur 2 lettres, ex. MA.').toUpperCase().optional(),
    requireApproval: z.boolean().optional()
});

/** Crée une catégorie avec ses groupes par défaut et un code d'accès */
async function createCategoryWithDefaults(db: Db, teamId: number, name: string, jumuaEnabled: boolean, sortOrder: number) {
    return db.category.create({
        data: {
            teamId, name, jumuaEnabled, sortOrder,
            groups: { create: DEFAULT_GROUPS.map((g, i) => ({ name: g, sortOrder: i })) },
            accessCodes: { create: [{ code: newReadableCode() }] }
        }
    });
}

export function registerAdminApi(app: FastifyInstance, { db, config, hub }: { db: Db; config: Config; hub: RealtimeHub }): void {
    const secureCookie = config.PUBLIC_URL.startsWith('https://');

    function setSessionCookie(reply: FastifyReply, token: string) {
        reply.setCookie(COOKIE, token, {
            path: '/api/admin', httpOnly: true, sameSite: 'strict', secure: secureCookie,
            maxAge: config.SESSION_DAYS * 24 * 3600
        });
    }

    /** Session en cours (vérifiée ou non) */
    async function currentSession(req: FastifyRequest) {
        const token = req.cookies[COOKIE];
        if (!token) return null;
        const session = await db.adminSession.findUnique({
            where: { tokenHash: hashToken(token) },
            include: { admin: { include: { member: { include: { roles: true } } } } }
        });
        if (!session || session.expiresAt < new Date() || session.admin.disabled) return null;
        return session;
    }

    /** Exige une session complète (2FA validée et configurée si obligatoire) */
    async function requireAdmin(req: FastifyRequest): Promise<AdminCtx> {
        const session = await currentSession(req);
        if (!session) throw unauthorized();
        const admin = session.admin;
        if (!session.verified) throw unauthorized('Saisissez le code de votre application d\'authentification.');
        if (admin.isSuperAdmin && !admin.totpEnabled) {
            throw forbidden('Activez la double authentification pour continuer.');
        }
        const memberActive = admin.member && admin.member.status === 'ACTIVE';
        const scope = scopeFrom(memberActive ? admin.member!.roles : [], admin.isSuperAdmin);
        if (!hasAnyRole(scope)) throw forbidden('Ce compte n\'a plus de rôle d\'administration.');
        return {
            id: admin.id,
            email: admin.email,
            superAdmin: admin.isSuperAdmin,
            scope,
            label: `admin:${admin.email}`,
            displayName: admin.member?.name ?? 'Super admin'
        };
    }

    /** Identifiants des équipes visibles par l'acteur (null : toutes) */
    async function visibleTeamIds(ctx: AdminCtx): Promise<number[] | null> {
        if (ctx.superAdmin) return null;
        const catIds = [...ctx.scope.categories, ...ctx.scope.schedules];
        const cats = catIds.length ? await db.category.findMany({ where: { id: { in: catIds } }, select: { teamId: true } }) : [];
        return [...new Set([...ctx.scope.teams, ...cats.map((c) => c.teamId)])];
    }

    /** Catégories visibles dans une équipe (toutes pour un admin d'équipe) */
    function visibleCategoryFilter(ctx: AdminCtx, teamId: number): { id?: { in: number[] } } {
        if (canManageTeam(ctx.scope, teamId)) return {};
        return { id: { in: [...ctx.scope.categories, ...ctx.scope.schedules] } };
    }

    async function loadCategory(id: number) {
        const category = await db.category.findUnique({ where: { id }, include: { groups: true } });
        if (!category) throw notFound('Catégorie introuvable.');
        return category;
    }

    async function loadMember(id: number) {
        const member = await db.member.findUnique({ where: { id }, include: { roles: true, adminAccount: true } });
        if (!member) throw notFound('Membre introuvable.');
        return member;
    }

    const loginLimit = { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } };

    // ------------------------------------------------------------------ Connexion

    app.post('/api/admin/auth/login', loginLimit, async (req, reply) => {
        const body = parse(z.object({ email: emailSchema, password: z.string().min(1).max(200) }), req.body);
        const admin = await db.adminAccount.findUnique({ where: { email: body.email } });
        const ok = admin && !admin.disabled && (await verifyPassword(body.password, admin.passwordHash));
        if (!ok) throw unauthorized('Email ou mot de passe incorrect.');
        const token = newToken();
        await db.adminSession.create({
            data: {
                tokenHash: hashToken(token), adminId: admin.id, verified: !admin.totpEnabled,
                expiresAt: new Date(Date.now() + config.SESSION_DAYS * 24 * 3600_000)
            }
        });
        await db.adminAccount.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
        setSessionCookie(reply, token);
        return { needsTotp: admin.totpEnabled, needsTotpSetup: admin.isSuperAdmin && !admin.totpEnabled };
    });

    // Second facteur à la connexion
    app.post('/api/admin/auth/totp', loginLimit, async (req) => {
        const session = await currentSession(req);
        if (!session) throw unauthorized();
        const body = parse(z.object({ code: z.string().regex(/^\d{6}$/, 'Code à 6 chiffres.') }), req.body);
        const secret = session.admin.totpSecret;
        if (!session.admin.totpEnabled || !secret) throw badRequest('La double authentification n\'est pas activée.');
        const result = await verifyTotp({ secret, token: body.code });
        if (!result.valid) throw unauthorized('Code incorrect. Saisissez le code affiché actuellement.');
        await db.adminSession.update({ where: { id: session.id }, data: { verified: true } });
        return { ok: true };
    });

    // Préparer la double authentification : secret + QR code à scanner
    app.post('/api/admin/auth/totp/setup', async (req) => {
        const session = await currentSession(req);
        if (!session || !session.verified) throw unauthorized();
        if (session.admin.totpEnabled) throw conflict('La double authentification est déjà activée.');
        const secret = generateSecret();
        await db.adminAccount.update({ where: { id: session.adminId }, data: { totpSecret: secret } });
        const uri = generateURI({ issuer: 'Pause', label: session.admin.email, secret });
        return { secret, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
    });

    app.post('/api/admin/auth/totp/enable', loginLimit, async (req) => {
        const session = await currentSession(req);
        if (!session || !session.verified) throw unauthorized();
        const body = parse(z.object({ code: z.string().regex(/^\d{6}$/, 'Code à 6 chiffres.') }), req.body);
        const secret = session.admin.totpSecret;
        if (!secret) throw badRequest('Lancez d\'abord la configuration.');
        const result = await verifyTotp({ secret, token: body.code });
        if (!result.valid) throw badRequest('Code incorrect. Vérifiez l\'heure de votre téléphone et réessayez.');
        await db.adminAccount.update({ where: { id: session.adminId }, data: { totpEnabled: true } });
        await audit(db, { actor: `admin:${session.admin.email}`, action: 'admin.totp_enabled' });
        return { ok: true };
    });

    app.post('/api/admin/auth/logout', async (req, reply) => {
        const token = req.cookies[COOKIE];
        if (token) await db.adminSession.deleteMany({ where: { tokenHash: hashToken(token) } });
        reply.clearCookie(COOKIE, { path: '/api/admin' });
        return { ok: true };
    });

    app.post('/api/admin/auth/password', loginLimit, async (req) => {
        const ctx = await requireAdmin(req);
        const body = parse(z.object({ current: z.string().min(1), next: passwordSchema }), req.body);
        const admin = await db.adminAccount.findUniqueOrThrow({ where: { id: ctx.id } });
        if (!(await verifyPassword(body.current, admin.passwordHash))) throw badRequest('Mot de passe actuel incorrect.');
        await db.adminAccount.update({ where: { id: ctx.id }, data: { passwordHash: await hashPassword(body.next) } });
        await audit(db, { actor: ctx.label, action: 'admin.password_changed' });
        return { ok: true };
    });

    // État de la session (utilisé par le tableau de bord au chargement)
    app.get('/api/admin/me', async (req) => {
        const session = await currentSession(req);
        if (!session) return { authenticated: false };
        const a = session.admin;
        const needsTotp = !session.verified;
        const needsTotpSetup = session.verified && a.isSuperAdmin && !a.totpEnabled;
        return {
            authenticated: true, needsTotp, needsTotpSetup,
            admin: { id: a.id, email: a.email, superAdmin: a.isSuperAdmin, totpEnabled: a.totpEnabled, name: a.member?.name ?? null }
        };
    });

    // ------------------------------------------------------------------ Vue d'ensemble

    app.get('/api/admin/overview', async (req) => {
        const ctx = await requireAdmin(req);
        const teamIds = await visibleTeamIds(ctx);
        const teamWhere = teamIds ? { id: { in: teamIds } } : {};
        const now = localNow(config.LOCAL_OFFSET_HOURS);
        const teams = await db.team.findMany({
            where: teamWhere,
            orderBy: { name: 'asc' },
            include: {
                categories: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], include: { _count: { select: { members: true, groups: true } } } },
                _count: { select: { members: true } }
            }
        });
        const categoryIds = teams.flatMap((t) => t.categories.map((c) => c.id));
        const [pending, publications, activeToday] = await Promise.all([
            db.member.count({ where: { status: 'PENDING', team: teamWhere } }),
            db.publication.findMany({ where: { date: toDbDate(now.date), categoryId: { in: categoryIds } }, select: { categoryId: true, prayer: true } }),
            db.member.count({ where: { team: teamWhere, lastSeenAt: { gte: new Date(Date.now() - 24 * 3600_000) } } })
        ]);
        return {
            today: now.date,
            nowMins: now.nowMins,
            totals: {
                teams: teams.length,
                members: teams.reduce((n, t) => n + t._count.members, 0),
                pending,
                activeToday
            },
            teams: teams.map((t) => ({
                id: t.id, name: t.name, city: t.city, members: t._count.members,
                categories: t.categories.map((c) => ({
                    id: c.id, name: c.name, members: c._count.members, groups: c._count.groups, jumuaEnabled: c.jumuaEnabled,
                    publishedToday: publications.filter((p) => p.categoryId === c.id).map((p) => p.prayer)
                }))
            }))
        };
    });

    // ------------------------------------------------------------------ Équipes

    app.post('/api/admin/teams', async (req, reply) => {
        const ctx = await requireAdmin(req);
        assert(ctx.superAdmin, 'Seul le super admin crée des équipes.');
        const body = parse(teamBody, req.body);
        const team = await db.team.create({
            data: { name: body.name, city: body.city ?? 'Marrakesh', country: body.country ?? 'MA', requireApproval: body.requireApproval ?? false }
        });
        for (const [i, c] of DEFAULT_CATEGORIES.entries()) await createCategoryWithDefaults(db, team.id, c.name, c.jumuaEnabled, i);
        await audit(db, { actor: ctx.label, action: 'team.create', teamId: team.id, target: team.name });
        reply.code(201);
        return { id: team.id };
    });

    app.get('/api/admin/teams/:id', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const teamIds = await visibleTeamIds(ctx);
        if (teamIds && !teamIds.includes(id)) throw notFound('Équipe introuvable.');
        const catFilter = visibleCategoryFilter(ctx, id);
        const team = await db.team.findUnique({
            where: { id },
            include: {
                categories: {
                    where: catFilter,
                    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
                    include: {
                        groups: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
                        accessCodes: { where: { revokedAt: null }, orderBy: { createdAt: 'desc' } }
                    }
                },
                members: {
                    where: catFilter.id ? { categoryId: catFilter.id } : {},
                    orderBy: { name: 'asc' },
                    include: { roles: true, adminAccount: { select: { id: true, email: true, disabled: true } } }
                }
            }
        });
        if (!team) throw notFound('Équipe introuvable.');
        const manageTeam = canManageTeam(ctx.scope, id);
        return {
            id: team.id, name: team.name, city: team.city, country: team.country, requireApproval: team.requireApproval,
            canManageTeam: manageTeam,
            categories: team.categories.map((c) => ({
                id: c.id, name: c.name, jumuaEnabled: c.jumuaEnabled, maxGroups: c.maxGroups,
                canManage: canManageCategory(ctx.scope, c), canPublish: canPublish(ctx.scope, c),
                groups: c.groups.map((g) => ({ id: g.id, name: g.name })),
                // Les codes ne sont visibles que par ceux qui gèrent l'équipe
                codes: manageTeam
                    ? c.accessCodes
                        .filter((a) => !a.expiresAt || a.expiresAt > new Date())
                        .map((a) => ({ id: a.id, code: a.code, expiresAt: a.expiresAt, createdAt: a.createdAt }))
                    : []
            })),
            members: team.members.map((m) => ({
                id: m.id, name: m.name, status: m.status, categoryId: m.categoryId,
                createdAt: m.createdAt, lastSeenAt: m.lastSeenAt,
                // Silence en cours seulement (nul si levé ou expiré)
                mutedUntil: m.mutedUntil && m.mutedUntil > new Date() ? m.mutedUntil : null,
                roles: m.roles.map((r) => ({ role: r.role, categoryId: r.categoryId })),
                account: m.adminAccount
            }))
        };
    });

    app.patch('/api/admin/teams/:id', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        assert(canManageTeam(ctx.scope, id));
        const body = parse(teamBody.partial(), req.body);
        await db.team.update({ where: { id }, data: body });
        await audit(db, { actor: ctx.label, action: 'team.update', teamId: id, details: body });
        return { ok: true };
    });

    app.delete('/api/admin/teams/:id', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        assert(ctx.superAdmin, 'Seul le super admin supprime une équipe.');
        const team = await db.team.findUnique({ where: { id } });
        if (!team) throw notFound('Équipe introuvable.');
        await db.team.delete({ where: { id } });
        await audit(db, { actor: ctx.label, action: 'team.delete', target: team.name, details: { teamId: id } });
        return { ok: true };
    });

    // ------------------------------------------------------------------ Catégories et groupes

    app.post('/api/admin/teams/:id/categories', async (req, reply) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        assert(canManageTeam(ctx.scope, id));
        const body = parse(z.object({
            name: z.string().trim().min(2, 'Nom de catégorie trop court.').max(60),
            jumuaEnabled: z.boolean().default(true)
        }), req.body);
        const exists = await db.category.findUnique({ where: { teamId_name: { teamId: id, name: body.name } } });
        if (exists) throw conflict(`La catégorie « ${body.name} » existe déjà.`);
        const count = await db.category.count({ where: { teamId: id } });
        const category = await createCategoryWithDefaults(db, id, body.name, body.jumuaEnabled, count);
        await audit(db, { actor: ctx.label, action: 'category.create', teamId: id, target: body.name });
        reply.code(201);
        return { id: category.id };
    });

    app.patch('/api/admin/categories/:id', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const category = await loadCategory(id);
        assert(canManageCategory(ctx.scope, category));
        const body = parse(z.object({
            name: z.string().trim().min(2).max(60).optional(),
            jumuaEnabled: z.boolean().optional(),
            maxGroups: z.number().int().min(1).max(50).optional()
        }), req.body);
        if (body.name !== undefined && !canManageTeam(ctx.scope, category.teamId)) throw forbidden('Seul un admin d\'équipe renomme une catégorie.');
        if (body.maxGroups !== undefined && body.maxGroups < category.groups.length) {
            throw badRequest(`La catégorie a déjà ${category.groups.length} groupes : supprimez-en avant de baisser la limite.`);
        }
        await db.category.update({ where: { id }, data: body });
        await audit(db, { actor: ctx.label, action: 'category.update', teamId: category.teamId, target: category.name, details: body });
        return { ok: true };
    });

    app.delete('/api/admin/categories/:id', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const category = await loadCategory(id);
        assert(canManageTeam(ctx.scope, category.teamId));
        const members = await db.member.count({ where: { categoryId: id } });
        if (members > 0) throw conflict(`La catégorie compte ${members} membre(s) : déplacez-les avant de la supprimer.`);
        await db.category.delete({ where: { id } });
        await audit(db, { actor: ctx.label, action: 'category.delete', teamId: category.teamId, target: category.name });
        return { ok: true };
    });

    app.post('/api/admin/categories/:id/groups', async (req, reply) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const category = await loadCategory(id);
        assert(canManageCategory(ctx.scope, category));
        if (category.groups.length >= category.maxGroups) {
            throw conflict(`Limite atteinte : ${category.maxGroups} groupes au plus. Augmentez la limite pour en ajouter.`, 'group_limit');
        }
        const body = parse(z.object({ name: z.string().trim().min(1).max(20).optional() }), req.body);
        // Nom par défaut : premier « G<n> » libre
        const names = new Set(category.groups.map((g) => g.name));
        let name = body.name;
        if (!name) {
            let n = 1;
            while (names.has(`G${n}`)) n++;
            name = `G${n}`;
        }
        if (names.has(name)) throw conflict(`Le groupe « ${name} » existe déjà.`);
        const group = await db.group.create({ data: { categoryId: id, name, sortOrder: category.groups.length } });
        await audit(db, { actor: ctx.label, action: 'group.create', teamId: category.teamId, target: `${category.name} ${name}` });
        reply.code(201);
        return { id: group.id, name };
    });

    app.patch('/api/admin/groups/:id', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const group = await db.group.findUnique({ where: { id }, include: { category: true } });
        if (!group) throw notFound('Groupe introuvable.');
        assert(canManageCategory(ctx.scope, group.category));
        const body = parse(z.object({ name: z.string().trim().min(1).max(20) }), req.body);
        const clash = await db.group.findUnique({ where: { categoryId_name: { categoryId: group.categoryId, name: body.name } } });
        if (clash && clash.id !== id) throw conflict(`Le groupe « ${body.name} » existe déjà.`);
        await db.group.update({ where: { id }, data: { name: body.name } });
        await audit(db, { actor: ctx.label, action: 'group.rename', teamId: group.category.teamId, target: `${group.name} → ${body.name}` });
        return { ok: true };
    });

    app.delete('/api/admin/groups/:id', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const group = await db.group.findUnique({ where: { id }, include: { category: true } });
        if (!group) throw notFound('Groupe introuvable.');
        assert(canManageCategory(ctx.scope, group.category));
        await db.group.delete({ where: { id } });
        await audit(db, { actor: ctx.label, action: 'group.delete', teamId: group.category.teamId, target: `${group.category.name} ${group.name}` });
        return { ok: true };
    });

    // ------------------------------------------------------------------ Codes d'accès

    app.post('/api/admin/categories/:id/codes', async (req, reply) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const category = await loadCategory(id);
        assert(canManageTeam(ctx.scope, category.teamId));
        const body = parse(z.object({
            expiresInDays: z.number().int().min(1).max(365).optional(),
            /** Révoque les codes actuels de la catégorie (régénération) */
            replace: z.boolean().default(true)
        }), req.body);
        const code = newReadableCode();
        await db.$transaction(async (tx) => {
            if (body.replace) await tx.accessCode.updateMany({ where: { categoryId: id, revokedAt: null }, data: { revokedAt: new Date() } });
            await tx.accessCode.create({
                data: { categoryId: id, code, expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 24 * 3600_000) : null }
            });
        });
        await audit(db, { actor: ctx.label, action: 'code.create', teamId: category.teamId, target: category.name, details: { code, ...body } });
        reply.code(201);
        return { code };
    });

    app.delete('/api/admin/codes/:id', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const code = await db.accessCode.findUnique({ where: { id }, include: { category: true } });
        if (!code) throw notFound('Code introuvable.');
        assert(canManageTeam(ctx.scope, code.category.teamId));
        await db.accessCode.update({ where: { id }, data: { revokedAt: new Date() } });
        await audit(db, { actor: ctx.label, action: 'code.revoke', teamId: code.category.teamId, target: code.code });
        return { ok: true };
    });

    // ------------------------------------------------------------------ Horaires du jour

    app.get('/api/admin/categories/:id/day', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const category = await loadCategory(id);
        assert(canPublish(ctx.scope, category) || canManageTeam(ctx.scope, category.teamId));
        const q = parse(z.object({ date: z.string().regex(DATE_RE).optional() }), req.query);
        const now = localNow(config.LOCAL_OFFSET_HOURS);
        // Dernière publication avant ce jour, pour préremplir le formulaire
        const date = q.date ?? now.date;
        const previous = await db.publication.findMany({
            where: { categoryId: id, date: { lt: toDbDate(date) } },
            orderBy: { date: 'desc' }, take: 3, include: { slots: true }
        });
        const day = await getDayView(db, id, date);
        return {
            ...day, today: now.date, nowMins: now.nowMins,
            previous: previous.map((p) => ({ prayer: p.prayer, slots: p.slots.map((s) => ({ groupId: s.groupId, timeMins: s.timeMins })) }))
        };
    });

    app.post('/api/admin/categories/:id/publish', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const category = await loadCategory(id);
        assert(canPublish(ctx.scope, category), 'Seuls les admins et responsables horaires publient les horaires.');
        const body = parse(z.object({ date: z.string().regex(DATE_RE), prayer: prayerSchema, slots: slotsSchema }), req.body);
        const now = localNow(config.LOCAL_OFFSET_HOURS);
        if (body.date < now.date) throw badRequest('On ne peut pas publier les horaires d\'un jour passé.');
        const slots = body.slots.map((s) => ({ groupId: s.groupId, timeMins: toMins(s.time) }));
        const result = await publish(db, { categoryId: id, date: body.date, prayer: body.prayer, by: ctx.displayName, slots });
        // Carte de publication dans la discussion + événements temps réel
        await hub.schedulePublished({ categoryId: id, date: body.date, prayer: body.prayer, slots, result });
        await audit(db, {
            actor: ctx.label, action: result.created ? 'schedule.publish' : 'schedule.update', teamId: category.teamId,
            target: `${category.name} ${body.prayer} ${body.date}`, details: { slots: body.slots, ...result }
        });
        return { ...(await getDayView(db, id, body.date)), today: now.date, nowMins: now.nowMins };
    });

    // ------------------------------------------------------------------ Membres

    app.patch('/api/admin/members/:id', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const member = await loadMember(id);
        assert(canManageTeam(ctx.scope, member.teamId));
        const body = parse(z.object({
            status: z.enum(['ACTIVE', 'BLOCKED']).optional(),
            categoryId: z.number().int().positive().optional(),
            name: z.string().trim().min(2).max(60).optional()
        }), req.body);
        if (body.categoryId !== undefined) {
            const target = await db.category.findUnique({ where: { id: body.categoryId } });
            if (!target || target.teamId !== member.teamId) throw badRequest('Cette catégorie n\'appartient pas à l\'équipe.');
        }
        if (body.name !== undefined) {
            const clash = await db.member.findUnique({ where: { teamId_name: { teamId: member.teamId, name: body.name } } });
            if (clash && clash.id !== id) throw conflict(`« ${body.name} » est déjà utilisé dans l'équipe.`);
        }
        await db.$transaction(async (tx) => {
            await tx.member.update({ where: { id }, data: body });
            if (body.categoryId !== undefined && body.categoryId !== member.categoryId) {
                // Changement de catégorie : ses groupes et rôles de catégorie ne s'appliquent plus
                await tx.usualGroup.deleteMany({ where: { memberId: id } });
                await tx.groupChoice.deleteMany({ where: { memberId: id } });
                await tx.roleAssignment.deleteMany({ where: { memberId: id, categoryId: { not: null } } });
            }
        });
        const movedCategory = body.categoryId !== undefined && body.categoryId !== member.categoryId;
        // Nouvelle discussion de catégorie : son historique n'est pas « non lu »
        if (movedCategory) await markChannelSeen(db, id, `cat:${body.categoryId}`);
        const action = body.status === 'BLOCKED' ? 'member.block' : body.status === 'ACTIVE' ? 'member.activate' : 'member.update';
        await audit(db, { actor: ctx.label, action, teamId: member.teamId, target: member.name, details: body });
        // Statut, catégorie ou nom modifié : le membre est prévenu en temps réel et relit son profil
        const renamed = body.name !== undefined && body.name !== member.name;
        if ((body.status !== undefined && body.status !== member.status) || movedCategory || renamed) void hub.memberStatus(id);
        return { ok: true };
    });

    app.delete('/api/admin/members/:id', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const member = await loadMember(id);
        assert(canManageTeam(ctx.scope, member.teamId));
        if (member.adminAccount && !ctx.superAdmin) throw forbidden('Seul le super admin supprime un membre qui a un compte admin.');
        await db.member.delete({ where: { id } });
        hub.closeMember(id);
        await audit(db, { actor: ctx.label, action: 'member.delete', teamId: member.teamId, target: member.name });
        return { ok: true };
    });

    app.post('/api/admin/members/:id/transfer-code', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const member = await loadMember(id);
        assert(canManageTeam(ctx.scope, member.teamId));
        const code = newReadableCode();
        const expiresAt = new Date(Date.now() + TRANSFER_CODE_HOURS * 3600_000);
        await db.transferCode.create({ data: { memberId: id, code, expiresAt } });
        await audit(db, { actor: ctx.label, action: 'member.transfer_code', teamId: member.teamId, target: member.name });
        return { code, expiresAt };
    });

    // Rôles : seul le super admin nomme les admins d'équipe ; un admin d'équipe nomme les rôles de catégorie
    app.put('/api/admin/members/:id/roles', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const member = await loadMember(id);
        assert(canManageTeam(ctx.scope, member.teamId));
        const body = parse(z.object({
            roles: z.array(z.object({
                role: z.enum(['TEAM_ADMIN', 'CATEGORY_ADMIN', 'SCHEDULER']),
                categoryId: z.number().int().positive().nullable()
            })).max(20)
        }), req.body);
        const before = new Set(member.roles.map((r) => `${r.role}:${r.categoryId}`));
        const after = new Set(body.roles.map((r) => `${r.role}:${r.role === 'TEAM_ADMIN' ? null : r.categoryId}`));
        const teamAdminChanged = before.has('TEAM_ADMIN:null') !== after.has('TEAM_ADMIN:null');
        if (teamAdminChanged && !ctx.superAdmin) throw forbidden('Seul le super admin nomme ou retire un admin d\'équipe.');
        const categoryIds = body.roles.filter((r) => r.role !== 'TEAM_ADMIN').map((r) => r.categoryId);
        if (categoryIds.some((c) => c === null)) throw badRequest('Indiquez la catégorie de chaque rôle de catégorie.');
        if (categoryIds.length) {
            const cats = await db.category.findMany({ where: { id: { in: categoryIds as number[] } } });
            if (cats.length !== new Set(categoryIds).size || cats.some((c) => c.teamId !== member.teamId)) {
                throw badRequest('Un des rôles vise une catégorie d\'une autre équipe.');
            }
        }
        await db.$transaction(async (tx) => {
            await tx.roleAssignment.deleteMany({ where: { memberId: id } });
            const unique = new Map(body.roles.map((r) => [`${r.role}:${r.role === 'TEAM_ADMIN' ? null : r.categoryId}`, r]));
            for (const r of unique.values()) {
                await tx.roleAssignment.create({
                    data: { memberId: id, teamId: member.teamId, role: r.role as Role, categoryId: r.role === 'TEAM_ADMIN' ? null : r.categoryId }
                });
            }
        });
        // Premier rôle : la discussion des admins apparaît, son historique n'est pas « non lu »
        if (member.roles.length === 0 && body.roles.length > 0) await markChannelSeen(db, id, `admins:${member.teamId}`);
        await audit(db, { actor: ctx.label, action: 'member.roles', teamId: member.teamId, target: member.name, details: { roles: body.roles } });
        // Droits modifiés : l'application relit son profil et ses discussions
        void hub.memberStatus(id);
        return { ok: true };
    });

    // Compte du tableau de bord pour un membre qui a un rôle
    app.post('/api/admin/members/:id/account', async (req, reply) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const member = await loadMember(id);
        assert(canManageTeam(ctx.scope, member.teamId));
        if (member.roles.length === 0) throw badRequest('Donnez d\'abord un rôle à ce membre.');
        if (member.adminAccount) throw conflict('Ce membre a déjà un compte.');
        const body = parse(z.object({ email: emailSchema, password: passwordSchema }), req.body);
        if (await db.adminAccount.findUnique({ where: { email: body.email } })) throw conflict('Cette adresse email est déjà utilisée.');
        await db.adminAccount.create({ data: { email: body.email, passwordHash: await hashPassword(body.password), memberId: id } });
        await audit(db, { actor: ctx.label, action: 'account.create', teamId: member.teamId, target: body.email, details: { member: member.name } });
        reply.code(201);
        return { ok: true };
    });

    // ------------------------------------------------------------------ Comptes (super admin)

    app.get('/api/admin/accounts', async (req) => {
        const ctx = await requireAdmin(req);
        assert(ctx.superAdmin);
        const accounts = await db.adminAccount.findMany({
            orderBy: { email: 'asc' },
            include: { member: { select: { name: true, team: { select: { name: true } } } } }
        });
        return accounts.map((a) => ({
            id: a.id, email: a.email, superAdmin: a.isSuperAdmin, totpEnabled: a.totpEnabled, disabled: a.disabled,
            lastLoginAt: a.lastLoginAt, member: a.member ? { name: a.member.name, team: a.member.team.name } : null
        }));
    });

    app.post('/api/admin/accounts', async (req, reply) => {
        const ctx = await requireAdmin(req);
        assert(ctx.superAdmin);
        const body = parse(z.object({ email: emailSchema, password: passwordSchema }), req.body);
        if (await db.adminAccount.findUnique({ where: { email: body.email } })) throw conflict('Cette adresse email est déjà utilisée.');
        await db.adminAccount.create({ data: { email: body.email, passwordHash: await hashPassword(body.password), isSuperAdmin: true } });
        await audit(db, { actor: ctx.label, action: 'account.create_superadmin', target: body.email });
        reply.code(201);
        return { ok: true };
    });

    app.patch('/api/admin/accounts/:id', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        const account = await db.adminAccount.findUnique({ where: { id }, include: { member: true } });
        if (!account) throw notFound('Compte introuvable.');
        const allowed = ctx.superAdmin || (account.member !== null && !account.isSuperAdmin && canManageTeam(ctx.scope, account.member.teamId));
        assert(allowed);
        if (id === ctx.id) throw badRequest('Vous ne pouvez pas modifier votre propre compte ici.');
        const body = parse(z.object({
            disabled: z.boolean().optional(),
            password: passwordSchema.optional(),
            resetTotp: z.boolean().optional()
        }), req.body);
        await db.adminAccount.update({
            where: { id },
            data: {
                disabled: body.disabled,
                passwordHash: body.password ? await hashPassword(body.password) : undefined,
                ...(body.resetTotp ? { totpEnabled: false, totpSecret: null } : {})
            }
        });
        if (body.disabled || body.password || body.resetTotp) await db.adminSession.deleteMany({ where: { adminId: id } });
        await audit(db, {
            actor: ctx.label, action: 'account.update', teamId: account.member?.teamId ?? null, target: account.email,
            details: { disabled: body.disabled, passwordReset: Boolean(body.password), totpReset: Boolean(body.resetTotp) }
        });
        return { ok: true };
    });

    app.delete('/api/admin/accounts/:id', async (req) => {
        const ctx = await requireAdmin(req);
        const { id } = parse(idParam, req.params);
        assert(ctx.superAdmin);
        if (id === ctx.id) throw badRequest('Vous ne pouvez pas supprimer votre propre compte.');
        const account = await db.adminAccount.findUnique({ where: { id } });
        if (!account) throw notFound('Compte introuvable.');
        await db.adminAccount.delete({ where: { id } });
        await audit(db, { actor: ctx.label, action: 'account.delete', target: account.email });
        return { ok: true };
    });

    // ------------------------------------------------------------------ Journal d'activité

    app.get('/api/admin/audit', async (req) => {
        const ctx = await requireAdmin(req);
        const q = parse(z.object({
            teamId: z.coerce.number().int().positive().optional(),
            before: z.coerce.number().int().positive().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50)
        }), req.query);
        const teamIds = await visibleTeamIds(ctx);
        if (q.teamId && teamIds && !teamIds.includes(q.teamId)) throw forbidden();
        const where = {
            ...(q.teamId ? { teamId: q.teamId } : teamIds ? { teamId: { in: teamIds } } : {}),
            ...(q.before ? { id: { lt: q.before } } : {})
        };
        const rows = await db.auditLog.findMany({ where, orderBy: { id: 'desc' }, take: q.limit });
        return rows;
    });
}
