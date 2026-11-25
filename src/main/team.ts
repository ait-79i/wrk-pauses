// Équipe de prière (serveur Pause) : adhésion, horaires du jour, choix de groupe,
// discussion et temps réel (contrat : docs/contrat-api-phases-2-3.md).
// La clé de l'appareil (ADR 0001) est chiffrée par Windows (safeStorage) dans un fichier à part :
// elle ne passe jamais par le stockage partagé avec les fenêtres ni par la synchronisation.
// Les fenêtres n'appellent le serveur qu'à travers ce module (IPC) : elles ne voient jamais la clé.
// Vocabulaire : GLOSSARY.md.

import { safeStorage } from 'electron';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';
import { TeamChannel, TeamDay, TeamInfo, TeamMessage, TeamNotice, TeamRealtime } from './types';

const DEFAULT_SERVER = 'https://pause.8hqi.com';
const DAY_REFRESH_MS = 60_000;
const PROFILE_REFRESH_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const WS_BACKOFF_MIN_MS = 1_000;
const WS_BACKOFF_MAX_MS = 30_000;
const WS_AUTH_REFUSED = 4401;
const CHANNELS_DEBOUNCE_MS = 400;
/** Le serveur envoie un ping toutes les 30 s : sans aucun message pendant 75 s, la connexion est morte */
const WS_WATCHDOG_MS = 35_000;
const WS_SILENCE_MAX_MS = 75_000;
/** Une publication faite d'ici ne déclenche pas de notification chez son auteur */
const OWN_PUBLISH_MS = 30_000;
const PRAYER_LATIN: Record<string, string> = { DHUHR: 'Dhuhr', ASR: 'Asr', JUMUA: 'Jumu\'a' };

export class TeamError extends Error {
    constructor(message: string, public status = 0, public code = 'error') {
        super(message);
    }
}

const hhmm = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const excerpt = (text: string, max = 120) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Événements émis :
 * - 'event' (évènement brut du serveur, relayé aux fenêtres de discussion)
 * - 'notify' (TeamNotice : notification Windows à afficher)
 */
export class TeamManager extends EventEmitter {
    private readonly server: string;
    private readonly keyFile: string;
    private token: string | null = null;
    private dayTimer: NodeJS.Timeout | null = null;
    private lastProfile = 0;
    private running = false;

    // Temps réel
    private ws: WebSocket | null = null;
    private wsRetry: NodeJS.Timeout | null = null;
    private wsBackoff = WS_BACKOFF_MIN_MS;
    private channelsTimer: NodeJS.Timeout | null = null;
    private notified = new Set<number>(); // messages déjà notifiés (annonce + mention)
    private lastFrameAt = 0;
    private watchdog: NodeJS.Timeout | null = null;
    private ownPublishes = new Map<string, number>(); // date|prière -> horodatage
    private lastMutedUntil: string | null | undefined = undefined; // undefined : pas encore connu

    constructor(private store: Store, userDataDir: string) {
        super();
        // PAUSE_SERVER_URL : serveur de développement (ex. http://127.0.0.1:3100)
        this.server = (process.env.PAUSE_SERVER_URL || DEFAULT_SERVER).replace(/\/+$/, '');
        this.keyFile = path.join(userDataDir, 'team-key.bin');
        this.token = this.readToken();
    }

    get joined(): boolean {
        return this.token !== null;
    }

    /** Démarre l'actualisation périodique des horaires du jour et la connexion temps réel */
    start(): void {
        this.running = true;
        if (this.dayTimer) clearInterval(this.dayTimer);
        this.dayTimer = setInterval(() => void this.refresh().catch(() => {}), DAY_REFRESH_MS);
        if (this.watchdog) clearInterval(this.watchdog);
        this.watchdog = setInterval(() => this.checkAlive(), WS_WATCHDOG_MS);
        void this.refresh(true).catch(() => {});
        this.connect();
    }

    stop(): void {
        this.running = false;
        if (this.dayTimer) clearInterval(this.dayTimer);
        this.dayTimer = null;
        if (this.watchdog) clearInterval(this.watchdog);
        this.watchdog = null;
        this.disconnect();
    }

    /** Sortie de veille ou changement de réseau : nouvelle connexion tout de suite, horaires relus */
    reconnectNow(): void {
        if (!this.running || !this.token) return;
        this.disconnect();
        this.connect();
        void this.refresh(true).catch(() => {});
    }

    // ---------------------------------------------------------------- Clé de l'appareil

    private readToken(): string | null {
        try {
            if (!fs.existsSync(this.keyFile)) return null;
            const raw = fs.readFileSync(this.keyFile);
            return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
        } catch (err) {
            console.error('[Pause & Salat] Clé d\'équipe illisible :', err);
            return null;
        }
    }

    private writeToken(token: string | null): void {
        this.token = token;
        if (token === null) {
            fs.rmSync(this.keyFile, { force: true });
            this.disconnect();
            return;
        }
        const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, 'utf8');
        fs.writeFileSync(this.keyFile, data, { mode: 0o600 });
        // Nouvelle clé : nouvelle connexion temps réel
        this.disconnect();
        this.connect();
    }

    /** Efface l'équipe de cet ordinateur (départ, clé refusée) */
    private forget(teamError: string | null): void {
        this.writeToken(null);
        this.store.set({ team: null, teamDay: null, teamError, teamChannels: [], teamUnread: 0, teamRealtime: null });
    }

    // ---------------------------------------------------------------- Requêtes

    private async request<T>(method: string, route: string, body?: unknown, auth = true): Promise<T> {
        const headers: Record<string, string> = {};
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (auth) {
            if (!this.token) throw new TeamError('Cet ordinateur n\'est relié à aucune équipe.', 401, 'unauthorized');
            headers.authorization = `Bearer ${this.token}`;
        }
        let res: Response;
        try {
            res = await fetch(`${this.server}/api/app${route}`, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
        } catch {
            throw new TeamError('Serveur de l\'équipe injoignable. Vérifiez votre connexion internet.', 0, 'network');
        }
        const data: any = await res.json().catch(() => null);
        if (!res.ok) {
            throw new TeamError(data?.message ?? `Erreur du serveur (${res.status}).`, res.status, data?.error ?? 'error');
        }
        return data as T;
    }

    /** Requête authentifiée : une clé refusée fait oublier l'équipe */
    private call<T>(method: string, route: string, body?: unknown): Promise<T> {
        return this.request<T>(method, route, body).catch((e) => this.handleAuthError(e));
    }

    /** Clé refusée (membre supprimé) : on oublie l'équipe localement, puis on relance l'erreur */
    private async handleAuthError(err: unknown): Promise<never> {
        if (err instanceof TeamError && err.status === 401 && this.token) {
            this.forget(err.message);
        }
        throw err;
    }

    // ---------------------------------------------------------------- Actions

    async join(code: string, name: string): Promise<TeamInfo | null> {
        const r = await this.request<{ token: string }>('POST', '/join', { code, name }, false);
        this.writeToken(r.token);
        this.store.set({ teamError: null });
        await this.refresh(true);
        return this.store.value('team') ?? null;
    }

    async transfer(code: string): Promise<TeamInfo | null> {
        const r = await this.request<{ token: string }>('POST', '/transfer', { code }, false);
        this.writeToken(r.token);
        this.store.set({ teamError: null });
        await this.refresh(true);
        return this.store.value('team') ?? null;
    }

    async leave(): Promise<void> {
        try {
            await this.request('POST', '/leave');
        } catch (err) {
            // Serveur injoignable : on quitte quand même sur cet ordinateur
            console.warn('[Pause & Salat] Départ de l\'équipe sans confirmation du serveur :', err);
        }
        this.forget(null);
    }

    async choose(date: string, prayer: string, groupId: number | null): Promise<TeamDay> {
        const day = await this.call<TeamDay>('PUT', '/choice', { date, prayer, groupId });
        this.store.set({ teamDay: day, teamError: null });
        return day;
    }

    async setUsual(prayer: string, groupId: number | null): Promise<void> {
        await this.call('PUT', '/usual', { prayer, groupId });
        await this.refresh();
    }

    /** Publication des horaires du jour (admins et responsables horaires). time : 'HH:MM' */
    async publish(date: string, prayer: string, slots: { groupId: number | null; time: string }[]): Promise<TeamDay> {
        // Avant l'appel : la carte SCHEDULE peut arriver par le temps réel avant la réponse
        this.ownPublishes.set(`${date}|${prayer}`, Date.now());
        const day = await this.call<TeamDay>('POST', '/publish', { date, prayer, slots });
        this.store.set({ teamDay: day, teamError: null });
        return day;
    }

    /**
     * Actualise le profil (toutes les 10 min) et les horaires du jour.
     * Hors ligne, les dernières données restent en place : le rappel continue de fonctionner.
     */
    async refresh(forceProfile = false): Promise<void> {
        if (!this.token) return;
        try {
            if (forceProfile || Date.now() - this.lastProfile > PROFILE_REFRESH_MS) {
                const me = await this.request<any>('GET', '/me');
                const team: TeamInfo = {
                    memberId: me.member.id,
                    memberName: me.member.name,
                    status: me.member.status,
                    teamId: me.team.id,
                    teamName: me.team.name,
                    categoryId: me.category.id,
                    categoryName: me.category.name,
                    canPublish: Boolean(me.canPublish),
                    accessCode: me.accessCode?.code ?? null,
                    accessCodeExpiresAt: me.accessCode?.expiresAt ?? null
                };
                this.store.set({ team });
                this.lastProfile = Date.now();
                if (team.status !== 'ACTIVE') {
                    this.store.set({ teamDay: null, teamError: null, teamChannels: [], teamUnread: 0 });
                    return;
                }
                this.scheduleChannels(0);
            }
            const day = await this.request<TeamDay>('GET', '/day');
            this.store.set({ teamDay: day, teamError: null });
        } catch (err) {
            if (err instanceof TeamError && err.status === 403) {
                // Bloqué ou en attente de validation : le profil sera relu, plus d'horaires
                this.lastProfile = 0;
                this.store.set({ teamDay: null, teamError: err.message });
                return;
            }
            if (err instanceof TeamError && err.status === 0) {
                this.store.set({ teamError: err.message });
                return;
            }
            await this.handleAuthError(err);
        }
    }

    // ---------------------------------------------------------------- Discussion

    /** Canaux visibles + total non lu, gardés dans le stockage (teamChannels, teamUnread) */
    async channels(): Promise<TeamChannel[]> {
        const r = await this.call<{ channels: TeamChannel[] }>('GET', '/channels');
        this.setChannels(r.channels);
        return r.channels;
    }

    async messages(channel: string, before?: number | null): Promise<{ messages: TeamMessage[]; hasMore: boolean }> {
        const q = new URLSearchParams({ channel, limit: '50' });
        if (before) q.set('before', String(before));
        return this.call('GET', `/messages?${q}`);
    }

    async post(channel: string, body: string, kind: 'TEXT' | 'ANNOUNCEMENT', replyToId: number | null): Promise<TeamMessage> {
        const payload: Record<string, unknown> = { channel, body, kind };
        if (replyToId) payload.replyToId = replyToId;
        return this.call<TeamMessage>('POST', '/messages', payload);
    }

    async remove(id: number): Promise<void> {
        await this.call('DELETE', `/messages/${id}`);
    }

    async react(id: number, emoji: string): Promise<TeamMessage> {
        return this.call<TeamMessage>('PUT', `/messages/${id}/reactions`, { emoji });
    }

    async markRead(channel: string, lastMessageId: number): Promise<void> {
        await this.call('POST', '/read', { channel, lastMessageId });
        const list = (this.store.value('teamChannels') ?? []) as TeamChannel[];
        this.setChannels(list.map((c) => (c.key === channel ? { ...c, unread: 0 } : c)));
    }

    private setChannels(list: TeamChannel[]): void {
        const unread = list.reduce((n, c) => n + (Number(c.unread) || 0), 0);
        this.store.set({ teamChannels: list, teamUnread: unread });
    }

    /** Relecture groupée des canaux (plusieurs messages d'affilée = un seul appel) */
    private scheduleChannels(delay = CHANNELS_DEBOUNCE_MS): void {
        if (this.channelsTimer) clearTimeout(this.channelsTimer);
        this.channelsTimer = setTimeout(() => {
            this.channelsTimer = null;
            if (this.token) void this.channels().catch(() => {});
        }, delay);
    }

    // ---------------------------------------------------------------- Temps réel (WebSocket)

    private wsUrl(): string {
        return `${this.server.replace(/^http/i, 'ws')}/api/app/ws`;
    }

    private setRealtime(state: TeamRealtime | null): void {
        if (this.store.value('teamRealtime') !== state) this.store.set({ teamRealtime: state });
    }

    /**
     * Connexion à moitié ouverte (veille, changement de Wi-Fi, NAT) : aucun 'close' n'arrive.
     * Sans message du serveur depuis 75 s (ping toutes les 30 s), on la ferme et on se reconnecte.
     */
    private checkAlive(): void {
        const ws = this.ws;
        if (!ws || Date.now() - this.lastFrameAt <= WS_SILENCE_MAX_MS) return;
        this.ws = null;
        try {
            ws.close();
        } catch {
            // déjà fermée
        }
        this.setRealtime('offline');
        this.retryLater();
    }

    private connect(): void {
        if (!this.running || !this.token || this.ws || this.wsRetry) return;
        this.lastFrameAt = Date.now();
        if (this.store.value('teamRealtime') !== 'offline') this.setRealtime('connecting');
        let ws: WebSocket;
        try {
            ws = new WebSocket(this.wsUrl());
        } catch (err) {
            console.warn('[Pause & Salat] Connexion temps réel impossible :', err);
            this.retryLater();
            return;
        }
        this.ws = ws;
        const token = this.token;
        ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
        ws.addEventListener('message', (e) => {
            if (this.ws !== ws) return;
            this.lastFrameAt = Date.now();
            let data: any;
            try {
                data = JSON.parse(String(e.data));
            } catch {
                return;
            }
            if (data?.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
            }
            this.onServerEvent(data);
        });
        ws.addEventListener('close', (e) => {
            if (this.ws !== ws) return;
            this.ws = null;
            if (e.code === WS_AUTH_REFUSED && this.token === token) {
                // Clé refusée : même traitement qu'une réponse 401
                this.forget('Votre accès à l\'équipe a été retiré. Rejoignez-la à nouveau avec un code d\'accès.');
                return;
            }
            this.setRealtime('offline');
            this.retryLater();
        });
        // 'error' est toujours suivi de 'close' : la reconnexion part de là
        ws.addEventListener('error', () => {});
    }

    private retryLater(): void {
        if (!this.running || !this.token || this.wsRetry) return;
        const delay = this.wsBackoff;
        this.wsBackoff = Math.min(this.wsBackoff * 2, WS_BACKOFF_MAX_MS);
        this.wsRetry = setTimeout(() => {
            this.wsRetry = null;
            this.connect();
        }, delay);
    }

    private disconnect(): void {
        if (this.token === null) this.setRealtime(null);
        if (this.wsRetry) clearTimeout(this.wsRetry);
        this.wsRetry = null;
        this.wsBackoff = WS_BACKOFF_MIN_MS;
        const ws = this.ws;
        this.ws = null;
        if (ws) {
            try {
                ws.close(1000);
            } catch {
                // déjà fermée
            }
        }
    }

    private me(): TeamInfo | null {
        return (this.store.value('team') as TeamInfo | null | undefined) ?? null;
    }

    private isMine(m: TeamMessage): boolean {
        const me = this.me();
        return Boolean(me && m.author.type === 'member' && m.author.id === me.memberId);
    }

    private onServerEvent(data: any): void {
        const type = String(data?.type ?? '');
        if (type === 'ready') {
            this.wsBackoff = WS_BACKOFF_MIN_MS;
            this.setRealtime('open');
            // Évènements manqués pendant la coupure : on relit tout
            this.scheduleChannels(0);
            void this.refresh().catch(() => {});
        } else if (type === 'message.created' && data.message) {
            const m = data.message as TeamMessage;
            if (!this.isMine(m)) {
                this.scheduleChannels();
                if (m.kind === 'ANNOUNCEMENT') {
                    this.notifyOnce(m, `Annonce de ${m.author.name}`);
                } else if (m.kind === 'SCHEDULE' && m.schedule && m.channel === `cat:${this.me()?.categoryId}`
                    && !this.isOwnPublish(m.schedule.date, m.schedule.prayer)) {
                    this.notifySchedule(m);
                }
            }
        } else if (type === 'message.updated') {
            this.scheduleChannels();
        } else if (type === 'mention' && data.message) {
            const m = data.message as TeamMessage;
            if (!this.isMine(m)) this.notifyOnce(m, `${m.author.name} vous a mentionné`);
        } else if (type === 'schedule.changed') {
            if (Number(data.categoryId) === this.me()?.categoryId) void this.refresh().catch(() => {});
        } else if (type === 'member.status') {
            this.onMemberStatus(String(data.status), data.mutedUntil ?? null);
        }
        this.emit('event', data);
    }

    private isOwnPublish(date: string, prayer: string): boolean {
        const now = Date.now();
        for (const [k, t] of this.ownPublishes) if (now - t > OWN_PUBLISH_MS) this.ownPublishes.delete(k);
        return this.ownPublishes.has(`${date}|${prayer}`);
    }

    private onMemberStatus(status: string, mutedUntil: string | null): void {
        const before = this.me();
        const known = status === 'ACTIVE' || status === 'BLOCKED' || status === 'PENDING';
        if (this.lastMutedUntil === undefined) {
            // Premier évènement : silence déjà connu par la liste des canaux
            const list = (this.store.value('teamChannels') ?? []) as TeamChannel[];
            this.lastMutedUntil = list[0]?.mutedUntil ?? null;
        }
        const mutedChanged = mutedUntil !== this.lastMutedUntil;
        this.lastMutedUntil = mutedUntil;
        if (before && known && before.status !== status) {
            if (status === 'ACTIVE') {
                this.notify({ title: 'Accès validé', body: 'Vous pouvez choisir votre groupe et écrire dans la discussion.', target: 'main' });
            } else if (status === 'BLOCKED') {
                this.notify({ title: 'Accès suspendu', body: 'Un admin a suspendu votre accès à l\'équipe. Contactez-le pour le rétablir.', target: 'main' });
            }
            // GET /me répond 403 à un membre suspendu : le nouveau statut est enregistré ici
            this.store.set({ team: { ...before, status: status as TeamInfo['status'] } });
            if (status !== 'ACTIVE') this.store.set({ teamDay: null, teamChannels: [], teamUnread: 0 });
        } else if (before && mutedChanged && mutedUntil && new Date(mutedUntil).getTime() > Date.now()) {
            const until = new Date(mutedUntil).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            this.notify({ title: 'Discussion en lecture seule', body: `Un admin vous a réduit au silence jusqu'à ${until}.`, target: 'chat' });
        }
        // Profil (catégorie, nom, rôles), horaires et droits d'écriture relus
        void this.refresh(true).catch(() => {});
    }

    // ---------------------------------------------------------------- Notifications

    private notify(n: TeamNotice): void {
        if (this.store.value('teamNotifications') === false) return;
        this.emit('notify', n);
    }

    private notifyOnce(m: TeamMessage, title: string): void {
        if (this.notified.has(m.id)) return;
        this.notified.add(m.id);
        if (this.notified.size > 200) this.notified.delete(this.notified.values().next().value as number);
        this.notify({ title, body: excerpt(m.body), target: 'chat', channel: m.channel });
    }

    private notifySchedule(m: TeamMessage): void {
        const s = m.schedule!;
        const day = this.store.value('teamDay') as TeamDay | null | undefined;
        const today = day?.today ?? null;
        // Une publication pour un jour passé n'intéresse personne
        if (today && s.date < today) return;
        this.notify({
            title: s.change === 'updated' ? 'Horaires modifiés' : 'Horaires publiés',
            body: describeSchedule(s, day ?? null),
            target: 'main'
        });
    }
}

/**
 * Texte d'une publication : « Dhuhr : G1 12:26, G2 12:36 », « Dhuhr : G2 déplacé à 12:40 »,
 * précédé de « Votre groupe G3 est retiré. Choisissez-en un autre. » si mon groupe disparaît.
 */
export function describeSchedule(s: NonNullable<TeamMessage['schedule']>, day: TeamDay | null): string {
    const dated = day && s.date !== day.today ? ` (${s.date.slice(8, 10)}/${s.date.slice(5, 7)})` : '';
    const head = `${PRAYER_LATIN[s.prayer] ?? s.prayer}${dated}`;
    if (s.prayer === 'JUMUA') return `${head} à ${hhmm(s.slots[0]?.timeMins ?? 0)}`;

    const name = (id: number) => s.slots.find((x) => x.groupId === id)?.groupName
        ?? day?.groups.find((g) => g.id === id)?.name
        ?? 'Un groupe';
    const mine = day && day.date === s.date ? day.prayers.find((p) => p.prayer === s.prayer)?.myGroupId ?? null : null;
    const lost = mine !== null && s.removedGroupIds.includes(mine)
        ? `Votre groupe ${name(mine)} est retiré. Choisissez-en un autre. `
        : '';
    const changes: string[] = [];
    if (s.change === 'updated') {
        for (const id of s.movedGroupIds) {
            const slot = s.slots.find((x) => x.groupId === id);
            if (slot) changes.push(`${name(id)} déplacé à ${hhmm(slot.timeMins)}`);
        }
        for (const id of s.addedGroupIds ?? []) {
            const slot = s.slots.find((x) => x.groupId === id);
            if (slot) changes.push(`${name(id)} ajouté à ${hhmm(slot.timeMins)}`);
        }
        for (const id of s.removedGroupIds) if (id !== mine) changes.push(`${name(id)} retiré`);
    }
    const list = changes.length ? changes : s.slots.map((x) => `${x.groupName ?? ''} ${hhmm(x.timeMins)}`.trim());
    return `${lost}${head} : ${list.join(', ')}`;
}
