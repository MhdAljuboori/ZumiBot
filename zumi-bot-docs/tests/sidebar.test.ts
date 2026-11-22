import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SIDEBAR } from '../src/sidebar.ts'

const DOCS = join(import.meta.dirname, '../src/content/docs')

const APPROVED_ORDER = [
  'Get started',
  'Chatting',
  'Agents',
  'Group rooms',
  'Projects & code',
  'Automation',
  'Voice',
  'Connect',
  'Agents at the computer',
  'Safety & cost',
  'Advanced engines',
  'Desktop app',
  'Run your server'
]

const folders = () =>
  readdirSync(DOCS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
const pages = (dir: string) => readdirSync(join(DOCS, dir)).filter((f) => /\.mdx?$/.test(f))

describe('sidebar', () => {
  it('every sidebar group has a folder with at least one page', () => {
    for (const g of SIDEBAR) {
      expect(pages(g.directory).length, `${g.directory} has no page`).toBeGreaterThan(0)
    }
  })

  it('every page folder is in the sidebar', () => {
    const listed = new Set(SIDEBAR.map((g) => g.directory))
    for (const dir of folders()) expect(listed.has(dir), `${dir} is not in SIDEBAR`).toBe(true)
  })

  it('groups keep the approved order', () => {
    // A subsequence: groups join as their pages are written, but never out of order.
    let from = 0
    for (const g of SIDEBAR) {
      const at = APPROVED_ORDER.indexOf(g.label, from)
      expect(at, `"${g.label}" is unknown or out of order`).toBeGreaterThanOrEqual(0)
      from = at + 1
    }
  })
})
