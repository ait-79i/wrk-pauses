// Pont de la fenêtre « Discussion » (contextIsolation + sandbox).
// C'est la seule fenêtre qui affiche du texte écrit par d'autres personnes : elle ne reçoit que
// ce dont chat.js a besoin. Pas de chrome.tabs, pas d'accès à tout le stockage, pas de clé d'appareil.

import { contextBridge, ipcRenderer } from 'electron';

/** Clés du stockage lisibles par la discussion */
const READABLE = ['team', 'teamDay', 'teamChannels', 'teamRealtime', 'isRamadanMode'];

function pick(values: Record<string, unknown> | null | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!values) return out;
    for (const k of READABLE) if (k in values) out[k] = values[k];
    return out;
}

const storeListeners = new Set<(changes: Record<string, unknown>) => void>();
ipcRenderer.on('store-changed', (_e, changes) => {
    const visible = pick(changes);
    if (!Object.keys(visible).length) return;
    for (const fn of storeListeners) {
        try {
            fn(visible);
        } catch (err) {
            console.error(err);
        }
    }
});

contextBridge.exposeInMainWorld('psStore', {
    /** Lecture de quelques clés autorisées */
    get: (keys: string[]): Promise<Record<string, unknown>> => {
        const wanted = (Array.isArray(keys) ? keys : []).map(String).filter((k) => READABLE.includes(k));
        return Promise.resolve(pick(ipcRenderer.sendSync('store:get', wanted)));
    },
    /** Changements des clés autorisées ({ clé: { newValue } }) ; renvoie la fonction de désabonnement */
    onChanged: (cb: (changes: Record<string, unknown>) => void): (() => void) => {
        storeListeners.add(cb);
        return () => storeListeners.delete(cb);
    }
});

// Choix de groupe depuis une carte d'horaires
contextBridge.exposeInMainWorld('psTeam', {
    choose: (date: string, prayer: string, groupId: number | null) =>
        ipcRenderer.invoke('team:choose', String(date), String(prayer), groupId === null ? null : Number(groupId)),
    /** Écran de choix : l'utilisateur ne prie pas avec un groupe pour cette prière */
    dismissChoice: (date: string, prayer: string) => ipcRenderer.invoke('team:dismissChoice', String(date), String(prayer))
});

// Discussion : retours { ok, value } / { ok: false, message } (la clé reste dans le processus principal)
contextBridge.exposeInMainWorld('psChat', {
    /** Ferme la discussion ancrée à droite de la fenêtre principale */
    closeDock: () => ipcRenderer.invoke('chat:closeDock'),
    channels: () => ipcRenderer.invoke('chat:channels'),
    messages: (channel: string, before?: number | null) => ipcRenderer.invoke('chat:messages', String(channel), before ?? null),
    post: (channel: string, body: string, kind?: 'TEXT' | 'ANNOUNCEMENT', replyToId?: number | null) =>
        ipcRenderer.invoke('chat:post', String(channel), String(body), kind ?? 'TEXT', replyToId ?? null),
    remove: (id: number) => ipcRenderer.invoke('chat:remove', Number(id)),
    react: (id: number, emoji: string) => ipcRenderer.invoke('chat:react', Number(id), String(emoji)),
    markRead: (channel: string, lastId: number) => ipcRenderer.invoke('chat:markRead', String(channel), Number(lastId)),
    /** Évènements temps réel du serveur ({ type, ... }) ; renvoie la fonction de désabonnement */
    onEvent: (cb: (event: unknown) => void): (() => void) => {
        const handler = (_e: unknown, event: unknown) => cb(event);
        ipcRenderer.on('team:event', handler);
        return () => ipcRenderer.removeListener('team:event', handler);
    },
    /** Demande d'ouverture d'un canal précis (clic sur une notification) */
    onOpenChannel: (cb: (channel: string) => void): (() => void) => {
        const handler = (_e: unknown, channel: string) => cb(String(channel));
        ipcRenderer.on('chat:openChannel', handler);
        return () => ipcRenderer.removeListener('chat:openChannel', handler);
    }
});
