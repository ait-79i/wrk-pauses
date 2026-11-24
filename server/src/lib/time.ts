// Jour et heure locaux des équipes (Maroc ; décalage réglable par LOCAL_OFFSET_HOURS).

export interface LocalNow {
    /** Jour local, AAAA-MM-JJ */
    date: string;
    /** Minutes écoulées depuis minuit, heure locale */
    nowMins: number;
}

export function localNow(offsetHours: number, ts = Date.now()): LocalNow {
    const d = new Date(ts + offsetHours * 3600_000);
    return {
        date: d.toISOString().slice(0, 10),
        nowMins: d.getUTCHours() * 60 + d.getUTCMinutes()
    };
}

/** 0 = dimanche … 6 = samedi, pour une date AAAA-MM-JJ */
export function weekdayOf(date: string): number {
    return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Jours ouvrés : lundi à vendredi */
export function isWorkday(date: string): boolean {
    const d = weekdayOf(date);
    return d >= 1 && d <= 5;
}

export const isFriday = (date: string): boolean => weekdayOf(date) === 5;

/** AAAA-MM-JJ → valeur d'une colonne DATE */
export const toDbDate = (date: string): Date => new Date(`${date}T00:00:00Z`);

export const fromDbDate = (d: Date): string => d.toISOString().slice(0, 10);

export function minsToHHMM(mins: number): string {
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
