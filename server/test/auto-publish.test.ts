import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDb, type Db } from '../src/db.js';
import { toDbDate } from '../src/lib/time.js';
import {
    AUTO_AUTHOR, autoSlots, clearOfficialTimesCache, isAutoWindow, officialMinsFor, runAutoPublish
} from '../src/services/auto-publish.js';

describe('règles de publication automatique', () => {
    it('fenêtre : de 20 min avant l\'heure officielle jusqu\'à cette heure', () => {
        expect(isAutoWindow(12 * 60 + 5, 12 * 60 + 26)).toBe(false);
        expect(isAutoWindow(12 * 60 + 6, 12 * 60 + 26)).toBe(true);
        expect(isAutoWindow(12 * 60 + 25, 12 * 60 + 26)).toBe(true);
        expect(isAutoWindow(12 * 60 + 26, 12 * 60 + 26)).toBe(false);
    });
    it('Jumu\'a suit l\'heure de Dhuhr', () => {
        expect(officialMinsFor('JUMUA', { Dhuhr: 746, Asr: 940 })).toBe(746);
        expect(officialMinsFor('ASR', { Dhuhr: 746, Asr: 940 })).toBe(940);
    });
    it('copie exacte de la dernière publication (groupes encore existants)', () => {
        const prev = [{ groupId: 1, timeMins: 746 }, { groupId: 2, timeMins: 760 }, { groupId: 9, timeMins: 770 }];
        expect(autoSlots('DHUHR', prev, [1, 2, 3], 750)).toEqual([{ groupId: 1, timeMins: 746 }, { groupId: 2, timeMins: 760 }]);
    });
    it('sans publication : G1 à l\'heure officielle puis +10 min, deux groupes', () => {
        expect(autoSlots('ASR', null, [4, 5, 6], 940)).toEqual([{ groupId: 4, timeMins: 940 }, { groupId: 5, timeMins: 950 }]);
    });
    it('Jumu\'a : copie de l\'heure précédente, sinon heure officielle', () => {
        expect(autoSlots('JUMUA', [{ groupId: null, timeMins: 780 }], [1], 746)).toEqual([{ groupId: null, timeMins: 780 }]);
        expect(autoSlots('JUMUA', null, [1], 746)).toEqual([{ groupId: null, timeMins: 746 }]);
    });
    it('catégorie sans groupe : rien à publier', () => {
        expect(autoSlots('DHUHR', null, [], 746)).toEqual([]);
    });
});

const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('publication automatique (intégration)', () => {
    let db: Db;
    const MONDAY = '2026-11-30';
    const THURSDAY = '2026-11-26';
    // Lundi 30/11 à 12:10 (heure locale = UTC) : fenêtre de Dhuhr ouverte (heure officielle 12:26)
    const NOW = Date.UTC(2026, 10, 30, 12, 10);
    const fetchTimes = async () => ({ Dhuhr: 12 * 60 + 26, Asr: 15 * 60 + 40 });
    const published: unknown[] = [];
    const hub = { schedulePublished: async (input: unknown) => { published.push(input); } };
    let withHistory = { id: 0, g1: 0, g2: 0 };
    let fresh = { id: 0, g1: 0, g2: 0 };

    beforeAll(async () => {
        const config = loadConfig({ ...process.env, DATABASE_URL: TEST_DB!, NODE_ENV: 'test' });
        db = createDb(config.DATABASE_URL);
        await db.team.deleteMany({ where: { name: 'Auto-publication' } });
        const team = await db.team.create({ data: { name: 'Auto-publication' } });
        const make = async (name: string) => {
            const c = await db.category.create({
                data: { teamId: team.id, name, jumuaEnabled: true, groups: { create: [{ name: 'G1', sortOrder: 0 }, { name: 'G2', sortOrder: 1 }] } },
                include: { groups: { orderBy: { sortOrder: 'asc' } } }
            });
            return { id: c.id, g1: c.groups[0].id, g2: c.groups[1].id };
        };
        withHistory = await make('Avec historique');
        fresh = await make('Nouvelle');
        // Dernière publication de Dhuhr : jeudi, G1 12:26 et G2 12:40 (écart non standard, copié tel quel)
        await db.publication.create({
            data: {
                categoryId: withHistory.id, date: toDbDate(THURSDAY), prayer: 'DHUHR', publishedBy: 'Azedine',
                slots: { create: [{ groupId: withHistory.g1, timeMins: 746 }, { groupId: withHistory.g2, timeMins: 760 }] }
            }
        });
        clearOfficialTimesCache();
    });

    afterAll(async () => {
        await db?.team.deleteMany({ where: { name: 'Auto-publication' } });
        await db?.$disconnect();
    });

    const slotsOf = async (categoryId: number, prayer: 'DHUHR' | 'ASR') => {
        const p = await db.publication.findUnique({
            where: { categoryId_date_prayer: { categoryId, date: toDbDate(MONDAY), prayer } },
            include: { slots: { orderBy: { timeMins: 'asc' } } }
        });
        return p ? { by: p.publishedBy, slots: p.slots.map((s) => ({ groupId: s.groupId, timeMins: s.timeMins })) } : null;
    };

    it('publie Dhuhr 20 min avant : copie exacte, ou G1 + 10 min sans historique', async () => {
        const done = await runAutoPublish({ db, hub, offsetHours: 0, fetchTimes, now: NOW });
        const mine = done.filter((d) => d.categoryId === withHistory.id || d.categoryId === fresh.id);
        expect(mine.map((d) => d.prayer)).toEqual(['DHUHR', 'DHUHR']);

        expect(await slotsOf(withHistory.id, 'DHUHR')).toEqual({
            by: AUTO_AUTHOR, slots: [{ groupId: withHistory.g1, timeMins: 746 }, { groupId: withHistory.g2, timeMins: 760 }]
        });
        expect(await slotsOf(fresh.id, 'DHUHR')).toEqual({
            by: AUTO_AUTHOR, slots: [{ groupId: fresh.g1, timeMins: 746 }, { groupId: fresh.g2, timeMins: 756 }]
        });
        // Asr n'est pas encore dans sa fenêtre
        expect(await slotsOf(fresh.id, 'ASR')).toBeNull();
        expect(published.length).toBeGreaterThanOrEqual(2);
        const log = await db.auditLog.findFirst({ where: { action: 'schedule.auto_publish' }, orderBy: { id: 'desc' } });
        expect(log?.actor).toBe('système');
    });

    it('ne remplace jamais une publication existante', async () => {
        await db.publicationSlot.updateMany({
            where: { publication: { categoryId: fresh.id, date: toDbDate(MONDAY), prayer: 'DHUHR' } },
            data: { timeMins: 800 }
        });
        const done = await runAutoPublish({ db, hub, offsetHours: 0, fetchTimes, now: NOW + 5 * 60_000 });
        expect(done.filter((d) => d.categoryId === fresh.id)).toEqual([]);
        expect((await slotsOf(fresh.id, 'DHUHR'))!.slots.every((s) => s.timeMins === 800)).toBe(true);
    });

    it('rien le week-end', async () => {
        const saturday = Date.UTC(2026, 10, 28, 12, 10);
        expect(await runAutoPublish({ db, hub, offsetHours: 0, fetchTimes, now: saturday })).toEqual([]);
    });
});
