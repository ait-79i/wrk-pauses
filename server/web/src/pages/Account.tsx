import { api, type Me } from '../api';
import { Field, useAction, useToast } from '../ui';

export function AccountPage({ me }: { me: Me }) {
    const { run, busy } = useAction();
    const toast = useToast();
    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Mon compte</h1>
                    <p className="page-sub">{me.admin?.email}</p>
                </div>
            </div>
            <div className="stack" style={{ maxWidth: 480 }}>
                <form
                    className="panel stack"
                    onSubmit={async (e) => {
                        e.preventDefault();
                        const form = e.currentTarget;
                        const f = new FormData(form);
                        if (f.get('next') !== f.get('confirm')) {
                            toast('Les deux nouveaux mots de passe ne sont pas identiques.', true);
                            return;
                        }
                        const ok = await run(() => api('POST', '/auth/password', { current: f.get('current'), next: f.get('next') }), 'Mot de passe changé');
                        if (ok) form.reset();
                    }}
                >
                    <h2>Mot de passe</h2>
                    <Field label="Mot de passe actuel"><input className="input" name="current" type="password" autoComplete="current-password" required /></Field>
                    <Field label="Nouveau mot de passe" hint="12 caractères minimum.">
                        <input className="input" name="next" type="password" autoComplete="new-password" required minLength={12} />
                    </Field>
                    <Field label="Confirmez le nouveau mot de passe">
                        <input className="input" name="confirm" type="password" autoComplete="new-password" required minLength={12} />
                    </Field>
                    <div><button className="btn btn-primary" disabled={busy}>Changer le mot de passe</button></div>
                </form>
                <div className="panel stack">
                    <h2>Double authentification</h2>
                    <p className="muted">
                        {me.admin?.totpEnabled
                            ? 'Activée : un code de votre application d\'authentification est demandé à chaque connexion.'
                            : 'Non activée. Demandez au super admin si vous souhaitez la mettre en place.'}
                    </p>
                </div>
            </div>
        </>
    );
}
