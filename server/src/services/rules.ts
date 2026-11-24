// Règles métier pures (sans base de données) : prières du jour, Jumu'a, choix de groupe.
// Vocabulaire : GLOSSARY.md.

import { isFriday, isWorkday } from '../lib/time.js';

export type PrayerKey = 'DHUHR' | 'ASR' | 'JUMUA';

/**
 * Prières à publier un jour donné pour une catégorie :
 * aucune le week-end ; le vendredi, Jumu'a remplace Dhuhr si elle est activée.
 */
export function prayersForDay(date: string, jumuaEnabled: boolean): PrayerKey[] {
    if (!isWorkday(date)) return [];
    return isFriday(date) && jumuaEnabled ? ['JUMUA', 'ASR'] : ['DHUHR', 'ASR'];
}

/** Jumu'a : créneau unique, sans choix de groupe */
export const hasGroupChoice = (prayer: PrayerKey): boolean => prayer !== 'JUMUA';

/**
 * Groupe effectif d'un membre pour une prière publiée.
 * explicit : undefined si le membre n'a rien choisi ce jour-là, null s'il a choisi « aucun groupe ».
 * Un choix explicite l'emporte ; sinon son groupe habituel s'il est publié ce jour-là.
 */
export function effectiveGroup(
    explicit: number | null | undefined,
    usualGroupId: number | null,
    publishedGroupIds: ReadonlySet<number>
): number | null {
    if (explicit !== undefined) return explicit !== null && publishedGroupIds.has(explicit) ? explicit : null;
    if (usualGroupId !== null && publishedGroupIds.has(usualGroupId)) return usualGroupId;
    return null;
}

export interface ChoiceChange {
    /** Jour visé et jour local actuel (AAAA-MM-JJ) */
    date: string;
    today: string;
    nowMins: number;
    /** Heure du groupe actuellement choisi (null si aucun) */
    currentTimeMins: number | null;
    /** Heure du groupe visé (null pour retirer son choix) */
    targetTimeMins: number | null;
}

/**
 * Un membre peut changer d'avis jusqu'à l'heure du groupe :
 * impossible pour un jour passé, ni pour quitter ou rejoindre un groupe dont l'heure est passée.
 * Renvoie null si le changement est permis, sinon le message à afficher.
 */
export function choiceChangeError(c: ChoiceChange): string | null {
    if (c.date < c.today) return 'Ce jour est passé : le choix ne peut plus changer.';
    if (c.date > c.today) return null;
    if (c.currentTimeMins !== null && c.currentTimeMins <= c.nowMins) {
        return 'L\'heure de votre groupe est passée : le choix ne peut plus changer.';
    }
    if (c.targetTimeMins !== null && c.targetTimeMins <= c.nowMins) {
        return 'L\'heure de ce groupe est passée. Choisissez un groupe plus tard.';
    }
    return null;
}

export interface SlotInput {
    groupId: number | null;
    timeMins: number;
}

/**
 * Valide les horaires d'une publication. Renvoie null si c'est valide, sinon le message d'erreur.
 * - Jumu'a : exactement un créneau, sans groupe.
 * - Dhuhr / Asr : au moins un groupe, chacun une seule fois, tous de la catégorie.
 */
export function publicationError(
    date: string,
    prayer: PrayerKey,
    jumuaEnabled: boolean,
    slots: SlotInput[],
    categoryGroupIds: ReadonlySet<number>
): string | null {
    const allowed = prayersForDay(date, jumuaEnabled);
    if (allowed.length === 0) return 'Les horaires se publient du lundi au vendredi.';
    if (!allowed.includes(prayer)) {
        return prayer === 'DHUHR'
            ? 'Ce vendredi, Dhuhr est remplacée par Jumu\'a : publiez l\'heure de Jumu\'a.'
            : 'Jumu\'a n\'a lieu que le vendredi, dans une catégorie où elle est activée.';
    }
    if (slots.some((s) => !Number.isInteger(s.timeMins) || s.timeMins < 0 || s.timeMins >= 1440)) {
        return 'Chaque horaire doit être une heure valide (00:00 à 23:59).';
    }
    if (prayer === 'JUMUA') {
        return slots.length === 1 && slots[0].groupId === null ? null : 'Jumu\'a a un seul horaire, sans groupe.';
    }
    if (slots.length === 0) return 'Indiquez l\'horaire d\'au moins un groupe.';
    const seen = new Set<number>();
    for (const s of slots) {
        if (s.groupId === null || !categoryGroupIds.has(s.groupId)) return 'Un des groupes n\'appartient pas à cette catégorie.';
        if (seen.has(s.groupId)) return 'Chaque groupe ne peut avoir qu\'un horaire.';
        seen.add(s.groupId);
    }
    return null;
}
