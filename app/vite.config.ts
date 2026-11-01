import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves from /<repo>/; override with BASE_PATH at build time.
  base: process.env.BASE_PATH ?? '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png', 'favicon-32.png'],
      manifest: {
        name: 'SnowCast CO',
        short_name: 'SnowCast',
        description: 'Colorado snowfall forecasts blended from 6 models + NWS',
        theme_color: '#1b6fd8',
        background_color: '#0b1220',
        display: 'standalone',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [
          {
            // Show the last forecast when offline (e.g. on the lift with no signal).
            urlPattern: /^https:\/\/(api\.open-meteo\.com|api\.weather\.gov)\//,
            handler: 'NetworkFirst',
            options: { cacheName: 'forecasts', networkTimeoutSeconds: 8, expiration: { maxEntries: 200, maxAgeSeconds: 6 * 3600 } },
          },
          {
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\//,
            handler: 'CacheFirst',
            options: { cacheName: 'map-tiles', expiration: { maxEntries: 1500, maxAgeSeconds: 30 * 24 * 3600 } },
          },
        ],
      },
    }),
  ],
})
