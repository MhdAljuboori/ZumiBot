import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { CONNECTOR_IDS } from '@zumibot/shared/connectors'
import { NO_EXTENSIONS, type Loadout } from '@zumibot/shared/extensions'
import { keyVarInUse } from '../../src/core/claudeStatus'
import { buildArgs } from '../../src/core/chat/claudeRunner'
import { buildAgentRunConfig } from '../../src/core/extensions/agentRunConfig'
import { connectorsGuardSettings } from '../../src/core/connectors/connectorsGuard'
import { vaultGuardSettings } from '../../src/core/vault/vaultGuard'
import { ConnectorStore } from '../../src/core/connectors/connectorStore'
import { ConnectorsService, startConnectors } from '../../src/core/connectors/connectorsService'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-connwire-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('connectors view with the real keyVarInUse', () => {
  it('names the variable, never the key', async () => {
    const secret = 'sk-ant-super-secret-value-123'
    const store = new ConnectorStore(dir)
    await store.load()
    const svc = new ConnectorsService({
      store,
      loadout: async () =>
        ({
          engine: 'claude',
          version: '2',
          folder: '/h',
          agent: null,
          servers: [],
          plugins: [],
          skills: [],
          hooks: [],
          errors: {},
          at: 1
        }) as Loadout,
      agents: async () => [],
      extensionsOf: async () => null,
      // The same shape as app.ts: the variable's name from the run env.
      keyVar: async () => keyVarInUse({ ANTHROPIC_API_KEY: secret }),
      now: () => 1,
      onChanged: () => {},
      log: () => {}
    })
    const text = JSON.stringify(await svc.list(false))
    expect(text).toContain('ANTHROPIC_API_KEY')
    expect(text).not.toContain(secret)
  })
})

describe('start-up chain', () => {
  const make = async (agents: () => Promise<never[]>, loadout: () => Promise<Loadout>) => {
    const store = new ConnectorStore(dir)
    await store.load()
    return new ConnectorsService({
      store,
      loadout,
      agents,
      extensionsOf: async () => null,
      keyVar: async () => null,
      now: () => 1,
      onChanged: () => {},
      log: () => {}
    })
  }
  const loadout = () =>
    vi.fn(
      async () =>
        ({
          engine: 'claude',
          version: '2',
          folder: '/h',
          agent: null,
          servers: [],
          plugins: [],
          skills: [],
          hooks: [],
          errors: {},
          at: 1
        }) as Loadout
    )

  it('runs learn once after the switch-over settles', async () => {
    const svc = await make(async () => [], loadout())
    const learn = vi.spyOn(svc, 'learn')
    await startConnectors(svc, () => {})
    expect(learn).toHaveBeenCalledTimes(1)
  })

  it('runs learn once even when the switch-over failed, and reports the failure', async () => {
    const svc = await make(async () => {
      throw Object.assign(new Error('x'), { code: 'EACCES' })
    }, loadout())
    const learn = vi.spyOn(svc, 'learn')
    const failed = vi.fn()
    await startConnectors(svc, failed)
    expect(failed).toHaveBeenCalledWith('EACCES')
    expect(learn).toHaveBeenCalledTimes(1)
  })
})

describe('ask rules in the run one --settings', () => {
  it('merge with the guard deny rules instead of replacing them', () => {
    const cfg = buildAgentRunConfig(NO_EXTENSIONS, [], { connectorsOff: CONNECTOR_IDS.filter((id) => id !== 'gmail') })
    const guard = vaultGuardSettings({
      keyFile: '/home/u/.config/zumibot-vault/vault.key',
      vaultFile: '/home/u/.local/share/zumibot/vault.json',
      home: '/home/u'
    })
    const connGuard = connectorsGuardSettings('/data/connectors.json')
    const args = buildArgs({
      agentName: 'a',
      resumeSessionId: null,
      permissionMode: 'auto',
      extraArgs: [...cfg.extraArgs, '--settings', guard, '--settings', connGuard]
    })
    expect(args.filter((a) => a === '--settings')).toHaveLength(1)
    const merged = JSON.parse(args[args.indexOf('--settings') + 1]) as { permissions: { ask: string[]; deny: string[] } }
    expect(merged.permissions.ask).toContain('mcp__claude_ai_Gmail__*')
    expect(merged.permissions.ask.some((r) => r.includes('Slack'))).toBe(false)
    for (const d of [...JSON.parse(guard).permissions.deny, ...JSON.parse(connGuard).permissions.deny])
      expect(merged.permissions.deny).toContain(d)
  })
})
