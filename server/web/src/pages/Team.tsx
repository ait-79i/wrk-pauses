import { useContext, useState } from 'react';
import { api, type TeamDetail } from '../api';
import { Field, FormDialog, Loading, NavContext, useAction, useData } from '../ui';
import { CategoriesTab } from './Categories';
import { DiscussionTab } from './Discussion';
import { MembersTab } from './Members';
import { ScheduleTab } from './Schedule';
import { StatsTab } from './Stats';

const TABS = [
    { id: 'horaires', label: 'Horaires du jour' },
    { id: 'discussion', label: 'Discussion' },
    { id: 'membres', label: 'Membres' },
    { id: 'statistiques', label: 'Statistiques' },
    { id: 'categories', label: 'Catégories et groupes' },
    { id: 'reglages', label: 'Réglages' }
] as const;

export function TeamPage({ teamId, tab, superAdmin }: { teamId: number; tab: string; superAdmin: boolean }) {
    const navigate = useContext(NavContext);
    const team = useData(() => api<TeamDetail>('GET', `/teams/${teamId}`), [teamId]);
    const t = team.data;
    if (!t) return <Loading error={team.error} />;

    const pending = t.members.filter((m) => m.status === 'PENDING').length;
    const visibleTabs = TABS.filter((x) => x.id !== 'reglages' || t.canManageTeam);
    const current = visibleTabs.some((x) => x.id === tab) ? tab : 'horaires';

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>{t.name}</h1>
                    <p className="page-sub">{t.city}, {t.members.length} membre{t.members.length > 1 ? 's' : ''}</p>
                </div>
            </div>

            <div className="tabs" role="tablist">
                {visibleTabs.map((x) => (
                    <button
                        key={x.id}
                        role="tab"
                        className="tab"
                        aria-selected={current === x.id}
                        onClick={() => navigate(`/equipes/${teamId}/${x.id}`)}
                    >
                        {x.label}
                        {x.id === 'membres' && pending > 0 && <span className="badge badge-live" style={{ marginLeft: 8 }}>{pending} en attente</span>}
                    </button>
                ))}
            </div>

            {current === 'horaires' && <ScheduleTab team={t} />}
            {current === 'discussion' && <DiscussionTab team={t} />}
            {current === 'statistiques' && <StatsTab team={t} />}
            {current === 'membres' && <MembersTab team={t} superAdmin={superAdmin} reload={team.reload} />}
            {current === 'categories' && <CategoriesTab team={t} reload={team.reload} />}
            {current === 'reglages' && <SettingsTab team={t} superAdmin={superAdmin} reload={team.reload} />}
        </>
    );
}

function SettingsTab({ team, superAdmin, reload }: { team: TeamDetail; superAdmin: boolean; reload: () => void }) {
    const navigate = useContext(NavContext);
    const { run, busy } = useAction();
    const [deleting, setDeleting] = useState(false);

    return (
        <div className="stack" style={{ maxWidth: 560 }}>
            <form
                className="panel stack"
                onSubmit={async (e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    const ok = await run(() => api('PATCH', `/teams/${team.id}`, {
                        name: String(f.get('name')).trim(),
                        city: String(f.get('city')).trim(),
                        country: String(f.get('country')).trim(),
                        requireApproval: f.get('requireApproval') === 'on'
                    }), 'Réglages enregistrés');
                    if (ok) reload();
                }}
            >
                <h2>Équipe</h2>
                <Field label="Nom"><input className="input" name="name" defaultValue={team.name} required minLength={2} maxLength={80} /></Field>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                        <Field label="Ville" hint="Horaires officiels de prière de l'équipe.">
                            <input className="input" name="city" defaultValue={team.city} required maxLength={80} />
                        </Field>
                    </div>
                    <div style={{ width: 96 }}>
                        <Field label="Pays"><input className="input" name="country" defaultValue={team.country} required maxLength={2} /></Field>
                    </div>
                </div>
                <label className="check">
                    <input type="checkbox" name="requireApproval" defaultChecked={team.requireApproval} />
                    Valider chaque nouveau membre avant son accès
                </label>
                <div><button className="btn btn-primary" disabled={busy}>Enregistrer</button></div>
            </form>

            {superAdmin && (
                <div className="panel stack">
                    <h2>Supprimer l'équipe</h2>
                    <p className="muted">Supprime ses catégories, groupes, membres et horaires. Le journal d'activité est conservé.</p>
                    <div><button className="btn btn-danger" onClick={() => setDeleting(true)}>Supprimer l'équipe…</button></div>
                </div>
            )}

            <FormDialog
                open={deleting}
                danger
                title={`Supprimer « ${team.name} » ?`}
                submitLabel="Supprimer définitivement"
                onClose={() => setDeleting(false)}
                onSubmit={async (f) => {
                    if (String(f.get('confirm')).trim() !== team.name) return false;
                    const ok = await run(() => api('DELETE', `/teams/${team.id}`), 'Équipe supprimée');
                    if (!ok) return false;
                    navigate('/');
                }}
            >
                <p>Cette action est définitive. Ses {team.members.length} membres perdront l'accès dans l'application.</p>
                <Field label={`Tapez « ${team.name} » pour confirmer`}><input className="input" name="confirm" required autoComplete="off" /></Field>
            </FormDialog>
        </div>
    );
}
