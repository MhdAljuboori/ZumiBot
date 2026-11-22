import { defineConfig } from 'vite'

// A second build, because a worker must be one classic file at a fixed, unhashed URL (/sw.js).
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    copyPublicDir: false,
    lib: { entry: 'src/sw/sw.ts', name: 'zumibotSw', formats: ['iife'], fileName: () => 'sw.js' }
  }
})
