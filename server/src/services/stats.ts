// Statistiques du tableau de bord (phase 3). Contrat : docs/contrat-api-phases-2-3.md §6.
// Effectif d'un groupe un jour donné = choix explicites ce jour-là + membres sans choix explicite
// dont le groupe habituel ACTUEL est ce groupe (approximation : l'historique des groupes habituels
// n'est pas conservé). Les membres pris en compte sont les membres actifs actuels de la catégorie.

import type { Db } from '../db.js';
import { fromDbDate, localNow, toDbDate } from '../lib/time.js';
import { effectiveGroup, hasGroupChoice, prayersForDay, type PrayerKey } from './rules.js';

const SEVEN_DAYS_MS = 7 * 24 * 3600_000;

export interface StatsCategoryInput {
    id: number;
    name: string;
    jumuaEnabled: boolean;
    createdAt: Date;
    groups: { id: number; name: string }[];
}

export interface StatsSlot {
    groupId: number | null;
    groupName: string | null;
    timeMins: number;
    count: number;
}

export interface StatsDay {
    date: string;
    categoryId: number;
    prayer: PrayerKey;
    published: boolean;
    publishedAt: string | null;
    total: number;
    slots: StatsSlot[];
}

export interface StatsCategory {
    id: number;
    name: string;
    members: number;
    activeMembers7d: number;
    publicationRate: number;
    participationRate: number;
}

export interface StatsGroup {
    groupId: number;
    name: string;
    categoryId: number;
    averageCount: number;
    averageTimeMins: number | null;
}

/** Compteurs bruts d'une catégorie, pour agréger plusieurs catégories (statistiques globales) */
export interface CategoryCounters {
    expected: number;
    published: number;
    participationSum: number;
    participationN: number;
}

export interface RangeStats {
    categories: StatsCategory[];
    days: StatsDay[];
    groups: StatsGroup[];
    counters: Map<number, CategoryCounters>;
}

/** Taux agrégés d'un ensemble de catégories */
export function combinedRates(counters: CategoryCounters[]): { publicationRate: number; participationRate: number } {
    const sum = (pick: (c: CategoryCounters) => number) => counters.reduce((n, c) => n + pick(c), 0);
    const n = sum((c) => c.participationN);
    return {
        publicationRate: round2(ratio(sum((c) => c.published), sum((c) => c.expected))),
        participationRate: round2(n ? sum((c) => c.participationSum) / n : 0)
    };
}

const PRAYER_ORDER: Record<PrayerKey, number> = { DHUHR: 0, JUMUA: 0, ASR: 1 };

/** Date AAAA-MM-JJ décalée de n jours */
export function addDays(date: string, n: number): string {
    const d = toDbDate(date);
    d.setUTCDate(d.getUTCDate() + n);
    return fromDbDate(d);
}

/** Jours AAAA-MM-JJ de from à to inclus */
export function datesBetween(from: string, to: string): string[] {
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
}

const ratio = (n: number, d: number): number => (d > 0 ? Math.min(1, n / d) : 0);
const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Statistiques d'un ensemble de catégories sur [from, to].
 * - days : prières attendues (jours ouvrés depuis la création de la catégorie) et prières publiées.
 * - publicationRate : publiées / attendues, sur les jours passés ou du jour.
 * - participationRate et groups : prières publiées passées ou du jour.
 */
export async function computeRangeStats(
    db: Db,
    categories: StatsCategoryInput[],
    from: string,
    to: string,
    offsetHours: number,
    nowTs = Date.now()
): Promise<RangeStats> {
    const today = localNow(offsetHours, nowTs).date;
    const categoryIds = categories.map((c) => c.id);
    if (categoryIds.length === 0) return { categories: [], days: [], groups: [], counters: new Map() };

    const [publications, members, choices, usuals] = await Promise.all([
        db.publication.findMany({
            where: { categoryId: { in: categoryIds }, date: { gte: toDbDate(from), lte: toDbDate(to) } },
            include: { slots: true }
        }),
        db.member.findMany({
            where: { categoryId: { in: categoryIds }, status: 'ACTIVE' },
            select: { id: true, categoryId: true, lastSeenAt: true }
        }),
        db.groupChoice.findMany({
            where: { date: { gte: toDbDate(from), lte: toDbDate(to) }, member: { categoryId: { in: categoryIds }, status: 'ACTIVE' } },
            select: { memberId: true, date: true, prayer: true, groupId: true }
        }),
        db.usualGroup.findMany({
            where: { member: { categoryId: { in: categoryIds }, status: 'ACTIVE' } },
            select: { memberId: true, prayer: true, groupId: true }
        })
    ]);

    const membersByCat = new Map<number, number[]>();
    for (const m of members) {
        const list = membersByCat.get(m.categoryId) ?? [];
        list.push(m.id);
        membersByCat.set(m.categoryId, list);
    }
    const seenSince = new Date(nowTs - SEVEN_DAYS_MS);
    const pubKey = (categoryId: number, date: string, prayer: string) => `${categoryId}|${date}|${prayer}`;
    const pubByKey = new Map(publications.map((p) => [pubKey(p.categoryId, fromDbDate(p.date), p.prayer), p]));
    // Choix explicite : clé date|prière|membre → groupe (null : aucun groupe)
    const explicit = new Map<string, number | null>();
    for (const c of choices) explicit.set(`${fromDbDate(c.date)}|${c.prayer}|${c.memberId}`, c.groupId);
    const usual = new Map<string, number>();
    for (const u of usuals) usual.set(`${u.prayer}|${u.memberId}`, u.groupId);

    const days: StatsDay[] = [];
    const outCategories: StatsCategory[] = [];
    const groupAgg = new Map<number, { counts: number; times: number; n: number }>();
    const counters = new Map<number, CategoryCounters>();

    for (const cat of categories) {
        const memberIds = membersByCat.get(cat.id) ?? [];
        const groupName = new Map(cat.groups.map((g) => [g.id, g.name]));
        const groupOrder = new Map(cat.groups.map((g, i) => [g.id, i]));
        const start = localNow(offsetHours, cat.createdAt.getTime()).date;

        // Prières attendues + publications existantes (même hors attente, ex. Jumu'a désactivée depuis)
        const entries = new Map<string, { date: string; prayer: PrayerKey; expected: boolean }>();
        for (const date of datesBetween(from > start ? from : start, to)) {
            for (const prayer of prayersForDay(date, cat.jumuaEnabled)) {
                entries.set(`${date}|${prayer}`, { date, prayer, expected: true });
            }
        }
        for (const p of publications) {
            if (p.categoryId !== cat.id) continue;
            const date = fromDbDate(p.date);
            const k = `${date}|${p.prayer}`;
            if (!entries.has(k)) entries.set(k, { date, prayer: p.prayer as PrayerKey, expected: false });
        }
        // Vendredi : le créneau de midi est rempli par Dhuhr ou par Jumu'a. Si l'option Jumu'a a changé depuis,
        // la publication existante compte comme la prière attendue (l'historique n'est pas réinterprété).
        for (const e of entries.values()) {
            if (!e.expected || (e.prayer !== 'DHUHR' && e.prayer !== 'JUMUA')) continue;
            const other = entries.get(`${e.date}|${e.prayer === 'DHUHR' ? 'JUMUA' : 'DHUHR'}`);
            if (other && !other.expected && !pubByKey.has(pubKey(cat.id, e.date, e.prayer))) {
                e.expected = false;
                other.expected = true;
            }
        }

        let expectedPast = 0;
        let publishedPast = 0;
        let participationSum = 0;
        let participationN = 0;

        const sorted = [...entries.values()].sort((a, b) =>
            a.date === b.date ? PRAYER_ORDER[a.prayer] - PRAYER_ORDER[b.prayer] : a.date < b.date ? -1 : 1);
        for (const e of sorted) {
            const pub = pubByKey.get(pubKey(cat.id, e.date, e.prayer));
            const past = e.date <= today;
            if (e.expected && past) {
                expectedPast++;
                if (pub) publishedPast++;
            }
            if (!pub) {
                if (!e.expected) continue;
                days.push({ date: e.date, categoryId: cat.id, prayer: e.prayer, published: false, publishedAt: null, total: 0, slots: [] });
                continue;
            }

            const publishedGroups = new Set(pub.slots.flatMap((s) => (s.groupId === null ? [] : [s.groupId])));
            const counts = new Map<number, number>();
            if (hasGroupChoice(e.prayer)) {
                for (const id of memberIds) {
                    const k = `${e.date}|${e.prayer}|${id}`;
                    const g = effectiveGroup(explicit.has(k) ? explicit.get(k)! : undefined, usual.get(`${e.prayer}|${id}`) ?? null, publishedGroups);
                    if (g !== null) counts.set(g, (counts.get(g) ?? 0) + 1);
                }
            }
            const slots: StatsSlot[] = pub.slots
                .slice()
                .sort((a, b) => (groupOrder.get(a.groupId ?? -1) ?? -1) - (groupOrder.get(b.groupId ?? -1) ?? -1))
                .map((s) => ({
                    groupId: s.groupId,
                    groupName: s.groupId === null ? null : groupName.get(s.groupId) ?? null,
                    timeMins: s.timeMins,
                    count: s.groupId === null ? memberIds.length : counts.get(s.groupId) ?? 0
                }));
            // Jumu'a : tous les membres actifs de la catégorie
            const total = e.prayer === 'JUMUA' ? memberIds.length : slots.reduce((n, s) => n + s.count, 0);
            days.push({
                date: e.date, categoryId: cat.id, prayer: e.prayer, published: true,
                publishedAt: pub.updatedAt.toISOString(), total, slots
            });

            if (!past) continue;
            // Participation : seulement les prières avec choix de groupe (Jumu'a n'a pas d'inscription)
            if (memberIds.length > 0 && hasGroupChoice(e.prayer)) {
                participationSum += ratio(total, memberIds.length);
                participationN++;
            }
            for (const s of slots) {
                if (s.groupId === null) continue;
                const agg = groupAgg.get(s.groupId) ?? { counts: 0, times: 0, n: 0 };
                agg.counts += s.count;
                agg.times += s.timeMins;
                agg.n++;
                groupAgg.set(s.groupId, agg);
            }
        }

        counters.set(cat.id, { expected: expectedPast, published: publishedPast, participationSum, participationN });
        outCategories.push({
            id: cat.id,
            name: cat.name,
            members: memberIds.length,
            activeMembers7d: members.filter((m) => m.categoryId === cat.id && m.lastSeenAt && m.lastSeenAt >= seenSince).length,
            publicationRate: round2(ratio(publishedPast, expectedPast)),
            participationRate: round2(participationN ? participationSum / participationN : 0)
        });
    }

    const groups: StatsGroup[] = categories.flatMap((cat) => cat.groups.map((g) => {
        const agg = groupAgg.get(g.id);
        return {
            groupId: g.id,
            name: g.name,
            categoryId: cat.id,
            averageCount: agg ? round2(agg.counts / agg.n) : 0,
            averageTimeMins: agg ? Math.round(agg.times / agg.n) : null
        };
    }));

    return { categories: outCategories, days, groups, counters };
}

/**
 * Messages des 7 derniers jours par équipe (tous canaux, messages supprimés exclus).
 * `categoryTeam` est conservé pour la compatibilité des appelants ; le message porte déjà son équipe.
 */
export async function messages7dByTeam(db: Db, _categoryTeam: ReadonlyMap<number, number>, nowTs = Date.now()): Promise<Map<number, number>> {
    const rows = await db.message.groupBy({
        by: ['teamId'], _count: { _all: true },
        where: { deletedAt: null, createdAt: { gte: new Date(nowTs - SEVEN_DAYS_MS) } }
    });
    return new Map(rows.map((r) => [r.teamId, r._count._all]));
}
