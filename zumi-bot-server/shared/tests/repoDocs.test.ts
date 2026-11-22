import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DOCS = join(ROOT, 'docs/architecture')
// Root CLAUDE.md loads into every session; feature detail goes to docs/architecture.
const ROOT_MAX = 16_384

const areaDocs = () =>
  existsSync(DOCS)
    ? readdirSync(DOCS)
        .filter((f) => f.endsWith('.md'))
        .sort()
    : []
const docNames = (text: string) => [...text.matchAll(/docs\/architecture\/([a-z0-9-]+\.md)/g)].map((m) => m[1])
// Only the index section counts: a doc named elsewhere in root must not hide a missing index line.
const docsSection = (text: string) => {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.trim() === '## Docs by area')
  if (start < 0) return ''
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines.slice(start, end < 0 ? undefined : end).join('\n')
}
// Fenced blocks go first, then code spans line by line (one odd backtick must not flip the rest of the file):
// moved text quotes link syntax such as `[<name>](<path>)`.
const relLinks = (text: string) => {
  let fenced = false
  const prose = text
    .split('\n')
    .filter((l) => {
      if (l.trimStart().startsWith('```')) {
        fenced = !fenced
        return false
      }
      return !fenced
    })
    .map((l) => l.replace(/`[^`]*`/g, ''))
    .join('\n')
  return [...prose.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((t) => !/^[a-z]+:/.test(t))
}

describe('repo docs', () => {
  it('keeps root CLAUDE.md within 16 KB', () => {
    expect(statSync(join(ROOT, 'CLAUDE.md')).size).toBeLessThanOrEqual(ROOT_MAX)
  })

  it('names every area doc in root CLAUDE.md, and only existing ones', () => {
    const named = [...new Set(docNames(docsSection(readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8'))))].sort()
    expect(areaDocs().length).toBeGreaterThan(0)
    expect(named).toEqual(areaDocs())
  })

  it('resolves every relative link in root CLAUDE.md and the area docs', () => {
    const files = [join(ROOT, 'CLAUDE.md'), ...areaDocs().map((f) => join(DOCS, f))]
    const broken = files.flatMap((f) =>
      relLinks(readFileSync(f, 'utf8'))
        .filter((t) => !existsSync(resolve(dirname(f), t)))
        .map((t) => `${f}: ${t}`)
    )
    expect(broken).toEqual([])
  })

  // Folder CLAUDE.md files load when Claude reads a file there; each must lead to a real doc.
  const SKIP = new Set(['node_modules', 'dist', 'out', 'build', 'release', '.git', '.claude', '.superpowers'])
  function nestedClaudeMds(dir = ROOT, acc: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !SKIP.has(e.name)) nestedClaudeMds(join(dir, e.name), acc)
      else if (e.isFile() && e.name === 'CLAUDE.md' && join(dir, e.name) !== join(ROOT, 'CLAUDE.md')) acc.push(join(dir, e.name))
    }
    return acc
  }

  it('points every folder CLAUDE.md at existing area docs', () => {
    const files = nestedClaudeMds()
    expect(files.length).toBeGreaterThanOrEqual(32)
    const bad = files.flatMap((f) => {
      const named = docNames(readFileSync(f, 'utf8'))
      return named.length === 0 ? [`${f}: names no doc`] : named.filter((d) => !existsSync(join(DOCS, d))).map((d) => `${f}: ${d}`)
    })
    expect(bad).toEqual([])
  })
})
