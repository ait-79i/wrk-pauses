// Processus principal Pause (Windows).
// Rôles : fenêtre principale + icône de la zone de notification, fenêtres de pause
// plein écran sur chaque écran, fenêtre de rappel de prière, récupération des horaires,
// base d'historique SQLite (fichier), discussion de l'équipe et notifications Windows.

import { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell, Display, Notification, powerMonitor } from 'electron';
import * as path from 'path';
import { pathToFileURL } from 'url';
import './shared'; // charge salat-core, day-core, salat-card comme globales
import { Store } from './store';
import { createHistory, HistoryManager } from './history';
import { SyncManager } from './sync';
import { TeamManager } from './team';
import { generateXlsx, generateCsv } from './exporter';
import { StoreChanges, TeamNotice } from './types';

const ROOT_DIR = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT_DIR, 'src', 'renderer');
const DAY_KEYS = ['clockIn', 'pauses', 'isPaused', 'pauseStartTime', 'workDate'];
const REFRESH_PERIOD_MS = 15 * 60 * 1000;
const AUTOSTART_OPTIONS = { path: process.execPath, args: ['--autostart'] };
const APP_USER_MODEL_ID = 'com.8hqi.pause-salat'; // = build.appId : notifications Windows

// Une seule instance : relancer l'application ne fait que ramener la fenêtre au premier plan
if (!app.requestSingleInstanceLock()) {
    app.quit();
    process.exit(0);
}

let store: Store;
let history: HistoryManager;
let syncManager: SyncManager;
let teamManager: TeamManager;

let mainWindow: BrowserWindow | null = null;
let historyWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let alertWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;
// Notifications affichées : gardées en mémoire pour que le clic reste actif
const liveNotices = new Set<Notification>();
const pauseWindows = new Map<string, BrowserWindow>(); // idÉcran -> BrowserWindow
let salatInflight: Promise<any> | null = null;
let alertTimer: NodeJS.Timeout | null = null;
let quitting = false;
let tray: Tray | null = null;

// ---------------------------------------------------------------- Démarrage

app.whenReady().then(() => {
    const userData = app.getPath('userData');
    store = new Store(path.join(userData, 'state.json'));
    history = createHistory(path.join(userData, 'history.sqlite'), broadcastHistoryChanged);
    syncManager = new SyncManager(store, history);
    teamManager = new TeamManager(store, userData);
    teamManager.on('event', broadcastTeamEvent);
    teamManager.on('notify', showTeamNotice);
    app.setAppUserModelId(APP_USER_MODEL_ID);

    if (store.value('salatAlertLead') === undefined) {
        store.set({ salatAlertLead: global.DEFAULT_ALERT_LEAD_MINS });
    }
    global.applyDayRulesConfig(store.value(global.DAY_RULES_KEY));

    stampArrivalOnBootLaunch();

    store.on('changed', onStoreChanged);
    registerIpc();
    createTray();
    createMainWindow();

    // Démarrage du planificateur de synchronisation automatique
    syncManager.startSchedule();
    teamManager.start();
    // Sortie de veille : la connexion temps réel est souvent morte sans le savoir
    powerMonitor.on('resume', () => teamManager.reconnectNow());

    ensureSalatDay().then(scheduleAlert).then(dispatchAlert);
    setInterval(() => ensureSalatDay().then(scheduleAlert).then(dispatchAlert), REFRESH_PERIOD_MS);
    dispatchPauseScreens();
});

app.on('second-instance', () => showMainWindow());

// Aucune fenêtre ne quitte les pages de l'application (lien ou fichier glissé, window.open) :
// le pont du preload ne doit jamais tourner sur une page distante.
app.on('web-contents-created', (_e, contents) => {
    const local = pathToFileURL(RENDERER).href;
    contents.on('will-navigate', (e, url) => {
        if (!url.startsWith(`${local}/`)) e.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
app.on('window-all-closed', () => {
    // Vit dans la zone de notification : ne pas quitter l'application
});
app.on('before-quit', () => {
    quitting = true;
    if (syncManager) syncManager.stopSchedule();
    if (teamManager) teamManager.stop();
});
app.on('will-quit', () => {
    if (tray && !tray.isDestroyed()) tray.destroy();
});

// ---------------------------------------------------------------- Fenêtre principale

function createMainWindow(): void {
    mainWindow = new BrowserWindow({
        width: 480,
        height: 860,
        minWidth: 360,
        minHeight: 300,
        show: false,
        title: 'Pause',
        icon: path.join(ROOT_DIR, 'build', 'icon.png'),
        autoHideMenuBar: true,
        backgroundColor: '#f1f2f7',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: false,
            sandbox: false,
            nodeIntegration: false
        }
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(RENDERER, 'popup.html'));
    mainWindow.once('ready-to-show', () => {
        if (mainWindow) mainWindow.show();
    });
    mainWindow.on('close', (e) => {
        if (quitting) return;
        e.preventDefault();
        if (mainWindow) mainWindow.hide();
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function showMainWindow(): void {
    if (!mainWindow) return createMainWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

// ---------------------------------------------------------------- Zone de notification

function createTray(): void {
    const iconPath = path.join(RENDERER, 'tray.png');
    const fallbackPath = path.join(RENDERER, 'icon.png');
    const img = nativeImage.createFromPath(iconPath);
    tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(fallbackPath) : img);
    updateTrayTooltip();

    const menu = Menu.buildFromTemplate([
        { label: 'Ouvrir', click: showMainWindow },
        {
            label: 'Pause rapide (+)',
            submenu: [
                { label: '+5 min', click: () => { addQuickPause(5); } },
                { label: '+10 min', click: () => { addQuickPause(10); } },
                { label: '+15 min', click: () => { addQuickPause(15); } },
                { label: '+30 min', click: () => { addQuickPause(30); } }
            ]
        },
        { type: 'separator' },
        { label: 'Discussion', click: () => openChatWindow() },
        { label: 'Historique', click: openHistoryWindow },
        { label: 'Réglages', click: openSettingsWindow },
        { type: 'separator' },
        {
            label: 'Synchroniser maintenant',
            click: () => {
                syncManager.sync().catch((err) => console.error('[Tray] Erreur synchro :', err));
            }
        },
        { type: 'separator' },
        {
            label: 'Quitter',
            click: () => {
                quitting = true;
                app.quit();
            }
        }
    ]);
    tray.setContextMenu(menu);
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
}

/** Infobulle de l'icône : nombre de messages non lus de la discussion */
function updateTrayTooltip(): void {
    if (!tray || tray.isDestroyed()) return;
    const unread = Number(store?.value('teamUnread')) || 0;
    tray.setToolTip(unread > 0 ? `Pause — ${unread} message${unread > 1 ? 's' : ''} non lu${unread > 1 ? 's' : ''}` : 'Pause');
}

// ---------------------------------------------------------------- Discussion de l'équipe (fenêtre)

function openChatWindow(channel?: string | null): void {
    if (chatWindow) {
        if (chatWindow.isMinimized()) chatWindow.restore();
        chatWindow.show();
        chatWindow.focus();
        if (channel) chatWindow.webContents.send('chat:openChannel', channel);
        return;
    }
    chatWindow = new BrowserWindow({
        width: 420,
        height: 640,
        minWidth: 340,
        minHeight: 420,
        title: 'Discussion — Pause',
        icon: path.join(ROOT_DIR, 'build', 'icon.png'),
        autoHideMenuBar: true,
        backgroundColor: store.value('isRamadanMode') ? '#0f1133' : '#f1f2f7',
        webPreferences: {
            // Seule fenêtre qui affiche le texte d'autres personnes : isolée, pont réduit (chat-preload.ts)
            preload: path.join(__dirname, 'chat-preload.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false
        }
    });
    chatWindow.setMenuBarVisibility(false);
    chatWindow.loadFile(path.join(RENDERER, 'chat.html'), channel ? { query: { channel } } : undefined);
    chatWindow.on('closed', () => {
        chatWindow = null;
    });
}

/** Évènements temps réel relayés aux fenêtres (discussion, panneau d'équipe) */
function broadcastTeamEvent(event: unknown): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('team:event', event);
    }
}

function showTeamNotice(n: TeamNotice): void {
    if (!Notification.isSupported()) return;
    const notice = new Notification({
        title: n.title,
        body: n.body,
        icon: path.join(ROOT_DIR, 'build', 'icon.png'),
        silent: false
    });
    const release = () => liveNotices.delete(notice);
    notice.on('click', () => {
        release();
        if (n.target === 'chat') openChatWindow(n.channel ?? null);
        else showMainWindow();
    });
    notice.on('close', release);
    liveNotices.add(notice);
    // Windows retire la notification du centre de notifications au bout d'un moment
    setTimeout(release, 10 * 60_000).unref?.();
    notice.show();
}

// ---------------------------------------------------------------- Historique (fenêtre)

function openHistoryWindow(): void {
    if (historyWindow) {
        historyWindow.show();
        historyWindow.focus();
        return;
    }
    historyWindow = new BrowserWindow({
        width: 1000,
        height: 760,
        title: 'Historique des journées',
        icon: path.join(ROOT_DIR, 'build', 'icon.png'),
        autoHideMenuBar: true,
        backgroundColor: '#f1f2f7',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: false,
            sandbox: false,
            nodeIntegration: false
        }
    });
    historyWindow.setMenuBarVisibility(false);
    historyWindow.loadFile(path.join(RENDERER, 'history.html'));
    historyWindow.on('closed', () => {
        historyWindow = null;
    });
}

// ---------------------------------------------------------------- Réglages (fenêtre)

function openSettingsWindow(): void {
    if (settingsWindow) {
        settingsWindow.show();
        settingsWindow.focus();
        return;
    }
    settingsWindow = new BrowserWindow({
        width: 840,
        height: 780,
        title: 'Réglages — Pause',
        icon: path.join(ROOT_DIR, 'build', 'icon.png'),
        autoHideMenuBar: true,
        backgroundColor: '#f1f2f7',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: false,
            sandbox: false,
            nodeIntegration: false
        }
    });
    settingsWindow.setMenuBarVisibility(false);
    settingsWindow.loadFile(path.join(RENDERER, 'settings.html'));
    settingsWindow.on('closed', () => {
        settingsWindow = null;
    });
}

function broadcastHistoryChanged(): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('history-changed');
    }
}

// ---------------------------------------------------------------- Horaires salat

function ensureSalatDay(force = false): Promise<any> {
    if (!salatInflight) salatInflight = loadSalatDay(force).finally(() => { salatInflight = null; });
    return salatInflight;
}

async function loadSalatDay(force: boolean): Promise<any> {
    const today = global.moroccoDateKey();
    const salatDay = store.value('salatDay');
    if (!force && salatDay && salatDay.date === today) return salatDay;
    try {
        const fresh = await global.fetchSalatDay(today);
        store.set({ salatDay: fresh, salatError: null });
        return fresh;
    } catch (err: any) {
        console.error('[Pause & Salat] Échec de récupération des horaires :', err);
        store.set({ salatError: String(err?.message || err) });
        return salatDay || null;
    }
}

// ---------------------------------------------------------------- Rappel de prière (fenêtre)

function currentAlert(): any {
    return global.pendingSalatAlert(store.get(global.SALAT_ALERT_KEYS));
}

function scheduleAlert(): void {
    if (alertTimer) {
        clearTimeout(alertTimer);
        alertTimer = null;
    }
    const day = store.value('salatDay');
    const { at, lead } = global.salatAlertSettings(store.get(['salatAlertLead', 'salatAlertAt']));
    const today = global.moroccoDateKey();
    const nowSecs = global.moroccoNowSecs();

    // Débuts des rappels : rappel personnel (heure fixe ou avance) + groupes choisis dans l'équipe
    const starts: number[] = global.teamAlertStarts(store.value('teamDay'), today);
    if (day && day.date === today) {
        if (at != null) starts.push(at * 60);
        else if (lead != null) starts.push(...global.PRAYER_ORDER.map((k) => ((day.times[k] ?? 0) - lead) * 60));
    }
    const nextStart = starts.filter((s) => s > nowSecs).sort((a, b) => a - b)[0];
    if (nextStart === undefined) return;
    const delayMs = (nextStart - nowSecs) * 1000;
    alertTimer = setTimeout(() => {
        dispatchAlert();
        scheduleAlert();
    }, Math.min(delayMs, 2 ** 31 - 1));
}

function dispatchAlert(): void {
    const alert = currentAlert();
    if (!alert) {
        if (alertWindow) {
            alertWindow.destroy();
            alertWindow = null;
        }
        return;
    }
    if (alertWindow) {
        alertWindow.showInactive();
        return;
    }
    // Rappel en plein écran sur l'écran principal (couvre aussi la barre des tâches)
    const { bounds } = screen.getPrimaryDisplay();
    alertWindow = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frame: false,
        fullscreen: true,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: false,
        title: 'Rappel de prière',
        backgroundColor: '#171a3a',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: false,
            sandbox: false,
            nodeIntegration: false
        }
    });
    alertWindow.setAlwaysOnTop(true, 'screen-saver');
    alertWindow.loadFile(path.join(RENDERER, 'alert.html'));
    alertWindow.once('ready-to-show', () => alertWindow?.focus());
    alertWindow.on('closed', () => {
        alertWindow = null;
    });
}

// ---------------------------------------------------------------- Écrans de pause plein écran

function openPauseWindowOn(display: Display): BrowserWindow {
    const b = display.bounds;
    const win = new BrowserWindow({
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        frame: false,
        fullscreen: true,
        kiosk: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        closable: true,
        title: 'Je suis en pause',
        backgroundColor: '#171a3a',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: false,
            sandbox: false,
            nodeIntegration: false
        }
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(RENDERER, 'pause.html'));

    win.on('close', () => {
        if (!quitting && Boolean(store.value('isPaused'))) {
            endPauseNow();
        }
    });
    win.on('leave-full-screen', () => {
        if (Boolean(store.value('isPaused')) && !win.isDestroyed()) {
            win.setFullScreen(true);
        }
    });
    return win;
}

function dispatchPauseScreens(): void {
    const isPaused = Boolean(store.value('isPaused'));
    const isFullscreen = store.value('fullscreenPause') !== false;

    for (const [id, win] of [...pauseWindows]) {
        if (win.isDestroyed()) pauseWindows.delete(id);
    }

    if (!isPaused || !isFullscreen) {
        for (const [id, win] of [...pauseWindows]) {
            win.destroy();
            pauseWindows.delete(id);
        }
        return;
    }

    const displays = screen.getAllDisplays();
    const seen = new Set<string>();
    for (const d of displays) {
        seen.add(String(d.id));
        if (!pauseWindows.has(String(d.id))) {
            pauseWindows.set(String(d.id), openPauseWindowOn(d));
        }
    }
    for (const [id, win] of [...pauseWindows]) {
        if (!seen.has(id)) {
            win.destroy();
            pauseWindows.delete(id);
        }
    }
}

/** Termine la pause en cours, l'enregistre dans l'historique */
async function endPauseNow(): Promise<any> {
    if (!Boolean(store.value('isPaused'))) return { ok: true };

    global.applyDayRulesConfig(store.value(global.DAY_RULES_KEY));
    const s = store.get(['pauseStartTime', 'pauses', 'clockIn', 'workDate', 'isRamadanMode']);
    const pauses = global.recordPause(s.pauses, s.pauseStartTime, Date.now());
    store.set({ isPaused: false, pauseStartTime: null, pauses });

    if (s.workDate) {
        const clockIn = s.clockIn || global.DEFAULT_CLOCK_IN;
        const ramadan = Boolean(s.isRamadanMode);
        const { departureMins } = global.computeDay({ clockIn, dayPauses: pauses, activeSecs: 0, ramadan });
        await history.saveDay({ date: s.workDate, clockIn, ramadan, departure: global.minsToHM(departureMins), pauses });
        if (syncManager && syncManager.getConfig().enabled && syncManager.getConfig().autoSync) {
            syncManager.sync().catch(() => {});
        }
    }
    return { ok: true };
}

/** Ajoute directement une pause de N minutes sans activer le mode plein écran */
async function addQuickPause(mins: number): Promise<any> {
    if (!Number.isFinite(mins) || mins <= 0) return { ok: false, error: 'Durée invalide' };

    global.applyDayRulesConfig(store.value(global.DAY_RULES_KEY));
    const s = store.get(['pauses', 'clockIn', 'workDate', 'isRamadanMode']);
    const nowTs = Date.now();
    const startTs = nowTs - mins * 60 * 1000;
    const today = global.moroccoDateKey();
    const workDate = s.workDate || today;
    const clockIn = s.clockIn || global.DEFAULT_CLOCK_IN;
    const ramadan = Boolean(s.isRamadanMode);

    const pauses = global.recordPause(s.pauses, startTs, nowTs);
    store.set({ pauses, workDate, clockIn });

    const { departureMins } = global.computeDay({ clockIn, dayPauses: pauses, activeSecs: 0, ramadan });
    await history.saveDay({ date: workDate, clockIn, ramadan, departure: global.minsToHM(departureMins), pauses });
    if (syncManager && syncManager.getConfig().enabled && syncManager.getConfig().autoSync) {
        syncManager.sync().catch(() => {});
    }
    return { ok: true, pauses };
}

// ---------------------------------------------------------------- Démarrage automatique

function readRegistryAutoLaunch(): boolean | null {
    try {
        return (app as any).getLoginItemSettings(AUTOSTART_OPTIONS).openAtLogin;
    } catch (err) {
        console.error('[Pause & Salat] Lecture du démarrage automatique impossible :', err);
        return null;
    }
}

function readAutoLaunch(): boolean {
    const reg = readRegistryAutoLaunch();
    if (reg === null) return Boolean(store.value('autoLaunch'));
    if (reg !== Boolean(store.value('autoLaunch'))) store.set({ autoLaunch: reg });
    return reg;
}

// ---------------------------------------------------------------- Démarrage automatique (arrivée)

function archivePreviousDay(): void {
    const s = store.get(['workDate', 'clockIn', 'pauses', 'isRamadanMode']);
    if (!s.workDate) return;
    const clockIn = s.clockIn || global.DEFAULT_CLOCK_IN;
    const ramadan = Boolean(s.isRamadanMode);
    const pauses = s.pauses || [];
    const { departureMins } = global.computeDay({ clockIn, dayPauses: pauses, activeSecs: 0, ramadan });
    history.saveDay({ date: s.workDate, clockIn, ramadan, departure: global.minsToHM(departureMins), pauses });
    if (syncManager && syncManager.getConfig().enabled && syncManager.getConfig().autoSync) {
        syncManager.sync().catch(() => {});
    }
}

function stampArrivalOnBootLaunch(): void {
    if (!process.argv.includes('--autostart')) return;
    const today = global.moroccoDateKey();
    if (store.value('workDate') === today) return;

    archivePreviousDay();
    store.remove(DAY_KEYS);
    store.set({ clockIn: global.formatMoroccoHM(Date.now()), workDate: today });
}

// ---------------------------------------------------------------- Réactions aux changements d'état

function onStoreChanged(changes: StoreChanges): void {
    for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('store-changed', changes);
    }

    if (changes.teamUnread !== undefined) updateTrayTooltip();
    if (changes[global.DAY_RULES_KEY]) global.applyDayRulesConfig(store.value(global.DAY_RULES_KEY));
    if (changes.isPaused !== undefined || changes.fullscreenPause !== undefined) dispatchPauseScreens();
    if (changes.salatDay || changes.salatAlertLead || changes.salatAlertAt || changes.teamDay !== undefined) scheduleAlert();
    if (changes.salatDay || changes.salatAlertLead || changes.salatAlertAt || changes.teamDay !== undefined || changes.salatDismissedKey) dispatchAlert();

    // Enregistrement d'un timestamp de modification de config pour la synchronisation
    if (changes[global.DAY_RULES_KEY] || changes.isRamadanMode || changes.salatAlertLead || changes.salatAlertAt || changes.salatAlertMessage !== undefined || changes.autoLaunch || changes.fullscreenPause !== undefined) {
        store.set({ syncConfigUpdatedAt: Date.now() });
        if (syncManager && syncManager.getConfig().enabled && syncManager.getConfig().autoSync) {
            setTimeout(() => syncManager.sync().catch(() => {}), 3000);
        }
    }
}

// ---------------------------------------------------------------- IPC

function registerIpc(): void {
    ipcMain.on('store:get', (e, keys) => { e.returnValue = store.get(keys); });
    ipcMain.on('store:set', (e, values) => { store.set(values); e.returnValue = true; });
    ipcMain.on('store:remove', (e, keys) => { store.remove(keys); e.returnValue = true; });

    ipcMain.handle('runtime:message', (_e, msg) => handleMessage(msg));
    ipcMain.handle('tabs:create', (_e, url) => {
        if (/history\.html$/.test(String(url))) return openHistoryWindow();
        if (/settings\.html$/.test(String(url))) return openSettingsWindow();
        // Seulement des pages web sécurisées : jamais file:, ni un autre protocole du système
        let target: URL;
        try {
            target = new URL(String(url));
        } catch {
            return undefined;
        }
        if (target.protocol !== 'https:') return undefined;
        return shell.openExternal(target.href);
    });

    // Hauteur de la fenêtre principale = hauteur du contenu, bornée par l'écran
    ipcMain.on('window:fitHeight', (e, height) => {
        if (!mainWindow || e.sender !== mainWindow.webContents) return;
        if (mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
        const h = Math.ceil(Number(height));
        if (!Number.isFinite(h) || h <= 0) return;
        const { workArea } = screen.getDisplayMatching(mainWindow.getBounds());
        const winH = mainWindow.getSize()[1];
        const [contentW, contentH] = mainWindow.getContentSize();
        const maxContentH = workArea.height - (winH - contentH);
        const target = Math.min(h, maxContentH);
        if (target !== contentH) mainWindow.setContentSize(contentW, target);
        // Si la fenêtre déborde en bas de l'écran, on la remonte
        const b = mainWindow.getBounds();
        const overflow = b.y + b.height - (workArea.y + workArea.height);
        if (overflow > 0) mainWindow.setPosition(b.x, Math.max(workArea.y, b.y - overflow));
    });

    // Équipe de prière : les erreurs remontent à la fenêtre avec leur message
    const teamCall = (fn: () => Promise<unknown>) => fn().then(
        (value) => ({ ok: true, value }),
        (err: any) => ({ ok: false, message: String(err?.message || err), code: err?.code ?? 'error' })
    );
    ipcMain.handle('team:join', (_e, code, name) => teamCall(() => teamManager.join(String(code), String(name))));
    ipcMain.handle('team:transfer', (_e, code) => teamCall(() => teamManager.transfer(String(code))));
    ipcMain.handle('team:leave', () => teamCall(() => teamManager.leave()));
    ipcMain.handle('team:choose', (_e, date, prayer, groupId) =>
        teamCall(() => teamManager.choose(String(date), String(prayer), groupId === null ? null : Number(groupId))));
    ipcMain.handle('team:setUsual', (_e, prayer, groupId) =>
        teamCall(() => teamManager.setUsual(String(prayer), groupId === null ? null : Number(groupId))));
    ipcMain.handle('team:refresh', () => teamCall(() => teamManager.refresh(true)));
    ipcMain.handle('team:publish', (_e, date, prayer, slots) => teamCall(() => teamManager.publish(
        String(date), String(prayer),
        (Array.isArray(slots) ? slots : []).map((s: any) => ({ groupId: s?.groupId == null ? null : Number(s.groupId), time: String(s?.time ?? '') }))
    )));
    ipcMain.handle('team:openChat', (_e, channel) => { openChatWindow(channel ? String(channel) : null); });

    // Discussion : la fenêtre ne voit jamais la clé de l'appareil
    ipcMain.handle('chat:channels', () => teamCall(() => teamManager.channels()));
    ipcMain.handle('chat:messages', (_e, channel, before) =>
        teamCall(() => teamManager.messages(String(channel), before == null ? null : Number(before))));
    ipcMain.handle('chat:post', (_e, channel, body, kind, replyToId) => teamCall(() => teamManager.post(
        String(channel), String(body), kind === 'ANNOUNCEMENT' ? 'ANNOUNCEMENT' : 'TEXT', replyToId == null ? null : Number(replyToId))));
    ipcMain.handle('chat:remove', (_e, id) => teamCall(() => teamManager.remove(Number(id))));
    ipcMain.handle('chat:react', (_e, id, emoji) => teamCall(() => teamManager.react(Number(id), String(emoji))));
    ipcMain.handle('chat:markRead', (_e, channel, lastId) => teamCall(() => teamManager.markRead(String(channel), Number(lastId))));

    ipcMain.handle('system:getAutoLaunch', () => readAutoLaunch());
    ipcMain.handle('system:setAutoLaunch', (_e, on) => {
        const enabled = Boolean(on);
        try {
            app.setLoginItemSettings({ openAtLogin: enabled, ...AUTOSTART_OPTIONS });
        } catch (err) {
            console.error('[Pause & Salat] Démarrage automatique impossible :', err);
        }
        store.set({ autoLaunch: enabled });
        const reg = readRegistryAutoLaunch();
        return reg === null ? enabled : reg;
    });

    ipcMain.handle('history:listDays', (_e, opts) => history.listDays(opts || {}));
    ipcMain.handle('history:exportFile', () => history.exportFile());
    ipcMain.handle('history:exportXlsx', async (_e, opts) => {
        const days = await history.listDays(opts || {});
        return generateXlsx(days);
    });
    ipcMain.handle('history:exportCsv', async (_e, opts) => {
        const days = await history.listDays(opts || {});
        return generateCsv(days);
    });

    // Synchronisation (Historique & Configuration)
    ipcMain.handle('sync:getConfig', () => syncManager.getConfig());
    ipcMain.handle('sync:saveConfig', (_e, config) => syncManager.saveConfig(config));
    ipcMain.handle('sync:syncNow', () => syncManager.sync());
    ipcMain.handle('sync:chooseFolder', (e) => syncManager.chooseFolder(BrowserWindow.fromWebContents(e.sender)));
    ipcMain.handle('sync:openFolder', (_e, folderPath) => {
        const p = folderPath || syncManager.getConfig().folderPath;
        if (p && require('fs').existsSync(p)) return shell.openPath(p);
        return false;
    });
    ipcMain.handle('sync:exportPackage', () => syncManager.exportSyncPackage());
    ipcMain.handle('sync:importPackage', (_e, jsonStr) => syncManager.importSyncPackage(jsonStr));
    ipcMain.handle('sync:getStatus', () => syncManager.getStatus());
}

function handleMessage(msg: any): Promise<any> {
    switch (msg && msg.type) {
        case 'salat:ensure': return ensureSalatDay(Boolean(msg.force));
        case 'pause:stop': return endPauseNow();
        case 'pause:quickAdd': return addQuickPause(Number(msg.mins));
        case 'history:saveDay': return history.saveDay(msg.day);
        case 'history:deleteDay': return history.deleteDay(msg.date);
        default: return Promise.resolve(null);
    }
}
