import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  // El build cae dentro de dist/, que es lo que Nest sirve como estatico:
  // un solo proceso en produccion, sin servidor web aparte.
  build: { outDir: '../dist/public', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
