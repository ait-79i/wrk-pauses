import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { audit } from './lib/audit.js';
import { HttpError } from './lib/errors.js';
import { hashPassword } from './lib/security.js';
import { registerAdminApi } from './routes/admin-api.js';
import { registerAppApi } from './routes/app-api.js';
import { registerChatApi } from './routes/chat-api.js';
import { registerStatsApi } from './routes/stats-api.js';
import { registerDownloadApi } from './routes/download-api.js';
import { startAutoPublisher } from './services/auto-publish.js';
import { RealtimeHub } from './services/realtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Tableau de bord compilé (web/dist), servi à la racine */
const WEB_DIST = join(HERE, '..', 'web', 'dist');

export async function buildApp(db: Db, config: Config): Promise<FastifyInstance> {
    const app = Fastify({
        logger: config.NODE_ENV === 'test' ? false : { level: config.NODE_ENV === 'production' ? 'info' : 'debug' },
        trustProxy: true, // derrière le proxy de Coolify (Traefik)
        bodyLimit: 64 * 1024
    });

    // HTTPS forcé (HSTS, upgrade-insecure-requests) seulement derrière HTTPS : sinon le développement local casse
    const https = config.PUBLIC_URL.startsWith('https://');
    await app.register(helmet, {
        hsts: https ? { maxAge: 15552000, includeSubDomains: false } : false,
        contentSecurityPolicy: {
            directives: {
                upgradeInsecureRequests: https ? [] : null,
                defaultSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
                fontSrc: ["'self'", 'https://fonts.gstatic.com'],
                imgSrc: ["'self'", 'data:'],
                connectSrc: ["'self'"],
                frameAncestors: ["'none'"]
            }
        }
    });
    await app.register(cookie);
    await app.register(rateLimit, { global: false });
    // Temps réel (discussion, horaires) : messages JSON de 4 Ko au plus côté client
    await app.register(websocket, { options: { maxPayload: 4096 } });

    app.setErrorHandler((err, req, reply) => {
        if (err instanceof HttpError) {
            return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 429) {
            return reply.code(429).send({ error: 'rate_limited', message: 'Trop de tentatives. Réessayez dans quelques minutes.' });
        }
        if (status && status >= 400 && status < 500) {
            return reply.code(status).send({ error: 'bad_request', message: 'Requête invalide.' });
        }
        req.log.error(err);
        return reply.code(500).send({ error: 'server_error', message: 'Erreur du serveur. Réessayez dans un instant.' });
    });

    app.get('/api/health', async () => {
        await db.$queryRaw`SELECT 1`;
        return { ok: true };
    });

    // Connexions WebSocket ouvertes : partagées par les API qui publient des événements
    const hub = new RealtimeHub(db, (err, msg) => app.log.error(err, msg));

    registerAppApi(app, { db, config, hub });
    registerAdminApi(app, { db, config, hub });
    await registerChatApi(app, { db, config, hub });
    registerStatsApi(app, { db, config });
    registerDownloadApi(app, { db, config });

    // Publication automatique des horaires non publiés 20 min avant l'heure officielle (pas pendant les tests)
    if (config.NODE_ENV !== 'test') {
        const stop = startAutoPublisher({
            db, hub, offsetHours: config.LOCAL_OFFSET_HOURS,
            log: (msg, err) => (err ? app.log.warn({ err }, msg) : app.log.info(msg))
        });
        app.addHook('onClose', async () => stop());
    }

    // Tableau de bord : fichiers statiques + retour sur index.html pour les routes du client
    if (existsSync(WEB_DIST)) {
        await app.register(fastifyStatic, { root: WEB_DIST, wildcard: false });
        app.setNotFoundHandler((req, reply) => {
            if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
            return reply.code(404).send({ error: 'not_found', message: 'Adresse inconnue.' });
        });
    }

    return app;
}

/** Crée le super admin à partir de l'environnement s'il n'en existe aucun (premier déploiement) */
export async function ensureSuperAdmin(db: Db, config: Config, log: (msg: string) => void): Promise<void> {
    const count = await db.adminAccount.count({ where: { isSuperAdmin: true } });
    if (count > 0) return;
    if (!config.SUPERADMIN_EMAIL || !config.SUPERADMIN_PASSWORD) {
        log('Aucun super admin : définissez SUPERADMIN_EMAIL et SUPERADMIN_PASSWORD puis redémarrez.');
        return;
    }
    const email = config.SUPERADMIN_EMAIL.toLowerCase();
    await db.adminAccount.create({
        data: { email, passwordHash: await hashPassword(config.SUPERADMIN_PASSWORD), isSuperAdmin: true }
    });
    await audit(db, { actor: 'système', action: 'account.create_superadmin', target: email });
    log(`Super admin créé : ${email} (activez la double authentification à la première connexion).`);
}
