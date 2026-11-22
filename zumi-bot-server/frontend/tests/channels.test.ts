import { describe, expect, it } from 'vitest'
import type { ChannelStatus } from '@zumibot/shared/channels'
import type { AgentSummary } from '@zumibot/shared/types'
import { channelAgents, pairLine, stateLine, toggleAgent } from '../src/state/channels'

const status = (o: Partial<ChannelStatus>): ChannelStatus => ({
  platform: 'telegram',
  configured: true,
  run: true,
  state: 'connected',
  bot: 'b',
  paired: null,
  pairing: null,
  agents: [],
  sharedCards: false,
  notify: { waiting: false, replied: false, error: false, routineFailed: false, workflow: false },
  ...o
})
const agent = (name: string, error: string | null = null) => ({ name, error }) as AgentSummary

describe('channels settings', () => {
  it('says where the bot stands', () => {
    expect(stateLine(status({ configured: false }))).toBe('No bot token saved.')
    expect(stateLine(status({ run: false }))).toMatch(/^Runs on the other machine/)
    expect(stateLine(status({}))).toBe('Connected as @b.')
    expect(stateLine(status({ state: 'conflict' }))).toMatch(/^Another machine/)
    expect(stateLine(status({ state: 'vault' }))).toMatch(/vault key/)
  })

  it('never lists Zumi Bot or a broken agent', () => {
    expect(channelAgents([agent('zed'), agent('zumi-bot'), agent('broken', 'bad yaml'), agent('amy')]).map((a) => a.name)).toEqual([
      'amy',
      'zed'
    ])
  })

  it('flips one agent and shows the code with its time left', () => {
    expect(toggleAgent(['a'], 'b', true)).toEqual(['a', 'b'])
    expect(toggleAgent(['a', 'b'], 'a', false)).toEqual(['b'])
    expect(pairLine('ABCDEFGH', 10 * 60_000, 30_000)).toBe('ABCD-EFGH · 10 min left')
    expect(pairLine('ABCDEFGH', 1000, 2000)).toBe('ABCD-EFGH · expired')
  })
})

describe('channels settings, Slack', () => {
  it('names the platform and both tokens', async () => {
    const { channelTid } = await import('../src/state/channels')
    const slack = (o: Partial<ChannelStatus>) => status({ platform: 'slack', ...o })
    expect(stateLine(slack({ configured: false }))).toBe('No tokens saved.')
    expect(stateLine(slack({ state: 'badToken' }))).toBe('Slack refused a token. Paste both again.')
    expect(stateLine(slack({ state: 'error' }))).toBe("Can't reach Slack right now. Retrying.")
    expect(channelTid('telegram', 'run')).toBe('channel-run')
    expect(channelTid('slack', 'run')).toBe('slack-run')
  })
})
