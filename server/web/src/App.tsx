import { useCallback, useEffect, useState } from 'react';
import { api, type Me, type Overview } from './api';
import { AccountPage } from './pages/Account';
import { AccountsPage } from './pages/Accounts';
import { AuditPage } from './pages/Audit';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { DesktopAppPage } from './pages/DesktopApp';
import { TeamPage } from './pages/Team';
import { ADMIN_BASE, Link, NavContext, useData, usePath } from './ui';

export function App() {
    const [me, setMe] = useState<Me | null>(null);
    const refreshMe = useCallback(() => api<Me>('GET', '/me').then(setMe).catch(() => setMe({ authenticated: false })), []);
    useEffect(() => { void refreshMe(); }, [refreshMe]);

    if (!me) return null;
    if (!me.authenticated || me.needsTotp || me.needsTotpSetup) return <LoginPage me={me} onDone={refreshMe} />;
    return <Shell me={me} onLogout={refreshMe} />;
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
    const [path, navigate] = usePath();
    const overview = useData(() => api<Overview>('GET', '/overview'), [path]);
    const superAdmin = Boolean(me.admin?.superAdmin);

    const teamMatch = path.match(/^\/equipes\/(\d+)(?:\/([a-z-]+))?/);
    let page;
    if (teamMatch) page = <TeamPage key={teamMatch[1]} teamId={Number(teamMatch[1])} tab={teamMatch[2] ?? 'horaires'} superAdmin={superAdmin} />;
    else if (path === '/comptes' && superAdmin) page = <AccountsPage />;
    else if (path === '/application' && superAdmin) page = <DesktopAppPage />;
    else if (path === '/journal') page = <AuditPage teams={overview.data?.teams ?? []} />;
    else if (path === '/compte') page = <AccountPage me={me} />;
    else page = <OverviewPage overview={overview} superAdmin={superAdmin} />;

    const logout = async () => {
        await api('POST', '/auth/logout').catch(() => {});
        window.history.replaceState(null, '', ADMIN_BASE);
        onLogout();
    };

    return (
        <NavContext.Provider value={navigate}>
            <div className="shell">
                <nav className="sidebar" aria-label="Navigation principale">
                    <div className="brand">
                        <span className="brand-mark" aria-hidden="true">
                            <svg width="20" height="20" viewBox="0 0 32 32">
                                <g fill="none" stroke="#2a2c96" strokeWidth="2.2" strokeLinejoin="round">
                                    <rect x="9" y="9" width="14" height="14" />
                                    <rect x="9" y="9" width="14" height="14" transform="rotate(45 16 16)" />
                                </g>
                            </svg>
                        </span>
                        Pause
                    </div>
                    <Link to="/" className="nav-link" current={path === '/'}>
                        Vue d'ensemble
                        {Boolean(overview.data?.totals.pending) && <span className="nav-count" title="Membres en attente">{overview.data!.totals.pending}</span>}
                    </Link>
                    {(overview.data?.teams.length ?? 0) > 0 && <p className="nav-label">Équipes</p>}
                    {overview.data?.teams.map((t) => (
                        <Link key={t.id} to={`/equipes/${t.id}`} className="nav-link" current={teamMatch?.[1] === String(t.id)}>
                            {t.name}
                        </Link>
                    ))}
                    <p className="nav-label">Administration</p>
                    {superAdmin && <Link to="/comptes" className="nav-link" current={path === '/comptes'}>Comptes admin</Link>}
                    {superAdmin && <Link to="/application" className="nav-link" current={path === '/application'}>Application Windows</Link>}
                    <Link to="/journal" className="nav-link" current={path === '/journal'}>Journal d'activité</Link>
                    <Link to="/compte" className="nav-link" current={path === '/compte'}>Mon compte</Link>
                    <div className="sidebar-foot">
                        <div>{me.admin?.name ?? (superAdmin ? 'Super admin' : 'Admin')}</div>
                        <div>{me.admin?.email}</div>
                        <button type="button" onClick={logout}>Se déconnecter</button>
                    </div>
                </nav>
                <main className="main">{page}</main>
            </div>
        </NavContext.Provider>
    );
}
