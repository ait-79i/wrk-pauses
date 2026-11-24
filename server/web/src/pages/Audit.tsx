import { useEffect, useState } from 'react';
import { api, type AuditRow, type Overview } from '../api';
import { Loading, useAction } from '../ui';

const ACTIONS: Record<string, string> = {
    'team.create': 'a créé l\'équipe',
    'team.update': 'a modifié l\'équipe',
    'team.delete': 'a supprimé l\'équipe',
    'category.create': 'a créé la catégorie',
    'category.update': 'a modifié la catégorie',
    'category.delete': 'a supprimé la catégorie',
    'group.create': 'a ajouté le groupe',
    'group.rename': 'a renommé le groupe',
    'group.delete': 'a supprimé le groupe',
    'code.create': 'a généré un code pour',
    'code.revoke': 'a révoqué le code',
    'schedule.publish': 'a publié les horaires',
    'schedule.update': 'a modifié les horaires',
    'member.join': 'a rejoint',
    'member.leave': 'a quitté l\'équipe',
    'member.transfer': 'a transféré son compte sur un autre ordinateur',
    'member.transfer_code': 'a généré un code de transfert pour',
    'member.update': 'a modifié le membre',
    'member.block': 'a bloqué',
    'member.activate': 'a validé ou débloqué',
    'member.delete': 'a supprimé le membre',
    'member.roles': 'a changé les rôles de',
    'account.create': 'a créé un accès admin pour',
    'account.create_superadmin': 'a créé le super admin',
    'account.update': 'a modifié le compte',
    'account.delete': 'a supprimé le compte',
    'admin.totp_enabled': 'a activé la double authentification',
    'admin.password_changed': 'a changé son mot de passe'
};

const fmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** « admin:x@y » → « x@y », « membre:Azedine » → « Azedine » */
const actorName = (actor: string) => actor.replace(/^(admin|membre):/, '');

export function AuditPage({ teams }: { teams: Overview['teams'] }) {
    const [teamId, setTeamId] = useState<number | ''>('');
    const [rows, setRows] = useState<AuditRow[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const { run, busy } = useAction();
    const teamName = (id: number | null) => teams.find((t) => t.id === id)?.name;

    const load = async (before?: number) => {
        const qs = new URLSearchParams({ limit: '50' });
        if (teamId) qs.set('teamId', String(teamId));
        if (before) qs.set('before', String(before));
        return api<AuditRow[]>('GET', `/audit?${qs}`);
    };

    useEffect(() => {
        setRows(null);
        setDone(false);
        load().then((r) => { setRows(r); setDone(r.length < 50); }).catch((e) => setError(e.message));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [teamId]);

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Journal d'activité</h1>
                    <p className="page-sub">Toutes les actions d'administration, conservées un an.</p>
                </div>
                <select className="select" style={{ width: 'auto' }} value={teamId} aria-label="Filtrer par équipe"
                    onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : '')}>
                    <option value="">Toutes les équipes</option>
                    {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
            </div>

            {!rows ? <Loading error={error} /> : rows.length === 0 ? (
                <div className="empty"><strong>Aucune activité</strong>Les actions des admins et des membres apparaîtront ici.</div>
            ) : (
                <div className="panel table-wrap">
                    <table>
                        <thead><tr><th>Quand</th><th>Qui</th><th>Action</th><th>Équipe</th></tr></thead>
                        <tbody>
                            {rows.map((r) => (
                                <tr key={r.id}>
                                    <td className="muted small" style={{ whiteSpace: 'nowrap' }}>{fmt.format(new Date(r.createdAt))}</td>
                                    <td><strong>{actorName(r.actor)}</strong></td>
                                    <td>{ACTIONS[r.action] ?? r.action}{r.target ? ` ${r.target}` : ''}</td>
                                    <td className="muted small">{teamName(r.teamId) ?? ''}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {!done && (
                        <div style={{ paddingTop: 12 }}>
                            <button className="btn btn-ghost" disabled={busy} onClick={async () => {
                                const more = await run(() => load(rows[rows.length - 1].id));
                                if (more) { setRows([...rows, ...more]); setDone(more.length < 50); }
                            }}>Afficher plus</button>
                        </div>
                    )}
                </div>
            )}
        </>
    );
}
