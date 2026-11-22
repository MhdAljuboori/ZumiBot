import { describe, expect, it } from 'vitest'
import { allowSettingsArgs } from '../../src/core/chat/allowRules'

describe('allowSettingsArgs', () => {
  it('puts chat rules first, dedupes and wraps them in one --settings', () => {
    expect(allowSettingsArgs(['Bash(a:*)'], ['Bash(a:*)', 'Bash(b:*)'], 'auto')).toEqual([
      '--settings',
      '{"permissions":{"allow":["Bash(a:*)","Bash(b:*)"]}}'
    ])
  })
  it('works in Ask and Accept edits', () => {
    expect(allowSettingsArgs(undefined, ['Bash(b:*)'], 'manual')).toHaveLength(2)
    expect(allowSettingsArgs(['Bash(b:*)'], [], 'acceptEdits')).toHaveLength(2)
  })
  it('never in Plan', () => {
    expect(allowSettingsArgs(['Bash(a:*)'], ['Bash(b:*)'], 'plan')).toEqual([])
  })
  it('keeps only exactly-shaped Bash rules', () => {
    expect(allowSettingsArgs(['Edit(x)', 'Bash(*)'], [], 'auto')).toEqual([])
    expect(allowSettingsArgs(['Edit(x)', 'Bash(ok:*)', 'Bash(a b)'], ['Bash(x)y:*)'], 'auto')).toEqual([
      '--settings',
      '{"permissions":{"allow":["Bash(ok:*)"]}}'
    ])
  })
  it('none at all gives nothing', () => {
    expect(allowSettingsArgs(undefined, [], 'auto')).toEqual([])
  })
})
