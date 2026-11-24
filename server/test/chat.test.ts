// Discussion, modération et temps réel contre une vraie base MySQL (TEST_DATABASE_URL), vidée au début.
// Sans TEST_DATABASE_URL, ces tests sont ignorés.

import type { FastifyInstance } from 'fastify';
import { generate, generateSecret } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WsClient from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db.js';
import { hashPassword } from '../src/lib/security.js';
import { findMentions } from '../src/services/chat.js';

const TEST_DB = process.env.TEST_DATABASE_URL;

/** Prochain lundi strictement après aujourd'hui */
function nextMonday(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

type Frame = { type: string } & Record<string, any>;

/** Client WebSocket de test : garde les messages reçus et attend ceux qu'on veut */
function collect(ws: { addEventListener?: unknown; on?: unknown }) {
    const frames: Frame[] = [];
    const waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
    const push = (data: unknown) => {
        const f = JSON.parse(String(data)) as Frame;
        frames.push(f);
        for (const w of [...waiters]) if (w.pred(f)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(f);
        }
    };
    if (ws instanceof WsClient) ws.on('message', (d) => push(d));
    else (ws as WebSocket).addEventListener('message', (e) => push(e.data));
    return {
        frames,
        next(pred: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
            const found = frames.find(pred);
            if (found) return Promise.resolve(found);
            return new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('Message WebSocket attendu non reçu')), timeoutMs);
                waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } });
            });
        }
    };
}

describe.skipIf(!TEST_DB)('Discussion (intégration)', () => {
    let app: FastifyInstance;
    let db: Db;
    let cookie = '';
    let baseWs = '';
    const monday = nextMonday();

    const admin = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
        const res = await app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
        const setCookie = res.headers['set-cookie'];
        if (setCookie) cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
        return res;
    };
    const member = (token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
        app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });

    let teamId = 0;
    let hommes = { id: 0, g1: 0, g2: 0 };
    let femmesId = 0;
    const tokens: Record<string, string> = {};
    const ids: Record<string, number> = {};
    let hommesKey = '';

    beforeAll(async () => {
        const config = loadConfig({ ...process.env, DATABASE_URL: TEST_DB!, NODE_ENV: 'test' });
        db = createDb(config.DATABASE_URL);
        await db.auditLog.deleteMany();
        await db.adminSession.deleteMany();
        await db.adminAccount.deleteMany();
        await db.team.deleteMany();
        const secret = generateSecret();
        await db.adminAccount.create({
            data: {
                email: 'super@test.local', passwordHash: await hashPassword('motdepasse-solide'),
                isSuperAdmin: true, totpEnabled: true, totpSecret: secret
            }
        });
        app = await buildApp(db, config);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const addr = app.server.address();
        baseWs = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

        await admin('POST', '/api/admin/auth/login', { email: 'super@test.local', password: 'motdepasse-solide' });
        expect((await admin('POST', '/api/admin/auth/totp', { code: await generate({ secret }) })).statusCode).toBe(200);

        teamId = (await admin('POST', '/api/admin/teams', { name: 'Équipe discussion' })).json().id;
        const team = (await admin('GET', `/api/admin/teams/${teamId}`)).json();
        const h = team.categories[0];
        hommes = { id: h.id, g1: h.groups[0].id, g2: h.groups[1].id };
        femmesId = team.categories[1].id;
        hommesKey = `cat:${hommes.id}`;
        const join = async (name: string, code: string) => {
            const res = await app.inject({ method: 'POST', url: '/api/app/join', payload: { code, name } });
            expect(res.statusCode).toBe(201);
            tokens[name] = res.json().token;
        };
        for (const name of ['Azedine', 'Karim', 'Karim B.', 'Saïd', 'Bavard']) await join(name, h.codes[0].code);
        await join('Fatima', team.categories[1].codes[0].code);
        const members = (await admin('GET', `/api/admin/teams/${teamId}`)).json().members as { id: number; name: string }[];
        for (const m of members) ids[m.name] = m.id;
    });

    afterAll(async () => {
        await app?.close();
        await db?.$disconnect();
    });

    it('mentions : sans casse ni accents, le plus long nom gagne', () => {
        const names = [{ id: 1, name: 'Karim' }, { id: 2, name: 'Karim B.' }, { id: 3, name: 'Saïd' }, { id: 4, name: 'Sa' }];
        expect(findMentions('Salam @karim b. et @SAID !', names).sort()).toEqual([2, 3]);
        expect(findMentions('@Karim, tu viens ?', names)).toEqual([1]);
        expect(findMentions('mail : said@karim.ma', names)).toEqual([]);
        expect(findMentions('@Saïdou', names)).toEqual([]);
    });

    it('un membre ne voit que la discussion de sa catégorie', async () => {
        const res = (await member(tokens.Azedine, 'GET', '/api/app/channels')).json();
        expect(res.channels).toEqual([
            { key: hommesKey, name: 'Hommes', unread: 0, canPost: true, canAnnounce: false, canModerate: false, mutedUntil: null }
        ]);
        expect((await member(tokens.Fatima, 'GET', `/api/app/messages?channel=${hommesKey}`)).statusCode).toBe(404);
        expect((await member(tokens.Fatima, 'POST', '/api/app/messages', { channel: hommesKey, body: 'Salam' })).statusCode).toBe(404);
        expect((await member(tokens.Azedine, 'GET', `/api/app/messages?channel=admins:${teamId}`)).statusCode).toBe(404);
        expect((await member(tokens.Azedine, 'GET', '/api/app/messages?channel=n_importe_quoi')).statusCode).toBe(400);
    });

    let firstId = 0;

    it('envoi, mentions, non lus et lecture', async () => {
        const post = await member(tokens.Azedine, 'POST', '/api/app/messages', { channel: hommesKey, body: '  Salam @karim b. et @SAID  ' });
        expect(post.statusCode).toBe(201);
        const msg = post.json();
        firstId = msg.id;
        expect(msg).toMatchObject({
            channel: hommesKey, kind: 'TEXT', body: 'Salam @karim b. et @SAID', deleted: false, replyTo: null, schedule: null,
            author: { type: 'member', id: ids.Azedine, name: 'Azedine' }
        });
        expect(msg.mentions.map((m: { name: string }) => m.name).sort()).toEqual(['Karim B.', 'Saïd']);

        const karim = (await member(tokens.Karim, 'GET', '/api/app/channels')).json().channels[0];
        expect(karim.unread).toBe(1);
        expect((await member(tokens.Azedine, 'GET', '/api/app/channels')).json().channels[0].unread).toBe(0);

        expect((await member(tokens.Karim, 'POST', '/api/app/read', { channel: hommesKey, lastMessageId: firstId })).statusCode).toBe(200);
        expect((await member(tokens.Karim, 'GET', '/api/app/channels')).json().channels[0].unread).toBe(0);

        // Vide, trop long, annonce sans rôle
        expect((await member(tokens.Azedine, 'POST', '/api/app/messages', { channel: hommesKey, body: '   ' })).statusCode).toBe(400);
        expect((await member(tokens.Azedine, 'POST', '/api/app/messages', { channel: hommesKey, body: 'x'.repeat(2001) })).statusCode).toBe(400);
        expect((await member(tokens.Azedine, 'POST', '/api/app/messages', { channel: hommesKey, body: 'Annonce', kind: 'ANNOUNCEMENT' })).statusCode).toBe(403);
    });

    it('réponse avec extrait, pagination', async () => {
        const reply = await member(tokens.Karim, 'POST', '/api/app/messages', { channel: hommesKey, body: 'Wa alaykoum salam', replyToId: firstId });
        expect(reply.statusCode).toBe(201);
        expect(reply.json().replyTo).toEqual({ id: firstId, authorName: 'Azedine', excerpt: 'Salam @karim b. et @SAID' });

        const page = (await member(tokens.Azedine, 'GET', `/api/app/messages?channel=${hommesKey}&limit=1`)).json();
        expect(page.hasMore).toBe(true);
        expect(page.messages).toHaveLength(1);
        const older = (await member(tokens.Azedine, 'GET', `/api/app/messages?channel=${hommesKey}&before=${page.messages[0].id}`)).json();
        expect(older.messages.map((m: { id: number }) => m.id)).toEqual([firstId]);
        expect(older.hasMore).toBe(false);
    });

    it('réactions : liste autorisée et bascule', async () => {
        const url = `/api/app/messages/${firstId}/reactions`;
        const on = await member(tokens.Karim, 'PUT', url, { emoji: '👍' });
        expect(on.statusCode).toBe(200);
        expect(on.json().reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
        await member(tokens.Azedine, 'PUT', url, { emoji: '😂' });
        const seen = (await member(tokens.Azedine, 'GET', `/api/app/messages?channel=${hommesKey}`)).json();
        expect(seen.messages.find((m: { id: number }) => m.id === firstId).reactions).toEqual([
            { emoji: '👍', count: 1, mine: false },
            { emoji: '😂', count: 1, mine: true }
        ]);
        const off = await member(tokens.Karim, 'PUT', url, { emoji: '👍' });
        expect(off.json().reactions).toEqual([{ emoji: '😂', count: 1, mine: false }]);
        expect((await member(tokens.Karim, 'PUT', url, { emoji: '🍕' })).statusCode).toBe(400);
    });

    it('suppression : ses messages, ou ceux des autres pour un modérateur (tracé)', async () => {
        const other = (await member(tokens.Karim, 'POST', '/api/app/messages', { channel: hommesKey, body: 'Message de Karim' })).json();
        expect((await member(tokens.Azedine, 'DELETE', `/api/app/messages/${other.id}`)).statusCode).toBe(403);

        const own = (await member(tokens.Azedine, 'POST', '/api/app/messages', { channel: hommesKey, body: 'À effacer' })).json();
        expect((await member(tokens.Azedine, 'DELETE', `/api/app/messages/${own.id}`)).statusCode).toBe(200);

        expect((await admin('DELETE', `/api/admin/messages/${other.id}`)).statusCode).toBe(200);
        const list = (await admin('GET', `/api/admin/messages?channel=${hommesKey}`)).json();
        for (const id of [own.id, other.id]) {
            expect(list.messages.find((m: { id: number }) => m.id === id)).toMatchObject({ deleted: true, body: '', reactions: [], mentions: [] });
        }
        const log = (await admin('GET', `/api/admin/audit?teamId=${teamId}`)).json();
        const deletes = log.filter((l: { action: string }) => l.action === 'message.delete');
        expect(deletes).toHaveLength(1); // la suppression de son propre message n'est pas de la modération
    });

    it('réduire au silence bloque l\'envoi jusqu\'à la levée', async () => {
        const mute = await admin('POST', `/api/admin/members/${ids.Karim}/mute`, { minutes: 30 });
        expect(mute.statusCode).toBe(200);
        expect(mute.json().mutedUntil).toBeTruthy();

        const denied = await member(tokens.Karim, 'POST', '/api/app/messages', { channel: hommesKey, body: 'Encore moi' });
        expect(denied.statusCode).toBe(403);
        expect(denied.json().message).toMatch(/silence/);
        const ch = (await member(tokens.Karim, 'GET', '/api/app/channels')).json().channels[0];
        expect(ch.canPost).toBe(false);
        expect(ch.mutedUntil).toBe(mute.json().mutedUntil);
        const team = (await admin('GET', `/api/admin/teams/${teamId}`)).json();
        expect(team.members.find((m: { name: string }) => m.name === 'Karim').mutedUntil).toBeTruthy();

        expect((await admin('POST', `/api/admin/members/${ids.Karim}/mute`, { minutes: null })).json()).toEqual({ mutedUntil: null });
        expect((await member(tokens.Karim, 'POST', '/api/app/messages', { channel: hommesKey, body: 'Me revoilà' })).statusCode).toBe(201);

        const actions = (await admin('GET', `/api/admin/audit?teamId=${teamId}`)).json().map((l: { action: string }) => l.action);
        expect(actions).toEqual(expect.arrayContaining(['member.mute', 'member.unmute']));
    });

    it('limite : 20 messages par minute', async () => {
        for (let i = 0; i < 20; i++) {
            expect((await member(tokens.Bavard, 'POST', '/api/app/messages', { channel: hommesKey, body: `Message ${i}` })).statusCode).toBe(201);
        }
        expect((await member(tokens.Bavard, 'POST', '/api/app/messages', { channel: hommesKey, body: 'Un de trop' })).statusCode).toBe(429);
    });

    it('chaque publication crée une carte d\'horaires dans la discussion', async () => {
        await admin('POST', `/api/admin/categories/${hommes.id}/publish`, {
            date: monday, prayer: 'DHUHR', slots: [{ groupId: hommes.g1, time: '12:26' }, { groupId: hommes.g2, time: '12:36' }]
        });
        let last = (await member(tokens.Azedine, 'GET', `/api/app/messages?channel=${hommesKey}&limit=1`)).json().messages[0];
        expect(last).toMatchObject({
            kind: 'SCHEDULE', author: { type: 'system', id: null, name: 'Horaires' },
            schedule: {
                date: monday, prayer: 'DHUHR', change: 'published', movedGroupIds: [], removedGroupIds: [],
                slots: [{ groupId: hommes.g1, groupName: 'G1', timeMins: 746 }, { groupId: hommes.g2, groupName: 'G2', timeMins: 756 }]
            }
        });
        expect(last.body).toContain('G1 12:26');

        await admin('POST', `/api/admin/categories/${hommes.id}/publish`, {
            date: monday, prayer: 'DHUHR', slots: [{ groupId: hommes.g1, time: '12:26' }, { groupId: hommes.g2, time: '12:40' }]
        });
        last = (await member(tokens.Azedine, 'GET', `/api/app/messages?channel=${hommesKey}&limit=1`)).json().messages[0];
        expect(last.schedule).toMatchObject({ change: 'updated', movedGroupIds: [hommes.g2] });
        expect(last.body).toContain('G2 déplacé à 12:40');

        // Publication depuis l'application (responsable horaires)
        await admin('PUT', `/api/admin/members/${ids.Azedine}/roles`, { roles: [{ role: 'SCHEDULER', categoryId: hommes.id }] });
        expect((await member(tokens.Azedine, 'POST', '/api/app/publish', {
            date: monday, prayer: 'ASR', slots: [{ groupId: hommes.g1, time: '15:40' }]
        })).statusCode).toBe(200);
        last = (await member(tokens.Karim, 'GET', `/api/app/messages?channel=${hommesKey}&limit=1`)).json().messages[0];
        expect(last.schedule).toMatchObject({ prayer: 'ASR', change: 'published' });

        // Aucune carte chez les Femmes
        const femmes = (await member(tokens.Fatima, 'GET', `/api/app/messages?channel=cat:${femmesId}`)).json();
        expect(femmes.messages).toHaveLength(0);
    });

    it('un rôle donne accès à la discussion des admins ; le tableau de bord voit tous les canaux', async () => {
        const channels = (await member(tokens.Azedine, 'GET', '/api/app/channels')).json().channels;
        expect(channels.map((c: { key: string }) => c.key)).toEqual([hommesKey, `admins:${teamId}`]);
        expect(channels[0]).toMatchObject({ canAnnounce: true, canModerate: false });
        expect(channels[1].name).toBe('Admins de l\'équipe');

        const ann = await member(tokens.Azedine, 'POST', '/api/app/messages', { channel: hommesKey, body: 'Réunion à 14h', kind: 'ANNOUNCEMENT' });
        expect(ann.statusCode).toBe(201);

        const adminPost = await admin('POST', '/api/admin/messages', { channel: `admins:${teamId}`, body: 'Bonjour les admins' });
        expect(adminPost.statusCode).toBe(201);
        expect(adminPost.json().author).toEqual({ type: 'admin', id: expect.any(Number), name: 'Super admin' });

        const dash = (await admin('GET', `/api/admin/teams/${teamId}/channels`)).json().channels;
        expect(dash.map((c: { name: string }) => c.name)).toEqual(['Hommes', 'Femmes', 'Admins de l\'équipe']);
        expect(dash[0].messages7d).toBeGreaterThan(5);
        expect(dash[1]).toEqual({ key: `cat:${femmesId}`, name: 'Femmes', messages7d: 0, lastMessageAt: null });
    });

    it('temps réel : authentification, message, mention, horaires, statut', async () => {
        // Clé refusée : fermeture 4401
        const bad = new WebSocket(`${baseWs}/api/app/ws`);
        await new Promise((r) => bad.addEventListener('open', r));
        bad.send(JSON.stringify({ type: 'auth', token: 'cle-inconnue' }));
        const closed = await new Promise<CloseEvent>((r) => bad.addEventListener('close', r));
        expect(closed.code).toBe(4401);

        const ws = new WebSocket(`${baseWs}/api/app/ws`);
        const inbox = collect(ws);
        await new Promise((r) => ws.addEventListener('open', r));
        ws.send(JSON.stringify({ type: 'auth', token: tokens.Saïd }));
        await inbox.next((f) => f.type === 'ready');

        const fws = new WebSocket(`${baseWs}/api/app/ws`);
        const finbox = collect(fws);
        await new Promise((r) => fws.addEventListener('open', r));
        fws.send(JSON.stringify({ type: 'auth', token: tokens.Fatima }));
        await finbox.next((f) => f.type === 'ready');

        // Tableau de bord : cookie de session
        const aws = new WsClient(`${baseWs}/api/admin/ws`, { headers: { cookie } });
        const ainbox = collect(aws);
        await ainbox.next((f) => f.type === 'ready');

        const sent = (await member(tokens.Karim, 'POST', '/api/app/messages', { channel: hommesKey, body: 'Tu viens @Saïd ?' })).json();
        const created = await inbox.next((f) => f.type === 'message.created' && f.message.id === sent.id);
        expect(created.message.body).toBe('Tu viens @Saïd ?');
        const mention = await inbox.next((f) => f.type === 'mention');
        expect(mention.message.id).toBe(sent.id);
        const adminCopy = await ainbox.next((f) => f.type === 'message.created' && f.message.id === sent.id);
        expect(adminCopy.message.channel).toBe(hommesKey);

        // Réaction : message.updated avec « mine » propre à chaque destinataire
        await member(tokens.Saïd, 'PUT', `/api/app/messages/${sent.id}/reactions`, { emoji: '❤️' });
        const updated = await inbox.next((f) => f.type === 'message.updated' && f.message.id === sent.id);
        expect(updated.message.reactions).toEqual([{ emoji: '❤️', count: 1, mine: true }]);
        const adminUpdated = await ainbox.next((f) => f.type === 'message.updated' && f.message.id === sent.id);
        expect(adminUpdated.message.reactions).toEqual([{ emoji: '❤️', count: 1, mine: false }]);

        await admin('POST', `/api/admin/categories/${hommes.id}/publish`, {
            date: monday, prayer: 'ASR', slots: [{ groupId: hommes.g1, time: '15:50' }]
        });
        const sched = await inbox.next((f) => f.type === 'schedule.changed');
        expect(sched).toMatchObject({ categoryId: hommes.id, date: monday, prayer: 'ASR', change: 'updated', movedGroupIds: [hommes.g1] });
        await inbox.next((f) => f.type === 'message.created' && f.message.kind === 'SCHEDULE');

        // Fatima (Femmes) ne reçoit rien des Hommes : son premier événement est son propre message
        const own = (await member(tokens.Fatima, 'POST', '/api/app/messages', { channel: `cat:${femmesId}`, body: 'Salam les sœurs' })).json();
        await finbox.next((f) => f.type === 'message.created' && f.message.id === own.id);
        expect(finbox.frames.filter((f) => f.type !== 'ready').map((f) => f.message?.channel)).toEqual([`cat:${femmesId}`]);
        expect(inbox.frames.some((f) => f.message?.id === own.id)).toBe(false);

        // Accès suspendu : member.status
        await admin('PATCH', `/api/admin/members/${ids.Saïd}`, { status: 'BLOCKED' });
        const status = await inbox.next((f) => f.type === 'member.status');
        expect(status).toEqual({ type: 'member.status', status: 'BLOCKED', mutedUntil: null });

        ws.close();
        fws.close();
        aws.close();
    });

    it('tableau de bord sans session : fermeture 4401', async () => {
        const aws = new WsClient(`${baseWs}/api/admin/ws`);
        const code = await new Promise<number>((r) => aws.on('close', (c) => r(c)));
        expect(code).toBe(4401);
    });

    it('tableau de bord depuis une autre origine : fermeture 4401', async () => {
        const aws = new WsClient(`${baseWs}/api/admin/ws`, { headers: { cookie, origin: 'https://autre.example.com' } });
        const code = await new Promise<number>((r) => aws.on('close', (c) => r(c)));
        expect(code).toBe(4401);
    });

    it('republier les mêmes horaires ne crée pas de carte ; un groupe ajouté est annoncé', async () => {
        const slots = [{ groupId: hommes.g1, time: '12:26' }, { groupId: hommes.g2, time: '12:40' }];
        const lastId = async () => (await member(tokens.Azedine, 'GET', `/api/app/messages?channel=${hommesKey}&limit=1`)).json().messages[0].id;
        const before = await lastId();
        expect((await admin('POST', `/api/admin/categories/${hommes.id}/publish`, { date: monday, prayer: 'DHUHR', slots })).statusCode).toBe(200);
        expect(await lastId()).toBe(before);

        await admin('POST', `/api/admin/categories/${hommes.id}/publish`, {
            date: monday, prayer: 'ASR', slots: [{ groupId: hommes.g1, time: '15:50' }, { groupId: hommes.g2, time: '16:00' }]
        });
        const last = (await member(tokens.Azedine, 'GET', `/api/app/messages?channel=${hommesKey}&limit=1`)).json().messages[0];
        expect(last.schedule).toMatchObject({ change: 'updated', movedGroupIds: [], removedGroupIds: [], addedGroupIds: [hommes.g2] });
        expect(last.body).toContain('G2 ajouté à 16:00');
    });

    it('un nouveau membre n\'a pas l\'historique en non lu', async () => {
        const team = (await admin('GET', `/api/admin/teams/${teamId}`)).json();
        const res = await app.inject({ method: 'POST', url: '/api/app/join', payload: { code: team.categories[0].codes[0].code, name: 'Nouveau' } });
        expect(res.statusCode).toBe(201);
        const channels = (await member(res.json().token, 'GET', '/api/app/channels')).json().channels;
        expect(channels[0]).toMatchObject({ key: hommesKey, unread: 0 });
    });

    it('limite : 60 réactions par minute et par membre', async () => {
        const target = (await member(tokens.Azedine, 'GET', `/api/app/messages?channel=${hommesKey}&limit=1`)).json().messages[0];
        for (let i = 0; i < 60; i++) {
            expect((await member(tokens['Karim B.'], 'PUT', `/api/app/messages/${target.id}/reactions`, { emoji: '👍' })).statusCode).toBe(200);
        }
        expect((await member(tokens['Karim B.'], 'PUT', `/api/app/messages/${target.id}/reactions`, { emoji: '👍' })).statusCode).toBe(429);
    }, 30_000);

    it('transfert : la connexion de l\'ancien ordinateur est fermée', async () => {
        const ws = new WebSocket(`${baseWs}/api/app/ws`);
        const inbox = collect(ws);
        await new Promise((r) => ws.addEventListener('open', r));
        ws.send(JSON.stringify({ type: 'auth', token: tokens.Karim }));
        await inbox.next((f) => f.type === 'ready');
        const closed = new Promise<CloseEvent>((r) => ws.addEventListener('close', r));

        const { code } = (await admin('POST', `/api/admin/members/${ids.Karim}/transfer-code`)).json();
        const res = await app.inject({ method: 'POST', url: '/api/app/transfer', payload: { code } });
        expect(res.statusCode).toBe(200);
        expect((await closed).code).toBe(4401);

        // L'ancienne clé est refusée, la nouvelle fonctionne
        expect((await member(tokens.Karim, 'GET', '/api/app/channels')).statusCode).toBe(401);
        tokens.Karim = res.json().token;
        expect((await member(tokens.Karim, 'GET', '/api/app/channels')).statusCode).toBe(200);
    });
});
