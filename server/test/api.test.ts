// Parcours complet contre une vraie base MySQL (TEST_DATABASE_URL), vidée au début.
// Sans TEST_DATABASE_URL, ces tests sont ignorés.

import type { FastifyInstance } from 'fastify';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db.js';
import { hashPassword } from '../src/lib/security.js';

const TEST_DB = process.env.TEST_DATABASE_URL;

/** Prochain jour de la semaine voulu (1 = lundi … 5 = vendredi), strictement après aujourd'hui */
function nextWeekday(target: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    while (d.getUTCDay() !== target) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

describe.skipIf(!TEST_DB)('API équipes (intégration)', () => {
    let app: FastifyInstance;
    let db: Db;
    let cookie = '';
    const monday = nextWeekday(1);
    const friday = nextWeekday(5);

    const admin = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
        const res = await app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
        const setCookie = res.headers['set-cookie'];
        if (setCookie) cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
        return res;
    };
    const member = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
        app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });

    beforeAll(async () => {
        const config = loadConfig({ ...process.env, DATABASE_URL: TEST_DB!, NODE_ENV: 'test' });
        db = createDb(config.DATABASE_URL);
        // Ordre de suppression compatible avec les clés étrangères
        await db.auditLog.deleteMany();
        await db.adminSession.deleteMany();
        await db.adminAccount.deleteMany();
        await db.team.deleteMany();
        await db.adminAccount.create({
            data: { email: 'super@test.local', passwordHash: await hashPassword('motdepasse-solide'), isSuperAdmin: true }
        });
        app = await buildApp(db, config);
    });

    afterAll(async () => {
        await app?.close();
        await db?.$disconnect();
    });

    let teamId = 0;
    let hommes = { id: 0, code: '', g1: 0, g2: 0 };
    let femmesCode = '';
    let azedine = '';

    it('connexion du super admin avec mise en place de la double authentification', async () => {
        const login = await admin('POST', '/api/admin/auth/login', { email: 'super@test.local', password: 'motdepasse-solide' });
        expect(login.statusCode).toBe(200);
        expect(login.json()).toMatchObject({ needsTotpSetup: true });

        // Sans 2FA, l'accès est refusé
        expect((await admin('GET', '/api/admin/overview')).statusCode).toBe(403);

        const setup = await admin('POST', '/api/admin/auth/totp/setup');
        const { secret } = setup.json();
        const enable = await admin('POST', '/api/admin/auth/totp/enable', { code: await generate({ secret }) });
        expect(enable.statusCode).toBe(200);
        expect((await admin('GET', '/api/admin/overview')).statusCode).toBe(200);
    });

    it('mauvais mot de passe refusé', async () => {
        const res = await app.inject({ method: 'POST', url: '/api/admin/auth/login', payload: { email: 'super@test.local', password: 'faux' } });
        expect(res.statusCode).toBe(401);
    });

    it('crée une équipe avec Hommes (G1, G2, Jumu\'a) et Femmes (sans Jumu\'a)', async () => {
        const res = await admin('POST', '/api/admin/teams', { name: 'WeShore Marrakech' });
        expect(res.statusCode).toBe(201);
        teamId = res.json().id;
        const team = (await admin('GET', `/api/admin/teams/${teamId}`)).json();
        expect(team.categories.map((c: { name: string }) => c.name)).toEqual(['Hommes', 'Femmes']);
        const h = team.categories[0];
        expect(h.jumuaEnabled).toBe(true);
        expect(team.categories[1].jumuaEnabled).toBe(false);
        expect(h.groups.map((g: { name: string }) => g.name)).toEqual(['G1', 'G2']);
        hommes = { id: h.id, code: h.codes[0].code, g1: h.groups[0].id, g2: h.groups[1].id };
        femmesCode = team.categories[1].codes[0].code;
    });

    it('un membre rejoint avec le code ; un nom déjà pris est refusé', async () => {
        const join = await app.inject({ method: 'POST', url: '/api/app/join', payload: { code: hommes.code.toLowerCase(), name: 'Azedine' } });
        expect(join.statusCode).toBe(201);
        azedine = join.json().token;
        expect(join.json().category.name).toBe('Hommes');

        const dup = await app.inject({ method: 'POST', url: '/api/app/join', payload: { code: femmesCode, name: 'Azedine' } });
        expect(dup.statusCode).toBe(409);

        const bad = await app.inject({ method: 'POST', url: '/api/app/join', payload: { code: 'AAA-AAA', name: 'Karim' } });
        expect(bad.statusCode).toBe(400);
    });

    it('le super admin publie Dhuhr ; le membre choisit G2 et l\'effectif suit', async () => {
        const pub = await admin('POST', `/api/admin/categories/${hommes.id}/publish`, {
            date: monday, prayer: 'DHUHR', slots: [{ groupId: hommes.g1, time: '12:26' }, { groupId: hommes.g2, time: '12:36' }]
        });
        expect(pub.statusCode).toBe(200);

        const before = (await member(azedine, 'GET', `/api/app/day?date=${monday}`)).json();
        const dhuhr = before.prayers.find((p: { prayer: string }) => p.prayer === 'DHUHR');
        expect(dhuhr.published).toBe(true);
        expect(dhuhr.slots.map((s: { timeMins: number }) => s.timeMins)).toEqual([746, 756]);
        expect(dhuhr.myGroupId).toBeNull();

        const choice = await member(azedine, 'PUT', '/api/app/choice', { date: monday, prayer: 'DHUHR', groupId: hommes.g2 });
        expect(choice.statusCode).toBe(200);
        const after = choice.json().prayers.find((p: { prayer: string }) => p.prayer === 'DHUHR');
        expect(after.myGroupId).toBe(hommes.g2);
        expect(after.slots.find((s: { groupId: number }) => s.groupId === hommes.g2).count).toBe(1);
    });

    it('le groupe habituel s\'applique dès la publication', async () => {
        expect((await member(azedine, 'PUT', '/api/app/usual', { prayer: 'ASR', groupId: hommes.g1 })).statusCode).toBe(200);
        await admin('POST', `/api/admin/categories/${hommes.id}/publish`, {
            date: monday, prayer: 'ASR', slots: [{ groupId: hommes.g1, time: '15:40' }]
        });
        const day = (await member(azedine, 'GET', `/api/app/day?date=${monday}`)).json();
        const asr = day.prayers.find((p: { prayer: string }) => p.prayer === 'ASR');
        expect(asr.myGroupId).toBe(hommes.g1);
        expect(asr.myChoiceIsExplicit).toBe(false);
    });

    it('un membre sans rôle ne publie pas ; un responsable horaires publie depuis l\'app', async () => {
        const denied = await member(azedine, 'POST', '/api/app/publish', { date: monday, prayer: 'ASR', slots: [{ groupId: hommes.g1, time: '15:45' }] });
        expect(denied.statusCode).toBe(403);

        const team = (await admin('GET', `/api/admin/teams/${teamId}`)).json();
        const memberId = team.members.find((m: { name: string }) => m.name === 'Azedine').id;
        const roles = await admin('PUT', `/api/admin/members/${memberId}/roles`, { roles: [{ role: 'SCHEDULER', categoryId: hommes.id }] });
        expect(roles.statusCode).toBe(200);

        const ok = await member(azedine, 'POST', '/api/app/publish', { date: monday, prayer: 'ASR', slots: [{ groupId: hommes.g1, time: '15:45' }] });
        expect(ok.statusCode).toBe(200);
        expect((await member(azedine, 'GET', '/api/app/me')).json().canPublish).toBe(true);
    });

    it('retirer G2 des horaires efface les choix de G2', async () => {
        await admin('POST', `/api/admin/categories/${hommes.id}/publish`, {
            date: monday, prayer: 'DHUHR', slots: [{ groupId: hommes.g1, time: '12:30' }]
        });
        const day = (await member(azedine, 'GET', `/api/app/day?date=${monday}`)).json();
        expect(day.prayers.find((p: { prayer: string }) => p.prayer === 'DHUHR').myGroupId).toBeNull();
    });

    it('vendredi : Jumu\'a remplace Dhuhr chez les Hommes', async () => {
        const dhuhr = await admin('POST', `/api/admin/categories/${hommes.id}/publish`, {
            date: friday, prayer: 'DHUHR', slots: [{ groupId: hommes.g1, time: '12:30' }]
        });
        expect(dhuhr.statusCode).toBe(400);
        const jumua = await admin('POST', `/api/admin/categories/${hommes.id}/publish`, {
            date: friday, prayer: 'JUMUA', slots: [{ groupId: null, time: '13:00' }]
        });
        expect(jumua.statusCode).toBe(200);
        expect(jumua.json().prayers.map((p: { prayer: string }) => p.prayer)).toEqual(['JUMUA', 'ASR']);
    });

    it('la limite de groupes est respectée', async () => {
        await admin('PATCH', `/api/admin/categories/${hommes.id}`, { maxGroups: 3 });
        expect((await admin('POST', `/api/admin/categories/${hommes.id}/groups`, {})).json().name).toBe('G3');
        expect((await admin('POST', `/api/admin/categories/${hommes.id}/groups`, {})).statusCode).toBe(409);
    });

    it('un membre bloqué n\'a plus accès ; le journal trace les actions', async () => {
        const team = (await admin('GET', `/api/admin/teams/${teamId}`)).json();
        const memberId = team.members.find((m: { name: string }) => m.name === 'Azedine').id;
        await admin('PATCH', `/api/admin/members/${memberId}`, { status: 'BLOCKED' });
        expect((await member(azedine, 'GET', '/api/app/day')).statusCode).toBe(403);

        const log = (await admin('GET', '/api/admin/audit')).json();
        const actions = log.map((l: { action: string }) => l.action);
        expect(actions).toEqual(expect.arrayContaining(['team.create', 'member.join', 'schedule.publish', 'member.roles', 'member.block']));
    });
});
