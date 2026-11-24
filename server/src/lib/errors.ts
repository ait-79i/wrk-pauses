/** Erreur métier renvoyée telle quelle au client (message en français, sans détail interne) */
export class HttpError extends Error {
    constructor(public statusCode: number, message: string, public code = 'error') {
        super(message);
    }
}

export const badRequest = (msg: string, code = 'bad_request') => new HttpError(400, msg, code);
export const unauthorized = (msg = 'Session expirée. Reconnectez-vous.') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'Vous n\'avez pas les droits pour cette action.') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'Élément introuvable.') => new HttpError(404, msg, 'not_found');
export const conflict = (msg: string, code = 'conflict') => new HttpError(409, msg, code);
