// Publication automatique des horaires du jour.
// Si personne n'a publié une prière AUTO_LEAD_MINS minutes avant son heure officielle (Aladhan, ville de l'équipe),
// le serveur republie à l'identique la dernière publication de cette prière dans la catégorie.
// Sans publication antérieure : G1 à l'heure officielle, puis un groupe toutes les AUTO_GAP_MINS minutes.

import type { Db } from '../db.js';
import type { Prayer } from '../generated/prisma/enums.js';
import { audit } from '../lib/audit.js';
import { localNow, toDbDate } from '../lib/time.js';
import type { RealtimeHub } from './realtime.js';
import { prayersForDay, type PrayerKey, type SlotInput } from './rules.js';
import { publish } from './schedule.js';

/** Minutes avant l'heure officielle à partir desquelles le serveur publie */
export const AUTO_LEAD_MINS = 20;
/** Écart entre deux groupes quand il n'existe aucune publication à copier */
export const AUTO_GAP_MINS = 10;
/** Groupes publiés par défaut sans publication à copier (G1, G2) */
export const AUTO_DEFAULT_GROUPS = 2;
export const AUTO_AUTHOR = 'Publication automatique';

export type OfficialTimes = { Dhuhr: number; Asr: number };

/** Heure officielle d'une prière de groupe : Jumu'a suit l'heure de Dhuhr */
export const officialMinsFor = (prayer: PrayerKey, t: OfficialTimes): number => (prayer === 'ASR' ? t.Asr : t.Dhuhr);

/** Fenêtre de publication automatique : de 20 min avant l'heure officielle jusqu'à cette heure */
export function isAutoWindow(nowMins: number, officialMins: number): boolean {
    return nowMins >= officialMins - AUTO_LEAD_MINS && nowMins < officialMins;
}

/**
 * Horaires à publier automatiquement.
 * - Copie exacte de la dernière publication de la prière (groupes encore existants seulement).
 * - Sinon : G1 à l'heure officielle, puis +10 min par groupe (deux groupes par défaut) ; Jumu'a : heure officielle.
 */
export function autoSlots(
    prayer: PrayerKey,
    previous: SlotInput[] | null,
    groupIds: number[],
    officialMins: number
): SlotInput[] {
    if (prayer === 'JUMUA') {
        const prev = previous?.find((s) => s.groupId === null);
        return [{ groupId: null, timeMins: prev ? prev.timeMins : officialMins }];
    }
    const existing = new Set(groupIds);
    const copied = (previous ?? []).filter((s) => s.groupId !== null && existing.has(s.groupId));
    if (copied.length) return copied.map((s) => ({ groupId: s.groupId, timeMins: s.timeMins }));
    return groupIds
        .slice(0, AUTO_DEFAULT_GROUPS)
        .map((groupId, i) => ({ groupId, timeMins: Math.min(officialMins + i * AUTO_GAP_MINS, 1439) }));
}

/** Horaires officiels Dhuhr / Asr d'une ville (même source et méthode que l'application) */
export type TimesFetcher = (date: string, city: string, country: string) => Promise<OfficialTimes>;

const SALAT_METHOD = 21; // Ministère des Habous (Maroc)

export const fetchAladhan: TimesFetcher = async (date, city, country) => {
    const [y, mo, d] = date.split('-');
    const url = `https://api.aladhan.com/v1/timingsByCity/${d}-${mo}-${y}` +
        `?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&method=${SALAT_METHOD}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Aladhan HTTP ${res.status}`);
    const json: any = await res.json();
    const t = json?.data?.timings;
    const toMins = (v: unknown) => {
        const m = typeof v === 'string' ? /^(\d{1,2}):(\d{2})/.exec(v) : null;
        if (!m) throw new Error('Aladhan : horaire invalide');
        return Number(m[1]) * 60 + Number(m[2]);
    };
    return { Dhuhr: toMins(t?.Dhuhr), Asr: toMins(t?.Asr) };
};

export interface AutoPublishDeps {
    db: Db;
    hub: Pick<RealtimeHub, 'schedulePublished'>;
    offsetHours: number;
    fetchTimes?: TimesFetcher;
    log?: (msg: string, err?: unknown) => void;
    /** Horodatage de référence (tests) */
    now?: number;
}

/** Horaires officiels mis en cache par ville et par jour */
const timesCache = new Map<string, OfficialTimes>();

/**
 * Un passage du planificateur : publie les prières non publiées dont la fenêtre est ouverte.
 * Renvoie les publications faites.
 */
export async function runAutoPublish(deps: AutoPublishDeps): Promise<{ categoryId: number; prayer: PrayerKey }[]> {
    const { db, hub, offsetHours } = deps;
    const fetchTimes = deps.fetchTimes ?? fetchAladhan;
    const { date, nowMins } = localNow(offsetHours, deps.now);
    const done: { categoryId: number; prayer: PrayerKey }[] = [];
    if (prayersForDay(date, true).length === 0) return done; // week-end

    const teams = await db.team.findMany({
        include: { categories: { include: { groups: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } } } }
    });
    for (const team of teams) {
        const key = `${date}|${team.city}|${team.country}`;
        let times = timesCache.get(key);
        if (!times) {
            try {
                times = await fetchTimes(date, team.city, team.country);
                timesCache.set(key, times);
            } catch (err) {
                deps.log?.(`Horaires officiels indisponibles pour ${team.city} : publication automatique reportée.`, err);
                continue;
            }
        }
        for (const category of team.categories) {
            for (const prayer of prayersForDay(date, category.jumuaEnabled)) {
                const official = officialMinsFor(prayer, times);
                if (!isAutoWindow(nowMins, official)) continue;
                const exists = await db.publication.findUnique({
                    where: { categoryId_date_prayer: { categoryId: category.id, date: toDbDate(date), prayer: prayer as Prayer } }
                });
                if (exists) continue;
                const previous = await db.publication.findFirst({
                    where: { categoryId: category.id, prayer: prayer as Prayer, date: { lt: toDbDate(date) } },
                    orderBy: { date: 'desc' },
                    include: { slots: true }
                });
                const slots = autoSlots(prayer, previous?.slots ?? null, category.groups.map((g) => g.id), official);
                if (slots.length === 0) continue; // catégorie sans groupe
                try {
                    const result = await publish(db, { categoryId: category.id, date, prayer, slots, by: AUTO_AUTHOR });
                    await hub.schedulePublished({ categoryId: category.id, date, prayer, slots, result });
                    await audit(db, {
                        actor: 'système', action: 'schedule.auto_publish', teamId: team.id,
                        target: `${category.name} ${prayer} ${date}`,
                        details: { slots, copiedFrom: previous ? previous.date.toISOString().slice(0, 10) : null }
                    });
                    done.push({ categoryId: category.id, prayer });
                } catch (err) {
                    deps.log?.(`Publication automatique impossible (${category.name} ${prayer}).`, err);
                }
            }
        }
    }
    // Le cache ne garde que le jour courant
    for (const k of [...timesCache.keys()]) if (!k.startsWith(`${date}|`)) timesCache.delete(k);
    return done;
}

/** Vide le cache des horaires officiels (tests) */
export const clearOfficialTimesCache = (): void => timesCache.clear();

/** Démarre le planificateur (toutes les minutes) ; renvoie la fonction d'arrêt */
export function startAutoPublisher(deps: Omit<AutoPublishDeps, 'now'>, intervalMs = 60_000): () => void {
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            const done = await runAutoPublish(deps);
            if (done.length) deps.log?.(`Publication automatique : ${done.length} prière(s) publiée(s).`);
        } catch (err) {
            deps.log?.('Publication automatique : passage en échec.', err);
        } finally {
            running = false;
        }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    void tick();
    return () => clearInterval(timer);
}
