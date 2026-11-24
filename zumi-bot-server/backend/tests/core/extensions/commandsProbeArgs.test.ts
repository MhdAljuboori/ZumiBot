import { describe, expect, it } from 'vitest'
import { commandsProbeArgs } from '../../../src/core/extensions/commandsProbeArgs'

const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf('--settings') + 1])

describe('commandsProbeArgs', () => {
  const full = [
    '--settings',
    JSON.stringify({
      skillOverrides: { noisy: 'off' },
      enabledPlugins: { 'p@m': true },
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] },
      deniedMcpServers: [{ serverName: 'a' }],
      permissions: { ask: ['mcp__x'] }
    }),
    '--mcp-config',
    JSON.stringify({ mcpServers: { own: { command: 'srv' } } })
  ]

  it('keeps skill overrides and plugins, turns hooks off, and drops the servers and the rest', () => {
    const args = commandsProbeArgs(full)
    expect(settingsOf(args)).toEqual({ disableAllHooks: true, skillOverrides: { noisy: 'off' }, enabledPlugins: { 'p@m': true } })
    expect(args).toContain('--strict-mcp-config')
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--disallowedTools')
  })

  it('still turns hooks off and servers strict for a run config with no settings or unreadable ones', () => {
    for (const extra of [[], ['--settings', 'not json'], ['--settings']]) {
      const args = commandsProbeArgs(extra)
      expect(settingsOf(args)).toEqual({ disableAllHooks: true })
      expect(args).toContain('--strict-mcp-config')
    }
  })
})
