// Téléchargement de l'application Windows : envoi par morceaux depuis /admin, lien direct public.

import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db.js';
import { hashPassword, hashToken, newToken } from '../src/lib/security.js';

const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('application Windows : téléchargement', () => {
    let app: FastifyInstance;
    let db: Db;
    let dir = '';
    let superCookie = '';
    let adminCookie = '';

    // Faux installateur : en-tête « MZ » puis 30 Ko
    const installer = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(30 * 1024, 7)]);

    const session = async (email: string, isSuperAdmin: boolean) => {
        const admin = await db.adminAccount.create({
            data: { email, passwordHash: await hashPassword('motdepasse-solide'), isSuperAdmin, totpEnabled: isSuperAdmin }
        });
        const token = newToken();
        await db.adminSession.create({ data: { tokenHash: hashToken(token), adminId: admin.id, verified: true, expiresAt: new Date(Date.now() + 3600_000) } });
        return `pause_admin=${token}`;
    };

    const put = (cookie: string, name: string, offset: number, total: number, body: Buffer) => app.inject({
        method: 'PUT',
        url: `/api/admin/desktop-installer?name=${name}&offset=${offset}&total=${total}`,
        headers: { cookie, 'content-type': 'application/octet-stream' },
        payload: body
    });

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'pause-downloads-'));
        const config = loadConfig({ ...process.env, DATABASE_URL: TEST_DB!, NODE_ENV: 'test', DOWNLOADS_DIR: dir });
        db = createDb(config.DATABASE_URL);
        await db.adminAccount.deleteMany({ where: { email: { in: ['dl-super@test.local', 'dl-admin@test.local'] } } });
        superCookie = await session('dl-super@test.local', true);
        // Admin sans rôle : refusé de toute façon (403), comme un admin d'équipe pour cette route
        adminCookie = await session('dl-admin@test.local', false);
        app = await buildApp(db, config);
    });

    afterAll(async () => {
        await app?.close();
        await db?.adminAccount.deleteMany({ where: { email: { in: ['dl-super@test.local', 'dl-admin@test.local'] } } });
        await db?.$disconnect();
        rmSync(dir, { recursive: true, force: true });
    });

    it('rien à télécharger au départ : page claire, pas de fichier', async () => {
        expect((await app.inject({ method: 'GET', url: '/api/download/windows' })).json()).toMatchObject({ available: false });
        const res = await app.inject({ method: 'GET', url: '/telecharger/windows' });
        expect(res.statusCode).toBe(404);
        expect(res.body).toContain('pas encore disponible');
    });

    it('envoi en deux morceaux, puis lien direct public', async () => {
        const half = 16 * 1024;
        const first = await put(superCookie, 'Pause-Setup-1.0.2.exe', 0, installer.length, installer.subarray(0, half));
        expect(first.json()).toMatchObject({ done: false, received: half });
        const last = await put(superCookie, 'Pause-Setup-1.0.2.exe', half, installer.length, installer.subarray(half));
        expect(last.json()).toMatchObject({ done: true, latest: { version: '1.0.2', sizeBytes: installer.length } });

        expect((await app.inject({ method: 'GET', url: '/api/download/windows' })).json())
            .toMatchObject({ available: true, version: '1.0.2', sizeBytes: installer.length, url: '/telecharger/windows' });
        const dl = await app.inject({ method: 'GET', url: '/telecharger/windows' });
        expect(dl.statusCode).toBe(200);
        expect(dl.headers['content-disposition']).toContain('Pause-Setup-1.0.2.exe');
        expect(dl.rawPayload.equals(installer)).toBe(true);
    });

    it('envoi interrompu : un morceau hors séquence est refusé', async () => {
        await put(superCookie, 'Pause-Setup-1.0.3.exe', 0, installer.length, installer.subarray(0, 1000));
        expect((await put(superCookie, 'Pause-Setup-1.0.3.exe', 5000, installer.length, installer.subarray(5000))).statusCode).toBe(409);
    });

    it('refuse un fichier qui n\'est pas un exécutable, un mauvais nom, et un non super admin', async () => {
        const fake = Buffer.from('pas un exe');
        expect((await put(superCookie, 'Pause-Setup-2.0.0.exe', 0, fake.length, fake)).statusCode).toBe(400);
        expect((await put(superCookie, 'virus.exe', 0, fake.length, fake)).statusCode).toBe(400);
        expect((await put(adminCookie, 'Pause-Setup-2.0.0.exe', 0, installer.length, installer)).statusCode).toBe(403);
        // La version publiée reste 1.0.2
        expect((await app.inject({ method: 'GET', url: '/api/download/windows' })).json()).toMatchObject({ version: '1.0.2' });
    });
});

describe.skipIf(!TEST_DB)('application Windows : dernière release GitHub', () => {
    let app: FastifyInstance;
    let db: Db;
    let dir = '';
    const realFetch = globalThis.fetch;

    beforeAll(async () => {
        const { clearGithubCache } = await import('../src/routes/download-api.js');
        clearGithubCache();
        dir = mkdtempSync(join(tmpdir(), 'pause-downloads-gh-'));
        // Simule l'API GitHub : release v1.0.5 avec son installateur
        globalThis.fetch = (async (url: string | URL) => {
            if (String(url).includes('api.github.com/repos/demo/pause/releases/latest')) {
                return new Response(JSON.stringify({
                    published_at: '2026-11-20T10:00:00Z',
                    assets: [
                        { name: 'latest.yml', size: 300, browser_download_url: 'https://github.com/demo/pause/releases/download/v1.0.5/latest.yml' },
                        { name: 'Pause-Setup-1.0.5.exe', size: 123000000, browser_download_url: 'https://github.com/demo/pause/releases/download/v1.0.5/Pause-Setup-1.0.5.exe' }
                    ]
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return realFetch(url);
        }) as typeof fetch;
        const config = loadConfig({ ...process.env, DATABASE_URL: TEST_DB!, NODE_ENV: 'test', DOWNLOADS_DIR: dir, DESKTOP_GITHUB_REPO: 'demo/pause' });
        db = createDb(config.DATABASE_URL);
        app = await buildApp(db, config);
    });

    afterAll(async () => {
        globalThis.fetch = realFetch;
        await app?.close();
        await db?.$disconnect();
        rmSync(dir, { recursive: true, force: true });
    });

    it('propose la dernière release sans envoi manuel, et le lien direct y redirige', async () => {
        expect((await app.inject({ method: 'GET', url: '/api/download/windows' })).json())
            .toMatchObject({ available: true, version: '1.0.5', sizeBytes: 123000000, source: 'github' });
        const dl = await app.inject({ method: 'GET', url: '/telecharger/windows' });
        expect(dl.statusCode).toBe(302);
        expect(dl.headers.location).toBe('https://github.com/demo/pause/releases/download/v1.0.5/Pause-Setup-1.0.5.exe');
    });
});

describe.skipIf(!TEST_DB)('application Windows : release GitLab et mises à jour', () => {
    let app: FastifyInstance;
    let db: Db;
    let dir = '';
    const realFetch = globalThis.fetch;
    const pkg = 'https://gitlab.com/api/v4/projects/1/packages/generic/pause/1.0.7';
    const yml = 'version: 1.0.7\nfiles:\n  - url: Pause-Setup-1.0.7.exe\n    sha512: abc\n    size: 124000000\npath: Pause-Setup-1.0.7.exe\n';

    beforeAll(async () => {
        const { clearReleaseCache } = await import('../src/routes/download-api.js');
        clearReleaseCache();
        dir = mkdtempSync(join(tmpdir(), 'pause-downloads-gl-'));
        globalThis.fetch = (async (url: string | URL) => {
            const u = String(url);
            if (u.includes('/projects/demo%2Fpause/releases/permalink/latest')) {
                return new Response(JSON.stringify({
                    released_at: '2026-11-26T09:00:00Z',
                    assets: { links: [
                        { name: 'Pause-Setup-1.0.7.exe', url: `${pkg}/Pause-Setup-1.0.7.exe` },
                        { name: 'Pause-Setup-1.0.7.exe.blockmap', url: `${pkg}/Pause-Setup-1.0.7.exe.blockmap` },
                        { name: 'latest.yml', url: `${pkg}/latest.yml` }
                    ] }
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (u === `${pkg}/latest.yml`) return new Response(yml, { status: 200 });
            return realFetch(url);
        }) as typeof fetch;
        const config = loadConfig({ ...process.env, DATABASE_URL: TEST_DB!, NODE_ENV: 'test', DOWNLOADS_DIR: dir, DESKTOP_GITLAB_PROJECT: 'demo/pause' });
        db = createDb(config.DATABASE_URL);
        app = await buildApp(db, config);
    });

    afterAll(async () => {
        globalThis.fetch = realFetch;
        await app?.close();
        await db?.$disconnect();
        rmSync(dir, { recursive: true, force: true });
    });

    it('propose la release GitLab : site, lien direct et mises à jour de l\'application', async () => {
        expect((await app.inject({ method: 'GET', url: '/api/download/windows' })).json())
            .toMatchObject({ available: true, version: '1.0.7', sizeBytes: 124000000, source: 'gitlab' });
        const dl = await app.inject({ method: 'GET', url: '/telecharger/windows' });
        expect(dl.statusCode).toBe(302);
        expect(dl.headers.location).toBe(`${pkg}/Pause-Setup-1.0.7.exe`);

        const latest = await app.inject({ method: 'GET', url: '/mises-a-jour/latest.yml' });
        expect(latest.statusCode).toBe(200);
        expect(latest.body).toBe(yml);
        const blockmap = await app.inject({ method: 'GET', url: '/mises-a-jour/Pause-Setup-1.0.7.exe.blockmap' });
        expect(blockmap.headers.location).toBe(`${pkg}/Pause-Setup-1.0.7.exe.blockmap`);
        expect((await app.inject({ method: 'GET', url: '/mises-a-jour/autre.exe' })).statusCode).toBe(404);
    });

    it('un installateur envoyé depuis /admin, plus récent, devient la source avec son latest.yml calculé', async () => {
        const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096, 1)]);
        writeFileSync(join(dir, 'Pause-Setup-1.0.8.exe'), exe);
        const latest = await app.inject({ method: 'GET', url: '/mises-a-jour/latest.yml' });
        const sha = createHash('sha512').update(exe).digest('base64');
        expect(latest.body).toContain('version: 1.0.8');
        expect(latest.body).toContain(`sha512: ${sha}`);
        expect(latest.body).toContain(`size: ${exe.length}`);
        const file = await app.inject({ method: 'GET', url: '/mises-a-jour/Pause-Setup-1.0.8.exe' });
        expect(file.rawPayload.equals(exe)).toBe(true);
    });
});
