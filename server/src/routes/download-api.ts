// Téléchargement et mises à jour de l'application Windows.
// - GET /telecharger/windows : lien direct public vers le dernier installateur.
// - GET /api/download/windows : version, taille et date (page d'accueil, /admin).
// - GET /mises-a-jour/latest.yml et /mises-a-jour/<fichier> : source des mises à jour automatiques
//   de l'application (electron-updater, fournisseur « generic »).
// - PUT /api/admin/desktop-installer : envoi par morceaux (super admin). Morceaux de 20 Mo au plus :
//   Cloudflare refuse les corps de plus de 100 Mo, l'installateur en fait davantage.
//
// La dernière version est la plus récente parmi : fichier envoyé depuis /admin, release GitLab
// (DESKTOP_GITLAB_PROJECT), release GitHub (DESKTOP_GITHUB_REPO).

import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { audit } from '../lib/audit.js';
import { requireAdminSession } from '../lib/admin-session.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { parse } from './validation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = join(HERE, '..', '..', 'downloads');
/** Pause-Setup-1.0.2.exe → version « 1.0.2 » */
const INSTALLER_RE = /^Pause-Setup-(\d+(?:\.\d+){0,3})\.exe$/;
export const CHUNK_MAX_BYTES = 20 * 1024 * 1024;
const INSTALLER_MAX_BYTES = 400 * 1024 * 1024;
/** Versions conservées sur le serveur (la plus récente est servie) */
const KEEP_VERSIONS = 2;
const REMOTE_TTL_MS = 10 * 60_000;

export interface InstallerInfo {
    file: string;
    version: string;
    sizeBytes: number;
    updatedAt: string;
}

const compareVersions = (a: string, b: string): number => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d) return d;
    }
    return 0;
};

/** Installateurs envoyés depuis /admin, du plus récent au plus ancien */
export async function listInstallers(dir: string): Promise<InstallerInfo[]> {
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return [];
    }
    const found: InstallerInfo[] = [];
    for (const file of names) {
        const m = INSTALLER_RE.exec(file);
        if (!m) continue;
        const s = await stat(join(dir, file)).catch(() => null);
        if (s?.isFile()) found.push({ file, version: m[1], sizeBytes: s.size, updatedAt: s.mtime.toISOString() });
    }
    return found.sort((a, b) => compareVersions(b.version, a.version));
}

// ---------------------------------------------------------------- Versions publiées

type Source = 'local' | 'gitlab' | 'github';

/** Version disponible et ses fichiers (installateur, blockmap, latest.yml) */
interface Release {
    source: Source;
    version: string;
    installer: string;
    sizeBytes: number | null;
    updatedAt: string | null;
    /** Adresse publique de chaque fichier de la release (sources distantes) */
    assets: Map<string, string>;
    /** Contenu de latest.yml (sources distantes) */
    latestYml: string | null;
}

const SOURCE_RANK: Record<Source, number> = { local: 0, gitlab: 1, github: 2 };
const remoteCache = new Map<string, { at: number; value: Release | null }>();
let localYmlCache: { key: string; yml: string } | null = null;

/** Vide les caches (tests) */
export const clearReleaseCache = (): void => { remoteCache.clear(); localYmlCache = null; };
/** Ancien nom, gardé pour les tests existants */
export const clearGithubCache = clearReleaseCache;

/** Taille annoncée dans latest.yml (« size: 123 ») */
const ymlSize = (yml: string | null): number | null => {
    const m = yml ? /\bsize:\s*(\d+)/.exec(yml) : null;
    return m ? Number(m[1]) : null;
};

async function fetchText(url: string): Promise<string | null> {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'pause-server' } });
    return res.ok ? res.text() : null;
}

/** Construit une release à partir de ses fichiers ; null si l'installateur manque */
async function toRelease(source: Source, assets: Map<string, string>, updatedAt: string | null, sizes: Map<string, number>): Promise<Release | null> {
    const installer = [...assets.keys()].find((n) => INSTALLER_RE.test(n));
    if (!installer) return null;
    const ymlUrl = assets.get('latest.yml');
    const latestYml = ymlUrl ? await fetchText(ymlUrl).catch(() => null) : null;
    return {
        source,
        version: INSTALLER_RE.exec(installer)![1],
        installer,
        sizeBytes: sizes.get(installer) ?? ymlSize(latestYml),
        updatedAt,
        assets,
        latestYml
    };
}

async function gitlabRelease(baseUrl: string, project: string): Promise<Release | null> {
    const res = await fetch(`${baseUrl}/api/v4/projects/${encodeURIComponent(project)}/releases/permalink/latest`, {
        headers: { accept: 'application/json', 'user-agent': 'pause-server' },
        signal: AbortSignal.timeout(8000)
    });
    if (res.status === 404) return null; // aucune release publiée
    if (!res.ok) throw new Error(`GitLab HTTP ${res.status}`);
    const release: any = await res.json();
    const assets = new Map<string, string>();
    for (const l of release.assets?.links ?? []) assets.set(String(l.name), String(l.url));
    return toRelease('gitlab', assets, release.released_at ?? release.created_at ?? null, new Map());
}

async function githubRelease(repo: string): Promise<Release | null> {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'pause-server' },
        signal: AbortSignal.timeout(8000)
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
    const release: any = await res.json();
    const assets = new Map<string, string>();
    const sizes = new Map<string, number>();
    for (const a of release.assets ?? []) {
        assets.set(String(a.name), String(a.browser_download_url));
        if (Number(a.size)) sizes.set(String(a.name), Number(a.size));
    }
    return toRelease('github', assets, release.published_at ?? null, sizes);
}

/**
 * Release distante mise en cache 10 min (limites d'appels des API) ;
 * en cas d'échec, la dernière valeur connue est gardée.
 */
async function cachedRemote(key: string, load: () => Promise<Release | null>, log: (m: string, e?: unknown) => void): Promise<Release | null> {
    const hit = remoteCache.get(key);
    if (hit && Date.now() - hit.at < REMOTE_TTL_MS) return hit.value;
    let value = hit?.value ?? null;
    try {
        value = await load();
    } catch (err) {
        log(`Releases injoignables (${key}) : dernière version connue conservée.`, err);
    }
    remoteCache.set(key, { at: Date.now(), value });
    return value;
}

async function sha512Base64(path: string): Promise<string> {
    const hash = createHash('sha512');
    await pipeline(createReadStream(path), hash);
    return hash.digest('base64');
}

/** latest.yml au format electron-builder pour l'installateur envoyé depuis /admin (empreinte calculée une fois) */
async function localLatestYml(dir: string, info: InstallerInfo): Promise<string> {
    const key = `${info.file}|${info.sizeBytes}|${info.updatedAt}`;
    if (localYmlCache?.key === key) return localYmlCache.yml;
    const sha512 = await sha512Base64(join(dir, info.file));
    const yml = [
        `version: ${info.version}`,
        'files:',
        `  - url: ${info.file}`,
        `    sha512: ${sha512}`,
        `    size: ${info.sizeBytes}`,
        `path: ${info.file}`,
        `sha512: ${sha512}`,
        `releaseDate: '${info.updatedAt}'`,
        ''
    ].join('\n');
    localYmlCache = { key, yml };
    return yml;
}

// ---------------------------------------------------------------- Routes

export function registerDownloadApi(app: FastifyInstance, { db, config }: { db: Db; config: Config }): void {
    const dir = config.DOWNLOADS_DIR ?? DEFAULT_DIR;
    const log = (msg: string, err?: unknown) => app.log.warn({ err }, msg);

    /** La version la plus récente parmi le fichier local et les releases GitLab / GitHub */
    async function resolveLatest(): Promise<{ release: Release; local?: InstallerInfo } | null> {
        const [local] = await listInstallers(dir);
        const candidates: { release: Release; local?: InstallerInfo }[] = [];
        if (local) {
            candidates.push({
                local,
                release: {
                    source: 'local', version: local.version, installer: local.file, sizeBytes: local.sizeBytes,
                    updatedAt: local.updatedAt, assets: new Map(), latestYml: null
                }
            });
        }
        if (config.DESKTOP_GITLAB_PROJECT) {
            const project = config.DESKTOP_GITLAB_PROJECT;
            const r = await cachedRemote(`gitlab:${project}`, () => gitlabRelease(config.GITLAB_URL, project), log);
            if (r) candidates.push({ release: r });
        }
        if (config.DESKTOP_GITHUB_REPO) {
            const repo = config.DESKTOP_GITHUB_REPO;
            const r = await cachedRemote(`github:${repo}`, () => githubRelease(repo), log);
            if (r) candidates.push({ release: r });
        }
        candidates.sort((a, b) => compareVersions(b.release.version, a.release.version)
            || SOURCE_RANK[a.release.source] - SOURCE_RANK[b.release.source]);
        return candidates[0] ?? null;
    }

    // Corps binaires bruts (morceaux de l'installateur) : le flux est lu par la route elle-même
    app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

    app.get('/telecharger/windows', async (_req, reply) => {
        const latest = await resolveLatest();
        if (latest?.local) {
            reply
                .header('Content-Type', 'application/vnd.microsoft.portable-executable')
                .header('Content-Disposition', `attachment; filename="${latest.local.file}"`)
                .header('Content-Length', String(latest.local.sizeBytes))
                .header('Cache-Control', 'no-cache');
            return reply.send(createReadStream(join(dir, latest.local.file)));
        }
        const url = latest?.release.assets.get(latest.release.installer);
        // Release distante : le téléchargement démarre directement depuis GitLab ou GitHub
        if (url) return reply.header('Cache-Control', 'no-cache').redirect(url, 302);
        if (config.DESKTOP_DOWNLOAD_URL) return reply.redirect(config.DESKTOP_DOWNLOAD_URL, 302);
        return reply.code(404).type('text/html; charset=utf-8').send(
            '<!doctype html><meta charset="utf-8"><title>Pause</title>' +
            '<p style="font-family:system-ui;max-width:40ch;margin:15vh auto;line-height:1.5">' +
            'L\'application Windows n\'est pas encore disponible au téléchargement. ' +
            'Demandez le fichier d\'installation à l\'admin de votre équipe.</p>'
        );
    });

    app.get('/api/download/windows', async () => {
        const latest = await resolveLatest();
        if (latest) {
            const r = latest.release;
            return { available: true, url: '/telecharger/windows', version: r.version, sizeBytes: r.sizeBytes, updatedAt: r.updatedAt, external: false, source: r.source };
        }
        if (config.DESKTOP_DOWNLOAD_URL) {
            return { available: true, url: '/telecharger/windows', version: null, sizeBytes: null, updatedAt: null, external: true, source: 'url' };
        }
        return { available: false, url: '/telecharger/windows', version: null, sizeBytes: null, updatedAt: null, external: false, source: null };
    });

    // Mises à jour automatiques de l'application installée (electron-updater, fournisseur « generic »)
    app.get('/mises-a-jour/latest.yml', async (_req, reply) => {
        const latest = await resolveLatest();
        const yml = latest?.local ? await localLatestYml(dir, latest.local) : latest?.release.latestYml ?? null;
        if (!yml) return reply.code(404).type('text/plain; charset=utf-8').send('Aucune version publiée.');
        return reply.header('Cache-Control', 'no-cache').type('text/yaml; charset=utf-8').send(yml);
    });

    app.get('/mises-a-jour/:file', async (req, reply) => {
        const { file } = parse(z.object({ file: z.string().max(120) }), req.params);
        const latest = await resolveLatest();
        if (latest?.local && file === latest.local.file) {
            reply
                .header('Content-Type', 'application/octet-stream')
                .header('Content-Length', String(latest.local.sizeBytes));
            return reply.send(createReadStream(join(dir, latest.local.file)));
        }
        // Fichiers de la release distante (installateur, blockmap) : redirection vers leur adresse publique
        const url = latest?.release.assets.get(file);
        if (url) return reply.redirect(url, 302);
        return reply.code(404).type('text/plain; charset=utf-8').send('Fichier introuvable.');
    });

    // Envoi par morceaux : offset 0 recommence le fichier ; le dernier morceau publie la nouvelle version
    app.put('/api/admin/desktop-installer', { bodyLimit: CHUNK_MAX_BYTES + 1024 }, async (req) => {
        const actor = await requireAdminSession(db, req);
        if (!actor.superAdmin) throw forbidden('Seul le super admin publie l\'application Windows.');
        const q = parse(z.object({
            name: z.string().regex(INSTALLER_RE, 'Nom attendu : Pause-Setup-<version>.exe (ex. Pause-Setup-1.0.2.exe).'),
            offset: z.coerce.number().int().min(0),
            total: z.coerce.number().int().min(1).max(INSTALLER_MAX_BYTES, 'Fichier trop volumineux (400 Mo au plus).')
        }), req.query);
        if (q.offset >= q.total) throw badRequest('Position d\'envoi invalide.');

        await mkdir(dir, { recursive: true });
        const part = join(dir, `.upload-${q.name}.part`);
        const current = q.offset === 0 ? 0 : (await stat(part).catch(() => null))?.size ?? -1;
        if (current !== q.offset) {
            throw conflict(`Envoi interrompu : reprenez depuis le début (reçu ${Math.max(0, current)} octets).`, 'upload_offset');
        }

        const handle = await open(part, q.offset === 0 ? 'w' : 'a');
        try {
            await pipeline(req.body as NodeJS.ReadableStream, handle.createWriteStream());
        } finally {
            await handle.close().catch(() => {});
        }
        const received = (await stat(part)).size;
        if (received > q.total) {
            await unlink(part).catch(() => {});
            throw badRequest('Le fichier reçu dépasse la taille annoncée. Recommencez l\'envoi.');
        }
        if (received < q.total) return { done: false, received, total: q.total };

        // Dernier morceau : vérifie qu'il s'agit bien d'un exécutable Windows (« MZ ») avant de le publier
        const check = await open(part, 'r');
        const head = Buffer.alloc(2);
        await check.read(head, 0, 2, 0);
        await check.close();
        if (head.toString('latin1') !== 'MZ') {
            await unlink(part).catch(() => {});
            throw badRequest('Ce fichier n\'est pas un installateur Windows (.exe).');
        }
        await rename(part, join(dir, q.name));
        // Ne garde que les dernières versions
        const all = await listInstallers(dir);
        for (const old of all.slice(KEEP_VERSIONS)) await unlink(join(dir, old.file)).catch(() => {});
        await audit(db, { actor: `admin:${actor.email}`, action: 'desktop.publish', target: q.name, details: { sizeBytes: received } });
        const [latest] = await listInstallers(dir);
        return { done: true, received, total: q.total, latest };
    });
}
