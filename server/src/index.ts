import { buildApp, ensureSuperAdmin } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { purgeAudit } from './lib/audit.js';
import { purgeMessages } from './services/chat.js';

const DAY_MS = 24 * 3600_000;

async function main(): Promise<void> {
    const config = loadConfig();
    const db = createDb(config.DATABASE_URL);
    const app = await buildApp(db, config);

    await ensureSuperAdmin(db, config, (msg) => app.log.info(msg));

    // Nettoyage quotidien : journal au-delà d'un an, messages de plus de 90 jours, sessions expirées
    const cleanup = async () => {
        try {
            const purged = await purgeAudit(db);
            await db.adminSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
            if (purged) app.log.info(`Journal : ${purged} entrée(s) de plus d'un an supprimée(s).`);
            const messages = await purgeMessages(db);
            if (messages) app.log.info(`Discussion : ${messages} message(s) de plus de 90 jours supprimé(s).`);
        } catch (err) {
            app.log.error(err, 'Nettoyage quotidien impossible');
        }
    };
    void cleanup();
    const timer = setInterval(cleanup, DAY_MS);

    const shutdown = async (signal: string) => {
        app.log.info(`${signal} reçu : arrêt…`);
        clearInterval(timer);
        await app.close();
        await db.$disconnect();
        process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
