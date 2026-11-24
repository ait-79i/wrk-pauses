import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from './generated/prisma/client.js';

export type Db = PrismaClient;

/** Client Prisma branché sur MySQL via l'adaptateur MariaDB (compatible MySQL 8) */
export function createDb(databaseUrl: string): PrismaClient {
    const url = new URL(databaseUrl);
    const adapter = new PrismaMariaDb({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.replace(/^\//, ''),
        connectionLimit: 10,
        allowPublicKeyRetrieval: true
    });
    return new PrismaClient({ adapter });
}
