import { useState } from 'react';
import { api, formatDateTime, muteMember, relativeTime, ROLE_LABEL, type RoleName, type TeamDetail } from '../api';
import { Field, FormDialog, generatePassword, useAction } from '../ui';

type Member = TeamDetail['members'][number];

const MUTE_OPTIONS = [
    { minutes: 60, label: '1 heure' },
    { minutes: 24 * 60, label: '24 heures' },
    { minutes: 7 * 24 * 60, label: '7 jours' }
] as const;

/** Réduit au silence : peut lire la discussion mais pas y écrire */
const isMuted = (m: Member) => Boolean(m.mutedUntil && new Date(m.mutedUntil).getTime() > Date.now());

const STATUS: Record<Member['status'], { label: string; cls: string }> = {
    ACTIVE: { label: 'Actif', cls: 'badge-ok' },
    PENDING: { label: 'En attente', cls: 'badge-live' },
    BLOCKED: { label: 'Bloqué', cls: 'badge-danger' }
};

export function MembersTab({ team, superAdmin, reload }: { team: TeamDetail; superAdmin: boolean; reload: () => void }) {
    const { run } = useAction();
    const [filter, setFilter] = useState('');
    const [rolesFor, setRolesFor] = useState<Member | null>(null);
    const [accountFor, setAccountFor] = useState<Member | null>(null);
    const [deleteFor, setDeleteFor] = useState<Member | null>(null);
    const [transfer, setTransfer] = useState<{ member: Member; code: string } | null>(null);
    const [muteFor, setMuteFor] = useState<Member | null>(null);
    const catName = (id: number | null) => team.categories.find((c) => c.id === id)?.name ?? '';
    const manage = team.canManageTeam;
    // Modération de la discussion : admin d'équipe ou admin de la catégorie du membre
    const canModerate = (m: Member) => manage || Boolean(team.categories.find((c) => c.id === m.categoryId)?.canManage);

    const members = team.members
        .filter((m) => m.name.toLowerCase().includes(filter.trim().toLowerCase()))
        // Les demandes en attente d'abord
        .sort((a, b) => Number(b.status === 'PENDING') - Number(a.status === 'PENDING'));

    const act = async (fn: () => Promise<unknown>, success: string) => {
        if (await run(fn, success)) reload();
    };

    if (team.members.length === 0) {
        return (
            <div className="empty">
                <strong>Aucun membre pour l'instant</strong>
                Partagez le code d'accès d'une catégorie (onglet Catégories et groupes) : chacun le saisit dans l'application Pause.
            </div>
        );
    }

    return (
        <div className="panel">
            <div className="panel-head">
                <input
                    className="input"
                    style={{ maxWidth: 280 }}
                    type="search"
                    placeholder="Rechercher un membre"
                    aria-label="Rechercher un membre"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
                <span className="muted small">{members.length} membre{members.length > 1 ? 's' : ''}</span>
            </div>
            <div className="table-wrap">
                <table>
                    <thead>
                        <tr><th>Nom</th><th>Catégorie</th><th>Statut</th><th>Rôles</th><th>Vu</th><th /></tr>
                    </thead>
                    <tbody>
                        {members.map((m) => (
                            <tr key={m.id}>
                                <td>
                                    <strong>{m.name}</strong>
                                    {m.account && <div className="muted small">{m.account.email}</div>}
                                </td>
                                <td>
                                    {manage ? (
                                        <select
                                            className="select"
                                            style={{ width: 'auto', padding: '5px 8px' }}
                                            value={m.categoryId}
                                            aria-label={`Catégorie de ${m.name}`}
                                            onChange={(e) => act(
                                                () => api('PATCH', `/members/${m.id}`, { categoryId: Number(e.target.value) }),
                                                `${m.name} déplacé`
                                            )}
                                        >
                                            {team.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                        </select>
                                    ) : catName(m.categoryId)}
                                </td>
                                <td>
                                    <div className="chip-list" style={{ gap: 6 }}>
                                        <span className={`badge ${STATUS[m.status].cls}`}>{STATUS[m.status].label}</span>
                                        {isMuted(m) && (
                                            <span className="badge badge-muted" title="Peut lire la discussion, pas y écrire">
                                                Silence jusqu'au {formatDateTime(m.mutedUntil!)}
                                            </span>
                                        )}
                                    </div>
                                </td>
                                <td>
                                    <div className="chip-list">
                                        {m.roles.length === 0 && <span className="muted small">Membre</span>}
                                        {m.roles.map((r) => (
                                            <span key={`${r.role}-${r.categoryId}`} className="badge badge-role">
                                                {ROLE_LABEL[r.role]}{r.categoryId ? ` (${catName(r.categoryId)})` : ''}
                                            </span>
                                        ))}
                                    </div>
                                </td>
                                <td className="muted small">{relativeTime(m.lastSeenAt)}</td>
                                <td className="actions">
                                    {(manage || canModerate(m)) && (
                                        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                                            {canModerate(m) && (isMuted(m) ? (
                                                <button className="btn btn-ghost btn-small" onClick={() => act(
                                                    () => muteMember(m.id, null), `${m.name} peut de nouveau écrire`
                                                )}>Lever le silence</button>
                                            ) : m.status === 'ACTIVE' && (
                                                <button className="btn btn-ghost btn-small" onClick={() => setMuteFor(m)}>Réduire au silence</button>
                                            ))}
                                            {manage && (<>
                                            {m.status === 'PENDING' && (
                                                <button className="btn btn-primary btn-small" onClick={() => act(
                                                    () => api('PATCH', `/members/${m.id}`, { status: 'ACTIVE' }), `${m.name} validé`
                                                )}>Valider</button>
                                            )}
                                            <button className="btn btn-ghost btn-small" onClick={() => setRolesFor(m)}>Rôles</button>
                                            <button className="btn btn-ghost btn-small" onClick={async () => {
                                                const r = await run(() => api<{ code: string }>('POST', `/members/${m.id}/transfer-code`));
                                                if (r) setTransfer({ member: m, code: r.code });
                                            }}>Transférer</button>
                                            {m.status === 'BLOCKED' ? (
                                                <button className="btn btn-ghost btn-small" onClick={() => act(
                                                    () => api('PATCH', `/members/${m.id}`, { status: 'ACTIVE' }), `${m.name} débloqué`
                                                )}>Débloquer</button>
                                            ) : m.status === 'ACTIVE' && (
                                                <button className="btn btn-ghost btn-small" onClick={() => act(
                                                    () => api('PATCH', `/members/${m.id}`, { status: 'BLOCKED' }), `${m.name} bloqué`
                                                )}>Bloquer</button>
                                            )}
                                            <button className="btn btn-danger btn-small" onClick={() => setDeleteFor(m)}>Supprimer</button>
                                            </>)}
                                        </div>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {rolesFor && (
                <RolesDialog
                    member={rolesFor}
                    team={team}
                    superAdmin={superAdmin}
                    onClose={() => setRolesFor(null)}
                    onSaved={() => { setRolesFor(null); reload(); }}
                    onCreateAccount={() => { setAccountFor(rolesFor); setRolesFor(null); }}
                />
            )}

            <FormDialog
                open={accountFor !== null}
                title={`Accès au tableau de bord pour ${accountFor?.name ?? ''}`}
                submitLabel="Créer l'accès"
                onClose={() => setAccountFor(null)}
                onSubmit={async (f) => {
                    const ok = await run(() => api('POST', `/members/${accountFor!.id}/account`, {
                        email: f.get('email'), password: f.get('password')
                    }), 'Accès créé : transmettez le mot de passe provisoire à la personne');
                    if (!ok) return false;
                    reload();
                }}
            >
                <p className="muted">La personne se connectera sur ce tableau de bord avec cet email et ce mot de passe provisoire.</p>
                <Field label="Email"><input className="input" name="email" type="email" required /></Field>
                <Field label="Mot de passe provisoire" hint="12 caractères minimum. Notez-le avant de valider.">
                    <input key={accountFor?.id ?? 'none'} className="input" name="password" defaultValue={generatePassword()} required minLength={12} />
                </Field>
            </FormDialog>

            <FormDialog
                open={transfer !== null}
                title="Code de transfert"
                submitLabel="Terminé"
                onClose={() => setTransfer(null)}
                onSubmit={() => undefined}
            >
                <p>
                    Sur son nouvel ordinateur, {transfer?.member.name} choisit « J'ai un code de transfert » dans l'application
                    et saisit ce code. Il est valable 24 heures et ne sert qu'une fois.
                </p>
                <div><span className="code">{transfer?.code}</span></div>
            </FormDialog>

            <FormDialog
                open={muteFor !== null}
                title={`Réduire ${muteFor?.name ?? ''} au silence`}
                submitLabel="Réduire au silence"
                onClose={() => setMuteFor(null)}
                onSubmit={async (f) => {
                    const minutes = Number(f.get('minutes'));
                    const label = MUTE_OPTIONS.find((o) => o.minutes === minutes)?.label ?? '';
                    const ok = await run(() => muteMember(muteFor!.id, minutes), `${muteFor!.name} réduit au silence pour ${label}`);
                    if (!ok) return false;
                    reload();
                }}
            >
                <p>Pendant cette durée, {muteFor?.name} lit la discussion mais ne peut plus y écrire. L'action est notée dans le journal d'activité.</p>
                <fieldset className="choice-list">
                    <legend className="field-label">Durée</legend>
                    {MUTE_OPTIONS.map((o, i) => (
                        <label key={o.minutes} className="check">
                            <input type="radio" name="minutes" value={o.minutes} defaultChecked={i === 0} required />
                            {o.label}
                        </label>
                    ))}
                </fieldset>
            </FormDialog>

            <FormDialog
                open={deleteFor !== null}
                danger
                title={`Supprimer ${deleteFor?.name ?? ''} ?`}
                submitLabel="Supprimer"
                onClose={() => setDeleteFor(null)}
                onSubmit={async () => {
                    const ok = await run(() => api('DELETE', `/members/${deleteFor!.id}`), 'Membre supprimé');
                    if (!ok) return false;
                    reload();
                }}
            >
                <p>Ses choix de groupe et ses rôles sont effacés. Il pourra rejoindre l'équipe à nouveau avec un code d'accès.</p>
            </FormDialog>
        </div>
    );
}

function RolesDialog({ member, team, superAdmin, onClose, onSaved, onCreateAccount }: {
    member: Member; team: TeamDetail; superAdmin: boolean;
    onClose: () => void; onSaved: () => void; onCreateAccount: () => void;
}) {
    const { run } = useAction();
    const has = (role: RoleName, categoryId: number | null) =>
        member.roles.some((r) => r.role === role && (role === 'TEAM_ADMIN' || r.categoryId === categoryId));

    return (
        <FormDialog
            open
            title={`Rôles de ${member.name}`}
            submitLabel="Enregistrer"
            onClose={onClose}
            onSubmit={async (f) => {
                const roles: { role: RoleName; categoryId: number | null }[] = [];
                if (f.get('TEAM_ADMIN') === 'on') roles.push({ role: 'TEAM_ADMIN', categoryId: null });
                for (const c of team.categories) {
                    if (f.get(`CATEGORY_ADMIN-${c.id}`) === 'on') roles.push({ role: 'CATEGORY_ADMIN', categoryId: c.id });
                    if (f.get(`SCHEDULER-${c.id}`) === 'on') roles.push({ role: 'SCHEDULER', categoryId: c.id });
                }
                const ok = await run(() => api('PUT', `/members/${member.id}/roles`, { roles }), 'Rôles enregistrés');
                if (!ok) return false;
                onSaved();
            }}
        >
            <label className="check">
                <input type="checkbox" name="TEAM_ADMIN" defaultChecked={has('TEAM_ADMIN', null)} disabled={!superAdmin} />
                Admin d'équipe {!superAdmin && <span className="muted small">(nommé par le super admin)</span>}
            </label>
            {team.categories.map((c) => (
                <fieldset key={c.id} className="stack" style={{ gap: 8, border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px' }}>
                    <legend className="field-label">{c.name}</legend>
                    <label className="check"><input type="checkbox" name={`CATEGORY_ADMIN-${c.id}`} defaultChecked={has('CATEGORY_ADMIN', c.id)} /> Admin de catégorie</label>
                    <label className="check"><input type="checkbox" name={`SCHEDULER-${c.id}`} defaultChecked={has('SCHEDULER', c.id)} /> Responsable horaires</label>
                </fieldset>
            ))}
            <p className="muted small">
                Dans l'application, ces rôles permettent de publier les horaires.
                {member.roles.length > 0 && !member.account && (
                    <> Pour l'accès à ce tableau de bord : <button type="button" className="btn-link" onClick={onCreateAccount}>créer un accès</button>.</>
                )}
            </p>
        </FormDialog>
    );
}
