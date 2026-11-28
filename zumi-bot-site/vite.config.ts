import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { pageUrl, sitemapXml } from './src/sitemap.ts'

const root = fileURLToPath(new URL('.', import.meta.url))

// Every root *.html is a page (vercel.json's cleanUrls drops the .html), so a new page needs no entry here. The home
// page keeps the input name `main`, which names its chunks.
const pages = readdirSync(root)
  .filter((f) => f.endsWith('.html'))
  .sort()
const input = Object.fromEntries(pages.map((f) => [f === 'index.html' ? 'main' : f.slice(0, -'.html'.length), join(root, f)]))

// sitemap.xml lists the same pages by their og:url; a page without one, or with a canonical that differs, fails the build.
const sitemap = (): Plugin => ({
  name: 'zumibot-sitemap',
  apply: 'build',
  generateBundle() {
    const urls = pages.map((f) => pageUrl(f, readFileSync(join(root, f), 'utf8')))
    this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemapXml(urls) })
  }
})

export default defineConfig({
  plugins: [react(), sitemap()],
  build: { rolldownOptions: { input } }
})
