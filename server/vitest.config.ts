import { defineConfig } from 'vitest/config';

// Les tests d'intégration partagent la base TEST_DATABASE_URL et la vident au début :
// les fichiers s'exécutent l'un après l'autre pour ne pas se marcher dessus.
export default defineConfig({
    test: {
        fileParallelism: false
    }
});
