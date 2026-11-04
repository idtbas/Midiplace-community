/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const apiTarget = process.env.RENOS_API_URL ?? 'http://127.0.0.1:8787';
/** Basis-Pfad, z. B. „/Midiplace-community/renos/“ auf GitHub Pages. */
const base = (process.env.RENOS_BASE ?? '/').replace(/\/?$/, '/');

export default defineConfig({
  base,
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/*.png', 'icons/*.svg', 'icons/apps/*', 'wallpapers/*.jpg'],
      manifest: {
        id: base,
        name: 'RenOS',
        short_name: 'RenOS',
        description: 'Desktop-Umgebung für das iPad mit Bibliothek und Player für Ren’Py-Webspiele.',
        lang: 'de',
        start_url: `${base}?source=pwa`,
        scope: base,
        display: 'standalone',
        orientation: 'any',
        background_color: '#11151c',
        theme_color: '#11151c',
        categories: ['games', 'utilities'],
        icons: [
          { src: `${base}icons/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `${base}icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: `${base}icons/icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Nur die App-Shell wird vorgeladen. Spiele liegen auf einem anderen Origin und
        // werden von diesem Service Worker nie berührt; die API wird nie zwischengespeichert.
        globPatterns: ['**/*.{js,css,html,svg,png,jpg,webmanifest}'],
        navigateFallback: `${base}index.html`,
        navigateFallbackDenylist: [new RegExp(`^${base}api/`)],
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: ['safari16', 'chrome110', 'firefox115'],
    sourcemap: true,
    chunkSizeWarningLimit: 600,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
});
