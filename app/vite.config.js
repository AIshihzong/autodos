import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.AUTODOS_API || 'http://127.0.0.1:4747';

export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: api,
        changeOrigin: true,
        // The API refuses cross-origin writes; the dev proxy is same-machine, so drop the browser Origin.
        configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')),
      },
    },
  },
});
