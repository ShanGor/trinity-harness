import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    allowedHosts: ['sam-pc'],
    proxy: {
      // Browser talks only to the vite dev server; API calls are forwarded.
      // WebSocket upgrades (streaming ASR) need explicit proxying too.
      '/api': {
        target: 'http://127.0.0.1:3000',
        ws: true,
        configure(proxy) {
          proxy.on('proxyRes', (upstream, _request, response) => {
            // An interrupted upstream SSE response must close the downstream
            // socket too, so EventSource can detect the loss and reconnect.
            upstream.once('close', () => {
              if (!upstream.complete) response.destroy();
            });
          });
        },
      },
    },
  },
});
