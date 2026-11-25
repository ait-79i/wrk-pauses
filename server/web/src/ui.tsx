// Briques partagées : navigation, notifications, chargement de données, dialogue de saisie.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './api';

// ------------------------------------------------------------------ Navigation (History API)

/** Le tableau de bord vit sous /admin ; ses chemins internes (« /equipes/1 ») restent sans préfixe */
export const ADMIN_BASE = '/admin';

/** /admin/equipes/1 → /equipes/1 ; /admin → / */
export const adminPath = (pathname: string): string => pathname.replace(/^\/admin(?=\/|$)/, '') || '/';

/** /equipes/1 → /admin/equipes/1 ; / → /admin */
export const adminHref = (to: string): string => (to === '/' ? ADMIN_BASE : `${ADMIN_BASE}${to}`);

export function usePath(): [string, (to: string) => void] {
    const [path, setPath] = useState(adminPath(window.location.pathname));
    useEffect(() => {
        const onPop = () => setPath(adminPath(window.location.pathname));
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);
    const navigate = useCallback((to: string) => {
        if (adminHref(to) === window.location.pathname) return;
        window.history.pushState(null, '', adminHref(to));
        setPath(to);
        window.scrollTo(0, 0);
    }, []);
    return [path, navigate];
}

export const NavContext = createContext<(to: string) => void>(() => {});

export function Link({ to, children, className, current }: { to: string; children: ReactNode; className?: string; current?: boolean }) {
    const navigate = useContext(NavContext);
    return (
        <a
            href={adminHref(to)}
            className={className}
            aria-current={current ? 'page' : undefined}
            onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                navigate(to);
            }}
        >
            {children}
        </a>
    );
}

// ------------------------------------------------------------------ Notifications

interface Toast { id: number; text: string; error: boolean }
const ToastContext = createContext<(text: string, error?: boolean) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const push = useCallback((text: string, error = false) => {
        const id = Date.now() + Math.random();
        setToasts((t) => [...t, { id, text, error }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 6000 : 3500);
    }, []);
    return (
        <ToastContext.Provider value={push}>
            {children}
            <div className="toasts" role="status" aria-live="polite">
                {toasts.map((t) => <div key={t.id} className={`toast${t.error ? ' toast-error' : ''}`}>{t.text}</div>)}
            </div>
        </ToastContext.Provider>
    );
}

export const useToast = () => useContext(ToastContext);

/** Exécute une action et affiche son résultat (succès ou message d'erreur du serveur) */
export function useAction() {
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const run = useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
        setBusy(true);
        try {
            const result = await fn();
            if (success) toast(success);
            return result;
        } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Action impossible. Réessayez.', true);
            return undefined;
        } finally {
            setBusy(false);
        }
    }, [toast]);
    return { run, busy };
}

// ------------------------------------------------------------------ Chargement

export function useData<T>(load: () => Promise<T>, deps: unknown[]) {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [version, setVersion] = useState(0);
    useEffect(() => {
        let alive = true;
        setError(null);
        load()
            .then((d) => { if (alive) setData(d); })
            .catch((err) => { if (alive) setError(err instanceof ApiError ? err.message : 'Chargement impossible.'); });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, version]);
    const reload = useCallback(() => setVersion((v) => v + 1), []);
    return { data, error, reload, setData };
}

export function Loading({ error }: { error: string | null }) {
    if (error) return <p className="form-error" role="alert">{error}</p>;
    return <p className="muted">Chargement…</p>;
}

// ------------------------------------------------------------------ Dialogue de formulaire

interface DialogProps {
    open: boolean;
    title: string;
    submitLabel: string;
    danger?: boolean;
    onClose: () => void;
    onSubmit: (form: FormData) => Promise<boolean | void> | boolean | void;
    children?: ReactNode;
}

/** Dialogue modal natif ; se ferme quand onSubmit ne renvoie pas false */
export function FormDialog({ open, title, submitLabel, danger, onClose, onSubmit, children }: DialogProps) {
    const ref = useRef<HTMLDialogElement>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        const d = ref.current;
        if (!d) return;
        if (open && !d.open) d.showModal();
        if (!open && d.open) d.close();
    }, [open]);
    return (
        <dialog ref={ref} onClose={onClose} aria-labelledby="dialog-title">
            <form
                className="stack"
                onSubmit={async (e) => {
                    e.preventDefault();
                    setBusy(true);
                    try {
                        const keepOpen = (await onSubmit(new FormData(e.currentTarget))) === false;
                        if (!keepOpen) onClose();
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                <h2 id="dialog-title">{title}</h2>
                {children}
                <div className="dialog-actions">
                    <button type="button" className="btn btn-ghost" onClick={onClose}>Annuler</button>
                    <button type="submit" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy}>{submitLabel}</button>
                </div>
            </form>
        </dialog>
    );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <label className="field">
            <span className="field-label">{label}</span>
            {children}
            {hint && <span className="field-hint">{hint}</span>}
        </label>
    );
}

/** Génère un mot de passe provisoire lisible (16 caractères) */
export function generatePassword(): string {
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint32Array(16));
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
