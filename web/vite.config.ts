/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// PWA manifest per PRD §18 (installable app shell; caching strategy refined in
// Phase 7/9). appShell only: workbox registration is generated at build.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [],
      manifest: {
        name: 'Anda',
        short_name: 'Anda',
        description: 'Shared egg inventory & settlement ledger for flatmates',
        theme_color: '#f59e0b',
        background_color: '#fffdf5',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/pwa-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
      workbox: {
        // Phase 7 defines the full offline strategy; for now cache the app
        // shell only so the PWA stays installable without premature caching.
        globPatterns: ['**/*.{js,css,html}'],
      },
    }),
  ],
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});