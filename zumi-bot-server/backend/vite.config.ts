import { chmodSync, cpSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { defineConfig } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }

// Ship runtime files beside every entry, including the complete pinned Playwright CLI/registry.
// Browser binaries live in the data dir and are downloaded only by browser-install.
function ship() {
  let outDir = ''
  return {
    name: 'zumibot-ship-assets',
    configResolved(c: { root: string; build: { outDir: string } }) {
      outDir = resolve(c.root, c.build.outDir)
    },
    closeBundle() {
      cpSync(join(root, 'src', 'http', 'login'), join(outDir, 'login'), { recursive: true })
      const web = join(root, '..', 'frontend', 'dist')
      if (existsSync(web)) cpSync(web, join(outDir, 'web'), { recursive: true })
      const playwright = dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'))
      cpSync(playwright, join(outDir, 'node_modules', 'playwright-core'), { recursive: true })
      chmodSync(join(outDir, 'server.mjs'), 0o755)
    }
  }
}

// Server/support bundles plus the complete optional browser runtime; no VPS npm install.
export default defineConfig({
  plugins: [ship()],
  // The version the self-update compares with the latest release (every workspace shares one number).
  define: { __SERVER_VERSION__: JSON.stringify(version) },
  ssr: { noExternal: true, external: ['playwright-core'] },
  build: {
    ssr: true,
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node22',
    rolldownOptions: {
      input: {
        browserBridge: join(root, 'src/core/browser/browserBridge.ts'),
        desktopBridge: join(root, 'src/core/desktop/desktopBridge.ts'),
        todoBridge: join(root, 'src/core/todos/todoBridge.ts'),
        processBridge: join(root, 'src/core/processes/processBridge.ts'),
        vaultBridge: join(root, 'src/core/vault/vaultBridge.ts'),
        askBridge: join(root, 'src/core/asks/askBridge.ts'),
        automationBridge: join(root, 'src/core/automations/automationBridge.ts'),
        pauseHook: join(root, 'src/core/chat/pauseHook.ts'),
        sandboxFileHook: join(root, 'src/core/isolation/sandboxFileHook.ts'),
        containerEntry: join(root, 'src/core/isolation/containerEntry.ts'),
        server: join(root, 'src/main.ts'),
        browserWorker: join(root, 'src/core/browser/browserWorker.ts'),
        browserRuntime: join(root, 'src/core/browser/browserRuntime.ts'),
        workerAdapter: join(root, 'src/core/browser/workerAdapter.ts')
      },
      external: ['playwright-core'],
      output: { format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs', banner: '#!/usr/bin/env node' }
    }
  }
})
