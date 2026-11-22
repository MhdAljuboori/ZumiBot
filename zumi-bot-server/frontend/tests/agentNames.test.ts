import { describe, expect, it } from 'vitest'
import { codeHandle, friendlyText, mentionLabel, revealsMention } from '../src/state/agentNames'

const agents = [{ name: 'workiom5-assistance' }, { name: 'ui-ux-specialist' }, { name: 'claude' }]

describe('mentionLabel', () => {
  it('reads an agent handle as its display name', () => {
    expect(mentionLabel('code-specialist')).toBe('@Code Specialist')
  })
  it('keeps @everyone as it is', () => {
    expect(mentionLabel('everyone')).toBe('@everyone')
  })
})

describe('friendlyText', () => {
  it('writes a known agent handle as its display name', () => {
    expect(friendlyText('/edit-agent @workiom5-assistance so the card', agents)).toBe('/edit-agent @Workiom5 Assistance so the card')
  })
  it('leaves unknown handles, code spans and @everyone alone', () => {
    expect(friendlyText('@nobody `@ui-ux-specialist` @everyone', agents)).toBe('@nobody `@ui-ux-specialist` @everyone')
  })
  it('matches a handle whatever its case', () => {
    expect(friendlyText('ask @UI-UX-Specialist', agents)).toBe('ask @Ui Ux Specialist')
  })
  it('keeps text with no agents to match', () => {
    expect(friendlyText('ask @ui-ux-specialist', [])).toBe('ask @ui-ux-specialist')
  })
})

describe('revealsMention', () => {
  // A mention at 3..19: the caret anywhere from its start to its end shows the raw handle for editing.
  it('reveals while the caret touches the mention', () => {
    expect(revealsMention(3, 19, 3, 3)).toBe(true)
    expect(revealsMention(3, 19, 10, 10)).toBe(true)
    expect(revealsMention(3, 19, 19, 19)).toBe(true)
  })
  it('shows the label once the caret is past it either way', () => {
    expect(revealsMention(3, 19, 2, 2)).toBe(false)
    expect(revealsMention(3, 19, 20, 20)).toBe(false)
  })
  it('reveals while a selection overlaps it', () => {
    expect(revealsMention(3, 19, 0, 5)).toBe(true)
    expect(revealsMention(3, 19, 0, 2)).toBe(false)
  })
})

describe('codeHandle', () => {
  it('names the agent a code span spells exactly', () => {
    expect(codeHandle('workiom5-assistance', agents)).toBe('workiom5-assistance')
  })
  it('skips a one-word handle, which usually names a program', () => {
    expect(codeHandle('claude', agents)).toBeNull()
  })
  it('skips anything that is not exactly a handle', () => {
    expect(codeHandle('ui-ux-specialist.md', agents)).toBeNull()
    expect(codeHandle(' ui-ux-specialist', agents)).toBeNull()
    expect(codeHandle('UI-UX-Specialist', agents)).toBeNull()
    expect(codeHandle('release-manager', agents)).toBeNull()
  })
})
