import type { Db } from '../db.js';

export interface AuditEntry {
    actor: string;
    action: string;
    teamId?: number | null;
    target?: string | null;
    details?: Record<string, unknown>;
}

/** Trace une action d'administration ; un échec d'écriture ne bloque jamais l'action elle-même */
export async function audit(db: Db, entry: AuditEntry): Promise<void> {
    try {
        await db.auditLog.create({
            data: {
                actor: entry.actor.slice(0, 120),
                action: entry.action,
                teamId: entry.teamId ?? null,
                target: entry.target ? entry.target.slice(0, 190) : null,
                details: (entry.details ?? undefined) as never
            }
        });
    } catch (err) {
        console.error('[audit] écriture impossible', err);
    }
}

const AUDIT_RETENTION_MS = 365 * 24 * 3600_000;

/** Purge du journal au-delà d'un an */
export async function purgeAudit(db: Db): Promise<number> {
    const cutoff = new Date(Date.now() - AUDIT_RETENTION_MS);
    const { count } = await db.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return count;
}
