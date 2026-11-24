import { useState } from 'react';
import { api, relativeTime, type AccountRow } from '../api';
import { Field, FormDialog, generatePassword, Loading, useAction, useData } from '../ui';

export function AccountsPage() {
    const accounts = useData(() => api<AccountRow[]>('GET', '/accounts'), []);
    const { run } = useAction();
    const [creating, setCreating] = useState(false);
    const [resetFor, setResetFor] = useState<AccountRow | null>(null);
    const act = async (fn: () => Promise<unknown>, success: string) => { if (await run(fn, success)) accounts.reload(); };

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Comptes admin</h1>
                    <p className="page-sub">Accès au tableau de bord. Les admins d'équipe et de catégorie reçoivent leur accès depuis l'onglet Membres de leur équipe.</p>
                </div>
                <button className="btn btn-primary" onClick={() => setCreating(true)}>Ajouter un super admin</button>
            </div>

            {!accounts.data ? <Loading error={accounts.error} /> : (
                <div className="panel table-wrap">
                    <table>
                        <thead><tr><th>Email</th><th>Rôle</th><th>Double authentification</th><th>Dernière connexion</th><th /></tr></thead>
                        <tbody>
                            {accounts.data.map((a) => (
                                <tr key={a.id}>
                                    <td>
                                        <strong>{a.email}</strong>
                                        {a.disabled && <span className="badge badge-danger" style={{ marginLeft: 8 }}>Désactivé</span>}
                                    </td>
                                    <td>{a.superAdmin ? <span className="badge badge-live">Super admin</span> : <span>{a.member?.name}, {a.member?.team}</span>}</td>
                                    <td>{a.totpEnabled ? <span className="badge badge-ok">Activée</span> : <span className="badge badge-wait">Non activée</span>}</td>
                                    <td className="muted small">{relativeTime(a.lastLoginAt)}</td>
                                    <td className="actions">
                                        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                                            <button className="btn btn-ghost btn-small" onClick={() => setResetFor(a)}>Réinitialiser</button>
                                            <button className="btn btn-ghost btn-small" onClick={() => act(
                                                () => api('PATCH', `/accounts/${a.id}`, { disabled: !a.disabled }),
                                                a.disabled ? 'Compte réactivé' : 'Compte désactivé'
                                            )}>{a.disabled ? 'Réactiver' : 'Désactiver'}</button>
                                            <button className="btn btn-danger btn-small" onClick={() => act(
                                                () => api('DELETE', `/accounts/${a.id}`), 'Compte supprimé'
                                            )}>Supprimer</button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <FormDialog
                open={creating}
                title="Ajouter un super admin"
                submitLabel="Créer le compte"
                onClose={() => setCreating(false)}
                onSubmit={async (f) => {
                    const ok = await run(() => api('POST', '/accounts', { email: f.get('email'), password: f.get('password') }), 'Super admin créé');
                    if (!ok) return false;
                    accounts.reload();
                }}
            >
                <p className="muted">Ce compte voit et contrôle toutes les équipes. Il devra activer la double authentification à sa première connexion.</p>
                <Field label="Email"><input className="input" name="email" type="email" required /></Field>
                <Field label="Mot de passe provisoire" hint="12 caractères minimum. Notez-le avant de valider.">
                    <input key={String(creating)} className="input" name="password" defaultValue={generatePassword()} required minLength={12} />
                </Field>
            </FormDialog>

            <FormDialog
                open={resetFor !== null}
                title={`Réinitialiser ${resetFor?.email ?? ''}`}
                submitLabel="Réinitialiser"
                onClose={() => setResetFor(null)}
                onSubmit={async (f) => {
                    const password = String(f.get('password') ?? '');
                    const ok = await run(() => api('PATCH', `/accounts/${resetFor!.id}`, {
                        password: password || undefined,
                        resetTotp: f.get('resetTotp') === 'on'
                    }), 'Compte réinitialisé : ses sessions ouvertes sont fermées');
                    if (!ok) return false;
                    accounts.reload();
                }}
            >
                <Field label="Nouveau mot de passe provisoire" hint="Laissez vide pour garder le mot de passe actuel.">
                    <input key={resetFor?.id} className="input" name="password" defaultValue={generatePassword()} minLength={12} />
                </Field>
                <label className="check"><input type="checkbox" name="resetTotp" /> Désactiver la double authentification (téléphone perdu)</label>
            </FormDialog>
        </>
    );
}
