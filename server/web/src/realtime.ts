// Temps réel du tableau de bord : une seule connexion WebSocket (/api/admin/ws, cookie de session)
// partagée par tous les écrans abonnés. Reconnexion avec un délai croissant (1 s → 30 s).

import { useEffect, useRef, useState } from 'react';
import type { MessageDTO, Prayer } from './api';

export type RealtimeEvent =
    | { type: 'ready' }
    | { type: 'message.created'; message: MessageDTO }
    | { type: 'message.updated'; message: MessageDTO }
    | {
        type: 'schedule.changed'; categoryId: number; date: string; prayer: Prayer;
        change: 'published' | 'updated'; movedGroupIds: number[]; removedGroupIds: number[]; addedGroupIds?: number[];
    }
    | { type: 'mention'; message: MessageDTO };

export type RealtimeStatus = 'connecting' | 'open' | 'closed';

type Listener = (event: RealtimeEvent) => void;

const listeners = new Set<Listener>();
const statusListeners = new Set<(s: RealtimeStatus) => void>();
let socket: WebSocket | null = null;
let status: RealtimeStatus = 'closed';
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(s: RealtimeStatus) {
    status = s;
    statusListeners.forEach((l) => l(s));
}

function dispatch(event: RealtimeEvent) {
    listeners.forEach((l) => {
        try {
            l(event);
        } catch (err) {
            console.error('Événement temps réel non traité', err);
        }
    });
}

function connect() {
    if (socket || listeners.size === 0) return;
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/admin/ws`;
    let ws: WebSocket;
    try {
        ws = new WebSocket(url);
    } catch {
        scheduleRetry();
        return;
    }
    socket = ws;
    setStatus('connecting');

    ws.onmessage = (e) => {
        let data: { type?: string };
        try {
            data = JSON.parse(String(e.data));
        } catch {
            return;
        }
        if (data.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
        }
        if (data.type === 'ready') {
            attempt = 0;
            setStatus('open');
        }
        if (typeof data.type === 'string') dispatch(data as RealtimeEvent);
    };
    ws.onclose = () => {
        if (socket === ws) socket = null;
        setStatus('closed');
        scheduleRetry();
    };
    ws.onerror = () => ws.close();
}

function scheduleRetry() {
    if (retryTimer || listeners.size === 0) return;
    const delay = Math.min(30_000, 1000 * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
    }, delay);
}

function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    connect();
    return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        // Garde la connexion quelques secondes : un changement d'écran se réabonne aussitôt
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (listeners.size > 0) return;
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = null;
            attempt = 0;
            const ws = socket;
            socket = null;
            ws?.close();
        }, 5000);
    };
}

/** Appelle `handler` à chaque événement du serveur (la dernière version du handler est toujours utilisée) */
export function useRealtime(handler: Listener) {
    const ref = useRef(handler);
    ref.current = handler;
    useEffect(() => subscribe((e) => ref.current(e)), []);
}

/** État de la connexion, pour signaler une discussion hors ligne */
export function useRealtimeStatus(): RealtimeStatus {
    const [s, setS] = useState(status);
    useEffect(() => {
        statusListeners.add(setS);
        setS(status);
        return () => { statusListeners.delete(setS); };
    }, []);
    return s;
}
