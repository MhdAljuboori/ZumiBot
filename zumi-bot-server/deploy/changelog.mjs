import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const bare = (version) => String(version).replace(/^v/, '')
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// The version must end at a space or the line end, so 0.1 never matches v0.1.0.
const heading = (version) => new RegExp(`^## v${esc(bare(version))}(?=\\s|$).*$`, 'm')

// A section ends at the next line starting with `## `, so notes must not use level-2 headings of their own.
/** The notes under `## v<version>`, trimmed and without the heading; null when the section is missing or empty. */
export function changelogSection(text, version) {
  const m = heading(version).exec(text)
  if (!m) return null
  const rest = text.slice(m.index + m[0].length)
  const next = rest.search(/^## /m)
  const body = (next === -1 ? rest : rest.slice(0, next)).trim()
  return body === '' ? null : body
}

/** Puts an empty `## v<version> — <date>` section above the older ones; unchanged when the version already has one. */
export function addSection(text, version, date) {
  if (heading(version).test(text)) return text
  const section = `## v${bare(version)} — ${date}\n\n`
  const first = text.search(/^## /m)
  if (first !== -1) return text.slice(0, first) + section + text.slice(first)
  return `${text.replace(/\n*$/, '\n')}\n${section}`
}

// CLI: `node changelog.mjs notes <version> <outFile>`, run by the release workflow from the repo root.
function isEntry() {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  } catch {
    return false // e.g. `node -`: argv[1] is not a file
  }
}
if (isEntry()) {
  const [cmd, version, out] = process.argv.slice(2)
  if (cmd !== 'notes' || !version || !out) {
    console.error('usage: changelog.mjs notes <version> <outFile>')
    process.exit(2)
  }
  const notes = changelogSection(readFileSync('CHANGELOG.md', 'utf8'), version)
  if (notes === null) {
    console.error(`CHANGELOG.md has no notes for v${bare(version)}`)
    process.exit(1)
  }
  writeFileSync(out, `${notes}\n`)
}
