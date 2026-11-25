// Mise à jour automatique de l'application (electron-updater, releases GitHub publiques).
// Chaque tag de version construit l'installateur et latest.yml (.github/workflows/release.yml) :
// l'application vérifie au démarrage puis toutes les 4 h, télécharge en arrière-plan
// et installe à la fermeture, ou tout de suite si l'utilisateur clique sur la notification.

import { app, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';

const CHECK_EVERY_MS = 4 * 3600_000;

export interface UpdaterHooks {
    /** Avant l'installation immédiate : laisse l'application se fermer (elle vit dans la zone de notification) */
    beforeQuitForUpdate: () => void;
    iconPath: string;
}

let started = false;
let downloadedVersion: string | null = null;

/** Démarre la vérification automatique (uniquement dans l'application installée) */
export function startAutoUpdate(hooks: UpdaterHooks): void {
    if (started || !app.isPackaged) return;
    started = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;

    autoUpdater.on('error', (err) => {
        // Hors ligne ou GitHub injoignable : on réessaiera au prochain passage
        console.warn('[Pause] Mise à jour impossible pour l\'instant :', err?.message ?? err);
    });

    autoUpdater.on('update-downloaded', (info) => {
        if (downloadedVersion === info.version) return;
        downloadedVersion = info.version;
        if (!Notification.isSupported()) return;
        const notice = new Notification({
            title: `Pause ${info.version} est prête`,
            body: 'Elle s\'installera à la fermeture de Pause. Cliquez ici pour redémarrer maintenant.',
            icon: hooks.iconPath
        });
        notice.on('click', () => installNow(hooks));
        notice.show();
    });

    const check = () => autoUpdater.checkForUpdates().catch(() => { /* déjà signalé par « error » */ });
    // Laisse l'application démarrer avant la première vérification
    setTimeout(check, 30_000).unref?.();
    setInterval(check, CHECK_EVERY_MS).unref?.();
}

/** Recherche manuelle (menu de la zone de notification) ; renvoie le message à afficher */
export async function checkForUpdateNow(): Promise<string> {
    if (!app.isPackaged) return 'Les mises à jour ne s\'appliquent qu\'à l\'application installée.';
    if (downloadedVersion) return `Pause ${downloadedVersion} est prête : elle s'installera à la fermeture.`;
    try {
        const result = await autoUpdater.checkForUpdates();
        const latest = result?.updateInfo?.version;
        if (!latest || latest === app.getVersion()) return `Pause est à jour (version ${app.getVersion()}).`;
        return `Pause ${latest} est en cours de téléchargement. Vous serez prévenu quand elle sera prête.`;
    } catch {
        return 'Impossible de vérifier les mises à jour. Vérifiez votre connexion internet.';
    }
}

/** Ferme et installe la version téléchargée, puis relance Pause */
export function installNow(hooks: UpdaterHooks): void {
    if (!downloadedVersion) return;
    hooks.beforeQuitForUpdate();
    // isSilent : sans assistant ; isForceRunAfter : Pause se relance après l'installation
    autoUpdater.quitAndInstall(true, true);
}
