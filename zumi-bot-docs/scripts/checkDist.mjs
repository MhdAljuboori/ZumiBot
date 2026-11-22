// Runs after `astro build`. Exits 1 when a built page has no CSP meta tag, has inline code the meta does not hash, or loads anything from another
// host, or holds an HTML comment: the site loads nothing third-party at view time.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unhashedInline } from '../src/lib/cspHashes.ts'
import { htmlComments, remoteLoads } from '../src/lib/distChecks.ts'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const htmlFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? htmlFiles(join(dir, e.name)) : e.name.endsWith('.html') ? [join(dir, e.name)] : []
  )

const CSP = /<meta[^>]+http-equiv="content-security-policy"/i

const problems = []
for (const file of htmlFiles(dist)) {
  const html = readFileSync(file, 'utf8')
  const name = file.slice(dist.length + 1)
  if (!CSP.test(html)) problems.push(`${name}: no content-security-policy meta tag`)
  // The meta is hash-only, so an inline script or style it does not hash would be blocked in the browser.
  for (const item of unhashedInline(html)) problems.push(`${name}: inline code not hashed in the CSP meta (${item})`)
  // Nothing is loaded from another host: not a script, stylesheet, image, frame, font or style import. Links to other sites are fine.
  for (const item of remoteLoads(html)) problems.push(`${name}: ${item}`)
  // Astro and Starlight write no HTML comments, so one means a page's source left a note in its text.
  for (const c of htmlComments(html)) problems.push(`${name}: HTML comment in the page (${c})`)
}

if (problems.length > 0) {
  console.error(`checkDist: ${problems.length} problem(s)\n${problems.join('\n')}`)
  process.exit(1)
}
console.log('checkDist: ok')
