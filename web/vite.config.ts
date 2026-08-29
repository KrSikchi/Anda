/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// PWA manifest per PRD §18/§37 (installable app shell). appShell only:
// workbox registration is generated at build.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [],
      manifest: {
        name: 'Anda',
        short_name: 'Anda',
        description: 'Eggs, sorted. The shared egg ledger for your flat.',
        theme_color: '#f59e0b',
        background_color: '#fffbf7',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // Cache the app shell so a cold start offline still paints (PRD §37).
        globPatterns: ['**/*.{js,css,html}'],
        // Ledger data is cached in IndexedDB by the app itself, never here:
        // runtime API responses must not be served stale by the service worker.
        navigateFallback: '/index.html',
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  test: {
    // Store/offline/push suites are framework-free and run in Node.
    environment: 'node',
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
