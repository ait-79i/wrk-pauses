// Horaires du jour : l'écran principal des admins. Chaque prière est présentée comme
// les messages d'horaires postés jusqu'ici dans la discussion (« صلاة الظهر — G1 : 12:26 »),
// avec l'effectif de chaque groupe à la place des réactions.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
    api, formatDay, hhmmToMins, minsToHHMM, nextWorkdays, PRAYER_ARABIC, PRAYER_LABEL,
    type DayPrayer, type DayView, type TeamDetail
} from '../api';
import { useRealtime } from '../realtime';
import { Loading, useAction, useData } from '../ui';

export function ScheduleTab({ team }: { team: TeamDetail }) {
    const categories = team.categories;
    const [categoryId, setCategoryId] = useState(categories[0]?.id ?? 0);
    const [date, setDate] = useState<string | null>(null);
    const category = categories.find((c) => c.id === categoryId);

    const day = useData(
        () => api<DayView>('GET', `/categories/${categoryId}/day${date ? `?date=${date}` : ''}`),
        [categoryId, date]
    );

    // Rafraîchit les effectifs toutes les 30 s pendant que l'écran est ouvert (filet de sécurité)
    useEffect(() => {
        const t = setInterval(() => day.reload(), 30_000);
        return () => clearInterval(t);
    }, [day.reload]);

    // Et dès qu'un événement temps réel touche cette catégorie (regroupés sur 800 ms)
    const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);
    useRealtime((e) => {
        const concerned =
            (e.type === 'schedule.changed' && e.categoryId === categoryId) ||
            ((e.type === 'message.created' || e.type === 'message.updated') && e.message.channel === `cat:${categoryId}`) ||
            e.type === 'ready';
        if (!concerned || pending.current) return;
        pending.current = setTimeout(() => {
            pending.current = null;
            day.reload();
        }, 800);
    });

    if (categories.length === 0) {
        return <div className="empty"><strong>Aucune catégorie</strong>Créez une catégorie dans l'onglet Catégories et groupes.</div>;
    }
    const d = day.data;
    const days = d ? nextWorkdays(d.today, 5) : [];

    return (
        <div className="stack">
            <div className="row">
                <div className="day-picker" role="group" aria-label="Catégorie">
                    {categories.map((c) => (
                        <button key={c.id} className="day-chip" aria-pressed={c.id === categoryId} onClick={() => setCategoryId(c.id)}>
                            {c.name}
                        </button>
                    ))}
                </div>
                <span className="spacer" />
                <div className="day-picker" role="group" aria-label="Jour">
                    {days.map((x) => (
                        <button key={x} className="day-chip" aria-pressed={(date ?? d?.today) === x} onClick={() => setDate(x)}>
                            {x === d?.today ? 'Aujourd\'hui' : formatDay(x).split(' ').slice(0, 2).join(' ')}
                        </button>
                    ))}
                </div>
            </div>

            {!d ? <Loading error={day.error} /> : (
                <>
                    <p className="muted">
                        {formatDay(d.date)}
                        {!d.isWorkday && ' : pas de prière en groupe le week-end.'}
                    </p>
                    {d.isWorkday && (
                        <div className="prayer-grid">
                            {d.prayers.map((p) => (
                                <PrayerCard
                                    key={`${d.category.id}-${d.date}-${p.prayer}`}
                                    day={d}
                                    prayer={p}
                                    canPublish={Boolean(category?.canPublish)}
                                    onPublished={(v) => day.setData({ ...v, previous: d.previous })}
                                />
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

interface Row { groupId: number | null; name: string; enabled: boolean; time: string; count: number }

function buildRows(day: DayView, prayer: DayPrayer): Row[] {
    const previous = day.previous?.find((x) => x.prayer === prayer.prayer);
    if (prayer.prayer === 'JUMUA') {
        const slot = prayer.slots[0] ?? previous?.slots[0];
        return [{ groupId: null, name: 'Jumu\'a', enabled: true, time: slot ? minsToHHMM(slot.timeMins) : '', count: prayer.slots[0]?.count ?? 0 }];
    }
    return day.groups.map((g) => {
        const published = prayer.slots.find((s) => s.groupId === g.id);
        const prev = previous?.slots.find((s) => s.groupId === g.id);
        const source = prayer.published ? published : prev;
        return {
            groupId: g.id,
            name: g.name,
            // Préremplissage : publication du jour, sinon la dernière publiée
            enabled: prayer.published ? Boolean(published) : Boolean(prev) || (!previous && day.groups.indexOf(g) < 2),
            time: source ? minsToHHMM(source.timeMins) : '',
            count: published?.count ?? 0
        };
    });
}

function PrayerCard({ day, prayer, canPublish, onPublished }: {
    day: DayView; prayer: DayPrayer; canPublish: boolean; onPublished: (v: DayView) => void;
}) {
    const initial = useMemo(() => buildRows(day, prayer), [day, prayer]);
    const [rows, setRows] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const { run, busy } = useAction();
    const edited = useRef(false);
    // Rechargement : garde la saisie en cours, ne met à jour que les effectifs
    useEffect(() => {
        if (!edited.current) return setRows(initial);
        setRows((cur) => cur.map((r) => ({ ...r, count: initial.find((x) => x.groupId === r.groupId)?.count ?? r.count })));
    }, [initial]);
    const edit = (next: Row[]) => {
        edited.current = true;
        setRows(next);
    };

    const strip = (list: Row[]) => JSON.stringify(list.map(({ count: _count, ...r }) => r));
    const dirty = strip(rows) !== strip(initial);
    const isToday = day.date === day.today;

    async function submit() {
        setError(null);
        const chosen = rows.filter((r) => r.enabled);
        if (chosen.length === 0) return setError('Activez au moins un groupe.');
        if (chosen.some((r) => !/^\d{2}:\d{2}$/.test(r.time))) return setError('Indiquez l\'heure de chaque groupe activé.');
        if (isToday && !prayer.published && chosen.some((r) => hhmmToMins(r.time) <= day.nowMins)) {
            return setError('Une des heures est déjà passée.');
        }
        const result = await run(() => api<DayView>('POST', `/categories/${day.category.id}/publish`, {
            date: day.date,
            prayer: prayer.prayer,
            slots: chosen.map((r) => ({ groupId: r.groupId, time: r.time }))
        }), prayer.published ? 'Horaires mis à jour' : 'Horaires publiés');
        if (result) {
            edited.current = false;
            onPublished(result);
        }
    }

    const total = rows.reduce((n, r) => n + (r.enabled ? r.count : 0), 0);

    return (
        <section className={`prayer-card${prayer.published ? ' is-published' : ''}`} aria-label={PRAYER_LABEL[prayer.prayer]}>
            <header className="prayer-card-head">
                <div>
                    <div className="prayer-arabic" lang="ar" dir="rtl">{PRAYER_ARABIC[prayer.prayer]}</div>
                    <div className="prayer-latin">{PRAYER_LABEL[prayer.prayer]}</div>
                </div>
                {prayer.published
                    ? <span className="badge badge-live">Publié</span>
                    : <span className="badge" style={{ color: '#fff', background: 'rgba(255,255,255,0.15)' }}>Non publié</span>}
            </header>

            <div className="slot-list">
                {rows.map((r, i) => (
                    <div key={r.groupId ?? 'jumua'} className={`slot${r.enabled ? '' : ' is-off'}`}>
                        {prayer.prayer === 'JUMUA' ? <span className="slot-name">—</span> : (
                            <label className="check slot-name">
                                <input
                                    type="checkbox"
                                    checked={r.enabled}
                                    disabled={!canPublish}
                                    aria-label={`Publier un horaire pour ${r.name}`}
                                    onChange={(e) => edit(rows.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))}
                                />
                                {r.name}
                            </label>
                        )}
                        <input
                            type="time"
                            className="slot-time"
                            value={r.time}
                            disabled={!canPublish || !r.enabled}
                            aria-label={`Heure de ${r.name}`}
                            onChange={(e) => edit(rows.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))}
                        />
                        <span className="slot-count" title="Membres qui prient avec ce groupe">
                            {prayer.published && r.enabled ? <span className="slot-count-pill">{r.count}</span> : <span className="muted">—</span>}
                        </span>
                    </div>
                ))}
            </div>

            <footer className="prayer-card-foot">
                <span className="muted small">
                    {prayer.published
                        ? `Par ${prayer.publishedBy}, ${prayer.prayer === 'JUMUA' ? `${total} membres` : `${total} inscrit${total > 1 ? 's' : ''}`}`
                        : 'Les membres reçoivent ces horaires dès la publication.'}
                </span>
                {canPublish && (
                    <button className="btn btn-primary" onClick={submit} disabled={busy || (prayer.published && !dirty)}>
                        {prayer.published ? 'Mettre à jour' : 'Publier'}
                    </button>
                )}
            </footer>
            {error && <p className="form-error" role="alert" style={{ margin: '0 20px 16px' }}>{error}</p>}
        </section>
    );
}
