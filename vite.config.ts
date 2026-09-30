import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist' },
  // Deliberately not 5173, which is Vite's default and therefore the port every other
  // project on this machine also wants. Picking a number of our own means `bun run dev`
  // never collides with whatever else is running. Keep in sync with the CORS allowlist
  // in `worker/src/cors.ts`, or the dev SPA cannot reach the Worker.
  server: { port: 5180 },
});
