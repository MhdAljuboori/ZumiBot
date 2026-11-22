import { describe, expect, it } from 'vitest'
import {
  CONNECTORS,
  CONNECTOR_IDS,
  askRules,
  connectorCallOf,
  connectorPrefixes,
  offRefusal,
  unattendedRefusal,
  connectorById,
  connectorOf,
  connectorState,
  connectorTools,
  denyEntries,
  isConnectorId,
  isReadTool,
  unknownTools,
  urlMatches,
  type Connector
} from '@zumibot/shared/connectors'
import { toolPrefix } from '@zumibot/shared/extensions'

describe('catalog', () => {
  it('ids are fixed', () => {
    expect(CONNECTORS.map((c) => c.id)).toEqual([...CONNECTOR_IDS])
    expect(CONNECTORS.map((c) => c.name)).toEqual(['Gmail', 'Google Calendar', 'Google Drive', 'Notion', 'GitHub', 'Slack', 'Linear'])
    expect(isConnectorId('gmail')).toBe(true)
    expect(isConnectorId('myspace')).toBe(false)
    expect(isConnectorId(7)).toBe(false)
    expect(connectorById('slack').name).toBe('Slack')
  })

  it('every url and pattern is https and every link is on claude.ai', () => {
    for (const c of CONNECTORS) {
      for (const u of c.urls) expect(u.startsWith('https://')).toBe(true)
      if (c.customUrl !== null) expect(c.customUrl.startsWith('https://')).toBe(true)
      expect(c.connectUrl.startsWith('https://claude.ai/')).toBe(true)
    }
  })

  it('no pattern or name in two entries', () => {
    const urls = CONNECTORS.flatMap((c) => c.urls)
    const names = CONNECTORS.flatMap((c) => c.names)
    expect(new Set(urls).size).toBe(urls.length)
    expect(new Set(names).size).toBe(names.length)
  })

  it('read and write are disjoint per entry', () => {
    for (const c of CONNECTORS) {
      expect(c.read.length).toBeGreaterThan(0)
      expect(c.read.filter((t) => c.write.includes(t))).toEqual([])
    }
  })

  it('catalog cannot be extended', () => {
    expect(Object.isFrozen(CONNECTORS)).toBe(true)
    for (const c of CONNECTORS) {
      expect(Object.isFrozen(c)).toBe(true)
      for (const list of [c.urls, c.names, c.read, c.write]) expect(Object.isFrozen(list)).toBe(true)
    }
    expect(() => (CONNECTORS as Connector[]).push(CONNECTORS[0])).toThrow(TypeError)
  })
})

describe('matching', () => {
  it('connectorOf matches URL first', () => {
    expect(connectorOf('https://mcp.notion.com/mcp', 'whatever')).toBe('notion')
    expect(connectorOf('https://api.githubcopilot.com/mcp/', 'My GitHub')).toBe('github')
    expect(connectorOf('https://gmailmcp.googleapis.com/mcp/v1', 'x')).toBe('gmail')
    expect(connectorOf('https://gmail.mcp.claude.com/mcp', 'x')).toBe('gmail')
  })

  it('connectorOf falls back to the claude.ai name', () => {
    expect(connectorOf('https://example.invalid/mcp', 'claude.ai Gmail')).toBe('gmail')
    expect(connectorOf(null, 'claude.ai Gmail (2)')).toBe('gmail')
    expect(connectorOf(null, 'claude.ai Fake Drive')).toBeNull()
  })

  it('connectorOf skips the URL step for a non-https url', () => {
    expect(connectorOf('http://mcp.notion.com/mcp', 'x')).toBeNull()
  })

  it('urlMatches is literal outside *', () => {
    expect(urlMatches('https://mcp.notion.com/*', 'https://mcp.notion.com/mcp')).toBe(true)
    expect(urlMatches('https://mcp.notion.com/*', 'https://mcpXnotion.com/a')).toBe(false)
    expect(urlMatches('https://mcp.notion.com/*', 'https://mcp.notion.com.evil.test/a')).toBe(false)
    expect(urlMatches('https://a.test/mcp', 'https://a.test/mcp/x')).toBe(false)
  })
})

describe('connectorState and tools', () => {
  it('takes the best of the matching rows', () => {
    expect(
      connectorState(
        [
          { connector: 'gmail', status: 'needs-auth' },
          { connector: 'gmail', status: 'connected' }
        ],
        'gmail'
      )
    ).toBe('connected')
    expect(connectorState([{ connector: 'gmail', status: 'pending' }], 'gmail')).toBe('needs-attention')
    expect(connectorState([{ connector: 'gmail', status: 'failed' }], 'gmail')).toBe('needs-attention')
    expect(connectorState([{ connector: 'gmail', status: 'unknown' }], 'gmail')).toBe('needs-attention')
    expect(connectorState([{ connector: 'gmail', status: 'disabled' }], 'gmail')).toBe('off-in-claude-code')
    expect(
      connectorState(
        [
          { connector: 'gmail', status: 'disabled' },
          { connector: 'gmail', status: 'failed' }
        ],
        'gmail'
      )
    ).toBe('needs-attention')
    expect(
      connectorState(
        [
          { connector: 'slack', status: 'connected' },
          { connector: null, status: 'connected' }
        ],
        'gmail'
      )
    ).toBe('not-connected')
    expect(connectorState([], 'gmail')).toBe('not-connected')
  })

  it('connectorTools is the union in first-seen order', () => {
    expect(
      connectorTools(
        [
          { connector: 'gmail', tools: ['a', 'b'] },
          { connector: 'slack', tools: ['z'] },
          { connector: 'gmail', tools: ['b', 'c'] },
          { connector: null, tools: ['q'] }
        ],
        'gmail'
      )
    ).toEqual(['a', 'b', 'c'])
  })
})

describe('tool classes', () => {
  it('unknown tool is a write', () => {
    expect(isReadTool('gmail', 'send_message')).toBe(false)
    expect(isReadTool('gmail', 'search_threads')).toBe(true)
    expect(isReadTool('gmail', 'brand_new')).toBe(false)
    expect(unknownTools('gmail', ['search_threads', 'brand_new', 'send_message', 'x2'])).toEqual(['brand_new', 'x2'])
  })

  it('the lists carry the spec tools', () => {
    expect(isReadTool('github', 'pull_request_read')).toBe(true)
    expect(isReadTool('github', 'merge_pull_request')).toBe(false)
    expect(isReadTool('github', 'ui_get')).toBe(false)
    expect(isReadTool('notion', 'notion-search')).toBe(true)
    expect(isReadTool('notion', 'notion-update-page')).toBe(false)
    expect(unknownTools('notion', ['notion-update-page', 'notion-delete-pages'])).toEqual([])
  })
})

describe('denyEntries', () => {
  it('lists urls, then names, and the tool prefix', () => {
    expect(denyEntries(['gmail'])).toEqual({
      deniedMcpServers: [
        { serverUrl: 'https://gmailmcp.googleapis.com/*' },
        { serverUrl: 'https://gmail.mcp.claude.com/*' },
        { serverName: 'claude.ai Gmail' }
      ],
      disallowedTools: ['mcp__claude_ai_Gmail']
    })
  })

  it('github has a url entry and no tool prefix', () => {
    const out = denyEntries(['github'])
    expect(out.deniedMcpServers).toEqual([{ serverUrl: 'https://api.githubcopilot.com/mcp*' }])
    expect(out.disallowedTools).toEqual([])
  })

  it('empty and unknown ids give nothing, and catalog order wins', () => {
    expect(denyEntries([])).toEqual({ deniedMcpServers: [], disallowedTools: [] })
    expect(denyEntries(['nope' as never])).toEqual({ deniedMcpServers: [], disallowedTools: [] })
    expect(denyEntries(['slack', 'gmail']).disallowedTools).toEqual(['mcp__claude_ai_Gmail', 'mcp__claude_ai_Slack'])
  })
})

describe('phase 3 helpers', () => {
  const servers = [
    { name: 'claude.ai Gmail (2)', connector: 'gmail' as const },
    { name: 'My GitHub', connector: 'github' as const }
  ]

  it('connectorPrefixes maps every catalog name and nothing else', () => {
    const p = connectorPrefixes([])
    const expected: Record<string, string> = {}
    for (const c of CONNECTORS) for (const n of c.names) expected[toolPrefix(n)] = c.id
    expect(p).toEqual(expected)
    expect(p['mcp__claude_ai_Gmail']).toBe('gmail')
  })

  it('connectorPrefixes adds the given servers', () => {
    const p = connectorPrefixes(servers)
    expect(p['mcp__claude_ai_Gmail__2_']).toBe('gmail')
    expect(p['mcp__My_GitHub']).toBe('github')
    expect(p['mcp__claude_ai_Gmail']).toBe('gmail')
  })

  it('connectorPrefixes returns a fresh object', () => {
    const a = connectorPrefixes([])
    a['mcp__evil'] = 'slack'
    delete a['mcp__claude_ai_Gmail']
    const b = connectorPrefixes([])
    expect(b['mcp__evil']).toBeUndefined()
    expect(b['mcp__claude_ai_Gmail']).toBe('gmail')
  })

  it('connectorCallOf takes the longest prefix', () => {
    const p = connectorPrefixes(servers)
    expect(connectorCallOf('mcp__claude_ai_Gmail__send_message', p)).toEqual({ id: 'gmail', tool: 'send_message' })
    expect(connectorCallOf('mcp__claude_ai_Gmail__2___send_message', p)).toEqual({ id: 'gmail', tool: 'send_message' })
    expect(connectorCallOf('mcp__My_GitHub__create_pull_request', p)).toEqual({ id: 'github', tool: 'create_pull_request' })
  })

  it('connectorCallOf is null for anything that is not a connector call', () => {
    const p = connectorPrefixes(servers)
    for (const t of [
      'mcp__claude_ai_Gmailx__send_message',
      'mcp__claude_ai_Gmail',
      'mcp__claude_ai_Gmail__',
      'mcp__zumibot_todos__add',
      'Bash'
    ]) {
      expect(connectorCallOf(t, p)).toBeNull()
    }
  })

  it('askRules lists one sorted wildcard per prefix of the connectors on', () => {
    const p = connectorPrefixes(servers)
    const gmail = [...CONNECTORS.find((c) => c.id === 'gmail')!.names.map((n) => toolPrefix(n)), 'mcp__claude_ai_Gmail__2_']
      .map((x) => `${x}__*`)
      .sort()
    expect(askRules(['gmail'], p)).toEqual(gmail)
    expect(askRules(['gmail'], p)).toEqual(['mcp__claude_ai_Gmail__*', 'mcp__claude_ai_Gmail__2___*'])
    expect(askRules([], p)).toEqual([])
    expect(askRules(['github'], connectorPrefixes([]))).toEqual([])
    expect(askRules(['github'], p)).toEqual(['mcp__My_GitHub__*'])
  })

  it('unattendedRefusal is the fixed sentence', () => {
    expect(unattendedRefusal('gmail', 'send_message')).toBe(
      'Gmail send_message changes data outside this machine. Runs started by a routine or workflow may only read; ask the user to do this in a chat.'
    )
  })

  it('offRefusal names the service and the Connectors page', () => {
    expect(offRefusal('gmail')).toBe('Gmail is not turned on for this agent on the Connectors page.')
    expect(offRefusal('google-calendar')).toBe('Google Calendar is not turned on for this agent on the Connectors page.')
  })
})
