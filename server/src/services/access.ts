// Droits d'accès selon les rôles (GLOSSARY.md › Rôles).

import { forbidden } from '../lib/errors.js';

export interface RoleRow {
    role: 'TEAM_ADMIN' | 'CATEGORY_ADMIN' | 'SCHEDULER';
    teamId: number;
    categoryId: number | null;
}

/** Périmètre d'un acteur : super admin, ou rôles portés par son identité de membre */
export interface Scope {
    superAdmin: boolean;
    /** Équipes dont il est admin d'équipe */
    teams: Set<number>;
    /** Catégories dont il est admin de catégorie */
    categories: Set<number>;
    /** Catégories dont il fixe les horaires (responsable horaires) */
    schedules: Set<number>;
}

export function scopeFrom(roles: RoleRow[], superAdmin = false): Scope {
    const scope: Scope = { superAdmin, teams: new Set(), categories: new Set(), schedules: new Set() };
    for (const r of roles) {
        if (r.role === 'TEAM_ADMIN') scope.teams.add(r.teamId);
        else if (r.role === 'CATEGORY_ADMIN' && r.categoryId !== null) scope.categories.add(r.categoryId);
        else if (r.role === 'SCHEDULER' && r.categoryId !== null) scope.schedules.add(r.categoryId);
    }
    return scope;
}

export interface CategoryRef {
    id: number;
    teamId: number;
}

/** Gérer l'équipe : code, catégories, membres, rôles */
export const canManageTeam = (s: Scope, teamId: number): boolean => s.superAdmin || s.teams.has(teamId);

/** Gérer la catégorie : groupes, limite de groupes, Jumu'a, horaires */
export const canManageCategory = (s: Scope, c: CategoryRef): boolean =>
    canManageTeam(s, c.teamId) || s.categories.has(c.id);

/** Publier les horaires du jour */
export const canPublish = (s: Scope, c: CategoryRef): boolean => canManageCategory(s, c) || s.schedules.has(c.id);

/** Voir une équipe dans le tableau de bord */
export const canViewTeam = (s: Scope, teamId: number, categoryTeamIds: (catId: number) => number | undefined): boolean =>
    canManageTeam(s, teamId) ||
    [...s.categories, ...s.schedules].some((catId) => categoryTeamIds(catId) === teamId);

export function assert(allowed: boolean, message?: string): void {
    if (!allowed) throw forbidden(message);
}

/** Un acteur a-t-il au moins un rôle d'administration ? */
export const hasAnyRole = (s: Scope): boolean =>
    s.superAdmin || s.teams.size > 0 || s.categories.size > 0 || s.schedules.size > 0;
