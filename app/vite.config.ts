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
      // Custom service worker so it can show push alerts; runtime caching lives in src/sw.ts.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // Off by default so dev reloads aren't served from a cache; `SW_DEV=1 npm run dev` to test push locally.
      devOptions: { enabled: process.env.SW_DEV === '1', type: 'module', navigateFallback: 'index.html' },
      includeAssets: ['apple-touch-icon.png', 'favicon-32.png'],
      manifest: {
        name: 'SnowCast CO',
        short_name: 'SnowCast',
        description: 'Colorado snowfall forecasts blended from 6 models + NWS',
        theme_color: '#bcdcff',
        background_color: '#03060f',
        display: 'standalone',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,woff2}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
    }),
  ],
})
