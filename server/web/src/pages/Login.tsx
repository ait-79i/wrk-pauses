import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Me } from '../api';
import { Field } from '../ui';

type Step = 'password' | 'totp' | 'setup';

export function LoginPage({ me, onDone }: { me: Me; onDone: () => void }) {
    const initial: Step = me.needsTotp ? 'totp' : me.needsTotpSetup ? 'setup' : 'password';
    const [step, setStep] = useState<Step>(initial);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);

    useEffect(() => {
        if (step !== 'setup' || setup) return;
        api<{ qr: string; secret: string }>('POST', '/auth/totp/setup')
            .then(setSetup)
            .catch((err) => setError(err instanceof ApiError ? err.message : 'Configuration impossible.'));
    }, [step, setup]);

    async function submit(e: FormEvent<HTMLFormElement>, action: (f: FormData) => Promise<void>) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            await action(new FormData(e.currentTarget));
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Connexion impossible. Réessayez.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="auth">
            <section className="auth-art" aria-hidden="true">
                <span className="prayer-arabic">الصلاة أولا</span>
                <p>Horaires de prière en groupe, publiés chaque jour pour chaque équipe.</p>
            </section>

            <section className="auth-form">
                {step === 'password' && (
                    <form className="stack" onSubmit={(e) => submit(e, async (f) => {
                        const r = await api<{ needsTotp: boolean; needsTotpSetup: boolean }>('POST', '/auth/login', {
                            email: f.get('email'), password: f.get('password')
                        });
                        if (r.needsTotp) setStep('totp');
                        else if (r.needsTotpSetup) setStep('setup');
                        else onDone();
                    })}>
                        <h1>Connexion</h1>
                        <p className="muted">Tableau de bord des équipes Pause.</p>
                        <Field label="Email"><input className="input" name="email" type="email" autoComplete="username" required autoFocus /></Field>
                        <Field label="Mot de passe"><input className="input" name="password" type="password" autoComplete="current-password" required /></Field>
                        {error && <p className="form-error" role="alert">{error}</p>}
                        <button className="btn btn-primary" disabled={busy}>Se connecter</button>
                    </form>
                )}

                {step === 'totp' && (
                    <form className="stack" onSubmit={(e) => submit(e, async (f) => {
                        await api('POST', '/auth/totp', { code: String(f.get('code')).replace(/\s/g, '') });
                        onDone();
                    })}>
                        <h1>Code de vérification</h1>
                        <p className="muted">Saisissez le code à 6 chiffres affiché dans votre application d'authentification.</p>
                        <Field label="Code">
                            <input className="input" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus />
                        </Field>
                        {error && <p className="form-error" role="alert">{error}</p>}
                        <button className="btn btn-primary" disabled={busy}>Vérifier</button>
                    </form>
                )}

                {step === 'setup' && (
                    <form className="stack" onSubmit={(e) => submit(e, async (f) => {
                        await api('POST', '/auth/totp/enable', { code: String(f.get('code')).replace(/\s/g, '') });
                        onDone();
                    })}>
                        <h1>Activer la double authentification</h1>
                        <p className="muted">
                            Le compte super admin contrôle toutes les équipes : il est protégé par un code à usage unique.
                            Scannez ce QR code avec Google Authenticator, Microsoft Authenticator ou une application équivalente.
                        </p>
                        {setup ? (
                            <>
                                <img className="qr" src={setup.qr} alt="QR code à scanner avec votre application d'authentification" />
                                <p className="secret">Saisie manuelle : <strong>{setup.secret}</strong></p>
                            </>
                        ) : <p className="muted">Préparation du QR code…</p>}
                        <Field label="Code affiché par l'application">
                            <input className="input" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required />
                        </Field>
                        {error && <p className="form-error" role="alert">{error}</p>}
                        <button className="btn btn-primary" disabled={busy || !setup}>Activer</button>
                    </form>
                )}
            </section>
        </div>
    );
}
