// Téléchargement de l'application Windows.
// - GET /telecharger/windows : lien direct public vers le dernier installateur (fichier envoyé depuis /admin,
//   sinon redirection vers DESKTOP_DOWNLOAD_URL).
// - GET /api/download/windows : version, taille et date, pour la page d'accueil et /admin.
// - PUT /api/admin/desktop-installer : envoi par morceaux (super admin). Morceaux de 20 Mo au plus :
//   Cloudflare refuse les corps de plus de 100 Mo, l'installateur en fait davantage.

import type { FastifyInstance } from 'fastify';
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

/** Installateurs présents, du plus récent au plus ancien */
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

/** Version proposée au téléchargement : fichier envoyé depuis /admin, ou dernière release GitHub */
interface Candidate {
    source: 'local' | 'github';
    version: string;
    sizeBytes: number | null;
    updatedAt: string | null;
    /** Fichier local (source « local ») ou adresse de l'asset (source « github ») */
    file?: string;
    url?: string;
}

const GITHUB_TTL_MS = 10 * 60_000;
let githubCache: { at: number; repo: string; value: Candidate | null } | null = null;

/** Vide le cache GitHub (tests) */
export const clearGithubCache = (): void => { githubCache = null; };

/**
 * Dernière release GitHub contenant Pause-Setup-<version>.exe. Mise en cache 10 min
 * (limite de 60 appels/h sans jeton) ; en cas d'échec, la dernière valeur connue est gardée.
 */
async function githubLatest(repo: string, log: (msg: string, err?: unknown) => void): Promise<Candidate | null> {
    if (githubCache && githubCache.repo === repo && Date.now() - githubCache.at < GITHUB_TTL_MS) return githubCache.value;
    let value: Candidate | null = githubCache?.repo === repo ? githubCache.value : null;
    try {
        const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'pause-server' },
            signal: AbortSignal.timeout(8000)
        });
        if (res.status === 404) value = null; // aucune release publiée
        else if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
        else {
            const release: any = await res.json();
            const asset = (release.assets ?? []).find((a: any) => INSTALLER_RE.test(String(a.name)));
            value = asset
                ? {
                    source: 'github',
                    version: INSTALLER_RE.exec(asset.name)![1],
                    sizeBytes: Number(asset.size) || null,
                    updatedAt: asset.updated_at ?? release.published_at ?? null,
                    url: String(asset.browser_download_url)
                }
                : null;
        }
    } catch (err) {
        log('Releases GitHub injoignables : dernière version connue conservée.', err);
    }
    githubCache = { at: Date.now(), repo, value };
    return value;
}

export function registerDownloadApi(app: FastifyInstance, { db, config }: { db: Db; config: Config }): void {
    const dir = config.DOWNLOADS_DIR ?? DEFAULT_DIR;
    const log = (msg: string, err?: unknown) => app.log.warn({ err }, msg);

    /** La version la plus récente entre le fichier envoyé depuis /admin et la dernière release GitHub */
    async function resolveLatest(): Promise<Candidate | null> {
        const [local] = await listInstallers(dir);
        const candidates: Candidate[] = [];
        if (local) candidates.push({ source: 'local', version: local.version, sizeBytes: local.sizeBytes, updatedAt: local.updatedAt, file: local.file });
        if (config.DESKTOP_GITHUB_REPO) {
            const gh = await githubLatest(config.DESKTOP_GITHUB_REPO, log);
            if (gh) candidates.push(gh);
        }
        // À version égale, le fichier local l'emporte (servi depuis ce site)
        candidates.sort((a, b) => compareVersions(b.version, a.version) || (a.source === 'local' ? -1 : 1));
        return candidates[0] ?? null;
    }

    // Corps binaires bruts (morceaux de l'installateur) : le flux est lu par la route elle-même
    app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

    app.get('/telecharger/windows', async (_req, reply) => {
        const latest = await resolveLatest();
        if (latest?.source === 'local') {
            reply
                .header('Content-Type', 'application/vnd.microsoft.portable-executable')
                .header('Content-Disposition', `attachment; filename="${latest.file}"`)
                .header('Content-Length', String(latest.sizeBytes))
                .header('Cache-Control', 'no-cache');
            return reply.send(createReadStream(join(dir, latest.file!)));
        }
        // Release GitHub : le téléchargement démarre directement depuis GitHub
        if (latest?.source === 'github') return reply.header('Cache-Control', 'no-cache').redirect(latest.url!, 302);
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
            return {
                available: true, url: '/telecharger/windows', version: latest.version, sizeBytes: latest.sizeBytes,
                updatedAt: latest.updatedAt, external: false, source: latest.source
            };
        }
        if (config.DESKTOP_DOWNLOAD_URL) {
            return { available: true, url: '/telecharger/windows', version: null, sizeBytes: null, updatedAt: null, external: true, source: 'url' };
        }
        return { available: false, url: '/telecharger/windows', version: null, sizeBytes: null, updatedAt: null, external: false, source: null };
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
