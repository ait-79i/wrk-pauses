// Schémas de validation partagés par les API de l'application et du tableau de bord.

import { z } from 'zod';
import { badRequest } from '../lib/errors.js';

/** Valide une entrée ; la première erreur est renvoyée au client telle quelle */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const r = schema.safeParse(value ?? {});
    if (!r.success) throw badRequest(r.error.issues[0]?.message ?? 'Requête invalide.');
    return r.data;
}

export const prayerSchema = z.enum(['DHUHR', 'ASR', 'JUMUA']);

export const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Heure attendue au format HH:MM.');

export const toMins = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Horaires d'une publication : groupId null pour Jumu'a */
export const slotsSchema = z.array(z.object({
    groupId: z.number().int().positive().nullable(),
    time: hhmmSchema
})).max(50);

export const idParam = z.object({ id: z.coerce.number().int().positive() });
