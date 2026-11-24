// Horaires du jour, publication et choix de groupe (accès base de données).
// Les règles elles-mêmes sont dans rules.ts.

import type { Db } from '../db.js';
import type { Prayer } from '../generated/prisma/enums.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { fromDbDate, isWorkday, toDbDate } from '../lib/time.js';
import {
    choiceChangeError,
    effectiveGroup,
    hasGroupChoice,
    prayersForDay,
    publicationError,
    type PrayerKey,
    type SlotInput
} from './rules.js';

export interface DaySlot {
    groupId: number | null;
    groupName: string | null;
    timeMins: number;
    /** Membres de la catégorie qui prient avec ce groupe */
    count: number;
}

export interface DayPrayer {
    prayer: PrayerKey;
    published: boolean;
    publishedAt: string | null;
    publishedBy: string | null;
    slots: DaySlot[];
    /** Groupe effectif du membre (null : aucun) ; absent pour une vue d'admin */
    myGroupId?: number | null;
    /** Le membre a fait un choix explicite ce jour-là (sinon : groupe habituel appliqué) */
    myChoiceIsExplicit?: boolean;
    usualGroupId?: number | null;
}

export interface DayView {
    date: string;
    isWorkday: boolean;
    category: { id: number; name: string; jumuaEnabled: boolean };
    groups: { id: number; name: string }[];
    prayers: DayPrayer[];
}

/**
 * Vue d'une journée pour une catégorie : horaires publiés, effectif de chaque groupe et,
 * si memberId est fourni, le choix de ce membre.
 */
export async function getDayView(db: Db, categoryId: number, date: string, memberId?: number): Promise<DayView> {
    const category = await db.category.findUnique({
        where: { id: categoryId },
        include: { groups: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } }
    });
    if (!category) throw notFound('Catégorie introuvable.');

    const prayers = prayersForDay(date, category.jumuaEnabled);
    const dbDate = toDbDate(date);
    const [publications, members, choices, usuals] = await Promise.all([
        db.publication.findMany({ where: { categoryId, date: dbDate }, include: { slots: true } }),
        db.member.findMany({ where: { categoryId, status: 'ACTIVE' }, select: { id: true } }),
        db.groupChoice.findMany({ where: { date: dbDate, member: { categoryId } } }),
        db.usualGroup.findMany({ where: { member: { categoryId, status: 'ACTIVE' } } })
    ]);
    const groupName = new Map(category.groups.map((g) => [g.id, g.name]));
    const groupOrder = new Map(category.groups.map((g, i) => [g.id, i]));

    const view: DayView = {
        date,
        isWorkday: isWorkday(date),
        category: { id: category.id, name: category.name, jumuaEnabled: category.jumuaEnabled },
        groups: category.groups.map((g) => ({ id: g.id, name: g.name })),
        prayers: []
    };

    for (const prayer of prayers) {
        const pub = publications.find((p) => p.prayer === prayer);
        const slots = (pub?.slots ?? [])
            .slice()
            .sort((a, b) => (groupOrder.get(a.groupId ?? -1) ?? -1) - (groupOrder.get(b.groupId ?? -1) ?? -1));
        const published = new Set(slots.flatMap((s) => (s.groupId === null ? [] : [s.groupId])));

        // Effectif : choix explicite du jour, à défaut groupe habituel publié
        const explicitByMember = new Map<number, number | null>();
        for (const c of choices) if (c.prayer === prayer) explicitByMember.set(c.memberId, c.groupId);
        const usualByMember = new Map<number, number>();
        if (hasGroupChoice(prayer)) for (const u of usuals) if (u.prayer === prayer) usualByMember.set(u.memberId, u.groupId);

        const counts = new Map<number, number>();
        if (hasGroupChoice(prayer)) {
            for (const m of members) {
                const g = effectiveGroup(explicitByMember.get(m.id), usualByMember.get(m.id) ?? null, published);
                if (g !== null) counts.set(g, (counts.get(g) ?? 0) + 1);
            }
        }

        const entry: DayPrayer = {
            prayer,
            published: Boolean(pub),
            publishedAt: pub ? pub.updatedAt.toISOString() : null,
            publishedBy: pub ? pub.publishedBy : null,
            slots: slots.map((s) => ({
                groupId: s.groupId,
                groupName: s.groupId === null ? null : groupName.get(s.groupId) ?? null,
                timeMins: s.timeMins,
                count: s.groupId === null ? members.length : counts.get(s.groupId) ?? 0
            }))
        };
        if (memberId !== undefined && hasGroupChoice(prayer)) {
            const explicit = explicitByMember.get(memberId);
            entry.myGroupId = effectiveGroup(explicit, usualByMember.get(memberId) ?? null, published);
            entry.myChoiceIsExplicit = explicit !== undefined;
            entry.usualGroupId = usualByMember.get(memberId) ?? null;
        }
        view.prayers.push(entry);
    }
    return view;
}

export interface PublishInput {
    categoryId: number;
    date: string;
    prayer: PrayerKey;
    slots: SlotInput[];
    /** Nom affiché de l'auteur (membre ou admin) */
    by: string;
}

export interface PublishResult {
    created: boolean;
    /** Groupes dont l'heure a changé (pour prévenir leurs membres) */
    movedGroupIds: number[];
    /** Groupes retirés : leurs choix explicites sont effacés */
    removedGroupIds: number[];
    /** Groupes ajoutés par une mise à jour */
    addedGroupIds: number[];
    /** Faux quand une mise à jour reprend exactement les mêmes horaires (rien à annoncer) */
    changed: boolean;
}

/** Publie (ou corrige) les horaires du jour d'une prière pour une catégorie */
export async function publish(db: Db, input: PublishInput): Promise<PublishResult> {
    const category = await db.category.findUnique({ where: { id: input.categoryId }, include: { groups: true } });
    if (!category) throw notFound('Catégorie introuvable.');
    const error = publicationError(
        input.date,
        input.prayer,
        category.jumuaEnabled,
        input.slots,
        new Set(category.groups.map((g) => g.id))
    );
    if (error) throw badRequest(error, 'invalid_publication');

    const dbDate = toDbDate(input.date);
    return db.$transaction(async (tx) => {
        const existing = await tx.publication.findUnique({
            where: { categoryId_date_prayer: { categoryId: input.categoryId, date: dbDate, prayer: input.prayer as Prayer } },
            include: { slots: true }
        });
        const before = new Map((existing?.slots ?? []).map((s) => [s.groupId, s.timeMins]));
        const after = new Map(input.slots.map((s) => [s.groupId, s.timeMins]));

        const pub = existing
            ? await tx.publication.update({ where: { id: existing.id }, data: { publishedBy: input.by.slice(0, 80) } })
            : await tx.publication.create({
                data: { categoryId: input.categoryId, date: dbDate, prayer: input.prayer as Prayer, publishedBy: input.by.slice(0, 80) }
            });
        await tx.publicationSlot.deleteMany({ where: { publicationId: pub.id } });
        await tx.publicationSlot.createMany({
            data: input.slots.map((s) => ({ publicationId: pub.id, groupId: s.groupId, timeMins: s.timeMins }))
        });

        const removedGroupIds = [...before.keys()].filter((g): g is number => g !== null && !after.has(g));
        const movedGroupIds = [...after.entries()]
            .filter(([g, t]) => g !== null && before.has(g) && before.get(g) !== t)
            .map(([g]) => g as number);
        const addedGroupIds = existing
            ? [...after.keys()].filter((g): g is number => g !== null && !before.has(g))
            : [];
        const changed = !existing || before.size !== after.size
            || [...after.entries()].some(([g, t]) => !before.has(g) || before.get(g) !== t);
        if (removedGroupIds.length) {
            await tx.groupChoice.deleteMany({
                where: { date: dbDate, prayer: input.prayer as Prayer, groupId: { in: removedGroupIds } }
            });
        }
        return { created: !existing, movedGroupIds, removedGroupIds, addedGroupIds, changed };
    });
}

export interface ChooseInput {
    memberId: number;
    categoryId: number;
    date: string;
    prayer: PrayerKey;
    /** Groupe choisi, ou null pour « aucun groupe ce jour-là » */
    groupId: number | null;
    today: string;
    nowMins: number;
}

/** Enregistre le choix de groupe d'un membre */
export async function choose(db: Db, input: ChooseInput): Promise<void> {
    if (!hasGroupChoice(input.prayer)) throw badRequest('Jumu\'a n\'a pas de choix de groupe.');
    const dbDate = toDbDate(input.date);
    const pub = await db.publication.findUnique({
        where: { categoryId_date_prayer: { categoryId: input.categoryId, date: dbDate, prayer: input.prayer as Prayer } },
        include: { slots: true }
    });
    if (!pub) throw conflict('Les horaires de cette prière ne sont pas encore publiés.', 'not_published');

    const timeOf = new Map(pub.slots.map((s) => [s.groupId, s.timeMins]));
    if (input.groupId !== null && !timeOf.has(input.groupId)) {
        throw badRequest('Ce groupe n\'a pas d\'horaire aujourd\'hui.');
    }

    const [explicit, usual] = await Promise.all([
        db.groupChoice.findUnique({
            where: { memberId_date_prayer: { memberId: input.memberId, date: dbDate, prayer: input.prayer as Prayer } }
        }),
        db.usualGroup.findUnique({ where: { memberId_prayer: { memberId: input.memberId, prayer: input.prayer as Prayer } } })
    ]);
    const published = new Set([...timeOf.keys()].filter((g): g is number => g !== null));
    const current = effectiveGroup(explicit ? explicit.groupId : undefined, usual?.groupId ?? null, published);

    const error = choiceChangeError({
        date: input.date,
        today: input.today,
        nowMins: input.nowMins,
        currentTimeMins: current === null ? null : timeOf.get(current) ?? null,
        targetTimeMins: input.groupId === null ? null : timeOf.get(input.groupId) ?? null
    });
    if (error) throw conflict(error, 'choice_locked');

    await db.groupChoice.upsert({
        where: { memberId_date_prayer: { memberId: input.memberId, date: dbDate, prayer: input.prayer as Prayer } },
        create: { memberId: input.memberId, date: dbDate, prayer: input.prayer as Prayer, groupId: input.groupId },
        update: { groupId: input.groupId }
    });
}

/** Définit (ou retire) le groupe habituel d'un membre pour Dhuhr ou Asr */
export async function setUsualGroup(
    db: Db,
    member: { id: number; categoryId: number },
    prayer: PrayerKey,
    groupId: number | null
): Promise<void> {
    if (!hasGroupChoice(prayer)) throw badRequest('Jumu\'a n\'a pas de groupe habituel.');
    if (groupId === null) {
        await db.usualGroup.deleteMany({ where: { memberId: member.id, prayer: prayer as Prayer } });
        return;
    }
    const group = await db.group.findFirst({ where: { id: groupId, categoryId: member.categoryId } });
    if (!group) throw badRequest('Ce groupe n\'appartient pas à votre catégorie.');
    await db.usualGroup.upsert({
        where: { memberId_prayer: { memberId: member.id, prayer: prayer as Prayer } },
        create: { memberId: member.id, prayer: prayer as Prayer, groupId },
        update: { groupId }
    });
}

export { fromDbDate };
