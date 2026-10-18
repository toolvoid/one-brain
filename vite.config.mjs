import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VITE_WATCH_IGNORED } from './src/lib/vite-watch.mjs';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173, strictPort: true,
    watch: { ignored: VITE_WATCH_IGNORED }
  }
});
