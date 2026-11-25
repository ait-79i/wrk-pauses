// Types partagés pour le processus principal et les modules TypeScript

export interface DayPause {
    start: string;
    end: string;
    durationMins?: number;
    position?: number;
}

export interface DayData {
    date: string;
    clockIn: string;
    ramadan: boolean;
    departure?: string | null;
    totalPauseMins?: number;
    pauses: DayPause[];
}

export interface SalatDayTimes {
    Fajr: number;
    Dhuhr: number;
    Asr: number;
    Maghrib: number;
    Isha: number;
    Sunrise?: number;
    [key: string]: number | undefined;
}

export interface SalatDay {
    date: string;
    times: SalatDayTimes;
}

export interface DayRuleModeConfig {
    workMins?: number;
    minOut?: number;
    maxOut?: number;
}

export interface DayRulesConfig {
    normal?: DayRuleModeConfig;
    ramadan?: DayRuleModeConfig;
}

export interface StoreValues {
    salatAlertLead?: number | null;
    salatAlertAt?: number | null;
    salatAlertMessage?: string;
    salatDay?: SalatDay | null;
    salatError?: string | null;
    salatDismissedKey?: string | null;
    dayRulesConfig?: DayRulesConfig;
    autoLaunch?: boolean;
    workDate?: string;
    clockIn?: string;
    pauses?: DayPause[];
    isPaused?: boolean;
    pauseStartTime?: number | null;
    isRamadanMode?: boolean;
    syncConfig?: SyncConfig;
    syncConfigUpdatedAt?: number;
    fullscreenPause?: boolean;
    showSalat?: boolean;
    targetOut?: string;
    team?: TeamInfo | null;
    teamDay?: TeamDay | null;
    teamError?: string | null;
    /** Canaux de discussion visibles (GET /api/app/channels) */
    teamChannels?: TeamChannel[];
    /** Total des messages non lus, tous canaux confondus */
    teamUnread?: number;
    /** Notifications Windows de l'équipe (défaut : activées) */
    teamNotifications?: boolean;
    /** État de la connexion temps réel avec le serveur de l'équipe */
    teamRealtime?: TeamRealtime | null;
    [key: string]: any;
}

// ------------------------------------------------------------- Équipe de prière (GLOSSARY.md)

/** 'open' : connecté ; 'connecting' : connexion en cours ; 'offline' : coupé, reconnexion automatique */
export type TeamRealtime = 'open' | 'connecting' | 'offline';

export interface TeamInfo {
    memberId: number;
    memberName: string;
    status: 'PENDING' | 'ACTIVE' | 'BLOCKED';
    teamId: number;
    teamName: string;
    categoryId: number;
    categoryName: string;
    /** Admin ou responsable horaires : peut publier les horaires */
    canPublish: boolean;
    /** Code d'accès actuel de la catégorie, à partager avec des collègues (null : aucun code actif) */
    accessCode?: string | null;
    accessCodeExpiresAt?: string | null;
}

export interface TeamSlot {
    groupId: number | null;
    groupName: string | null;
    /** Minutes depuis minuit, heure locale */
    timeMins: number;
    count: number;
}

export interface TeamPrayer {
    prayer: 'DHUHR' | 'ASR' | 'JUMUA';
    published: boolean;
    slots: TeamSlot[];
    myGroupId?: number | null;
    myChoiceIsExplicit?: boolean;
    usualGroupId?: number | null;
}

/** Journée vue par le membre (réponse de GET /api/app/day) */
export interface TeamDay {
    date: string;
    today: string;
    nowMins: number;
    isWorkday: boolean;
    category: { id: number; name: string; jumuaEnabled: boolean };
    groups: { id: number; name: string }[];
    prayers: TeamPrayer[];
}

// ------------------------------------------------------------- Discussion (contrat phases 2-3)

export interface TeamChannel {
    key: string;
    name: string;
    unread: number;
    canPost: boolean;
    canAnnounce: boolean;
    canModerate: boolean;
    mutedUntil: string | null;
}

export interface TeamMessage {
    id: number;
    channel: string;
    kind: 'TEXT' | 'ANNOUNCEMENT' | 'SCHEDULE';
    author: { type: 'member' | 'admin' | 'system'; id: number | null; name: string };
    body: string;
    replyTo: { id: number; authorName: string; excerpt: string } | null;
    schedule: {
        date: string;
        prayer: 'DHUHR' | 'ASR' | 'JUMUA';
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

/** Notification Windows préparée par TeamManager ; target : fenêtre ouverte au clic */
export interface TeamNotice {
    title: string;
    body: string;
    target: 'chat' | 'main';
    channel?: string;
}

export interface StoreChange {
    oldValue?: any;
    newValue?: any;
}

export type StoreChanges = Record<string, StoreChange>;

// ------------------------------------------------------------- Types Synchronisation

export interface SyncConfig {
    enabled: boolean;
    folderPath?: string;
    autoSync: boolean;
    syncIntervalMins: number;
    lastSyncTime?: number;
    lastSyncStatus?: 'idle' | 'syncing' | 'success' | 'error';
    lastSyncError?: string;
    lastSyncMergedCount?: number;
}

export interface SyncPayload {
    version: number;
    appName: string;
    exportDate: string;
    deviceId: string;
    updatedAt: number;
    config: {
        dayRulesConfig?: DayRulesConfig;
        isRamadanMode?: boolean;
        salatAlertLead?: number | null;
        salatAlertAt?: number | null;
        salatAlertMessage?: string;
        autoLaunch?: boolean;
        updatedAt: number;
    };
    history: DayData[];
}

export interface SyncResult {
    ok: boolean;
    mergedDaysCount?: number;
    configUpdated?: boolean;
    error?: string;
    syncedAt?: number;
    folderPath?: string;
}

export interface SyncStatus {
    isSyncing: boolean;
    lastSyncTime?: number;
    lastSyncStatus?: 'idle' | 'syncing' | 'success' | 'error';
    lastSyncError?: string;
    lastSyncMergedCount?: number;
    detectedDrivePath?: string | null;
    config: SyncConfig;
}


