import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const target = `http://127.0.0.1:${process.env.ZUMIBOT_PORT ?? 4317}`
// Every workspace shares one version (the bump:* scripts), so the UI's own is the server's too.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  // Fonts stay files: the CSP allows fonts from 'self' only, and Vite would inline KaTeX's smallest ones as data: URLs.
  build: { assetsInlineLimit: (file) => (/\.(woff2?|ttf)$/.test(file) ? false : undefined) },
  server: {
    proxy: {
      '/api': target,
      '/ws': { target, ws: true }
    }
  }
})
