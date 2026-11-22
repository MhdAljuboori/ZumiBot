import { defineConfig } from 'electron-vite'
import { cpSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

// The picker and error pages are plain static files (no renderer build, no dev server), copied next to the main bundle
// so they load the same way from `dev`, `build` and a packaged app. The app itself is served by the connected server.
function shipPages() {
  let outDir = ''
  return {
    name: 'zumibot-ship-pages',
    configResolved(c: { root: string; build: { outDir: string } }) {
      outDir = resolve(c.root, c.build.outDir)
    },
    closeBundle() {
      cpSync(resolve('src/pages'), join(outDir, 'pages'), { recursive: true })
      cpSync(resolve('build/icon.png'), join(outDir, 'tray.png'))
      const syncDir = join(outDir, 'sync')
      mkdirSync(syncDir, { recursive: true })
      cpSync(resolve('src/sync/runner.mjs'), join(syncDir, 'runner.mjs'))
      for (const name of ['sync.mjs', 'config.mjs', 'vaultSync.mjs']) {
        cpSync(resolve('../zumi-bot-server/deploy', name), join(syncDir, name))
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [shipPages()],
    // The workspace packages ship TypeScript, so they are bundled; only real dependencies stay external.
    build: { externalizeDeps: { exclude: ['@zumibot/backend', '@zumibot/shared'] } }
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } }
    }
  }
})
