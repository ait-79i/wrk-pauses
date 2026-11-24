import { describe, expect, it } from 'vitest';
import { choiceChangeError, effectiveGroup, prayersForDay, publicationError } from '../src/services/rules.js';

// 2026-11-23 lundi, 2026-11-27 vendredi, 2026-11-28 samedi
const MONDAY = '2026-11-23';
const FRIDAY = '2026-11-27';
const SATURDAY = '2026-11-28';

describe('prayersForDay', () => {
    it('Dhuhr et Asr en semaine', () => expect(prayersForDay(MONDAY, true)).toEqual(['DHUHR', 'ASR']));
    it('Jumu\'a remplace Dhuhr le vendredi si activée', () => expect(prayersForDay(FRIDAY, true)).toEqual(['JUMUA', 'ASR']));
    it('garde Dhuhr le vendredi si Jumu\'a est désactivée', () => expect(prayersForDay(FRIDAY, false)).toEqual(['DHUHR', 'ASR']));
    it('rien le week-end', () => expect(prayersForDay(SATURDAY, true)).toEqual([]));
});

describe('effectiveGroup', () => {
    const published = new Set([1, 2]);
    it('choix explicite prioritaire', () => expect(effectiveGroup(2, 1, published)).toBe(2));
    it('groupe habituel sans choix explicite', () => expect(effectiveGroup(undefined, 1, published)).toBe(1));
    it('« aucun groupe » explicite masque le groupe habituel', () => expect(effectiveGroup(null, 1, published)).toBeNull());
    it('groupe habituel non publié ce jour-là', () => expect(effectiveGroup(undefined, 3, published)).toBeNull());
});

describe('choiceChangeError', () => {
    const base = { date: MONDAY, today: MONDAY, nowMins: 12 * 60 + 30 };
    it('accepte un groupe à venir', () =>
        expect(choiceChangeError({ ...base, currentTimeMins: null, targetTimeMins: 12 * 60 + 36 })).toBeNull());
    it('refuse un groupe dont l\'heure est passée', () =>
        expect(choiceChangeError({ ...base, currentTimeMins: null, targetTimeMins: 12 * 60 + 26 })).toMatch(/passée/));
    it('refuse de quitter un groupe dont l\'heure est passée', () =>
        expect(choiceChangeError({ ...base, currentTimeMins: 12 * 60 + 26, targetTimeMins: 12 * 60 + 36 })).toMatch(/votre groupe/));
    it('refuse un jour passé', () =>
        expect(choiceChangeError({ ...base, date: '2026-11-20', currentTimeMins: null, targetTimeMins: null })).toMatch(/passé/));
    it('accepte tout pour un jour à venir', () =>
        expect(choiceChangeError({ ...base, date: '2026-11-24', currentTimeMins: 600, targetTimeMins: 600 })).toBeNull());
});

describe('publicationError', () => {
    const groups = new Set([10, 11]);
    it('accepte G1 et G2 un lundi', () =>
        expect(publicationError(MONDAY, 'DHUHR', true, [{ groupId: 10, timeMins: 746 }, { groupId: 11, timeMins: 756 }], groups)).toBeNull());
    it('refuse le week-end', () =>
        expect(publicationError(SATURDAY, 'DHUHR', true, [{ groupId: 10, timeMins: 746 }], groups)).toMatch(/lundi au vendredi/));
    it('refuse Dhuhr un vendredi avec Jumu\'a', () =>
        expect(publicationError(FRIDAY, 'DHUHR', true, [{ groupId: 10, timeMins: 746 }], groups)).toMatch(/Jumu'a/));
    it('accepte Jumu\'a avec un seul créneau sans groupe', () =>
        expect(publicationError(FRIDAY, 'JUMUA', true, [{ groupId: null, timeMins: 780 }], groups)).toBeNull());
    it('refuse Jumu\'a avec un groupe', () =>
        expect(publicationError(FRIDAY, 'JUMUA', true, [{ groupId: 10, timeMins: 780 }], groups)).toMatch(/seul horaire/));
    it('refuse un groupe d\'une autre catégorie', () =>
        expect(publicationError(MONDAY, 'ASR', true, [{ groupId: 99, timeMins: 900 }], groups)).toMatch(/n'appartient pas/));
    it('refuse un groupe en double', () =>
        expect(publicationError(MONDAY, 'ASR', true, [{ groupId: 10, timeMins: 900 }, { groupId: 10, timeMins: 910 }], groups)).toMatch(/qu'un horaire/));
    it('refuse une heure invalide', () =>
        expect(publicationError(MONDAY, 'ASR', true, [{ groupId: 10, timeMins: 1440 }], groups)).toMatch(/heure valide/));
});
