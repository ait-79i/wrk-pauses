// Page d'accueil publique : ce que fait Pause, et comment installer l'application Windows.
// L'élément fort : l'avant / après d'un message d'horaires (réactions comptées à la main → carte Pause).

import { useEffect, useState } from 'react';
import '../landing.css';

interface DownloadInfo { available: boolean; url: string; version: string | null; sizeBytes: number | null }

const DOWNLOAD_PATH = '/telecharger/windows';

function ZelligeMark({ size = 22 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
                <rect x="9" y="9" width="14" height="14" />
                <rect x="9" y="9" width="14" height="14" transform="rotate(45 16 16)" />
            </g>
        </svg>
    );
}

export function LandingPage() {
    const [info, setInfo] = useState<DownloadInfo | null>(null);
    const [copied, setCopied] = useState(false);
    const directUrl = `${window.location.origin}${DOWNLOAD_PATH}`;

    useEffect(() => {
        document.title = 'Pause — prière en groupe au bureau';
        fetch('/api/download/windows').then((r) => (r.ok ? r.json() : null)).then(setInfo).catch(() => setInfo(null));
    }, []);

    const meta = info?.available
        ? [info.version && `Version ${info.version}`, info.sizeBytes && `${Math.round(info.sizeBytes / (1024 * 1024))} Mo`, 'Windows 10 et 11']
            .filter(Boolean).join(', ')
        : 'Windows 10 et 11';

    const copy = async () => {
        await navigator.clipboard.writeText(directUrl).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const DownloadButton = ({ className = '' }: { className?: string }) => (
        info && !info.available
            ? <span className={`lp-btn lp-btn-disabled ${className}`} aria-disabled="true">Bientôt disponible</span>
            : <a className={`lp-btn ${className}`} href={DOWNLOAD_PATH} download>Télécharger pour Windows</a>
    );

    return (
        <div className="lp">
            <header className="lp-bar">
                <a className="lp-brand" href="/"><span className="lp-brand-mark"><ZelligeMark /></span>Pause</a>
                <a className="lp-bar-link lp-bar-install" href="#installer">Installer</a>
            </header>

            <main>
                <section className="lp-hero" aria-labelledby="lp-title">
                    <div className="lp-hero-text">
                        <p className="lp-hero-ar" lang="ar" dir="rtl">الصلاة أولا</p>
                        <h1 id="lp-title">L'heure de la prière en groupe, sans la chercher dans la discussion.</h1>
                        <p className="lp-lead">
                            Chaque jour, l'admin de votre équipe publie les horaires de Dhuhr et d'Asr par groupe.
                            Vous choisissez le vôtre en un clic, et Pause vous rappelle l'heure 5 minutes avant, en plein écran.
                        </p>
                        <div className="lp-cta">
                            <DownloadButton />
                            <span className="lp-meta">{meta}</span>
                        </div>
                    </div>

                    {/* Avant / après : le même horaire, compté à la main puis géré par Pause */}
                    <div className="lp-story" aria-label="Avant et après Pause">
                        <figure className="lp-before">
                            <figcaption>Avant, dans la discussion</figcaption>
                            <div className="lp-chat">
                                <p className="lp-chat-author">Azedine <span>11:58</span></p>
                                <p className="lp-chat-ar" lang="ar" dir="rtl">صلاة الظهر</p>
                                <div className="lp-chat-row"><strong>G1 : 12:26</strong><span className="lp-reacts" aria-label="10 réactions">👍👍🏽👍🏿 <b>10</b></span></div>
                                <div className="lp-chat-row"><strong>G2 : 12:36</strong><span className="lp-reacts" aria-label="10 réactions">👍🏿👍🏾👍🏻 <b>10</b></span></div>
                            </div>
                        </figure>

                        <figure className="lp-after">
                            <figcaption>Avec Pause</figcaption>
                            <div className="lp-card">
                                <div className="lp-card-head">
                                    <span lang="ar" dir="rtl">صلاة الظهر</span>
                                    <em>Dhuhr</em>
                                </div>
                                <div className="lp-card-slot">
                                    <strong>G1</strong><span>12:26</span><b className="lp-count">5</b>
                                </div>
                                <div className="lp-card-slot is-mine">
                                    <strong>G2</strong><span>12:36</span><b className="lp-count">4</b>
                                    <i>Votre groupe</i>
                                </div>
                                <p className="lp-card-foot">Rappel 5 min avant, à 12:31</p>
                            </div>
                        </figure>
                    </div>
                </section>

                <section id="installer" className="lp-section" aria-labelledby="lp-install">
                    <h2 id="lp-install">Installer Pause sur votre PC</h2>
                    <ol className="lp-steps">
                        <li>
                            <h3>Téléchargez l'installateur</h3>
                            <p>Un seul fichier, <code>Pause-Setup.exe</code>, toujours dans sa dernière version.</p>
                            <div className="lp-direct">
                                <DownloadButton className="lp-btn-small" />
                                <span className="lp-direct-link">
                                    <input readOnly value={directUrl} aria-label="Lien direct de téléchargement" onFocus={(e) => e.target.select()} />
                                    <button type="button" onClick={copy}>{copied ? 'Copié' : 'Copier le lien'}</button>
                                </span>
                            </div>
                        </li>
                        <li>
                            <h3>Lancez l'installation</h3>
                            <p>
                                Ouvrez le fichier téléchargé. Si Windows affiche « Windows a protégé votre ordinateur »,
                                cliquez sur <strong>Informations complémentaires</strong>, puis <strong>Exécuter quand même</strong>.
                                Pause s'installe et s'ouvre toute seule, puis reste dans la zone de notification.
                            </p>
                        </li>
                        <li>
                            <h3>Rejoignez votre équipe</h3>
                            <p>
                                Dans le panneau <strong>Prière en groupe</strong>, cliquez sur <strong>Rejoindre</strong>,
                                puis saisissez le code donné par l'admin (par exemple <code>K7P-2QW</code>) et votre prénom.
                                Vos collègues déjà inscrits voient aussi ce code à côté de leur nom.
                            </p>
                        </li>
                    </ol>
                </section>

                <section className="lp-section lp-features" aria-labelledby="lp-features">
                    <h2 id="lp-features">Ce que Pause fait pour vous</h2>
                    <ul>
                        <li><h3>Votre journée</h3><p>Heure d'arrivée, pauses et heure de sortie calculée selon vos règles, mode Ramadan compris.</p></li>
                        <li><h3>Votre groupe en un clic</h3><p>Dès la publication des horaires, un écran vous demande votre groupe. Retenez-le une fois, il s'applique chaque jour.</p></li>
                        <li><h3>Un rappel qu'on ne rate pas</h3><p>Plein écran sur tous vos moniteurs, 5 minutes avant l'heure de votre groupe. Même hors ligne.</p></li>
                        <li><h3>La discussion de votre catégorie</h3><p>Annonces, réponses et mentions, à droite de la fenêtre principale. Les horaires y arrivent en carte.</p></li>
                    </ul>
                </section>

                <section className="lp-privacy" aria-label="Confidentialité">
                    <ZelligeMark size={28} />
                    <p>
                        <strong>Vos pauses restent sur votre ordinateur.</strong> Le serveur ne connaît que votre équipe,
                        les horaires de prière, votre choix de groupe et la discussion. Personne ne voit votre temps de pause.
                    </p>
                </section>
            </main>

            <footer className="lp-foot">
                <span>Pause, pour prier ensemble au bureau.</span>
                <a href="#lp-title">Revenir en haut</a>
            </footer>
        </div>
    );
}
