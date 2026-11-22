import { beforeEach, describe, expect, it } from 'vitest'
import { CONNECTOR_TEXT } from '@zumibot/shared/connectors'
import type { AgentSummary } from '@zumibot/shared/types'
import { createHandlers, type HandlerDeps, type Handlers } from '../../src/rpc/handlers'

let h: Handlers
let calls: Array<[string, unknown[]]>

const agent = (name: string, error: string | null = null, provider?: 'codex'): AgentSummary =>
  ({
    filePath: `/agents/${name}.md`,
    name,
    description: '',
    color: null,
    icon: null,
    error,
    builtIn: name === 'zumi-bot',
    ...(provider ? { provider } : {})
  }) as AgentSummary

beforeEach(() => {
  calls = []
  h = createHandlers({
    connectors: {
      list: async (...args: unknown[]) => {
        calls.push(['list', args])
        return { listed: true }
      },
      setAgent: async (...args: unknown[]) => {
        calls.push(['setAgent', args])
      },
      setRemember: async (...args: unknown[]) => {
        calls.push(['setRemember', args])
      }
    },
    agents: { list: async () => [agent('dev'), agent('broken', 'bad frontmatter'), agent('zumi-bot'), agent('cx', null, 'codex')] }
  } as unknown as HandlerDeps)
})

describe('connectors handlers', () => {
  it('list passes refresh', async () => {
    await h['connectors:list'](null)
    await h['connectors:list'](undefined)
    await h['connectors:list'](true)
    expect(calls).toEqual([
      ['list', [false]],
      ['list', [false]],
      ['list', [true]]
    ])
    await expect(h['connectors:list']('yes')).rejects.toThrow(TypeError)
    expect(calls).toHaveLength(3)
  })

  it('setAgent validates', async () => {
    await expect(h['connectors:setAgent']('fax', 'dev', true)).rejects.toThrow(TypeError)
    await expect(h['connectors:setAgent']('gmail', 1, true)).rejects.toThrow(TypeError)
    await expect(h['connectors:setAgent']('gmail', 'dev', 'on')).rejects.toThrow(TypeError)
    for (const a of ['zumi-bot', 'cx', 'broken', 'ghost']) {
      await expect(h['connectors:setAgent']('gmail', a, true), a).rejects.toThrow(CONNECTOR_TEXT.notSwitchable)
    }
    expect(calls).toEqual([])
  })

  it('setAgent passes a valid call', async () => {
    await h['connectors:setAgent']('slack', 'dev', false)
    expect(calls).toEqual([['setAgent', ['slack', 'dev', false]]])
  })

  it('setRemember validates', async () => {
    await expect(h['connectors:setRemember']('nope', true)).rejects.toThrow(TypeError)
    await expect(h['connectors:setRemember'](1, true)).rejects.toThrow(TypeError)
    await expect(h['connectors:setRemember'](null, true)).rejects.toThrow(TypeError)
    await expect(h['connectors:setRemember']('gmail', 'yes')).rejects.toThrow(TypeError)
    await expect(h['connectors:setRemember']('gmail', undefined)).rejects.toThrow(TypeError)
    expect(calls).toEqual([])
  })

  it('setRemember passes a valid call', async () => {
    await h['connectors:setRemember']('gmail', true)
    await h['connectors:setRemember']('slack', false)
    expect(calls).toEqual([
      ['setRemember', ['gmail', true]],
      ['setRemember', ['slack', false]]
    ])
  })
})
