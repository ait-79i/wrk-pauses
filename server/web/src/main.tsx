import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { LandingPage } from './pages/Landing';
import './styles.css';
import { ADMIN_BASE, ToastProvider } from './ui';

// Anciennes adresses du tableau de bord (avant /admin) : redirigées vers leur nouvel emplacement
if (/^\/(equipes|comptes|journal|compte)(\/|$)/.test(window.location.pathname)) {
    window.history.replaceState(null, '', `${ADMIN_BASE}${window.location.pathname}`);
}

const isAdmin = /^\/admin(\/|$)/.test(window.location.pathname);

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        {isAdmin ? (
            <ToastProvider>
                <App />
            </ToastProvider>
        ) : <LandingPage />}
    </StrictMode>
);
