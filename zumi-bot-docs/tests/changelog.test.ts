import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { publicChangelog } from '../src/lib/changelog.ts'

describe('publicChangelog', () => {
  it('drops the title and intro', () => {
    expect(publicChangelog('# Changelog\n\nIntro.\n\n## v1 — d\n\n- a\n')).toBe('## v1 — d\n\n- a\n')
  })

  it('keeps every release', () => {
    const raw = readFileSync(join(import.meta.dirname, '../../CHANGELOG.md'), 'utf8')
    const count = (s: string) => (s.match(/^## v/gm) ?? []).length
    expect(count(raw)).toBeGreaterThan(0)
    expect(count(publicChangelog(raw))).toBe(count(raw))
  })
})
