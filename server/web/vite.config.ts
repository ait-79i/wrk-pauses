import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En développement, l'API tourne sur le port 3100 (npm run dev dans server/, voir .env.example) ;
// ws: true relaie aussi la connexion temps réel /api/admin/ws
export default defineConfig({
    plugins: [react()],
    server: { port: 5173, proxy: { '/api': { target: 'http://localhost:3100', ws: true } } },
    build: { outDir: 'dist', sourcemap: false }
});
