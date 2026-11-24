// Statistiques du tableau de bord (phase 3). Contrat : docs/contrat-api-phases-2-3.md §6.
// GET /api/admin/teams/:id/stats et GET /api/admin/stats/global.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { requireAdminSession, type AdminActor } from '../lib/admin-session.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { DATE_RE, fromDbDate, localNow, toDbDate } from '../lib/time.js';
import { canManageTeam } from '../services/access.js';
import { addDays, combinedRates, computeRangeStats, datesBetween, messages7dByTeam } from '../services/stats.js';
import { idParam, parse } from './validation.js';

const MAX_RANGE_DAYS = 92;
const DEFAULT_RANGE_DAYS = 30;

const dateSchema = z.string().regex(DATE_RE, 'Date attendue au format AAAA-MM-JJ.')
    .refine((d) => fromDbDate(toDbDate(d)) === d, 'Cette date n\'existe pas.');
const rangeQuery = z.object({ from: dateSchema.optional(), to: dateSchema.optional() });

const categoryInclude = { groups: { orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }], select: { id: true, name: true } } };
const categoryOrder = [{ sortOrder: 'asc' as const }, { id: 'asc' as const }];

/** Catégories visibles par l'acteur dans l'équipe ; null si l'équipe ne lui est pas visible */
function visibleCategoryIds(actor: AdminActor, teamId: number, teamCategoryIds: number[]): number[] | null {
    if (canManageTeam(actor.scope, teamId)) return teamCategoryIds;
    const mine = new Set([...actor.scope.categories, ...actor.scope.schedules]);
    const visible = teamCategoryIds.filter((id) => mine.has(id));
    return visible.length ? visible : null;
}

export function registerStatsApi(app: FastifyInstance, { db, config }: { db: Db; config: Config }): void {
    app.get('/api/admin/teams/:id/stats', async (req) => {
        const actor = await requireAdminSession(db, req);
        const { id } = parse(idParam, req.params);
        const query = parse(rangeQuery, req.query);

        const today = localNow(config.LOCAL_OFFSET_HOURS).date;
        // Par défaut : les 30 derniers jours ; avec « from » seul, 30 jours à partir de cette date (sans dépasser aujourd'hui)
        let to = query.to ?? today;
        if (!query.to && query.from) {
            const end = addDays(query.from, DEFAULT_RANGE_DAYS - 1);
            to = end < today ? end : query.from > today ? query.from : today;
        }
        const from = query.from ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
        if (from > to) throw badRequest('La date de début doit précéder la date de fin.');
        if (datesBetween(from, to).length > MAX_RANGE_DAYS) {
            throw badRequest(`Période trop longue : ${MAX_RANGE_DAYS} jours au maximum.`);
        }

        const team = await db.team.findUnique({
            where: { id },
            include: { categories: { orderBy: categoryOrder, include: categoryInclude } }
        });
        // Équipe invisible : même réponse qu'une équipe inexistante (comme GET /api/admin/teams/:id)
        if (!team) throw notFound('Équipe introuvable.');
        const visible = visibleCategoryIds(actor, team.id, team.categories.map((c) => c.id));
        if (!visible) throw notFound('Équipe introuvable.');

        const categories = team.categories.filter((c) => visible.includes(c.id));
        const stats = await computeRangeStats(db, categories, from, to, config.LOCAL_OFFSET_HOURS);
        return { from, to, categories: stats.categories, days: stats.days, groups: stats.groups };
    });

    app.get('/api/admin/stats/global', async (req) => {
        const actor = await requireAdminSession(db, req);
        if (!actor.superAdmin) throw forbidden('Statistiques globales réservées au super admin.');

        const now = Date.now();
        const to = localNow(config.LOCAL_OFFSET_HOURS, now).date;
        const from = addDays(to, -6);
        const teams = await db.team.findMany({
            orderBy: { name: 'asc' },
            include: { categories: { orderBy: categoryOrder, include: categoryInclude } }
        });
        const categoryTeam = new Map(teams.flatMap((t) => t.categories.map((c) => [c.id, t.id] as const)));
        const [stats, messages] = await Promise.all([
            computeRangeStats(db, teams.flatMap((t) => t.categories), from, to, config.LOCAL_OFFSET_HOURS, now),
            messages7dByTeam(db, categoryTeam, now)
        ]);

        const rows = teams.map((t) => {
            const cats = stats.categories.filter((c) => categoryTeam.get(c.id) === t.id);
            const rates = combinedRates(cats.map((c) => stats.counters.get(c.id)!));
            return {
                id: t.id,
                name: t.name,
                members: cats.reduce((n, c) => n + c.members, 0),
                activeMembers7d: cats.reduce((n, c) => n + c.activeMembers7d, 0),
                publicationRate7d: rates.publicationRate,
                participationRate7d: rates.participationRate,
                messages7d: messages.get(t.id) ?? 0
            };
        });

        return {
            totals: {
                teams: rows.length,
                members: rows.reduce((n, r) => n + r.members, 0),
                activeMembers7d: rows.reduce((n, r) => n + r.activeMembers7d, 0),
                messages7d: rows.reduce((n, r) => n + r.messages7d, 0)
            },
            teams: rows
        };
    });
}
