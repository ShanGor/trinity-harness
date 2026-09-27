import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Browser talks only to the vite dev server; API calls are forwarded.
      '/api': 'http://127.0.0.1:3000',
    },
  },
});
