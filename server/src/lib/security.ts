import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/** Jeton aléatoire remis au client (clé d'appareil, session du tableau de bord) */
export function newToken(): string {
    return randomBytes(32).toString('base64url');
}

/** Empreinte stockée en base : le jeton lui-même n'est jamais conservé */
export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

// Sans 0/O/1/I/L : lisible et facile à dicter
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Code lisible, ex. « K7P-2QW », pour les codes d'accès et de transfert */
export function newReadableCode(length = 6): string {
    let out = '';
    for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return `${out.slice(0, 3)}-${out.slice(3)}`;
}

/** Normalise une saisie de code : majuscules, tiret remis au bon endroit */
export function normalizeCode(input: string): string {
    const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
}

const SCRYPT_KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, SCRYPT_KEYLEN);
    return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const [scheme, saltB64, keyB64] = stored.split('$');
    if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
    const expected = Buffer.from(keyB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
