import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { CONNECTOR_TEXT } from '@zumibot/shared/connectors'
import type { Loadout, LoadoutServer, AgentExtensions } from '@zumibot/shared/extensions'
import type { AgentSummary } from '@zumibot/shared/types'
import { ConnectorStore } from '../../src/core/connectors/connectorStore'
import { ConnectorsService, startConnectors } from '../../src/core/connectors/connectorsService'
import type { ConnectorsDeps } from '../../src/core/connectors/connectorsService'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-connsvc-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const agent = (name: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
  filePath: `/x/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...extra
})
const server = (name: string, connector: LoadoutServer['connector'], over: Partial<LoadoutServer> = {}): LoadoutServer =>
  ({
    name,
    status: 'connected',
    source: 'claude-ai',
    transport: 'claudeai-proxy',
    plugin: null,
    tools: [],
    scope: null,
    note: null,
    connector,
    ...over
  }) as LoadoutServer
const loadoutOf = (servers: LoadoutServer[], errors: Loadout['errors'] = {}): Loadout => ({
  engine: 'claude',
  version: '2',
  folder: '/h',
  agent: null,
  servers,
  plugins: [],
  skills: [],
  hooks: [],
  errors,
  at: 1
})
const ext = (over: Partial<AgentExtensions> = {}): AgentExtensions => ({
  serversOff: [],
  skillsOff: [],
  plugins: {},
  servers: [],
  serversEditable: true,
  hooks: {} as AgentExtensions['hooks'],
  hooksEditable: true,
  ...over
})

async function make(over: Partial<ConnectorsDeps> = {}) {
  const store = new ConnectorStore(dir)
  await store.load()
  const onChanged = vi.fn()
  const deps: ConnectorsDeps = {
    store,
    loadout: vi.fn(async () => loadoutOf([server('claude.ai Gmail', 'gmail'), server('claude.ai Slack', 'slack')])),
    agents: async () => [agent('dev'), agent('cx', { provider: 'codex' }), agent('zumi-bot')],
    extensionsOf: async () => ext(),
    keyVar: async () => null,
    now: () => 42,
    onChanged,
    log: vi.fn(),
    ...over
  }
  return { svc: new ConnectorsService(deps), deps, store, onChanged }
}

describe('ConnectorsService', () => {
  it('switch-over with no Claude agents writes kept without probing', async () => {
    const { svc, deps, store } = await make({
      agents: async () => [agent('cx', { provider: 'codex' }), agent('zumi-bot'), agent('bad', { error: 'x' })]
    })
    await svc.migrate()
    expect(deps.loadout).not.toHaveBeenCalled()
    expect(store.migration()).toBe('kept')
  })

  it('switch-over keeps on-state', async () => {
    const { svc, store, onChanged, deps } = await make()
    await svc.migrate()
    expect(store.onFor('dev')).toEqual(['gmail', 'slack'])
    expect(store.onFor('cx')).toEqual([])
    expect(store.agents()).toEqual(['dev'])
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledWith('connectors: kept on-state for 1 agents')
  })

  it('switch-over failure starts everything off', async () => {
    const a = await make({
      loadout: vi.fn(async () => {
        throw new Error('secret https://x cli text')
      })
    })
    await a.svc.migrate()
    expect(a.store.migration()).toBe('failed')
    expect(a.store.onFor('dev')).toEqual([])
    expect(a.deps.log).toHaveBeenCalledWith('connectors: switch-over probe failed, every connector starts off')
    const dir2 = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-connsvc-'))
    try {
      const store = new ConnectorStore(dir2)
      await store.load()
      const b = new ConnectorsService({ ...a.deps, store, loadout: async () => loadoutOf([], { servers: 'nope' }) })
      await b.migrate()
      expect(store.migration()).toBe('failed')
      expect(store.onFor('dev')).toEqual([])
    } finally {
      await fs.rm(dir2, { recursive: true, force: true })
    }
  })

  it('a stop during the probe leaves the store unmigrated and writes nothing', async () => {
    let fail!: () => void
    const probing = new Promise<never>((_, rej) => {
      fail = () => rej(new Error('ESHUTDOWN'))
    })
    const { svc, store, onChanged, deps } = await make({ loadout: vi.fn(() => probing) })
    const migrating = svc.migrate()
    await vi.waitFor(() => expect(deps.loadout).toHaveBeenCalled())
    const stopping = svc.stop()
    fail() // what extensions.stop() does to the probe
    await Promise.all([migrating, stopping])
    expect(store.migrated()).toBe(false)
    expect(store.migration()).toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
    expect(await fs.readdir(dir)).toEqual([])
    await svc.migrate() // after stop: still nothing
    expect(deps.loadout).toHaveBeenCalledTimes(1)
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('a stop that lands while the probe returns an error loadout writes nothing', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { svc, store } = await make({
      loadout: vi.fn(async () => {
        await gate
        return loadoutOf([], { servers: 'aborted' })
      })
    })
    const migrating = svc.migrate()
    const stopping = svc.stop()
    release()
    await Promise.all([migrating, stopping])
    expect(store.migrated()).toBe(false)
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('migrate twice probes once', async () => {
    const { svc, deps } = await make()
    await Promise.all([svc.migrate(), svc.migrate()])
    await svc.migrate()
    expect(deps.loadout).toHaveBeenCalledTimes(1)
  })

  it('migrate takes own servers and serversOff from each agent', async () => {
    const { svc, store } = await make({
      extensionsOf: async () =>
        ext({
          serversOff: ['claude.ai Slack'],
          servers: [
            { name: 'lin', def: { url: 'https://mcp.linear.app/mcp' } },
            { name: 'nodef', def: null }
          ]
        })
    })
    await svc.migrate()
    expect(store.onFor('dev')).toEqual(['gmail', 'linear'])
  })

  it('list while running', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { svc } = await make({
      extensionsOf: async () => {
        await gate
        return ext()
      }
    })
    const migrating = svc.migrate()
    const view = await svc.list(false)
    expect(view.migration).toBe('running')
    expect(view.connectors.every((c) => c.on.length === 0)).toBe(true)
    release()
    await migrating
    expect((await svc.list(false)).migration).toBe('kept')
  })

  it('list builds cards', async () => {
    const { svc } = await make({
      loadout: async () => loadoutOf([server('claude.ai Gmail', 'gmail', { tools: ['search_threads', 'brand_new'] })])
    })
    await svc.migrate()
    const view = await svc.list(true)
    const gmail = view.connectors.find((c) => c.id === 'gmail')!
    expect(gmail).toMatchObject({ state: 'connected', unknownTools: ['brand_new'], on: ['dev'], tools: ['search_threads', 'brand_new'] })
    expect(view.connectors.find((c) => c.id === 'google-drive')!.state).toBe('not-connected')
    expect(view.agents).toEqual([
      { name: 'cx', engine: 'codex' },
      { name: 'dev', engine: 'claude' }
    ])
    expect(view.at).toBe(42)
    expect(view.error).toBeNull()
  })

  it('list names the key variable, never its value', async () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-fake-value' }
    const { svc } = await make({ keyVar: async () => 'ANTHROPIC_API_KEY' })
    const json = JSON.stringify(await svc.list(false))
    expect(json).toContain('ANTHROPIC_API_KEY')
    expect(json).not.toContain(env.ANTHROPIC_API_KEY)
  })

  it('probe failure shows not checked', async () => {
    const { svc, deps } = await make()
    await svc.migrate()
    const failing = new ConnectorsService({
      ...deps,
      loadout: async () => {
        throw new Error('boom https://x')
      }
    })
    const view = await failing.list(true)
    expect(view.error).toBe(CONNECTOR_TEXT.probeFailed)
    expect(view.connectors.every((c) => c.state === 'unknown' && c.tools.length === 0)).toBe(true)
    expect(JSON.stringify(view)).not.toContain('boom')
  })

  it('a loadout error sentence reaches the view', async () => {
    const { svc } = await make({ loadout: async () => loadoutOf([], { servers: 'Fixed sentence.' }) })
    await svc.migrate()
    const view = await svc.list(false)
    expect(view.error).toBe('Fixed sentence.')
    expect(view.connectors.every((c) => c.state === 'unknown')).toBe(true)
  })

  describe('server names', () => {
    const named = () => loadoutOf([server('claude.ai Gmail', 'gmail'), server('My GitHub', 'github'), server('ordinary', null)])

    it('list adds the catalog servers it saw, not the ordinary ones', async () => {
      const { svc } = await make({ loadout: vi.fn(async () => named()) })
      expect(svc.serverNames()).toEqual([])
      await svc.list(false)
      expect(svc.serverNames()).toEqual([
        { name: 'claude.ai Gmail', connector: 'gmail' },
        { name: 'My GitHub', connector: 'github' }
      ])
    })

    it("the switch-over's read adds names the same way", async () => {
      const { svc } = await make({ loadout: vi.fn(async () => named()) })
      await svc.migrate()
      expect(svc.serverNames()).toEqual([
        { name: 'claude.ai Gmail', connector: 'gmail' },
        { name: 'My GitHub', connector: 'github' }
      ])
    })

    it('learn adds names, and a repeat adds no duplicates', async () => {
      const { svc, deps, store } = await make({ loadout: vi.fn(async () => named()) })
      await store.replace({ dev: ['gmail'] }, 'kept')
      await svc.learn()
      await svc.learn()
      expect(deps.loadout).toHaveBeenCalledWith(false, false)
      expect(svc.serverNames()).toEqual([
        { name: 'claude.ai Gmail', connector: 'gmail' },
        { name: 'My GitHub', connector: 'github' }
      ])
    })

    it('names accumulate across reads and are never removed', async () => {
      const reads = [loadoutOf([server('claude.ai Gmail', 'gmail')]), loadoutOf([server('Work Slack', 'slack')])]
      const { svc, store } = await make({ loadout: vi.fn(async () => reads.shift() as Loadout) })
      await store.replace({ dev: ['gmail'] }, 'kept')
      await svc.learn()
      await svc.learn()
      expect(svc.serverNames()).toEqual([
        { name: 'claude.ai Gmail', connector: 'gmail' },
        { name: 'Work Slack', connector: 'slack' }
      ])
    })

    it('a read with a server error, or one that throws, adds nothing and keeps the earlier names', async () => {
      const reads: Array<() => Loadout> = [
        () => loadoutOf([server('claude.ai Gmail', 'gmail')]),
        () => loadoutOf([server('My GitHub', 'github')], { servers: 'nope' }),
        () => {
          throw new Error('secret https://x cli text')
        }
      ]
      const { svc, store } = await make({ loadout: vi.fn(async () => (reads.shift() as () => Loadout)()) })
      await store.replace({ dev: ['gmail'] }, 'kept')
      await svc.learn()
      await svc.learn()
      await svc.list(true)
      expect(svc.serverNames()).toEqual([{ name: 'claude.ai Gmail', connector: 'gmail' }])
    })

    it('learn after stop reads nothing', async () => {
      const { svc, deps, store } = await make({ loadout: vi.fn(async () => named()) })
      await store.replace({ dev: ['gmail'] }, 'kept')
      await svc.stop()
      await svc.learn()
      expect(deps.loadout).not.toHaveBeenCalled()
      expect(svc.serverNames()).toEqual([])
    })

    it('learn reads nothing while no agent has a connector on, and reads once one does', async () => {
      const { svc, deps, store } = await make({ loadout: vi.fn(async () => named()) })
      await store.replace({}, 'kept')
      await svc.learn()
      expect(deps.loadout).not.toHaveBeenCalled()
      await store.replace({ dev: ['gmail'] }, 'kept')
      await store.set('dev', 'gmail', false)
      await svc.learn()
      expect(deps.loadout).not.toHaveBeenCalled()
      await store.set('dev', 'github', true)
      await svc.learn()
      expect(deps.loadout).toHaveBeenCalledTimes(1)
    })

    it('a learn that throws inside logs one line and resolves', async () => {
      const { svc, deps, store } = await make({
        loadout: vi.fn(async () => {
          throw new Error('secret https://x cli text')
        })
      })
      await store.replace({ dev: ['gmail'] }, 'kept')
      await expect(svc.learn()).resolves.toBeUndefined()
      expect(deps.log).toHaveBeenCalledTimes(1)
      expect(deps.log).toHaveBeenCalledWith('connectors: server names not read')
    })
  })

  describe('ready', () => {
    const named = () => loadoutOf([server('My GitHub', 'github')])

    it('joins an in-flight learn and sees its names', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      const { svc, deps, store } = await make({
        loadout: vi.fn(async () => {
          await gate
          return named()
        })
      })
      await store.replace({ dev: ['github'] }, 'kept')
      void svc.learn()
      const ready = svc.ready(10_000)
      release()
      await ready
      expect(svc.serverNames()).toEqual([{ name: 'My GitHub', connector: 'github' }])
      expect(deps.loadout).toHaveBeenCalledTimes(1)
    })

    it('joins the start-up chain that is tracked, switch-over included', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      const { svc, deps } = await make({
        loadout: vi.fn(async () => {
          await gate
          return named()
        })
      })
      const chain = startConnectors(svc, () => {})
      const ready = svc.ready(10_000)
      release()
      await ready
      await chain
      expect(svc.serverNames()).toEqual([{ name: 'My GitHub', connector: 'github' }])
      expect(deps.loadout).toHaveBeenCalledTimes(2) // the switch-over's read and the chain's own; ready added none
    })

    it('returns after maxMs when the read hangs', async () => {
      vi.useFakeTimers()
      try {
        const { svc, store } = await make({ loadout: vi.fn(() => new Promise<Loadout>(() => {})) })
        await store.replace({ dev: ['github'] }, 'kept')
        void svc.learn()
        let done = false
        const ready = svc.ready(500).then(() => {
          done = true
        })
        await vi.advanceTimersByTimeAsync(499)
        expect(done).toBe(false)
        await vi.advanceTimersByTimeAsync(2)
        await ready
        expect(done).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('a failed learn is not read again before 60 s, and is after', async () => {
      let t = 1000
      const reads: Array<() => Loadout> = [
        () => {
          throw new Error('x')
        },
        () => named()
      ]
      const { svc, deps, store } = await make({ now: () => t, loadout: vi.fn(async () => (reads.shift() as () => Loadout)()) })
      await store.replace({ dev: ['github'] }, 'kept')
      await svc.learn()
      expect(deps.loadout).toHaveBeenCalledTimes(1)
      t += 59_999
      await svc.ready(1000)
      expect(deps.loadout).toHaveBeenCalledTimes(1)
      expect(svc.serverNames()).toEqual([])
      t += 1
      await svc.ready(1000)
      expect(deps.loadout).toHaveBeenCalledTimes(2)
      expect(svc.serverNames()).toEqual([{ name: 'My GitHub', connector: 'github' }])
      t += 120_000
      await svc.ready(1000) // that one worked: no more reads
      expect(deps.loadout).toHaveBeenCalledTimes(2)
    })

    it('a read with a server error counts as failed', async () => {
      let t = 0
      const reads = [loadoutOf([], { servers: 'nope' }), named()]
      const { svc, deps, store } = await make({ now: () => t, loadout: vi.fn(async () => reads.shift() as Loadout) })
      await store.replace({ dev: ['github'] }, 'kept')
      await svc.learn()
      t = 60_000
      await svc.ready(1000)
      expect(deps.loadout).toHaveBeenCalledTimes(2)
      expect(svc.serverNames()).toEqual([{ name: 'My GitHub', connector: 'github' }])
    })

    it('starts the first read when none has run and a connector is on', async () => {
      const { svc, deps, store } = await make({ loadout: vi.fn(async () => named()) })
      await store.replace({ dev: ['github'] }, 'kept')
      await svc.ready(1000)
      expect(deps.loadout).toHaveBeenCalledTimes(1)
      expect(svc.serverNames()).toEqual([{ name: 'My GitHub', connector: 'github' }])
    })

    it('never reads while every connector is off', async () => {
      const { svc, deps, store } = await make({ loadout: vi.fn(async () => named()) })
      await store.replace({}, 'kept')
      await svc.ready(1000)
      await svc.ready(1000)
      expect(deps.loadout).not.toHaveBeenCalled()
    })

    it('resolves at once after stop', async () => {
      const { svc, deps, store } = await make({ loadout: vi.fn(async () => named()) })
      await store.replace({ dev: ['github'] }, 'kept')
      await svc.stop()
      await svc.ready(10_000)
      expect(deps.loadout).not.toHaveBeenCalled()
    })

    it('never throws', async () => {
      const { svc, store } = await make({
        loadout: vi.fn(async () => {
          throw new Error('boom')
        })
      })
      await store.replace({ dev: ['github'] }, 'kept')
      await expect(svc.ready(1000)).resolves.toBeUndefined()
    })
  })

  it('setAgent stores the switch and announces it', async () => {
    const { svc, store, onChanged } = await make()
    await svc.migrate()
    onChanged.mockClear()
    await svc.setAgent('notion', 'dev', true)
    expect(store.onFor('dev')).toContain('notion')
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('setRemember stores the switch, announces it, and the card shows it', async () => {
    const { svc, store, onChanged } = await make()
    await svc.migrate()
    onChanged.mockClear()
    await svc.setRemember('gmail', true)
    expect(store.remembers('gmail')).toBe(true)
    expect(onChanged).toHaveBeenCalledTimes(1)
    const cards = (await svc.list(false)).connectors
    expect(cards.find((c) => c.id === 'gmail')!.remember).toBe(true)
    expect(cards.find((c) => c.id === 'slack')!.remember).toBe(false)
  })

  it('a failed probe still shows remember', async () => {
    const { svc, deps } = await make()
    await svc.migrate()
    await svc.setRemember('gmail', true)
    const failing = new ConnectorsService({
      ...deps,
      loadout: async () => {
        throw new Error('boom')
      }
    })
    const cards = (await failing.list(true)).connectors
    expect(cards.every((c) => c.state === 'unknown')).toBe(true)
    expect(cards.find((c) => c.id === 'gmail')!.remember).toBe(true)
    expect(cards.find((c) => c.id === 'slack')!.remember).toBe(false)
  })
})
