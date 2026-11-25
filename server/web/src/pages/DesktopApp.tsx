// Application Windows (super admin) : version publiée, lien direct à partager, envoi d'une nouvelle version.
// L'envoi se fait par morceaux de 16 Mo (Cloudflare refuse les corps de plus de 100 Mo).

import { useRef, useState } from 'react';
import { ApiError } from '../api';
import { Loading, useData, useToast } from '../ui';

interface DownloadInfo {
    available: boolean;
    url: string;
    version: string | null;
    sizeBytes: number | null;
    updatedAt: string | null;
    external: boolean;
}

const CHUNK = 16 * 1024 * 1024;
const NAME_RE = /^Pause-Setup-(\d+(?:\.\d+){0,3})\.exe$/;

const formatSize = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} Mo`;
const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

async function fetchInfo(): Promise<DownloadInfo> {
    const res = await fetch('/api/download/windows', { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, 'Informations de téléchargement indisponibles.', 'error');
    return res.json();
}

export function DesktopAppPage() {
    const info = useData(fetchInfo, []);
    const toast = useToast();
    const inputRef = useRef<HTMLInputElement>(null);
    const [file, setFile] = useState<File | null>(null);
    const [version, setVersion] = useState('');
    const [progress, setProgress] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const cancelRef = useRef(false);

    const publicUrl = `${window.location.origin}/telecharger/windows`;

    function pick(f: File | null | undefined) {
        setError(null);
        if (!f) return;
        if (!/\.exe$/i.test(f.name)) {
            setFile(null);
            return setError('Choisissez le fichier d\'installation Windows (.exe), par exemple release\\Pause-Setup-1.0.2.exe.');
        }
        setFile(f);
        setVersion(NAME_RE.exec(f.name)?.[1] ?? '');
    }

    async function upload() {
        if (!file) return;
        if (!/^\d+(\.\d+){0,3}$/.test(version)) return setError('Indiquez la version au format 1.0.2.');
        const name = `Pause-Setup-${version}.exe`;
        cancelRef.current = false;
        setError(null);
        setProgress(0);
        try {
            for (let offset = 0; offset < file.size; offset += CHUNK) {
                if (cancelRef.current) throw new Error('cancelled');
                const res = await fetch(
                    `/api/admin/desktop-installer?name=${encodeURIComponent(name)}&offset=${offset}&total=${file.size}`,
                    { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file.slice(offset, offset + CHUNK) }
                );
                const data = await res.json().catch(() => null);
                if (!res.ok) throw new ApiError(res.status, data?.message ?? `Envoi refusé (${res.status}).`, data?.error ?? 'error');
                setProgress(Math.min(1, (offset + CHUNK) / file.size));
            }
            toast(`Version ${version} publiée : le lien direct la propose dès maintenant`);
            setFile(null);
            setProgress(null);
            if (inputRef.current) inputRef.current.value = '';
            info.reload();
        } catch (err) {
            setProgress(null);
            if (err instanceof Error && err.message === 'cancelled') return setError('Envoi annulé. La version en ligne n\'a pas changé.');
            setError(err instanceof ApiError ? err.message : 'Envoi interrompu. Vérifiez votre connexion et réessayez.');
        }
    }

    const d = info.data;
    const uploading = progress !== null;

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>Application Windows</h1>
                    <p className="page-sub">Le fichier que vos collègues téléchargent depuis la page d'accueil.</p>
                </div>
            </div>

            <div className="stack" style={{ maxWidth: 720 }}>
                <section className="panel stack" aria-labelledby="dl-current">
                    <h2 id="dl-current">En ligne</h2>
                    {!d ? <Loading error={info.error} /> : d.available && !d.external ? (
                        <p>
                            <strong>Version {d.version}</strong>
                            <span className="muted">, {formatSize(d.sizeBytes!)}, publiée le {dateFmt.format(new Date(d.updatedAt!))}</span>
                        </p>
                    ) : d.external ? (
                        <p>Le lien direct redirige vers l'adresse définie dans <code>DESKTOP_DOWNLOAD_URL</code>. Envoyez un fichier ci-dessous pour le servir depuis ce site.</p>
                    ) : (
                        <p className="muted">Aucune version en ligne : le lien direct affiche « pas encore disponible ». Envoyez l'installateur ci-dessous.</p>
                    )}
                    <div className="field">
                        <span className="field-label">Lien direct à partager</span>
                        <div className="row">
                            <input className="input" style={{ flex: 1, minWidth: 220 }} readOnly value={publicUrl} aria-label="Lien direct de téléchargement" onFocus={(e) => e.target.select()} />
                            <button className="btn btn-ghost" onClick={async () => {
                                await navigator.clipboard.writeText(publicUrl).catch(() => {});
                                toast('Lien copié');
                            }}>Copier</button>
                        </div>
                        <span className="field-hint">Il propose toujours la dernière version envoyée. La page d'accueil l'utilise aussi.</span>
                    </div>
                </section>

                <section className="panel stack" aria-labelledby="dl-upload">
                    <h2 id="dl-upload">Publier une nouvelle version</h2>
                    <p className="muted">
                        Sur votre PC, lancez <code>npm run dist</code>, puis envoyez le fichier créé dans <code>release\</code>.
                        Les deux dernières versions sont conservées ; la plus récente est proposée au téléchargement.
                    </p>

                    <label
                        className={`dropzone${dragging ? ' is-dragging' : ''}${file ? ' has-file' : ''}`}
                        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files[0]); }}
                    >
                        <input ref={inputRef} type="file" accept=".exe" className="sr-only" disabled={uploading} onChange={(e) => pick(e.target.files?.[0])} />
                        {file ? (
                            <span><strong>{file.name}</strong><span className="muted">, {formatSize(file.size)}</span></span>
                        ) : (
                            <span>Déposez <strong>Pause-Setup-x.y.z.exe</strong> ici, ou <span className="btn-link">choisissez le fichier</span></span>
                        )}
                    </label>

                    {file && (
                        <div className="row" style={{ alignItems: 'flex-end' }}>
                            <label className="field" style={{ width: 140 }}>
                                <span className="field-label">Version</span>
                                <input className="input" value={version} disabled={uploading} onChange={(e) => setVersion(e.target.value.trim())} placeholder="1.0.2" inputMode="decimal" />
                            </label>
                            <span className="spacer" />
                            {uploading ? (
                                <button className="btn btn-ghost" onClick={() => { cancelRef.current = true; }}>Annuler l'envoi</button>
                            ) : (
                                <button className="btn btn-primary" onClick={upload}>Publier la version {version || '…'}</button>
                            )}
                        </div>
                    )}

                    {uploading && (
                        <div className="upload-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress! * 100)} aria-label="Envoi de l'installateur">
                            <span style={{ width: `${Math.round(progress! * 100)}%` }} />
                            <em>{Math.round(progress! * 100)} %</em>
                        </div>
                    )}
                    {error && <p className="form-error" role="alert">{error}</p>}
                </section>
            </div>
        </>
    );
}
