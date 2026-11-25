import { useState } from 'react';
import { api, type TeamDetail } from '../api';
import { Field, FormDialog, useAction, useToast } from '../ui';

type Category = TeamDetail['categories'][number];

export function CategoriesTab({ team, reload }: { team: TeamDetail; reload: () => void }) {
    const { run } = useAction();
    const [adding, setAdding] = useState(false);

    return (
        <div className="stack">
            {team.categories.map((c) => <CategoryPanel key={c.id} team={team} category={c} reload={reload} />)}
            {team.canManageTeam && (
                <div><button className="btn btn-ghost" onClick={() => setAdding(true)}>Ajouter une catégorie</button></div>
            )}
            <FormDialog
                open={adding}
                title="Nouvelle catégorie"
                submitLabel="Créer la catégorie"
                onClose={() => setAdding(false)}
                onSubmit={async (f) => {
                    const ok = await run(() => api('POST', `/teams/${team.id}/categories`, {
                        name: String(f.get('name')).trim(), jumuaEnabled: f.get('jumua') === 'on'
                    }), 'Catégorie créée avec G1, G2 et un code d\'accès');
                    if (!ok) return false;
                    reload();
                }}
            >
                <Field label="Nom"><input className="input" name="name" required minLength={2} maxLength={60} placeholder="Ex. Équipe de nuit" /></Field>
                <label className="check"><input type="checkbox" name="jumua" defaultChecked /> Jumu'a remplace Dhuhr le vendredi</label>
            </FormDialog>
        </div>
    );
}

type CategoryRole = 'CATEGORY_ADMIN' | 'SCHEDULER';
const CATEGORY_ROLES: { role: CategoryRole; label: string }[] = [
    { role: 'CATEGORY_ADMIN', label: 'Admin de catégorie' },
    { role: 'SCHEDULER', label: 'Responsable horaires' }
];

/**
 * Admins de catégorie et responsables horaires, gérés depuis la carte de la catégorie.
 * Même route que la fenêtre « Rôles » de l'onglet Membres : les autres rôles du membre sont conservés.
 */
function CategoryManagers({ team, category: c, reload }: { team: TeamDetail; category: Category; reload: () => void }) {
    const { run, busy } = useAction();
    const [memberId, setMemberId] = useState('');
    const [role, setRole] = useState<CategoryRole>('CATEGORY_ADMIN');

    const holders = team.members.flatMap((m) => m.roles
        .filter((r) => r.categoryId === c.id && r.role !== 'TEAM_ADMIN')
        .map((r) => ({ member: m, role: r.role as CategoryRole })));
    // Membres actifs de l'équipe, ceux de la catégorie en premier
    const candidates = team.members
        .filter((m) => m.status === 'ACTIVE')
        .sort((a, b) => Number(b.categoryId === c.id) - Number(a.categoryId === c.id) || a.name.localeCompare(b.name, 'fr'));

    const saveRoles = (member: TeamDetail['members'][number], roles: TeamDetail['members'][number]['roles'], success: string) =>
        run(() => api('PUT', `/members/${member.id}/roles`, { roles }), success).then((ok) => { if (ok !== undefined) reload(); });

    const add = () => {
        const member = team.members.find((m) => m.id === Number(memberId));
        if (!member) return;
        if (member.roles.some((r) => r.role === role && r.categoryId === c.id)) return;
        const label = CATEGORY_ROLES.find((x) => x.role === role)!.label.toLowerCase();
        void saveRoles(member, [...member.roles, { role, categoryId: c.id }], `${member.name} est maintenant ${label} de ${c.name}`);
        setMemberId('');
    };

    return (
        <div className="stack" style={{ gap: 8 }}>
            <h3>Responsables</h3>
            <p className="muted small">
                L'admin de catégorie gère les groupes, la limite, Jumu'a, les horaires et la discussion de {c.name}.
                Le responsable horaires publie seulement les horaires. Ils agissent depuis l'application ;
                pour leur ouvrir ce tableau de bord, utilisez « Rôles » puis « créer un accès » dans l'onglet Membres.
            </p>
            {holders.length === 0
                ? <p className="muted small">Aucun responsable pour l'instant.</p>
                : (
                    <div className="chip-list">
                        {holders.map(({ member, role: r }) => (
                            <span key={`${member.id}-${r}`} className="group-chip">
                                {member.name}
                                <span className="badge badge-role">{CATEGORY_ROLES.find((x) => x.role === r)!.label}</span>
                                <button
                                    className="icon-btn"
                                    aria-label={`Retirer le rôle de ${member.name}`}
                                    disabled={busy}
                                    onClick={() => saveRoles(
                                        member,
                                        member.roles.filter((x) => !(x.role === r && x.categoryId === c.id)),
                                        `Rôle retiré à ${member.name}`
                                    )}
                                >✕</button>
                            </span>
                        ))}
                    </div>
                )}
            {candidates.length === 0 ? (
                <p className="muted small">Personne n'a encore rejoint l'équipe : partagez le code d'accès ci-dessous, puis revenez nommer un responsable.</p>
            ) : (
                <div className="row">
                    <select
                        className="select"
                        style={{ width: 'auto', minWidth: 180 }}
                        value={memberId}
                        aria-label={`Membre à nommer responsable de ${c.name}`}
                        onChange={(e) => setMemberId(e.target.value)}
                    >
                        <option value="">Choisir un membre</option>
                        {candidates.map((m) => (
                            <option key={m.id} value={m.id}>
                                {m.name}{m.categoryId !== c.id ? ` (${team.categories.find((x) => x.id === m.categoryId)?.name ?? ''})` : ''}
                            </option>
                        ))}
                    </select>
                    <select
                        className="select"
                        style={{ width: 'auto' }}
                        value={role}
                        aria-label="Rôle"
                        onChange={(e) => setRole(e.target.value as CategoryRole)}
                    >
                        {CATEGORY_ROLES.map((x) => <option key={x.role} value={x.role}>{x.label}</option>)}
                    </select>
                    <button className="btn btn-primary btn-small" disabled={!memberId || busy} onClick={add}>Ajouter</button>
                </div>
            )}
        </div>
    );
}

function CategoryPanel({ team, category: c, reload }: { team: TeamDetail; category: Category; reload: () => void }) {
    const { run } = useAction();
    const toast = useToast();
    const [newCode, setNewCode] = useState(false);
    const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
    const [removing, setRemoving] = useState(false);
    const act = async (fn: () => Promise<unknown>, success: string) => { if (await run(fn, success)) reload(); };
    const atLimit = c.groups.length >= c.maxGroups;

    return (
        <section className="panel category-block" aria-labelledby={`cat-${c.id}`}>
            <div className="panel-head" style={{ marginBottom: 0 }}>
                <h2 id={`cat-${c.id}`}>{c.name}</h2>
                {team.canManageTeam && (
                    <button className="btn btn-danger btn-small" onClick={() => setRemoving(true)}>Supprimer la catégorie</button>
                )}
            </div>

            <div className="stack" style={{ gap: 8 }}>
                <h3>Groupes <span className="muted small">({c.groups.length} sur {c.maxGroups} au plus)</span></h3>
                <div className="chip-list">
                    {c.groups.map((g) => (
                        <span key={g.id} className="group-chip">
                            {c.canManage ? (
                                <button className="btn-link" style={{ color: 'var(--ink)' }} title="Renommer" onClick={() => setRenaming(g)}>{g.name}</button>
                            ) : g.name}
                            {c.canManage && (
                                <button className="icon-btn" aria-label={`Supprimer ${g.name}`} onClick={() => act(
                                    () => api('DELETE', `/groups/${g.id}`), `${g.name} supprimé`
                                )}>✕</button>
                            )}
                        </span>
                    ))}
                    {c.canManage && (
                        <button
                            className="btn btn-ghost btn-small"
                            disabled={atLimit}
                            title={atLimit ? 'Limite atteinte : augmentez-la ci-dessous' : undefined}
                            onClick={() => act(() => api('POST', `/categories/${c.id}/groups`, {}), 'Groupe ajouté')}
                        >Ajouter un groupe</button>
                    )}
                </div>
            </div>

            {c.canManage && (
                <div className="row" style={{ gap: 24 }}>
                    <label className="row" style={{ gap: 8 }}>
                        <span className="field-label">Limite de groupes</span>
                        <input
                            className="input"
                            style={{ width: 80 }}
                            type="number"
                            min={Math.max(1, c.groups.length)}
                            max={50}
                            defaultValue={c.maxGroups}
                            onBlur={(e) => {
                                const v = Number(e.target.value);
                                if (v !== c.maxGroups && v >= 1) void act(() => api('PATCH', `/categories/${c.id}`, { maxGroups: v }), 'Limite enregistrée');
                            }}
                        />
                    </label>
                    <label className="check">
                        <input
                            type="checkbox"
                            defaultChecked={c.jumuaEnabled}
                            onChange={(e) => act(
                                () => api('PATCH', `/categories/${c.id}`, { jumuaEnabled: e.target.checked }),
                                e.target.checked ? 'Jumu\'a activée' : 'Jumu\'a désactivée'
                            )}
                        />
                        Jumu'a remplace Dhuhr le vendredi
                    </label>
                </div>
            )}

            {team.canManageTeam && <CategoryManagers team={team} category={c} reload={reload} />}

            {team.canManageTeam && (
                <div className="stack" style={{ gap: 8 }}>
                    <h3>Code d'accès</h3>
                    <p className="muted small">Chaque personne qui saisit ce code dans l'application rejoint la catégorie {c.name}.</p>
                    <div className="row">
                        {c.codes.length === 0 && <span className="muted">Aucun code actif : personne ne peut rejoindre cette catégorie.</span>}
                        {c.codes.map((code) => (
                            <span key={code.id} className="row" style={{ gap: 8 }}>
                                <span className="code">{code.code}</span>
                                <button className="btn btn-ghost btn-small" onClick={async () => {
                                    await navigator.clipboard.writeText(code.code).catch(() => {});
                                    toast('Code copié');
                                }}>Copier</button>
                                {code.expiresAt && <span className="muted small">expire le {new Date(code.expiresAt).toLocaleDateString('fr-FR')}</span>}
                            </span>
                        ))}
                        <button className="btn btn-ghost btn-small" onClick={() => setNewCode(true)}>Nouveau code</button>
                    </div>
                </div>
            )}

            <FormDialog
                open={newCode}
                title={`Nouveau code pour ${c.name}`}
                submitLabel="Générer le code"
                onClose={() => setNewCode(false)}
                onSubmit={async (f) => {
                    const days = Number(f.get('days'));
                    const ok = await run(() => api('POST', `/categories/${c.id}/codes`, {
                        expiresInDays: days > 0 ? days : undefined, replace: true
                    }), 'Nouveau code généré');
                    if (!ok) return false;
                    reload();
                }}
            >
                <p className="muted">L'ancien code cessera de fonctionner. Les membres déjà inscrits ne sont pas concernés.</p>
                <Field label="Expiration" hint="Laissez vide pour un code sans expiration.">
                    <select className="select" name="days" defaultValue="">
                        <option value="">Jamais</option>
                        <option value="1">Dans 1 jour</option>
                        <option value="7">Dans 7 jours</option>
                        <option value="30">Dans 30 jours</option>
                    </select>
                </Field>
            </FormDialog>

            <FormDialog
                open={renaming !== null}
                title="Renommer le groupe"
                submitLabel="Renommer"
                onClose={() => setRenaming(null)}
                onSubmit={async (f) => {
                    const ok = await run(() => api('PATCH', `/groups/${renaming!.id}`, { name: String(f.get('name')).trim() }), 'Groupe renommé');
                    if (!ok) return false;
                    reload();
                }}
            >
                <Field label="Nom"><input key={renaming?.id ?? 'none'} className="input" name="name" defaultValue={renaming?.name} required maxLength={20} /></Field>
            </FormDialog>

            <FormDialog
                open={removing}
                danger
                title={`Supprimer la catégorie ${c.name} ?`}
                submitLabel="Supprimer"
                onClose={() => setRemoving(false)}
                onSubmit={async () => {
                    const ok = await run(() => api('DELETE', `/categories/${c.id}`), 'Catégorie supprimée');
                    if (!ok) return false;
                    reload();
                }}
            >
                <p>Une catégorie qui compte encore des membres ne peut pas être supprimée : déplacez-les d'abord.</p>
            </FormDialog>
        </section>
    );
}
