import { defineConfig } from 'prisma/config';

// DATABASE_URL : mysql://user:motdepasse@hote:3306/pause (fourni par Coolify en production)
export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: { path: 'prisma/migrations' },
    datasource: { url: process.env.DATABASE_URL ?? 'mysql://pause:pause@localhost:3306/pause' }
});
