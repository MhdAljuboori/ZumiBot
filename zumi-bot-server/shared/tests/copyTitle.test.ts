import { describe, expect, it } from 'vitest'
import { copyTitle } from '@zumibot/shared/copyTitle'

describe('copyTitle', () => {
  it('fits the given cap with the number showing', () => {
    const out = copyTitle('w'.repeat(100), [], 100, 'Workflow')
    expect(out).toHaveLength(100)
    expect(out.endsWith(' (2)')).toBe(true)
  })

  it('uses the fallback for a blank name', () => {
    expect(copyTitle('  ', [], 100, 'Workflow')).toBe('Workflow (2)')
  })

  it('skips taken names and bumps a trailing number', () => {
    expect(copyTitle('Daily digest', ['Daily digest (2)'], 100, 'Workflow')).toBe('Daily digest (3)')
    expect(copyTitle('Daily digest (3)', [], 100, 'Workflow')).toBe('Daily digest (4)')
  })
})
