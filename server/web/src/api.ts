// Client de l'API du tableau de bord (/api/admin). Cookie de session httpOnly : rien à stocker ici.

export class ApiError extends Error {
    constructor(public status: number, message: string, public code: string) {
        super(message);
    }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`/api/admin${path}`, {
            method,
            credentials: 'same-origin',
            headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
            body: body !== undefined ? JSON.stringify(body) : undefined
        });
    } catch {
        throw new ApiError(0, 'Serveur injoignable. Vérifiez votre connexion.', 'network');
    }
    const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
    if (!res.ok) {
        throw new ApiError(res.status, data?.message ?? `Erreur ${res.status}.`, data?.error ?? 'error');
    }
    return data as T;
}

// ------------------------------------------------------------------ Types renvoyés par l'API

export type Prayer = 'DHUHR' | 'ASR' | 'JUMUA';
export type RoleName = 'TEAM_ADMIN' | 'CATEGORY_ADMIN' | 'SCHEDULER';

export interface Me {
    authenticated: boolean;
    needsTotp?: boolean;
    needsTotpSetup?: boolean;
    admin?: { id: number; email: string; superAdmin: boolean; totpEnabled: boolean; name: string | null };
}

export interface Overview {
    today: string;
    nowMins: number;
    totals: { teams: number; members: number; pending: number; activeToday: number };
    teams: {
        id: number; name: string; city: string; members: number;
        categories: { id: number; name: string; members: number; groups: number; jumuaEnabled: boolean; publishedToday: Prayer[] }[];
    }[];
}

export interface TeamDetail {
    id: number; name: string; city: string; country: string; requireApproval: boolean; canManageTeam: boolean;
    categories: {
        id: number; name: string; jumuaEnabled: boolean; maxGroups: number; canManage: boolean; canPublish: boolean;
        groups: { id: number; name: string }[];
        codes: { id: number; code: string; expiresAt: string | null; createdAt: string }[];
    }[];
    members: {
        id: number; name: string; status: 'PENDING' | 'ACTIVE' | 'BLOCKED'; categoryId: number;
        createdAt: string; lastSeenAt: string | null;
        /** Phase 2 : fin de la réduction au silence (null ou passé = peut écrire) */
        mutedUntil?: string | null;
        roles: { role: RoleName; categoryId: number | null }[];
        account: { id: number; email: string; disabled: boolean } | null;
    }[];
}

export interface DaySlot { groupId: number | null; groupName: string | null; timeMins: number; count: number }
export interface DayPrayer { prayer: Prayer; published: boolean; publishedAt: string | null; publishedBy: string | null; slots: DaySlot[] }
export interface DayView {
    date: string; isWorkday: boolean; today: string; nowMins: number;
    category: { id: number; name: string; jumuaEnabled: boolean };
    groups: { id: number; name: string }[];
    prayers: DayPrayer[];
    previous?: { prayer: Prayer; slots: { groupId: number | null; timeMins: number }[] }[];
}

export interface AccountRow {
    id: number; email: string; superAdmin: boolean; totpEnabled: boolean; disabled: boolean;
    lastLoginAt: string | null; member: { name: string; team: string } | null;
}

export interface AuditRow {
    id: number; actor: string; action: string; teamId: number | null; target: string | null;
    details: Record<string, unknown> | null; createdAt: string;
}

// ------------------------------------------------------------------ Discussion (phase 2)

export type MessageKind = 'TEXT' | 'ANNOUNCEMENT' | 'SCHEDULE';

export interface MessageDTO {
    id: number;
    channel: string;
    kind: MessageKind;
    author: { type: 'member' | 'admin' | 'system'; id: number | null; name: string };
    body: string;
    replyTo: { id: number; authorName: string; excerpt: string } | null;
    schedule: {
        date: string;
        prayer: Prayer;
        change: 'published' | 'updated';
        slots: { groupId: number | null; groupName: string | null; timeMins: number }[];
        movedGroupIds: number[];
        removedGroupIds: number[];
        /** Groupes ajoutés par une mise à jour (absent des cartes anciennes) */
        addedGroupIds?: number[];
    } | null;
    mentions: { memberId: number; name: string }[];
    reactions: { emoji: string; count: number; mine: boolean }[];
    deleted: boolean;
    createdAt: string;
}

export interface ChannelRow { key: string; name: string; messages7d: number; lastMessageAt: string | null }
export interface MessagePage { messages: MessageDTO[]; hasMore: boolean }

export const listChannels = (teamId: number) => api<{ channels: ChannelRow[] }>('GET', `/teams/${teamId}/channels`);

export function listMessages(channel: string, before?: number, limit = 50) {
    const q = new URLSearchParams({ channel, limit: String(limit) });
    if (before) q.set('before', String(before));
    return api<MessagePage>('GET', `/messages?${q}`);
}

export const postMessage = (body: { channel: string; body: string; kind?: 'TEXT' | 'ANNOUNCEMENT'; replyToId?: number }) =>
    api<MessageDTO>('POST', '/messages', body);

export const deleteMessage = (id: number) => api<{ ok: true }>('DELETE', `/messages/${id}`);

/** minutes = null lève la réduction au silence */
export const muteMember = (memberId: number, minutes: number | null) =>
    api<{ mutedUntil: string | null }>('POST', `/members/${memberId}/mute`, { minutes });

// ------------------------------------------------------------------ Statistiques (phase 3)

export interface TeamStats {
    from: string; to: string;
    categories: {
        id: number; name: string; members: number; activeMembers7d: number;
        publicationRate: number; participationRate: number;
    }[];
    days: {
        date: string; categoryId: number; prayer: Prayer; published: boolean; publishedAt: string | null; total: number;
        slots: { groupId: number | null; groupName: string | null; timeMins: number; count: number }[];
    }[];
    groups: { groupId: number; name: string; categoryId: number; averageCount: number; averageTimeMins: number | null }[];
}

export interface GlobalStats {
    totals: { teams: number; members: number; activeMembers7d: number; messages7d: number };
    teams: {
        id: number; name: string; members: number; activeMembers7d: number;
        publicationRate7d: number; participationRate7d: number; messages7d: number;
    }[];
}

export const teamStats = (teamId: number, from: string, to: string) =>
    api<TeamStats>('GET', `/teams/${teamId}/stats?from=${from}&to=${to}`);

export const globalStats = () => api<GlobalStats>('GET', '/stats/global');

// ------------------------------------------------------------------ Formats

export const minsToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const hhmmToMins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

export const PRAYER_LABEL: Record<Prayer, string> = { DHUHR: 'Dhuhr', ASR: 'Asr', JUMUA: 'Jumu\'a' };
export const PRAYER_ARABIC: Record<Prayer, string> = { DHUHR: 'صلاة الظهر', ASR: 'صلاة العصر', JUMUA: 'صلاة الجمعة' };
export const ROLE_LABEL: Record<RoleName, string> = {
    TEAM_ADMIN: 'Admin d\'équipe', CATEGORY_ADMIN: 'Admin de catégorie', SCHEDULER: 'Responsable horaires'
};

const dateFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
export const formatDay = (date: string) => dateFmt.format(new Date(`${date}T12:00:00Z`));

export function relativeTime(iso: string | null): string {
    if (!iso) return 'jamais';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 2) return 'à l\'instant';
    if (mins < 60) return `il y a ${mins} min`;
    const h = Math.round(mins / 60);
    if (h < 24) return `il y a ${h} h`;
    const d = Math.round(h / 24);
    return d === 1 ? 'hier' : `il y a ${d} jours`;
}

const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
export const formatTime = (iso: string) => timeFmt.format(new Date(iso));

const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const formatDateTime = (iso: string) => dateTimeFmt.format(new Date(iso));

/** Date locale AAAA-MM-JJ, décalée de `offsetDays` jours */
export function localDate(offsetDays = 0): string {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const percent = (rate: number) => `${Math.round(rate * 100)} %`;

/** Jours ouvrés à partir d'aujourd'hui (pour publier à l'avance) */
export function nextWorkdays(today: string, count: number): string[] {
    const out: string[] = [];
    const d = new Date(`${today}T12:00:00Z`);
    while (out.length < count) {
        const wd = d.getUTCDay();
        if (wd >= 1 && wd <= 5) out.push(d.toISOString().slice(0, 10));
        d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
}
