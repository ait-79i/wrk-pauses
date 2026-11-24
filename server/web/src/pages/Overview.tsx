import { useState } from 'react';
import { api, formatDay, globalStats, percent, PRAYER_LABEL, type Overview, type Prayer } from '../api';
import { Field, FormDialog, Link, Loading, useAction, useData } from '../ui';

type OverviewData = ReturnType<typeof useData<Overview>>;

/** Prières attendues aujourd'hui pour une catégorie (Jumu'a remplace Dhuhr le vendredi) */
function expectedToday(date: string, jumuaEnabled: boolean): Prayer[] {
    const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6) return [];
    return wd === 5 && jumuaEnabled ? ['JUMUA', 'ASR'] : ['DHUHR', 'ASR'];
}

export function OverviewPage({ overview, superAdmin }: { overview: OverviewData; superAdmin: boolean }) {
    const [creating, setCreating] = useState(false);
    const { run } = useAction();
    const data = overview.data;
    if (!data) return <Loading error={overview.error} />;

    const missing = data.teams.flatMap((t) => t.categories.flatMap((c) =>
        expectedToday(data.today, c.jumuaEnabled).filter((p) => !c.publishedToday.includes(p))
    )).length;

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Vue d'ensemble</h1>
                    <p className="page-sub">{formatDay(data.today)}</p>
                </div>
                {superAdmin && <button className="btn btn-primary" onClick={() => setCreating(true)}>Créer une équipe</button>}
            </div>

            <div className="stats">
                <div className="stat"><div className="stat-value">{data.totals.teams}</div><div className="stat-label">équipes</div></div>
                <div className="stat"><div className="stat-value">{data.totals.members}</div><div className="stat-label">membres</div></div>
                <div className="stat"><div className="stat-value">{data.totals.activeToday}</div><div className="stat-label">actifs ces dernières 24 h</div></div>
                <div className={`stat${missing ? ' stat-alert' : ''}`}>
                    <div className="stat-value">{missing}</div>
                    <div className="stat-label">horaires non publiés aujourd'hui</div>
                </div>
            </div>

            {data.teams.length === 0 ? (
                <div className="empty">
                    <strong>Aucune équipe pour l'instant</strong>
                    {superAdmin
                        ? 'Créez la première équipe : les catégories Hommes et Femmes, les groupes G1 et G2 et leurs codes d\'accès sont préparés automatiquement.'
                        : 'Le super admin ne vous a encore confié aucune équipe.'}
                </div>
            ) : (
                <div className="panel" style={{ padding: 0 }}>
                    {data.teams.map((t) => (
                        <Link key={t.id} to={`/equipes/${t.id}`} className="team-row">
                            <div>
                                <h3>{t.name}</h3>
                                <p className="muted small">{t.city}, {t.members} membre{t.members > 1 ? 's' : ''}</p>
                            </div>
                            <div className="team-cats">
                                {t.categories.map((c) => {
                                    const expected = expectedToday(data.today, c.jumuaEnabled);
                                    return (
                                        <span key={c.id} className="row" style={{ gap: 6 }}>
                                            <span className="small" style={{ fontWeight: 600 }}>{c.name}</span>
                                            {expected.length === 0 && <span className="badge badge-wait">week-end</span>}
                                            {expected.map((p) => c.publishedToday.includes(p)
                                                ? <span key={p} className="badge badge-live">{PRAYER_LABEL[p]} publié</span>
                                                : <span key={p} className="badge badge-wait">{PRAYER_LABEL[p]} à publier</span>)}
                                        </span>
                                    );
                                })}
                            </div>
                            <span className="muted small">Ouvrir</span>
                        </Link>
                    ))}
                </div>
            )}

            {superAdmin && data.teams.length > 0 && <GlobalStatsPanel />}

            <FormDialog
                open={creating}
                title="Créer une équipe"
                submitLabel="Créer l'équipe"
                onClose={() => setCreating(false)}
                onSubmit={async (f) => {
                    const r = await run(() => api<{ id: number }>('POST', '/teams', {
                        name: String(f.get('name')).trim(),
                        city: String(f.get('city')).trim() || undefined,
                        requireApproval: f.get('requireApproval') === 'on'
                    }), 'Équipe créée');
                    if (!r) return false;
                    overview.reload();
                }}
            >
                <Field label="Nom de l'équipe"><input className="input" name="name" required minLength={2} maxLength={80} placeholder="WeShore Marrakech" /></Field>
                <Field label="Ville" hint="Ville des horaires officiels de prière.">
                    <input className="input" name="city" defaultValue="Marrakesh" maxLength={80} />
                </Field>
                <label className="check"><input type="checkbox" name="requireApproval" /> Valider chaque nouveau membre avant son accès</label>
            </FormDialog>
        </>
    );
}

/** Super admin : activité des 7 derniers jours, toutes équipes confondues */
function GlobalStatsPanel() {
    const stats = useData(globalStats, []);
    const s = stats.data;
    // Statistiques facultatives : une erreur ici ne doit pas gêner la vue d'ensemble
    if (!s) return stats.error ? <p className="muted small" style={{ marginTop: 24 }}>Statistiques globales indisponibles : {stats.error}</p> : null;
    const maxMessages = Math.max(1, ...s.teams.map((t) => t.messages7d));

    return (
        <section className="panel" style={{ marginTop: 24 }} aria-labelledby="global-stats">
            <div className="panel-head">
                <h2 id="global-stats">Ces 7 derniers jours</h2>
                <span className="muted small">
                    {s.totals.activeMembers7d} membres actifs sur {s.totals.members}, {s.totals.messages7d} message{s.totals.messages7d > 1 ? 's' : ''}
                </span>
            </div>
            <div className="table-wrap">
                <table>
                    <thead>
                        <tr><th>Équipe</th><th>Actifs</th><th>Horaires publiés</th><th>Participation</th><th>Messages</th></tr>
                    </thead>
                    <tbody>
                        {s.teams.map((t) => (
                            <tr key={t.id}>
                                <td><Link to={`/equipes/${t.id}/statistiques`}>{t.name}</Link></td>
                                <td className="tabular">{t.activeMembers7d} <span className="muted small">sur {t.members}</span></td>
                                <td><RateBar rate={t.publicationRate7d} /></td>
                                <td><RateBar rate={t.participationRate7d} /></td>
                                <td>
                                    <div className="inline-bar">
                                        <span className="inline-bar-fill" style={{ width: `${(t.messages7d / maxMessages) * 100}%` }} />
                                        <span className="tabular">{t.messages7d}</span>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

function RateBar({ rate }: { rate: number }) {
    const v = Math.max(0, Math.min(1, rate));
    return (
        <div className="inline-bar">
            <span className="inline-bar-fill" style={{ width: `${v * 100}%` }} />
            <span className="tabular">{percent(v)}</span>
        </div>
    );
}
