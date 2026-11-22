import { describe, expect, it } from 'vitest'
import { keptSwitches } from '../../src/core/connectors/migration'

const servers = [
  { name: 'claude.ai Gmail', connector: 'gmail' as const, status: 'connected' as const },
  { name: 'claude.ai Notion', connector: 'notion' as const, status: 'connected' as const },
  { name: 'stub', connector: null, status: 'connected' as const }
]

describe('keptSwitches', () => {
  it('keeps what each agent loads today', () => {
    const out = keptSwitches(servers, [
      { name: 'a', serversOff: ['claude.ai Notion'], own: [{ name: 'lin', url: 'https://mcp.linear.app/mcp' }] },
      { name: 'b', serversOff: ['claude.ai Gmail', 'claude.ai Notion'], own: [{ name: 'x', url: null }] }
    ])
    expect(out).toEqual({ a: ['gmail', 'linear'] })
    expect('b' in out).toBe(false)
  })

  it('lists in catalog order without repeats', () => {
    const out = keptSwitches(servers, [{ name: 'a', serversOff: [], own: [{ name: 'g', url: 'https://gmailmcp.googleapis.com/mcp/v1' }] }])
    expect(out).toEqual({ a: ['gmail', 'notion'] })
  })

  it('skips a connector turned off in Claude Code, and keeps one that only needs signing in again', () => {
    const rows = [
      { name: 'claude.ai Gmail', connector: 'gmail' as const, status: 'disabled' as const },
      { name: 'claude.ai Notion', connector: 'notion' as const, status: 'needs-auth' as const },
      { name: 'claude.ai Slack', connector: 'slack' as const, status: 'failed' as const },
      { name: 'claude.ai Linear', connector: 'linear' as const, status: 'disabled' as const },
      // A second server of the same service that is connected keeps it
      { name: 'claude.ai Linear (2)', connector: 'linear' as const, status: 'connected' as const },
      { name: 'claude.ai Google Drive', connector: 'google-drive' as const, status: 'pending' as const }
    ]
    expect(keptSwitches(rows, [{ name: 'a', serversOff: [], own: [] }])).toEqual({ a: ['google-drive', 'notion', 'slack', 'linear'] })
    // Nothing else is on: an agent with only a disabled connector gets no entry
    expect(keptSwitches(rows.slice(0, 1), [{ name: 'a', serversOff: [], own: [] }])).toEqual({})
    // The agent's own server at a catalog URL is its own connection, kept whatever the home loadout says
    expect(
      keptSwitches(rows.slice(0, 1), [{ name: 'a', serversOff: [], own: [{ name: 'g', url: 'https://gmailmcp.googleapis.com/mcp/v1' }] }])
    ).toEqual({ a: ['gmail'] })
  })
})
