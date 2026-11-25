import { z } from 'zod';

// Configuration lue dans l'environnement (variables Coolify en production).

/** Docker Compose transmet « VAR= » quand la variable n'est pas définie : vide = absente */
const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const schema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL est obligatoire'),
    /** Adresse publique, ex. https://pause.8hqi.com (cookies sécurisés) */
    PUBLIC_URL: z.string().url().default('http://localhost:3000'),
    /** Super admin créé au premier démarrage s'il n'existe encore aucun super admin */
    SUPERADMIN_EMAIL: z.string().email().optional(),
    SUPERADMIN_PASSWORD: z.string().min(12, 'SUPERADMIN_PASSWORD : 12 caractères minimum').optional(),
    /** Décalage horaire des équipes par rapport à UTC (Maroc : GMT officiel → 0) */
    LOCAL_OFFSET_HOURS: z.coerce.number().default(0),
    /** Durée des sessions du tableau de bord, en jours */
    SESSION_DAYS: z.coerce.number().int().positive().default(7),
    /** Dossier des installateurs Windows envoyés depuis /admin (volume persistant en production) */
    DOWNLOADS_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
    /**
     * Dépôt GitHub public dont les releases contiennent l'installateur (ex. ait-79i/wrk-pauses) :
     * la dernière release est proposée automatiquement, sans envoi manuel depuis /admin.
     */
    DESKTOP_GITHUB_REPO: z.preprocess(emptyToUndefined, z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'DESKTOP_GITHUB_REPO attendu au format propriétaire/dépôt').optional()),
    /** Lien de secours vers l'installateur (ex. release GitHub/GitLab) si aucun fichier n'a été envoyé */
    DESKTOP_DOWNLOAD_URL: z.preprocess(emptyToUndefined, z.string().url('DESKTOP_DOWNLOAD_URL doit être une adresse complète (https://…)').optional())
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const parsed = schema.safeParse(env);
    if (!parsed.success) {
        const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
        throw new Error(`Configuration invalide :\n${details}`);
    }
    return parsed.data;
}
