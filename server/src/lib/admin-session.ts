// Session du tableau de bord pour les routes hors admin-api.ts (statistiques).
// Mêmes règles que requireAdmin() d'admin-api.ts : cookie « pause_admin », session vérifiée (2FA),
// super admin avec 2FA activée, périmètre tiré des rôles du membre lié (s'il est actif).

import type { FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { forbidden, unauthorized } from './errors.js';
import { hashToken } from './security.js';
import { hasAnyRole, scopeFrom, type Scope } from '../services/access.js';

export const ADMIN_COOKIE = 'pause_admin';

export interface AdminActor {
    id: number;
    email: string;
    superAdmin: boolean;
    scope: Scope;
}

/** Exige une session complète ; lève 401 ou 403 avec le message à afficher */
export async function requireAdminSession(db: Db, req: FastifyRequest): Promise<AdminActor> {
    const token = req.cookies[ADMIN_COOKIE];
    if (!token) throw unauthorized();
    const session = await db.adminSession.findUnique({
        where: { tokenHash: hashToken(token) },
        include: { admin: { include: { member: { include: { roles: true } } } } }
    });
    if (!session || session.expiresAt < new Date() || session.admin.disabled) throw unauthorized();
    const admin = session.admin;
    if (!session.verified) throw unauthorized('Saisissez le code de votre application d\'authentification.');
    if (admin.isSuperAdmin && !admin.totpEnabled) {
        throw forbidden('Activez la double authentification pour continuer.');
    }
    const memberActive = admin.member && admin.member.status === 'ACTIVE';
    const scope = scopeFrom(memberActive ? admin.member!.roles : [], admin.isSuperAdmin);
    if (!hasAnyRole(scope)) throw forbidden('Ce compte n\'a plus de rôle d\'administration.');
    return { id: admin.id, email: admin.email, superAdmin: admin.isSuperAdmin, scope };
}
