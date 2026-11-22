import { describe, expect, it } from 'vitest'
import { commandIssue, fillPrompt, leadingCommand, parseCommands, validCommands } from '@zumibot/shared/commands'

describe('fillPrompt', () => {
  it('replaces every $ARGUMENTS', () => expect(fillPrompt('A $ARGUMENTS B $ARGUMENTS', 'x')).toBe('A x B x'))
  it('appends after a blank line when the prompt has no placeholder', () => expect(fillPrompt('Check it', 'link')).toBe('Check it\n\nlink'))
  it('sends the prompt alone when nothing was typed', () => expect(fillPrompt('Check it', '')).toBe('Check it'))
  it('drops the trailing newline a YAML block scalar leaves', () => {
    expect(fillPrompt('Check it\n', 'link')).toBe('Check it\n\nlink')
    expect(fillPrompt('Use $ARGUMENTS\n', 'x')).toBe('Use x')
    expect(fillPrompt('Check it\n', '')).toBe('Check it')
  })
  it('keeps $ patterns in the user text', () => expect(fillPrompt('Use $ARGUMENTS', 'a$&b$1c$$')).toBe('Use a$&b$1c$$'))
})

describe('leadingCommand', () => {
  it('reads name and trimmed args', () =>
    expect(leadingCommand('/check  https://x/1 \n more')).toEqual({ name: 'check', args: 'https://x/1 \n more' }))
  it('takes a bare command', () => expect(leadingCommand('/upgrade-check')).toEqual({ name: 'upgrade-check', args: '' }))
  it.each(['/Check x', ' /check x', 'hi /check', '/check-', '//check', '/'])('ignores %j', (t) => expect(leadingCommand(t)).toBeNull())
  it('reads a longer name as its own name', () => expect(leadingCommand('/checkx L')?.name).toBe('checkx'))
})

describe('parseCommands / commandIssue / validCommands', () => {
  it('treats a non-list as no commands', () => {
    expect(parseCommands('check')).toEqual([])
    expect(parseCommands({ a: 1 })).toEqual([])
  })
  it('keeps bad rows for the editor and skips them in validCommands', () => {
    const list = parseCommands([
      { name: 'check', description: 'd', prompt: 'p' },
      { name: 'check', description: 'd', prompt: 'p' },
      { name: 'Fix', description: 'd', prompt: 'p' },
      { name: 'x', description: 'd' },
      'junk'
    ])
    expect(list).toHaveLength(5)
    expect(commandIssue(list, 1)).toBe('Another command is already named /check')
    expect(commandIssue(list, 2)).toBe('Name must be lowercase letters, digits and single hyphens')
    expect(commandIssue(list, 3)).toBe('Prompt is required')
    expect(validCommands(list).map((c) => c.name)).toEqual(['check'])
  })
  it('counts an object or list value as empty', () => {
    const list = parseCommands([
      { name: 'a', description: 'd', prompt: { a: 1 } },
      { name: 'b', description: ['x'], prompt: 'p' }
    ])
    expect(list[0].prompt).toBe('')
    expect(list[1].description).toBe('')
    expect(validCommands(list)).toEqual([])
    expect(commandIssue(list, 0)).toBe('Prompt is required')
    expect(commandIssue(list, 1)).toBe('Description is required')
  })
  it('caps the prompt', () =>
    expect(commandIssue([{ name: 'a', description: 'd', prompt: 'x'.repeat(8001) }], 0)).toBe('Prompt is longer than 8000 characters'))
  it('wants a one-line description', () =>
    expect(commandIssue([{ name: 'a', description: 'one\ntwo', prompt: 'p' }], 0)).toBe('Description must be one line'))
  it('wants a description', () => expect(commandIssue([{ name: 'a', description: ' ', prompt: 'p' }], 0)).toBe('Description is required'))
  it('keeps todos: true and drops any other value', () => {
    const list = parseCommands([
      { name: 'a', description: 'd', prompt: 'p', todos: true },
      { name: 'b', description: 'd', prompt: 'p', todos: 'yes' },
      { name: 'c', description: 'd', prompt: 'p', todos: false },
      { name: 'd', description: 'd', prompt: 'p' }
    ])
    expect(list[0].todos).toBe(true)
    expect(list.slice(1).every((c) => !('todos' in c))).toBe(true)
  })
  it('reserves /todo', () => expect(commandIssue([{ name: 'todo', description: 'd', prompt: 'p' }], 0)).toBe('/todo is built in'))
  it('keeps a model as written, and only opus, sonnet or haiku is valid', () => {
    const parsed = parseCommands([
      { name: 'card', description: 'd', prompt: 'p', model: 'sonnet' },
      { name: 'odd', description: 'd', prompt: 'p', model: 'gpt-5' },
      { name: 'none', description: 'd', prompt: 'p' }
    ])
    expect(parsed.map((c) => c.model)).toEqual(['sonnet', 'gpt-5', undefined])
    expect(commandIssue(parsed, 1)).toBe('Model must be opus, sonnet or haiku')
    expect(validCommands(parsed).map((c) => c.name)).toEqual(['card', 'none'])
  })
})
