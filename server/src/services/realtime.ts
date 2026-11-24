// Temps réel : connexions WebSocket de l'application et du tableau de bord (contrat §5).
// Les destinataires sont recalculés depuis la base à chaque envoi : un changement de rôle,
// de catégorie ou de statut s'applique sans reconnexion.

import type { WebSocket } from 'ws';
import type { Db } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { hashToken } from '../lib/security.js';
import {
    adminFromSession, adminSessionInclude, canView, createScheduleMessage, memberFromToken, toDTO, toMemberActor,
    type Actor, type AdminActor, type ChannelRef, type MemberActor, type MessageRow, type ScheduleCard
} from './chat.js';

const PING_MS = 30_000;
const AUTH_TIMEOUT_MS = 10_000;
/** Connexion fermée après 2 ping sans réponse */
const MAX_MISSED = 2;
export const CLOSE_UNAUTHORIZED = 4401;
/** Connexions en attente d'authentification : par adresse IP et au total */
const MAX_PENDING_PER_IP = 50;
const MAX_PENDING_TOTAL = 1000;
/** Connexions authentifiées par membre ou par session : les plus anciennes sont fermées */
const MAX_PER_ACTOR = 3;
/** Fermeture d'une connexion remplacée par une plus récente du même acteur */
export const CLOSE_REPLACED = 4000;

interface Client {
    socket: WebSocket;
    kind: 'member' | 'admin';
    /** memberId ou adminId */
    id: number;
    /** Session du tableau de bord (admins) */
    sessionId?: number;
    /** Empreinte de la clé d'appareil utilisée (membres) : une clé remplacée coupe la connexion */
    tokenHash?: string;
    missed: number;
}

type Outgoing = { type: string } & Record<string, unknown>;

export class RealtimeHub {
    private clients = new Set<Client>();
    /** Connexions pas encore authentifiées, par adresse IP */
    private pending = new Map<string, number>();
    private pendingTotal = 0;
    private timer: NodeJS.Timeout | null = null;

    constructor(private db: Db, private log: (err: unknown, msg: string) => void = () => undefined) {}

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => this.heartbeat(), PING_MS);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        for (const c of this.clients) c.socket.close(1001, 'Arrêt du serveur');
        this.clients.clear();
    }

    /** Nombre de connexions ouvertes (diagnostic et tests) */
    get size(): number {
        return this.clients.size;
    }

    private heartbeat(): void {
        for (const c of this.clients) {
            if (c.missed >= MAX_MISSED) {
                c.socket.terminate();
                this.clients.delete(c);
                continue;
            }
            c.missed++;
            this.send(c, { type: 'ping' });
        }
    }

    private send(c: Client, payload: Outgoing): void {
        if (c.socket.readyState !== c.socket.OPEN) return;
        try {
            c.socket.send(JSON.stringify(payload));
        } catch (err) {
            this.log(err, 'Envoi WebSocket impossible');
        }
    }

    /** Messages du client après authentification : pong (et ping de courtoisie) */
    private listen(c: Client): void {
        c.socket.on('message', (raw) => {
            const msg = parseFrame(raw);
            if (!msg) return;
            if (msg.type === 'pong') c.missed = 0;
            else if (msg.type === 'ping') {
                c.missed = 0;
                this.send(c, { type: 'pong' });
            }
        });
        c.socket.on('close', () => this.clients.delete(c));
        c.socket.on('error', () => this.clients.delete(c));
    }

    /** Ajoute une connexion authentifiée ; au-delà de MAX_PER_ACTOR, les plus anciennes du même acteur sont fermées */
    private admit(client: Client): void {
        const same = [...this.clients].filter((c) => c.kind === client.kind
            && (client.kind === 'member' ? c.id === client.id : c.sessionId === client.sessionId));
        for (const old of same.slice(0, Math.max(0, same.length - MAX_PER_ACTOR + 1))) {
            old.socket.close(CLOSE_REPLACED, 'Connexion remplacée');
            this.clients.delete(old);
        }
        this.clients.add(client);
        this.listen(client);
        this.send(client, { type: 'ready' });
    }

    /** Application : le premier message doit être { type: 'auth', token } dans les 10 s */
    attachMember(socket: WebSocket, ip = ''): void {
        const waiting = this.pending.get(ip) ?? 0;
        if (waiting >= MAX_PENDING_PER_IP || this.pendingTotal >= MAX_PENDING_TOTAL) {
            socket.close(1013, 'Trop de connexions, réessayez plus tard');
            return;
        }
        this.pending.set(ip, waiting + 1);
        this.pendingTotal++;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            this.pendingTotal--;
            const n = (this.pending.get(ip) ?? 1) - 1;
            if (n > 0) this.pending.set(ip, n);
            else this.pending.delete(ip);
        };
        let done = false;
        const timeout = setTimeout(() => {
            if (!done) socket.close(CLOSE_UNAUTHORIZED, 'Authentification attendue');
        }, AUTH_TIMEOUT_MS);
        socket.once('message', async (raw) => {
            done = true;
            clearTimeout(timeout);
            const msg = parseFrame(raw);
            const token = msg?.type === 'auth' && typeof msg.token === 'string' ? msg.token : '';
            try {
                const member = await memberFromToken(this.db, token);
                release();
                if (!member) {
                    socket.close(CLOSE_UNAUTHORIZED, 'Clé refusée');
                    return;
                }
                if (socket.readyState !== socket.OPEN) return;
                // Un membre en attente ou suspendu reste connecté : il reçoit seulement member.status
                this.admit({ socket, kind: 'member', id: member.id, tokenHash: hashToken(token), missed: 0 });
            } catch (err) {
                release();
                this.log(err, 'Authentification WebSocket impossible');
                socket.close(1011, 'Erreur du serveur');
            }
        });
        socket.on('close', () => {
            clearTimeout(timeout);
            release();
        });
    }

    /** Tableau de bord : session déjà vérifiée par la route (cookie) */
    attachAdmin(socket: WebSocket, admin: AdminActor): void {
        this.admit({ socket, kind: 'admin', id: admin.id, sessionId: admin.sessionId, missed: 0 });
    }

    /** Ferme tout de suite les connexions d'un membre (clé remplacée, membre supprimé ou parti) */
    closeMember(memberId: number): void {
        for (const c of this.clients) {
            if (c.kind !== 'member' || c.id !== memberId) continue;
            c.socket.close(CLOSE_UNAUTHORIZED, 'Accès refusé');
            this.clients.delete(c);
        }
    }

    /** Acteurs connectés (rechargés depuis la base), les connexions refusées sont fermées */
    private async connectedActors(): Promise<{ client: Client; actor: Actor }[]> {
        const clients = [...this.clients];
        const memberIds = [...new Set(clients.filter((c) => c.kind === 'member').map((c) => c.id))];
        const sessionIds = [...new Set(clients.filter((c) => c.kind === 'admin').map((c) => c.sessionId!))];
        const [members, sessions] = await Promise.all([
            memberIds.length ? this.db.member.findMany({ where: { id: { in: memberIds } }, include: { roles: true } }) : [],
            sessionIds.length ? this.db.adminSession.findMany({ where: { id: { in: sessionIds } }, include: adminSessionInclude }) : []
        ]);
        const memberById = new Map(members.map((m) => [m.id, toMemberActor(m)]));
        const hashById = new Map(members.map((m) => [m.id, m.deviceTokenHash]));
        const adminBySession = new Map(sessions.map((s) => [s.id, adminFromSession(s)]));
        const out: { client: Client; actor: Actor }[] = [];
        for (const c of clients) {
            const actor = c.kind === 'member' ? memberById.get(c.id) : adminBySession.get(c.sessionId!);
            const keyReplaced = c.kind === 'member' && hashById.get(c.id) !== c.tokenHash;
            if (!actor || actor instanceof HttpError || keyReplaced) {
                // Membre supprimé, clé d'appareil remplacée (transfert) ou session expirée
                c.socket.close(CLOSE_UNAUTHORIZED, 'Accès refusé');
                this.clients.delete(c);
                continue;
            }
            out.push({ client: c, actor });
        }
        return out;
    }

    private async audience(ch: ChannelRef): Promise<{ client: Client; actor: Actor }[]> {
        if (!this.clients.size) return [];
        return (await this.connectedActors()).filter(({ actor }) => canView(actor, ch));
    }

    /** message.created / message.updated : réactions « mine » calculées pour chaque destinataire */
    async broadcastMessage(type: 'message.created' | 'message.updated', row: MessageRow, ch: ChannelRef): Promise<void> {
        try {
            for (const { client, actor } of await this.audience(ch)) {
                const viewer = actor.type === 'member' ? `m:${actor.id}` : null; // tableau de bord : mine toujours false
                this.send(client, { type, message: toDTO(row, viewer) });
            }
        } catch (err) {
            this.log(err, 'Diffusion du message impossible');
        }
    }

    /** mention : seulement les membres mentionnés (connexions de l'application) */
    async notifyMentions(row: MessageRow, ch: ChannelRef, memberIds: number[]): Promise<void> {
        if (!memberIds.length) return;
        try {
            const wanted = new Set(memberIds);
            for (const { client, actor } of await this.audience(ch)) {
                if (actor.type === 'member' && wanted.has(actor.id)) this.send(client, { type: 'mention', message: toDTO(row, `m:${actor.id}`) });
            }
        } catch (err) {
            this.log(err, 'Envoi des mentions impossible');
        }
    }

    /** schedule.changed : membres de la catégorie et admins qui la voient */
    async broadcastSchedule(ch: ChannelRef, card: ScheduleCard): Promise<void> {
        try {
            const payload = {
                type: 'schedule.changed', categoryId: ch.categoryId, date: card.date, prayer: card.prayer, change: card.change,
                movedGroupIds: card.movedGroupIds, removedGroupIds: card.removedGroupIds, addedGroupIds: card.addedGroupIds ?? []
            };
            for (const { client } of await this.audience(ch)) this.send(client, payload);
        } catch (err) {
            this.log(err, 'Diffusion des horaires impossible');
        }
    }

    /**
     * Après chaque publication (application et tableau de bord) : carte SCHEDULE dans la discussion
     * de la catégorie, puis message.created et schedule.changed. Un échec n'annule jamais la publication.
     */
    async schedulePublished(input: Parameters<typeof createScheduleMessage>[1]): Promise<void> {
        // Mêmes horaires publiés à nouveau : rien à annoncer
        if (!input.result.changed) return;
        try {
            const { row, card } = await createScheduleMessage(this.db, input);
            const ch: ChannelRef = { key: row.channel, teamId: row.teamId, categoryId: row.categoryId, name: '' };
            await this.broadcastMessage('message.created', row, ch);
            await this.broadcastSchedule(ch, card);
        } catch (err) {
            this.log(err, 'Message de publication impossible');
        }
    }

    /**
     * member.status : le membre concerné (statut, silence, catégorie, nom ou rôles modifiés).
     * L'application relit alors son profil et ses discussions.
     */
    async memberStatus(memberId: number): Promise<void> {
        try {
            const member = await this.db.member.findUnique({
                where: { id: memberId }, select: { status: true, mutedUntil: true, deviceTokenHash: true }
            });
            if (!member) {
                this.closeMember(memberId);
                return;
            }
            const mutedUntil = member.mutedUntil && member.mutedUntil > new Date() ? member.mutedUntil.toISOString() : null;
            for (const c of this.clients) {
                if (c.kind !== 'member' || c.id !== memberId) continue;
                if (c.tokenHash !== member.deviceTokenHash) {
                    c.socket.close(CLOSE_UNAUTHORIZED, 'Accès refusé');
                    this.clients.delete(c);
                    continue;
                }
                this.send(c, { type: 'member.status', status: member.status, mutedUntil });
            }
        } catch (err) {
            this.log(err, 'Envoi du statut impossible');
        }
    }
}

function parseFrame(raw: unknown): ({ type?: unknown } & Record<string, unknown>) | null {
    try {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : String(raw);
        if (text.length > 4096) return null;
        const value = JSON.parse(text) as unknown;
        return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

export type { MemberActor };
