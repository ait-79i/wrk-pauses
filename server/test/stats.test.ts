// Statistiques du tableau de bord (contrat §6) contre une vraie base MySQL (TEST_DATABASE_URL), vidée au début.
// Sans TEST_DATABASE_URL, ces tests sont ignorés.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db.js';
import { hashToken, newToken } from '../src/lib/security.js';
import { addDays } from '../src/services/stats.js';

const TEST_DB = process.env.TEST_DATABASE_URL;

/** Lundi de la semaine passée complète (le vendredi qui suit est dans le passé) */
function pastMonday(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 7);
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

describe.skipIf(!TEST_DB)('statistiques (intégration)', () => {
    let app: FastifyInstance;
    let db: Db;
    const monday = pastMonday();
    const wednesday = addDays(monday, 2);
    const friday = addDays(monday, 4);
    const ids = { team: 0, other: 0, hommes: 0, femmes: 0, g1: 0, g2: 0, f1: 0 };
    const cookies = { superAdmin: '', teamAdmin: '', femmesAdmin: '', otherCatAdmin: '' };

    /** Compte du tableau de bord avec une session déjà vérifiée ; renvoie l'en-tête cookie */
    async function session(email: string, data: { isSuperAdmin?: boolean; memberId?: number }): Promise<string> {
        const account = await db.adminAccount.create({
            data: { email, passwordHash: 'x', isSuperAdmin: data.isSuperAdmin ?? false, totpEnabled: data.isSuperAdmin ?? false, memberId: data.memberId }
        });
        const token = newToken();
        await db.adminSession.create({
            data: { tokenHash: hashToken(token), adminId: account.id, verified: true, expiresAt: new Date(Date.now() + 3600_000) }
        });
        return `pause_admin=${token}`;
    }

    const newMember = (teamId: number, categoryId: number, name: string, extra: { status?: 'ACTIVE' | 'BLOCKED'; lastSeenAt?: Date } = {}) =>
        db.member.create({ data: { teamId, categoryId, name, deviceTokenHash: hashToken(newToken()), ...extra } });

    const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

    beforeAll(async () => {
        const config = loadConfig({ ...process.env, DATABASE_URL: TEST_DB!, NODE_ENV: 'test' });
        db = createDb(config.DATABASE_URL);
        // Table de la discussion (phase 2) : peut ne pas exister encore
        try { await db.$executeRawUnsafe('DELETE FROM `Message`'); } catch { /* table absente */ }
        await db.auditLog.deleteMany();
        await db.adminSession.deleteMany();
        await db.adminAccount.deleteMany();
        await db.team.deleteMany();

        // Équipe 1 : Hommes (Jumu'a, G1, G2) créée le lundi, Femmes (F1) créée le mercredi
        const team = await db.team.create({ data: { name: 'Équipe stats' } });
        ids.team = team.id;
        const hommes = await db.category.create({
            data: {
                teamId: team.id, name: 'Hommes', jumuaEnabled: true, sortOrder: 0, createdAt: dbDate(monday),
                groups: { create: [{ name: 'G1', sortOrder: 0 }, { name: 'G2', sortOrder: 1 }] }
            },
            include: { groups: { orderBy: { sortOrder: 'asc' } } }
        });
        ids.hommes = hommes.id;
        ids.g1 = hommes.groups[0].id;
        ids.g2 = hommes.groups[1].id;
        const femmes = await db.category.create({
            data: {
                teamId: team.id, name: 'Femmes', jumuaEnabled: false, sortOrder: 1, createdAt: dbDate(wednesday),
                groups: { create: [{ name: 'F1', sortOrder: 0 }] }
            },
            include: { groups: true }
        });
        ids.femmes = femmes.id;
        ids.f1 = femmes.groups[0].id;

        // Membres d'Hommes : 3 actifs (dont 1 vu cette semaine) + 1 bloqué (ignoré)
        const a = await newMember(team.id, hommes.id, 'Amine', { lastSeenAt: new Date() });
        const b = await newMember(team.id, hommes.id, 'Badr', { lastSeenAt: new Date(Date.now() - 10 * 24 * 3600_000) });
        const c = await newMember(team.id, hommes.id, 'Chakib');
        const d = await newMember(team.id, hommes.id, 'Driss', { status: 'BLOCKED', lastSeenAt: new Date() });
        const fatima = await newMember(team.id, femmes.id, 'Fatima');

        await db.usualGroup.createMany({
            data: [
                { memberId: a.id, prayer: 'DHUHR', groupId: ids.g1 },
                { memberId: b.id, prayer: 'DHUHR', groupId: ids.g1 },
                { memberId: c.id, prayer: 'ASR', groupId: ids.g2 },
                { memberId: d.id, prayer: 'DHUHR', groupId: ids.g1 }
            ]
        });
        await db.groupChoice.createMany({
            data: [
                { memberId: b.id, date: dbDate(monday), prayer: 'DHUHR', groupId: ids.g2 },
                { memberId: c.id, date: dbDate(monday), prayer: 'DHUHR', groupId: null },
                { memberId: a.id, date: dbDate(monday), prayer: 'ASR', groupId: ids.g1 }
            ]
        });
        // Publications : lundi Dhuhr (G1 12:30, G2 12:40), lundi Asr (G1 15:30), vendredi Jumu'a (13:00)
        await db.publication.create({
            data: {
                categoryId: hommes.id, date: dbDate(monday), prayer: 'DHUHR', publishedBy: 'test',
                slots: { create: [{ groupId: ids.g1, timeMins: 750 }, { groupId: ids.g2, timeMins: 760 }] }
            }
        });
        await db.publication.create({
            data: { categoryId: hommes.id, date: dbDate(monday), prayer: 'ASR', publishedBy: 'test', slots: { create: [{ groupId: ids.g1, timeMins: 930 }] } }
        });
        await db.publication.create({
            data: { categoryId: hommes.id, date: dbDate(friday), prayer: 'JUMUA', publishedBy: 'test', slots: { create: [{ groupId: null, timeMins: 780 }] } }
        });

        // Équipe 2 avec son admin de catégorie
        const other = await db.team.create({ data: { name: 'Autre équipe' } });
        ids.other = other.id;
        const otherCat = await db.category.create({ data: { teamId: other.id, name: 'Hommes' } });
        const otherAdmin = await newMember(other.id, otherCat.id, 'Omar');
        await db.roleAssignment.create({ data: { memberId: otherAdmin.id, teamId: other.id, categoryId: otherCat.id, role: 'CATEGORY_ADMIN' } });

        // Rôles dans l'équipe 1 : admin d'équipe (Amine), admin de catégorie Femmes (Fatima)
        await db.roleAssignment.create({ data: { memberId: a.id, teamId: team.id, categoryId: null, role: 'TEAM_ADMIN' } });
        await db.roleAssignment.create({ data: { memberId: fatima.id, teamId: team.id, categoryId: femmes.id, role: 'CATEGORY_ADMIN' } });

        cookies.superAdmin = await session('super@stats.local', { isSuperAdmin: true });
        cookies.teamAdmin = await session('amine@stats.local', { memberId: a.id });
        cookies.femmesAdmin = await session('fatima@stats.local', { memberId: fatima.id });
        cookies.otherCatAdmin = await session('omar@stats.local', { memberId: otherAdmin.id });

        app = await buildApp(db, config);
    });

    afterAll(async () => {
        await app?.close();
        await db?.$disconnect();
    });

    const statsUrl = (teamId: number, from = monday, to = friday) => `/api/admin/teams/${teamId}/stats?from=${from}&to=${to}`;

    it('compte les groupes habituels et les choix explicites', async () => {
        const res = await get(cookies.superAdmin, statsUrl(ids.team));
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toMatchObject({ from: monday, to: friday });

        const dhuhr = body.days.find((d: { date: string; prayer: string; categoryId: number }) =>
            d.date === monday && d.prayer === 'DHUHR' && d.categoryId === ids.hommes);
        // G1 : Amine (habituel) ; G2 : Badr (choix explicite) ; Chakib : aucun groupe ; Driss bloqué
        expect(dhuhr).toMatchObject({ published: true, total: 2 });
        expect(dhuhr.slots).toEqual([
            { groupId: ids.g1, groupName: 'G1', timeMins: 750, count: 1 },
            { groupId: ids.g2, groupName: 'G2', timeMins: 760, count: 1 }
        ]);

        // Asr : G2 (habituel de Chakib) non publié → seul Amine compte
        const asr = body.days.find((d: { date: string; prayer: string }) => d.date === monday && d.prayer === 'ASR');
        expect(asr).toMatchObject({ published: true, total: 1 });

        const tuesday = body.days.find((d: { date: string; prayer: string }) => d.date === addDays(monday, 1) && d.prayer === 'DHUHR');
        expect(tuesday).toMatchObject({ published: false, publishedAt: null, total: 0, slots: [] });
    });

    it('Jumu\'a : tous les membres actifs de la catégorie', async () => {
        const body = (await get(cookies.superAdmin, statsUrl(ids.team))).json();
        const jumua = body.days.find((d: { date: string; prayer: string }) => d.date === friday && d.prayer === 'JUMUA');
        expect(jumua).toMatchObject({ published: true, total: 3 });
        expect(jumua.slots).toEqual([{ groupId: null, groupName: null, timeMins: 780, count: 3 }]);
        expect(body.days.some((d: { date: string; prayer: string; categoryId: number }) =>
            d.date === friday && d.prayer === 'DHUHR' && d.categoryId === ids.hommes)).toBe(false);
    });

    it('taux de publication et de participation, moyennes par groupe', async () => {
        const body = (await get(cookies.superAdmin, statsUrl(ids.team))).json();
        const hommes = body.categories.find((c: { id: number }) => c.id === ids.hommes);
        // 3 publiées sur 10 attendues (lun–jeu Dhuhr + Asr, ven Jumu'a + Asr)
        // Participation : prières avec choix de groupe seulement (Jumu'a n'a pas d'inscription) : (2/3 + 1/3) / 2
        expect(hommes).toEqual({
            id: ids.hommes, name: 'Hommes', members: 3, activeMembers7d: 1, publicationRate: 0.3, participationRate: 0.5
        });
        // Femmes créée le mercredi : 6 prières attendues, aucune publiée
        const femmes = body.categories.find((c: { id: number }) => c.id === ids.femmes);
        expect(femmes).toMatchObject({ members: 1, publicationRate: 0, participationRate: 0 });
        expect(body.days.filter((d: { categoryId: number }) => d.categoryId === ids.femmes)).toHaveLength(6);
        expect(body.days.filter((d: { categoryId: number }) => d.categoryId === ids.hommes)).toHaveLength(10);

        expect(body.groups).toEqual([
            { groupId: ids.g1, name: 'G1', categoryId: ids.hommes, averageCount: 1, averageTimeMins: 840 },
            { groupId: ids.g2, name: 'G2', categoryId: ids.hommes, averageCount: 1, averageTimeMins: 760 },
            { groupId: ids.f1, name: 'F1', categoryId: ids.femmes, averageCount: 0, averageTimeMins: null }
        ]);
    });

    it('Jumu\'a désactivée après coup : le vendredi publié reste compté', async () => {
        await db.category.update({ where: { id: ids.hommes }, data: { jumuaEnabled: false } });
        try {
            const body = (await get(cookies.superAdmin, statsUrl(ids.team))).json();
            const hommes = body.categories.find((c: { id: number }) => c.id === ids.hommes);
            expect(hommes.publicationRate).toBe(0.3);
            expect(body.days.some((d: { date: string; prayer: string; categoryId: number }) =>
                d.date === friday && d.prayer === 'DHUHR' && d.categoryId === ids.hommes)).toBe(false);
            expect(body.days.filter((d: { categoryId: number }) => d.categoryId === ids.hommes)).toHaveLength(10);
        } finally {
            await db.category.update({ where: { id: ids.hommes }, data: { jumuaEnabled: true } });
        }
    });

    it('un admin de catégorie ne voit que sa catégorie', async () => {
        const res = await get(cookies.femmesAdmin, statsUrl(ids.team));
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.categories.map((c: { id: number }) => c.id)).toEqual([ids.femmes]);
        expect(body.days.every((d: { categoryId: number }) => d.categoryId === ids.femmes)).toBe(true);
        expect(body.groups.map((g: { groupId: number }) => g.groupId)).toEqual([ids.f1]);
    });

    it('un admin de catégorie d\'une autre équipe est refusé', async () => {
        const res = await get(cookies.otherCatAdmin, statsUrl(ids.team));
        expect(res.statusCode).toBe(404);
        expect(res.json().categories).toBeUndefined();
        expect((await get('', statsUrl(ids.team))).statusCode).toBe(401);
    });

    it('période : 30 derniers jours par défaut, 92 jours au maximum', async () => {
        const def = (await get(cookies.teamAdmin, `/api/admin/teams/${ids.team}/stats`)).json();
        const today = new Date().toISOString().slice(0, 10);
        expect(def).toMatchObject({ to: today, from: addDays(today, -29) });

        expect((await get(cookies.teamAdmin, statsUrl(ids.team, friday, monday))).statusCode).toBe(400);
        expect((await get(cookies.teamAdmin, statsUrl(ids.team, addDays(friday, -92), friday))).statusCode).toBe(400);
        expect((await get(cookies.teamAdmin, statsUrl(ids.team, addDays(friday, -91), friday))).statusCode).toBe(200);
        expect((await get(cookies.teamAdmin, statsUrl(ids.team, '2026-02-30', friday))).statusCode).toBe(400);
    });

    it('statistiques globales : super admin seulement', async () => {
        expect((await get(cookies.teamAdmin, '/api/admin/stats/global')).statusCode).toBe(403);

        const res = await get(cookies.superAdmin, '/api/admin/stats/global');
        expect(res.statusCode).toBe(200);
        const body = res.json();
        // Membres actifs : 3 (Hommes) + 1 (Femmes) + 1 (autre équipe) ; vus en 7 jours : Amine
        expect(body.totals).toMatchObject({ teams: 2, members: 5, activeMembers7d: 1 });
        expect(typeof body.totals.messages7d).toBe('number');
        const team = body.teams.find((t: { id: number }) => t.id === ids.team);
        expect(team).toMatchObject({ name: 'Équipe stats', members: 4, activeMembers7d: 1 });
        for (const key of ['publicationRate7d', 'participationRate7d', 'messages7d']) {
            expect(team[key]).toBeGreaterThanOrEqual(0);
        }
        expect(team.publicationRate7d).toBeLessThanOrEqual(1);
    });
});
