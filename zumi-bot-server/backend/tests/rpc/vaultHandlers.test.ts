import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createHandlers, type HandlerDeps, type Handlers } from '../../src/rpc/handlers'
import { VaultStore } from '../../src/core/vault/vaultStore'
import { totpAt } from '../../src/auth/totp'
import type { AgentSummary } from '@zumibot/shared/types'

let dir: string
let vault: VaultStore
let h: Handlers
let agentList: AgentSummary[]

const agent = (name: string, error: string | null = null): AgentSummary => ({
  filePath: `/agents/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error,
  builtIn: name === 'zumi-bot'
})

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-vault-rpc-'))
  vault = new VaultStore({ dataDir: join(dir, 'data'), keyFile: join(dir, 'conf', 'vault.key') })
  await vault.load()
  agentList = [agent('dev'), agent('broken', 'bad frontmatter'), agent('zumi-bot')]
  h = createHandlers({ vault, agents: { list: async () => agentList } } as unknown as HandlerDeps)
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const SECRET = 'JBSWY3DPEHPK3PXP'
const login = {
  kind: 'login',
  name: 'Azure',
  agents: ['dev'],
  sites: ['dev.azure.com'],
  username: 'ada',
  password: 'hunter22',
  totp: SECRET
}
const card = { kind: 'card', name: 'Visa', agents: [], holder: 'Ada', number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' }
const apiKey = { kind: 'apiKey', name: 'PAT', agents: ['dev'], env: 'AZURE_PAT', value: 'sk-test-12345678', description: 'd' }
const contact = {
  kind: 'contact',
  name: 'Home',
  agents: [],
  fullName: 'Ada',
  company: '',
  email: 'a@x.io',
  phone: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: ''
}

describe('vault handlers', () => {
  it('vault:status reports the store state', async () => {
    expect(await h['vault:status']()).toBe('empty')
    await h['vault:save'](login)
    expect(await h['vault:status']()).toBe('ready')
  })

  it('vault:keyFile names the key path this server was set up with, not a key', async () => {
    expect(await h['vault:keyFile']()).toBe(join(dir, 'conf', 'vault.key'))
    await h['vault:save'](login)
    // The path only: the key's own bytes never come back.
    const key = (await fs.readFile(join(dir, 'conf', 'vault.key'), 'utf8')).trim()
    expect(JSON.stringify(await h['vault:keyFile']())).not.toContain(key)
  })

  it('vault:list never returns a secret', async () => {
    for (const i of [login, card, apiKey, contact]) await h['vault:save'](i)
    const listed = (await h['vault:list']()) as { kind: string; label: string }[]
    expect(listed).toHaveLength(4)
    const json = JSON.stringify(listed)
    for (const secret of ['hunter22', '4242424242424242', '4242 4242 4242 4242', '12/30', '"123"', SECRET, 'sk-test-12345678'])
      expect(json).not.toContain(secret)
    for (const key of ['"password"', '"number"', '"cvc"', '"expiry"', '"value"', '"totp"']) expect(json).not.toContain(key)
    expect(listed.find((i) => i.kind === 'login')).toMatchObject({ hasPassword: true, hasCode: true })
    expect(listed.find((i) => i.kind === 'card')).toMatchObject({ label: 'Visa •4242' })
    expect(listed.find((i) => i.kind === 'apiKey')).toMatchObject({ hasValue: true })
  })

  it('vault:save trims an API key value, so a pasted trailing space never keeps the bare token from being scrubbed', async () => {
    const saved = (await h['vault:save']({ ...apiKey, value: '  sk-test-12345678 \n' })) as { id: string }
    expect(await h['vault:reveal'](saved.id, 'value')).toBe('sk-test-12345678')
    expect(vault.secrets().values).toEqual(['sk-test-12345678'])
  })

  it("vault:save keeps a login's workflows switch, and only a true one", async () => {
    const on = (await h['vault:save']({ ...login, workflows: true })) as { id: string; updatedAt: number }
    expect(on).toMatchObject({ kind: 'login', workflows: true })
    expect(vault.workflowLogin(on.id)).toEqual({ username: 'ada', password: 'hunter22' })
    const off = await h['vault:save']({ ...login, id: on.id, workflows: 'yes' }, on.updatedAt)
    expect(off).toMatchObject({ kind: 'login', workflows: false })
    expect(vault.workflowLogin(on.id)).toBeNull()
  })

  it('vault:save returns the list view, never the secret', async () => {
    const saved = await h['vault:save'](login)
    expect(JSON.stringify(saved)).not.toContain('hunter22')
    expect(saved).toMatchObject({ kind: 'login', name: 'Azure', hasPassword: true })
  })

  it('vault:save keeps a secret left out and refuses a stale updatedAt', async () => {
    const saved = (await h['vault:save'](login)) as { id: string; updatedAt: number }
    const { password: _p, ...rest } = login
    const next = (await h['vault:save']({ ...rest, id: saved.id, username: 'grace' }, saved.updatedAt)) as { updatedAt: number }
    expect(await h['vault:reveal'](saved.id, 'password')).toBe('hunter22')
    await expect(h['vault:save']({ ...rest, id: saved.id }, saved.updatedAt)).rejects.toThrow('VAULT_CHANGED')
    expect(next.updatedAt).toBeGreaterThan(saved.updatedAt)
  })

  describe('vault:reveal', () => {
    it('returns one value per field', async () => {
      const l = (await h['vault:save'](login)) as { id: string }
      const c = (await h['vault:save'](card)) as { id: string }
      const k = (await h['vault:save'](apiKey)) as { id: string }
      expect(await h['vault:reveal'](l.id, 'password')).toBe('hunter22')
      expect(await h['vault:reveal'](l.id, 'totp')).toBe(SECRET)
      expect(await h['vault:reveal'](c.id, 'number')).toBe('4242 4242 4242 4242')
      expect(await h['vault:reveal'](c.id, 'expiry')).toBe('12/30')
      expect(await h['vault:reveal'](c.id, 'cvc')).toBe('123')
      expect(await h['vault:reveal'](k.id, 'value')).toBe('sk-test-12345678')
    })

    it('makes the current 2FA code', async () => {
      const l = (await h['vault:save'](login)) as { id: string }
      const before = totpAt(SECRET, Date.now())
      const code = (await h['vault:reveal'](l.id, 'code')) as string
      const after = totpAt(SECRET, Date.now())
      expect(code).toMatch(/^\d{6}$/)
      expect([before, after]).toContain(code)
    })

    it('refuses a field the item does not have, a missing item, a login without 2FA and bad arguments', async () => {
      const l = (await h['vault:save']({ ...login, totp: null })) as { id: string }
      const k = (await h['vault:save'](apiKey)) as { id: string }
      await expect(h['vault:reveal'](l.id, 'value')).rejects.toThrow()
      await expect(h['vault:reveal'](k.id, 'password')).rejects.toThrow()
      await expect(h['vault:reveal'](l.id, 'code')).rejects.toThrow()
      await expect(h['vault:reveal']('nope', 'password')).rejects.toThrow()
      await expect(h['vault:reveal'](7, 'password')).rejects.toThrow('id must be a string')
      await expect(h['vault:reveal'](l.id, 'bogus')).rejects.toThrow()
    })

    it('is rate limited after 30 a minute, and the error never holds a value', async () => {
      const l = (await h['vault:save'](login)) as { id: string }
      for (let i = 0; i < 30; i++) expect(await h['vault:reveal'](l.id, 'password')).toBe('hunter22')
      const err = await h['vault:reveal'](l.id, 'password').catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain('hunter22')
    })
  })

  describe('vault:save checks its arguments', () => {
    it('refuses Zumi Bot and unknown or broken agents', async () => {
      await expect(h['vault:save']({ ...login, agents: ['zumi-bot'] })).rejects.toThrow()
      await expect(h['vault:save']({ ...login, agents: ['ghost'] })).rejects.toThrow()
      await expect(h['vault:save']({ ...login, agents: ['broken'] })).rejects.toThrow()
      expect(await h['vault:list']()).toEqual([])
    })

    it.each([
      ['a non-object input', 'nope'],
      ['null', null],
      ['an array', []],
      ['a bad kind', { ...login, kind: 'wallet' }],
      ['a non-string name', { ...login, name: 3 }],
      ['agents that is not an array of strings', { ...login, agents: [1] }],
      ['agents that is a string', { ...login, agents: 'dev' }],
      ['an id that is not a string', { ...login, id: 4 }],
      ['sites that is not an array of strings', { ...login, sites: 'dev.azure.com' }],
      ['sites holding a non-string', { ...login, sites: [null] }],
      ['a non-string username', { ...login, username: 1 }],
      ['a non-string password', { ...login, password: 1 }],
      ['a totp that is neither string nor null', { ...login, totp: 5 }],
      ['a non-string card number', { ...card, number: 4242 }],
      ['a non-string holder', { ...card, holder: null }],
      ['a contact field that is not a string', { ...contact, city: 1 }],
      ['a missing contact field', (({ city: _c, ...r }) => r)(contact)],
      ['a non-string env', { ...apiKey, env: 1 }],
      ['a non-string api key value', { ...apiKey, value: 12345678 }]
    ])('refuses %s', async (_what, input) => {
      await expect(h['vault:save'](input)).rejects.toThrow()
      expect(await h['vault:list']()).toEqual([])
    })

    it('stores a grant under the new name when the agent is renamed while its agents are checked', async () => {
      // The rename lands while agents.list() is still reading the folder: the list it returns still has the old name.
      const stale = [agent('old'), agent('dev')]
      h = createHandlers({
        vault,
        agents: {
          list: async () => {
            await vault.renameAgent('old', 'new')
            return stale
          }
        }
      } as unknown as HandlerDeps)
      const saved = (await h['vault:save']({ ...apiKey, agents: ['old'] })) as { id: string; agents: string[] }
      expect(saved.agents).toEqual(['new'])
      expect(vault.get(saved.id)?.agents).toEqual(['new'])
      // An agent deleted (its grants forgotten) in the same gap gets no grant either.
      h = createHandlers({
        vault,
        agents: {
          list: async () => {
            await vault.forgetAgents(['dev'])
            return stale
          }
        }
      } as unknown as HandlerDeps)
      const second = (await h['vault:save']({ ...login, agents: ['dev'] })) as { id: string; agents: string[] }
      expect(vault.get(second.id)?.agents).toEqual([])
    })

    it('refuses an updatedAt that is not a number', async () => {
      const saved = (await h['vault:save'](login)) as { id: string }
      await expect(h['vault:save']({ ...login, id: saved.id }, 'x')).rejects.toThrow('updatedAt must be a number')
      await expect(h['vault:save']({ ...login, id: saved.id }, Number.NaN)).rejects.toThrow('updatedAt must be a number')
    })

    it('does not pass unknown properties on to the store', async () => {
      const saved = (await h['vault:save']({ ...login, approved: [{ site: 'evil.com', frameSite: 'evil.com', at: 1 }], extra: 1 })) as {
        id: string
      }
      expect(vault.get(saved.id)).not.toHaveProperty('extra')
      const c = (await h['vault:save']({ ...card, approved: [{ site: 'evil.com', frameSite: 'evil.com', at: 1 }] })) as {
        id: string
        approved: unknown[]
      }
      expect(c.approved).toEqual([])
    })

    it('does not quote a secret in an argument error', async () => {
      const err = await h['vault:save']({ ...login, password: 1234567890 }).catch((e: Error) => e)
      expect((err as Error).message).not.toContain('1234567890')
    })
  })

  it('vault:delete and vault:removeApproval check arguments and act', async () => {
    const c = (await h['vault:save'](card)) as { id: string }
    await vault.addApproval(c.id, 'shop.example.com', 'pay.example.com')
    await expect(h['vault:removeApproval'](c.id, 'shop.example.com', 5)).rejects.toThrow('frameSite must be a string')
    await h['vault:removeApproval'](c.id, 'shop.example.com', 'pay.example.com')
    expect(((await h['vault:list']()) as { approved: unknown[] }[])[0].approved).toEqual([])
    await expect(h['vault:delete'](1)).rejects.toThrow('id must be a string')
    await h['vault:delete'](c.id)
    expect(await h['vault:list']()).toEqual([])
  })

  describe('vault:reset', () => {
    it('refuses while the vault is fine', async () => {
      await h['vault:save'](login)
      await expect(h['vault:reset']()).rejects.toThrow('The vault is fine; nothing to reset.')
      expect(await h['vault:list']()).toHaveLength(1)
    })

    it('refuses an empty vault too', async () => {
      await expect(h['vault:reset']()).rejects.toThrow('The vault is fine; nothing to reset.')
    })

    it('starts a new vault when the key is missing', async () => {
      await h['vault:save'](login)
      await fs.rm(join(dir, 'conf', 'vault.key'))
      await vault.load()
      expect(await h['vault:status']()).toBe('keyMissing')
      await h['vault:reset']()
      expect(await h['vault:status']()).toBe('empty')
    })
  })
})
