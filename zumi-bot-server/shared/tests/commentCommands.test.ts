import { describe, expect, it } from 'vitest'
import { commandTokens, commentCommands } from '../src/commentCommands'
import type { AgentCommand } from '../src/commands'

const card: AgentCommand = { name: 'card', description: 'Make a card', prompt: 'Create a card for: $ARGUMENTS' }
const check: AgentCommand = { name: 'check', description: 'Check it', prompt: 'Check the work.' }

describe('commandTokens', () => {
  it('finds /name at the start or after whitespace, never inside a path or code', () => {
    expect(commandTokens('@a /card now /etc/hosts http://x/card `/check` /check').map((t) => t.name)).toEqual(['card', 'check'])
  })
})

describe('commentCommands', () => {
  it('fills each owned command once with the comment minus handles and commands', () => {
    const got = commentCommands('@a /card fix the login bug /card @b', [card, check], ['a', 'b'])
    expect(got).toEqual([{ name: 'card', prompt: 'Create a card for: fix the login bug' }])
  })

  it('runs every owned command named, in order, and leaves other /words in the text', () => {
    const got = commentCommands('@a /check then /card /other words', [card, check], ['a'])
    expect(got.map((c) => c.name)).toEqual(['check', 'card'])
    expect(got[1]!.prompt).toBe('Create a card for: then /other words')
  })

  it('is empty when the agent owns none of the commands written', () => {
    expect(commentCommands('@a /deploy', [card], ['a'])).toEqual([])
  })
})
