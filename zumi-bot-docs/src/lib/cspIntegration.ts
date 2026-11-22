import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addInlineHashes } from './cspHashes.ts'

const htmlFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? htmlFiles(join(dir, e.name)) : e.name.endsWith('.html') ? [join(dir, e.name)] : []
  )

/** After the build, hashes the inline code Astro's own CSP leaves out into every page's meta. */
export const inlineHashes = () => ({
  name: 'inline-csp-hashes',
  hooks: {
    'astro:build:done': ({ dir }: { dir: URL }) => {
      for (const file of htmlFiles(fileURLToPath(dir))) {
        const html = readFileSync(file, 'utf8')
        const next = addInlineHashes(html)
        if (next !== html) writeFileSync(file, next)
      }
    }
  }
})
