import { describe, expect, it } from 'vitest'
import { claudeCommandRows, codexSkillRows } from '../../../src/core/extensions/engineCommandRows'

describe('claudeCommandRows', () => {
  it('cuts a long hint at 80 characters, as the description at 300', () => {
    const [row] = claudeCommandRows({ commands: [{ name: 'x', description: 'd'.repeat(500), argumentHint: 'h'.repeat(200) }] })
    expect(row.hint).toBe('h'.repeat(80))
    expect(row.description).toBe('d'.repeat(300))
  })

  it('keeps allowed built-ins, plugin commands and a hint, and drops denied, __, reserved and malformed rows', () => {
    const rows = claudeCommandRows({
      commands: [
        { name: 'goal', description: 'Set a goal', builtin: true },
        { name: 'superpowers:brainstorming', description: 'Explore ideas' },
        { name: 'review', description: 'Review', argumentHint: '  [x]  ' },
        { name: 'model', description: 'Switch', builtin: true },
        { name: '__remote-workflow', description: 'x', builtin: true },
        { name: '__hidden', description: 'x' },
        { name: 'todo', description: 'x' },
        { name: 'btw', description: 'x', builtin: true },
        { name: 'run-workflow', description: 'x' },
        { name: 42 },
        { name: 'bad name', description: 'x' },
        { name: '-lead', description: 'x' },
        null,
        'text'
      ]
    })
    expect(rows).toEqual([
      { name: 'goal', description: 'Set a goal', kind: 'command' },
      { name: 'superpowers:brainstorming', description: 'Explore ideas', kind: 'command' },
      { name: 'review', description: 'Review', hint: '[x]', kind: 'command' }
    ])
  })

  it("drops the codex plugin's commands, which hand work to the other engine, and keeps names that only mention it", () => {
    const rows = claudeCommandRows({
      commands: [
        { name: 'codex:rescue', description: '(codex) Delegate to Codex' },
        { name: 'codex:review', description: '(codex) Run a Codex review' },
        { name: 'codex-notes', description: 'My own command' },
        { name: 'superpowers:brainstorming', description: 'Explore ideas' }
      ]
    })
    expect(rows.map((r) => r.name)).toEqual(['codex-notes', 'superpowers:brainstorming'])
  })

  it("keeps a user's own command that shares a denied built-in's name", () => {
    expect(claudeCommandRows({ commands: [{ name: 'model', description: 'Mine' }] })).toEqual([{ name: 'model', description: 'Mine', kind: 'command' }])
  })

  it('compares names as given, with no lowercasing', () => {
    expect(claudeCommandRows({ commands: [{ name: 'Model', description: 'x', builtin: true }] })).toHaveLength(1)
  })

  it('takes the first line, trimmed and cut at 300 characters, and the first row of a name', () => {
    const rows = claudeCommandRows({
      commands: [
        { name: 'a', description: '  First line  \nsecond line' },
        { name: 'b', description: 'x'.repeat(500) },
        { name: 'a', description: 'duplicate' },
        { name: 'c', description: 7, argumentHint: '   ' }
      ]
    })
    expect(rows.map((r) => r.name)).toEqual(['a', 'b', 'c'])
    expect(rows[0].description).toBe('First line')
    expect(rows[1].description).toHaveLength(300)
    expect(rows[2]).toEqual({ name: 'c', description: '', kind: 'command' })
  })

  it('marks a row a skill when the skills listing has it, a claude.ai skill by its short name, else a command', () => {
    const skills = {
      skills: [
        { name: 'apple-design', source: 'user' },
        { name: 'superpowers:brainstorming', source: 'plugin' },
        { name: 'anthropic-skills:pdf', source: 'claude.ai sync' },
        { name: 'anthropic-skills:deep-research', source: 'claude.ai sync' },
        null
      ]
    }
    const rows = claudeCommandRows(
      {
        commands: [
          { name: 'apple-design', description: 'd' },
          { name: 'superpowers:brainstorming', description: 'd' },
          { name: 'pdf', description: 'd' },
          { name: 'deep-research', description: 'd', builtin: true },
          { name: 'goal', description: 'd', builtin: true },
          { name: 'code-review:code-review', description: 'd' }
        ]
      },
      skills
    )
    expect(rows.map((r) => `${r.name}=${r.kind}`)).toEqual([
      'apple-design=skill',
      'superpowers:brainstorming=skill',
      'pdf=skill',
      'deep-research=command',
      'goal=command',
      'code-review:code-review=command'
    ])
  })

  it('marks every row a command when the skills listing is missing or of another shape', () => {
    for (const s of [null, undefined, {}, { skills: 'x' }])
      expect(claudeCommandRows({ commands: [{ name: 'apple-design', description: 'd' }] }, s)[0].kind).toBe('command')
  })

  it('gives no rows for an answer of another shape', () => {
    for (const a of [null, undefined, 'x', [], {}, { commands: 'x' }, { commands: {} }]) expect(claudeCommandRows(a)).toEqual([])
  })
})

describe('codexSkillRows', () => {
  it('keeps enabled skills with a path, prefers interface.shortDescription, keeps the path', () => {
    const rows = codexSkillRows({
      data: [
        {
          cwd: '/w',
          errors: [],
          skills: [
            { name: 'plain', description: 'Long', enabled: true, path: '/p/SKILL.md' },
            { name: 'short', description: 'Long', shortDescription: 'Short', enabled: true, path: '/q' },
            {
              name: 'iface',
              description: 'Long',
              shortDescription: 'Short',
              interface: { shortDescription: 'Iface' },
              enabled: true,
              path: '/r'
            },
            { name: 'off', description: 'd', enabled: false, path: '/s' },
            { name: 'nopath', description: 'd', enabled: true },
            { name: 'bad name', description: 'd', enabled: true, path: '/t' },
            { name: 'plain', description: 'again', enabled: true, path: '/u' },
            { name: 'nul', description: 'D', interface: null, enabled: true, path: '/v' },
            null
          ]
        }
      ]
    })
    expect(rows).toEqual([
      { name: 'plain', description: 'Long', path: '/p/SKILL.md', kind: 'skill' },
      { name: 'short', description: 'Short', path: '/q', kind: 'skill' },
      { name: 'iface', description: 'Iface', path: '/r', kind: 'skill' },
      { name: 'nul', description: 'D', path: '/v', kind: 'skill' }
    ])
  })

  it("drops a claude plugin's skills, which hand work to the other engine, and keeps skills both engines have", () => {
    const skill = (name: string) => ({ name, description: 'd', enabled: true, path: `/${name}` })
    const rows = codexSkillRows({
      data: [{ cwd: '/w', errors: [], skills: [skill('claude:delegate'), skill('claude-notes'), skill('superpowers:brainstorming')] }]
    })
    expect(rows.map((r) => r.name)).toEqual(['claude-notes', 'superpowers:brainstorming'])
  })

  it('gives no rows for an answer of another shape', () => {
    for (const a of [null, 'x', {}, { data: 'x' }, { data: [null, { skills: 'x' }] }]) expect(codexSkillRows(a)).toEqual([])
  })
})
