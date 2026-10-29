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
    salatAlertLead?: number;
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
    [key: string]: any;
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
        salatAlertLead?: number;
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


