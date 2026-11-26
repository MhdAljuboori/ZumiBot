import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const page = (file: string): string => fileURLToPath(new URL(file, import.meta.url))

export default defineConfig({
  plugins: [react()],
  // Two pages: the showcase and /sponsor (vercel.json's cleanUrls drops the .html).
  build: { rolldownOptions: { input: { main: page('./index.html'), sponsor: page('./sponsor.html') } } }
})
