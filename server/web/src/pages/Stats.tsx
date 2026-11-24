// Statistiques d'une équipe : publication des horaires et participation, par catégorie et par jour.
// Graphiques en SVG simple, sans bibliothèque.

import { useState } from 'react';
import {
    formatDay, localDate, minsToHHMM, percent, PRAYER_LABEL, teamStats,
    type TeamDetail, type TeamStats
} from '../api';
import { Loading, useData } from '../ui';

const PRESETS = [7, 30, 90] as const;

type Day = TeamStats['days'][number];

export function StatsTab({ team }: { team: TeamDetail }) {
    const [range, setRange] = useState<(typeof PRESETS)[number]>(30);
    const from = localDate(-(range - 1));
    const to = localDate(0);
    const stats = useData(() => teamStats(team.id, from, to), [team.id, from, to]);
    // Données d'une autre période (chargement ou échec en cours) : jamais affichées comme celles demandées
    const s = stats.data && stats.data.from === from && stats.data.to === to ? stats.data : null;

    return (
        <div className="stack">
            <div className="row">
                <div className="day-picker" role="group" aria-label="Période">
                    {PRESETS.map((n) => (
                        <button key={n} className="day-chip" aria-pressed={range === n} onClick={() => setRange(n)}>
                            {n} jours
                        </button>
                    ))}
                </div>
                <span className="spacer" />
                {s && <span className="muted small">Du {formatDay(s.from)} au {formatDay(s.to)}</span>}
            </div>

            {!s ? <Loading error={stats.error} /> : s.categories.length === 0 ? (
                <div className="empty">
                    <strong>Aucune catégorie</strong>
                    Créez une catégorie dans l'onglet Catégories et groupes, puis publiez ses horaires : les statistiques apparaîtront ici.
                </div>
            ) : (
                <>
                    <div className="stat-cards">
                        {s.categories.map((c) => (
                            <section key={c.id} className="panel stat-card" aria-label={c.name}>
                                <h2>{c.name}</h2>
                                <div className="stat-pair">
                                    <div><div className="stat-value">{c.members}</div><div className="stat-label">membres</div></div>
                                    <div><div className="stat-value">{c.activeMembers7d}</div><div className="stat-label">actifs ces 7 jours</div></div>
                                </div>
                                <Meter label="Horaires publiés" rate={c.publicationRate} hint="Prières publiées sur les prières attendues des jours ouvrés" />
                                <Meter label="Participation" rate={c.participationRate} hint="Inscrits sur membres actifs, en moyenne par prière publiée avec choix de groupe (Jumu'a non comptée)" />
                            </section>
                        ))}
                    </div>

                    <p className="muted small hint">
                        Effectifs estimés : un membre qui n'a pas choisi de groupe un jour donné est compté dans son groupe habituel actuel.
                    </p>

                    {s.categories.map((c) => (
                        <CategoryDetail
                            key={c.id}
                            name={c.name}
                            days={s.days.filter((d) => d.categoryId === c.id)}
                            groups={s.groups.filter((g) => g.categoryId === c.id)}
                        />
                    ))}
                </>
            )}
        </div>
    );
}

function Meter({ label, rate, hint }: { label: string; rate: number; hint: string }) {
    const value = Math.max(0, Math.min(1, rate));
    return (
        <div className="meter" title={hint}>
            <div className="meter-head">
                <span className="small">{label}</span>
                <strong className="tabular">{percent(value)}</strong>
            </div>
            <div className="meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
                <div className="meter-fill" style={{ width: `${value * 100}%` }} />
            </div>
        </div>
    );
}

interface DayRow { date: string; midday: Day | undefined; asr: Day | undefined }

function CategoryDetail({ name, days, groups }: { name: string; days: Day[]; groups: TeamStats['groups'] }) {
    const dates = [...new Set(days.map((d) => d.date))].sort();
    const rows: DayRow[] = dates.map((date) => ({
        date,
        midday: days.find((d) => d.date === date && (d.prayer === 'DHUHR' || d.prayer === 'JUMUA')),
        asr: days.find((d) => d.date === date && d.prayer === 'ASR')
    }));
    const max = Math.max(1, ...days.map((d) => d.total));
    const maxGroup = Math.max(1, ...groups.map((g) => g.averageCount));

    return (
        <section className="panel stack" aria-label={`Fréquentation ${name}`}>
            <div className="panel-head" style={{ marginBottom: 0 }}>
                <h2>Fréquentation, {name}</h2>
                <div className="legend small">
                    <span><i className="swatch swatch-midday" /> Dhuhr ou Jumu'a</span>
                    <span><i className="swatch swatch-asr" /> Asr</span>
                </div>
            </div>

            {rows.length === 0 ? <p className="muted">Aucune prière attendue sur cette période.</p> : (
                <DayChart rows={rows} max={max} />
            )}

            {groups.length > 0 && (
                <div className="table-wrap">
                    <table>
                        <thead><tr><th>Groupe</th><th>Inscrits en moyenne</th><th>Heure moyenne</th></tr></thead>
                        <tbody>
                            {groups.map((g) => (
                                <tr key={g.groupId}>
                                    <td><strong>{g.name}</strong></td>
                                    <td>
                                        <div className="inline-bar">
                                            <span className="inline-bar-fill" style={{ width: `${(g.averageCount / maxGroup) * 100}%` }} />
                                            <span className="tabular">{g.averageCount.toLocaleString('fr-FR', { maximumFractionDigits: 1 })}</span>
                                        </div>
                                    </td>
                                    <td className="tabular">{g.averageTimeMins === null ? <span className="muted">—</span> : minsToHHMM(Math.round(g.averageTimeMins))}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {rows.length > 0 && (
                <details className="day-details">
                    <summary>Détail par jour</summary>
                    <div className="table-wrap">
                        <table>
                            <thead><tr><th>Jour</th><th>Dhuhr ou Jumu'a</th><th>Asr</th></tr></thead>
                            <tbody>
                                {[...rows].reverse().map((r) => (
                                    <tr key={r.date}>
                                        <td>{formatDay(r.date)}</td>
                                        <td><DayCell day={r.midday} /></td>
                                        <td><DayCell day={r.asr} /></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </details>
            )}
        </section>
    );
}

function DayCell({ day }: { day: Day | undefined }) {
    if (!day) return <span className="muted">—</span>;
    if (!day.published) return <span className="badge badge-wait">non publié</span>;
    const detail = day.slots.map((s) => `${s.groupName ?? PRAYER_LABEL[day.prayer]} ${minsToHHMM(s.timeMins)} : ${s.count}`).join(', ');
    return (
        <span title={detail}>
            <strong className="tabular">{day.total}</strong>
            <span className="muted small"> inscrit{day.total > 1 ? 's' : ''}{day.prayer === 'JUMUA' ? ', Jumu\'a' : ''}</span>
        </span>
    );
}

/** Colonnes groupées par jour : midi (Dhuhr/Jumu'a) puis Asr. Un trait pointillé marque une prière non publiée. */
function DayChart({ rows, max }: { rows: DayRow[]; max: number }) {
    const H = 120;
    const step = 24;
    const bar = 9;
    const width = rows.length * step;
    const y = (v: number) => H - (v / max) * (H - 4);
    const label = (i: number) => formatDay(rows[i].date).split(' ').slice(0, 3).join(' ');
    const ticks = rows.length <= 2 ? rows.map((_, i) => i) : [0, Math.floor((rows.length - 1) / 2), rows.length - 1];

    const mark = (d: Day | undefined, x: number, cls: string, key: string) => {
        if (!d) return null;
        const title = `${formatDay(d.date)}, ${PRAYER_LABEL[d.prayer]} : ${d.published ? `${d.total} inscrit${d.total > 1 ? 's' : ''}` : 'non publié'}`;
        if (!d.published) {
            return <line key={key} className="chart-missing" x1={x} x2={x + bar} y1={H - 1} y2={H - 1}><title>{title}</title></line>;
        }
        const top = y(d.total);
        return <rect key={key} className={cls} x={x} y={top} width={bar} height={Math.max(H - top, d.total > 0 ? 2 : 0)} rx={2}><title>{title}</title></rect>;
    };

    return (
        <figure className="chart">
            <div className="chart-scale small muted"><span className="tabular">{max}</span><span className="tabular">0</span></div>
            <div className="chart-plot">
                <svg viewBox={`0 0 ${width} ${H}`} preserveAspectRatio="none" role="img" aria-label="Inscrits par jour et par prière">
                    <line className="chart-axis" x1={0} x2={width} y1={H - 0.5} y2={H - 0.5} />
                    <line className="chart-grid" x1={0} x2={width} y1={4.5} y2={4.5} />
                    {rows.map((r, i) => {
                        const x = i * step + (step - bar * 2 - 2) / 2;
                        return (
                            <g key={r.date}>
                                {mark(r.midday, x, 'chart-bar-midday', 'm')}
                                {mark(r.asr, x + bar + 2, 'chart-bar-asr', 'a')}
                            </g>
                        );
                    })}
                </svg>
                <div className="chart-x small muted">
                    {ticks.map((i) => <span key={i}>{label(i)}</span>)}
                </div>
            </div>
        </figure>
    );
}
