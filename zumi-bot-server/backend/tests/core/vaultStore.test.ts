import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultInput } from '@zumibot/shared/vault'
import { keyIdOf, newKey, seal, writeKey } from '../../src/core/vault/vaultCrypto'
import { VaultStore } from '../../src/core/vault/vaultStore'

let dir: string
let dataDir: string
let keyFile: string
let t: number
let n: number

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-vault-store-'))
  dataDir = join(dir, 'data')
  keyFile = join(dir, 'conf', 'vault.key')
  t = 1_000
  n = 0
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const make = () => new VaultStore({ dataDir, keyFile, now: () => ++t, newId: () => `id${++n}` })
const ready = async () => {
  const s = make()
  await s.load()
  return s
}
const login: VaultInput = { kind: 'login', name: 'Azure', agents: ['dev'], sites: ['dev.azure.com'], username: 'ada', password: 'hunter22' }
const card: VaultInput = {
  kind: 'card',
  name: 'Work Visa',
  agents: ['dev'],
  holder: 'Ada',
  number: '4242 4242 4242 4242',
  expiry: '12/30',
  cvc: '123'
}
const api: VaultInput = { kind: 'apiKey', name: 'PAT', agents: ['dev'], env: 'AZURE_PAT', value: 'sk-test-12345678', description: 'd' }
const vaultFile = () => join(dataDir, 'vault.json')
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false
  )

describe('VaultStore', () => {
  it('is empty with no key and makes the key at the first save', async () => {
    const s = await ready()
    expect(s.status()).toBe('empty')
    expect(s.list()).toEqual([])
    expect(await exists(keyFile)).toBe(false)
    const item = await s.save(login)
    expect(await exists(keyFile)).toBe(true)
    expect(s.status()).toBe('ready')
    expect(item.id).toBe('id1')
    expect(s.get('id1')).toMatchObject({ kind: 'login', password: 'hunter22', username: 'ada' })
    const again = await ready()
    expect(again.status()).toBe('ready')
    expect(again.get('id1')).toMatchObject({ name: 'Azure', password: 'hunter22' })
    if (process.platform !== 'win32') expect((await fs.stat(vaultFile())).mode & 0o777).toBe(0o600)
  })

  it('does not make a key when the first save is refused', async () => {
    const s = await ready()
    await expect(s.save({ ...login, name: '' })).rejects.toThrow('Give the item a name.')
    expect(await exists(keyFile)).toBe(false)
  })

  it('keeps stored secrets when an input leaves them out', async () => {
    const s = await ready()
    const l = await s.save(login)
    const c = await s.save(card)
    const k = await s.save(api)
    await s.save({ ...login, id: l.id, name: 'Azure 2', password: undefined }, l.updatedAt)
    await s.save({ ...card, id: c.id, number: undefined, expiry: undefined, cvc: undefined, holder: 'Ada L' }, c.updatedAt)
    await s.save({ ...api, id: k.id, value: undefined, description: 'new' }, k.updatedAt)
    expect(s.get(l.id)).toMatchObject({ name: 'Azure 2', password: 'hunter22' })
    expect(s.get(c.id)).toMatchObject({ holder: 'Ada L', number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123' })
    expect(s.get(k.id)).toMatchObject({ value: 'sk-test-12345678', description: 'new' })
    const reopened = await ready()
    expect(reopened.get(k.id)).toMatchObject({ value: 'sk-test-12345678' })
  })

  it('keeps the 2FA secret when left out, clears it with null, and turns an otpauth link into the secret', async () => {
    const s = await ready()
    const uri = 'otpauth://totp/x?secret=jbswy3dpehpk3pxp&issuer=y'
    const l = await s.save({ ...login, totp: uri })
    expect(s.get(l.id)).toMatchObject({ totp: 'JBSWY3DPEHPK3PXP' })
    const l2 = await s.save({ ...login, id: l.id }, l.updatedAt)
    expect(s.get(l.id)).toMatchObject({ totp: 'JBSWY3DPEHPK3PXP' })
    await s.save({ ...login, id: l.id, totp: null }, l2.updatedAt)
    expect(s.get(l.id)).toMatchObject({ totp: null })
  })

  it('stores logins sites as bare normalized hosts, deduped', async () => {
    const s = await ready()
    const l = await s.save({ ...login, sites: ['https://Dev.Azure.com/org/', 'dev.azure.com', 'Example.COM.', '*.Example.com'] })
    expect((s.get(l.id) as { sites: string[] }).sites).toEqual(['dev.azure.com', 'example.com', '*.example.com'])
    await expect(s.save({ ...login, sites: ['ok.com', 'a b'] })).rejects.toThrow('One of the sites is not a valid host.')
  })

  it('refuses a stale save with VAULT_CHANGED', async () => {
    const s = await ready()
    const l = await s.save(login)
    const l2 = await s.save({ ...login, id: l.id, name: 'B' }, l.updatedAt)
    expect(l2.updatedAt).toBeGreaterThan(l.updatedAt)
    await expect(s.save({ ...login, id: l.id, name: 'C' }, l.updatedAt)).rejects.toThrow('VAULT_CHANGED')
    await expect(s.save({ ...login, id: 'nope', name: 'C' }, 5)).rejects.toThrow('VAULT_CHANGED')
    expect(s.get(l.id)?.name).toBe('B')
  })

  it('refuses an input with another kind for the same id, and a full vault', async () => {
    const s = await ready()
    const l = await s.save(login)
    await expect(s.save({ ...api, id: l.id }, l.updatedAt)).rejects.toThrow()
    const full = make()
    await full.load()
    for (let i = 0; i < 499; i++)
      await full.save({
        kind: 'contact',
        name: `c${i}`,
        agents: [],
        fullName: '',
        company: '',
        email: '',
        phone: '',
        line1: '',
        line2: '',
        city: '',
        region: '',
        postalCode: '',
        country: ''
      })
    await expect(full.save(login)).rejects.toThrow('VAULT_FULL')
  }, 60_000)

  it('deletes as a tombstone', async () => {
    const s = await ready()
    const l = await s.save(login)
    await s.delete(l.id)
    expect(s.list()).toEqual([])
    expect(s.get(l.id)).toBeNull()
    const file = JSON.parse(await fs.readFile(vaultFile(), 'utf8'))
    expect(file.items).toHaveLength(1)
    expect(file.items[0]).toMatchObject({ id: l.id, deleted: true, sealed: null })
    expect(file.items[0].updatedAt).toBeGreaterThan(l.updatedAt)
    expect((await ready()).list()).toEqual([])
    await s.delete('nope')
  })

  it('reports keyMissing and keyMismatch and refuses saves', async () => {
    const s = await ready()
    await s.save(login)
    const good = await fs.readFile(keyFile, 'utf8')

    await fs.rm(keyFile)
    const missing = await ready()
    expect(missing.status()).toBe('keyMissing')
    expect(missing.list()).toEqual([])
    await expect(missing.save(login)).rejects.toThrow('VAULT_UNAVAILABLE')
    await expect(missing.delete('id1')).rejects.toThrow('VAULT_UNAVAILABLE')
    expect(await exists(keyFile)).toBe(false)

    await fs.mkdir(join(dir, 'conf'), { recursive: true })
    await writeKey(keyFile, newKey())
    const mismatch = await ready()
    expect(mismatch.status()).toBe('keyMismatch')
    expect(mismatch.grantedTo('dev')).toEqual([])
    await expect(mismatch.save(login)).rejects.toThrow('VAULT_UNAVAILABLE')

    await fs.rm(keyFile)
    await fs.writeFile(keyFile, good, { mode: 0o600 })
    expect((await ready()).status()).toBe('ready')
  })

  it('never overwrites an unreadable vault', async () => {
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(vaultFile(), '{')
    const s = await ready()
    expect(s.status()).toBe('keyMismatch')
    await expect(s.save(login)).rejects.toThrow('VAULT_UNAVAILABLE')
    expect(await fs.readFile(vaultFile(), 'utf8')).toBe('{')
    expect(await exists(keyFile)).toBe(false)
    await s.reset()
    expect(s.status()).toBe('empty')
    const names = await fs.readdir(dataDir)
    expect(names.some((f) => /^vault\.json\.unreadable-/.test(f))).toBe(true)
    expect(names).not.toContain('vault.json')
    const moved = names.find((f) => /^vault\.json\.unreadable-/.test(f))!
    expect(await fs.readFile(join(dataDir, moved), 'utf8')).toBe('{')
    await s.save(login)
    expect(s.status()).toBe('ready')
  })

  it('treats an unknown version, a bad shape and an item that does not open as keyMismatch', async () => {
    const key = newKey()
    await writeKey(keyFile, key)
    await fs.mkdir(dataDir, { recursive: true })
    for (const content of [
      JSON.stringify({ v: 2, keyId: keyIdOf(key), items: [] }),
      JSON.stringify({ v: 1, keyId: keyIdOf(key), items: 'x' }),
      JSON.stringify({
        v: 1,
        keyId: keyIdOf(key),
        items: [{ id: 'a', updatedAt: 1, deleted: false, sealed: seal(newKey(), 'a', 1, { kind: 'login' }) }]
      })
    ]) {
      await fs.writeFile(vaultFile(), content)
      expect((await ready()).status()).toBe('keyMismatch')
    }
  })

  it('treats a key file that is not a key as keyMismatch', async () => {
    await fs.mkdir(join(dir, 'conf'), { recursive: true })
    await fs.writeFile(keyFile, 'garbage')
    const s = await ready()
    expect(s.status()).toBe('keyMismatch')
    await expect(s.save(login)).rejects.toThrow('VAULT_UNAVAILABLE')
  })

  it('moves grants on rename synchronously', async () => {
    const s = await ready()
    const l = await s.save({ ...login, agents: ['old', 'dev'] })
    await s.save({ ...api, agents: ['old'] })
    const pending = s.renameAgent('old', 'new')
    expect(s.grantedTo('new').map((i) => i.id)).toContain(l.id)
    expect(s.grantedTo('old')).toEqual([])
    await pending
    expect(s.grantedTo('new')).toHaveLength(2)
    expect(s.get(l.id)?.agents).toEqual(['new', 'dev'])
    expect(s.get(l.id)!.updatedAt).toBeGreaterThan(l.updatedAt)
    expect((await ready()).grantedTo('new')).toHaveLength(2)
    // Renaming onto a name the item already has leaves one grant.
    await s.renameAgent('dev', 'new')
    expect(s.get(l.id)?.agents).toEqual(['new'])
  })

  it('forgets removed agents', async () => {
    const s = await ready()
    const l = await s.save({ ...login, agents: ['a', 'b'] })
    await s.save({ ...api, agents: ['c'] })
    const pending = s.forgetAgents(['a', 'c'])
    expect(s.grantedTo('a')).toEqual([])
    await pending
    expect(s.get(l.id)?.agents).toEqual(['b'])
    expect((await ready()).agents()).toEqual(['b'])
    await s.forgetAgents(['nobody'])
  })

  it('applies a rename that lands while a new save is in flight', async () => {
    const s = await ready()
    const saving = s.save({ ...login, agents: ['old'] })
    const renaming = s.renameAgent('old', 'new')
    const item = await saving
    await renaming
    expect(item.agents).toEqual(['new'])
    expect(s.get(item.id)?.agents).toEqual(['new'])
    expect((await ready()).get(item.id)?.agents).toEqual(['new'])
  })

  it('does not leave a grant for an agent forgotten while its save is in flight', async () => {
    const s = await ready()
    const saving = s.save({ ...login, agents: ['gone', 'dev'] })
    const forgetting = s.forgetAgents(['gone'])
    const item = await saving
    await forgetting
    expect(s.get(item.id)?.agents).toEqual(['dev'])
    const again = await ready()
    expect(again.get(item.id)?.agents).toEqual(['dev'])
    expect(again.agents()).toEqual(['dev'])
  })

  it('keeps a rename made while an update of the same item is in flight', async () => {
    const s = await ready()
    const first = await s.save({ ...login, agents: ['old'] })
    const saving = s.save({ ...login, id: first.id, agents: ['old'], username: 'grace' }, first.updatedAt)
    const renaming = s.renameAgent('old', 'new')
    await Promise.all([saving, renaming])
    expect(s.get(first.id)).toMatchObject({ agents: ['new'], username: 'grace' })
    expect((await ready()).get(first.id)?.agents).toEqual(['new'])
  })

  it('applies a rename that lands during the write of a card approval', async () => {
    const s = await ready()
    const c = await s.save({ ...card, agents: ['old'] })
    const real = fs.mkdir.bind(fs)
    let renaming: Promise<void> | null = null
    const spy = vi.spyOn(fs, 'mkdir').mockImplementation(async (...a: Parameters<typeof fs.mkdir>) => {
      renaming ??= s.renameAgent('old', 'new')
      return real(...a)
    })
    try {
      await s.addApproval(c.id, 'shop.example.com', 'shop.example.com')
    } finally {
      spy.mockRestore()
    }
    await renaming
    expect(s.get(c.id)?.agents).toEqual(['new'])
    expect((s.get(c.id) as { approved: unknown[] }).approved).toHaveLength(1)
    const again = await ready()
    expect(again.get(c.id)?.agents).toEqual(['new'])
    expect((again.get(c.id) as { approved: unknown[] }).approved).toHaveLength(1)
  })

  it('tells onChange when a reload finds the key missing or wrong', async () => {
    const s = await ready()
    await s.save(login)
    let calls = 0
    s.onChange(() => calls++)
    await s.load()
    const afterReady = calls
    await fs.rm(keyFile)
    await s.load()
    expect(s.status()).toBe('keyMissing')
    expect(calls).toBe(afterReady + 1)
    // Still missing: no new event.
    await s.load()
    expect(calls).toBe(afterReady + 1)
    await writeKey(keyFile, newKey())
    await s.load()
    expect(s.status()).toBe('keyMismatch')
    expect(calls).toBe(afterReady + 2)
  })

  it('writes only ids, times and sealed blobs', async () => {
    const s = await ready()
    await s.save(login)
    await s.save(card)
    await s.save({
      kind: 'contact',
      name: 'Home contact',
      agents: ['dev'],
      fullName: 'Grace Hopper',
      company: '',
      email: 'g@h.example',
      phone: '',
      line1: '',
      line2: '',
      city: '',
      region: '',
      postalCode: '',
      country: ''
    })
    await s.save(api)
    const text = await fs.readFile(vaultFile(), 'utf8')
    // Ids are random hex and sealed blobs random base64, so a short secret ('ada', '4242') can turn up in them by chance:
    // look for secrets only in what is left (the field shapes are checked below).
    const visible = text.replace(/"(id|keyId|sealed)": "[^"]*"/g, '')
    for (const secret of [
      'Azure',
      'ada',
      'hunter22',
      '4242',
      'Work Visa',
      'Grace Hopper',
      'g@h.example',
      'sk-test',
      'AZURE_PAT',
      'dev.azure.com',
      '"dev"'
    ])
      expect(visible).not.toContain(secret)
    const file = JSON.parse(text)
    expect(Object.keys(file).sort()).toEqual(['items', 'keyId', 'v'])
    expect(file.v).toBe(1)
    for (const it of file.items) expect(Object.keys(it).sort()).toEqual(['deleted', 'id', 'sealed', 'updatedAt'])
  })

  it('secrets() skips passwords under 6 characters', async () => {
    const s = await ready()
    await s.save({ ...login, password: 'abc12' })
    await s.save({ ...login, name: 'L2', password: 'abc123' })
    await s.save(card)
    await s.save(api)
    const { values, cards } = s.secrets()
    expect(values).toContain('abc123')
    expect(values).not.toContain('abc12')
    expect(values).toContain('sk-test-12345678')
    expect(cards).toEqual(['4242424242424242'])
  })

  it('records card approvals once and removes them', async () => {
    const s = await ready()
    const c = await s.save(card)
    await s.addApproval(c.id, 'shop.example.com', 'pay.example.com')
    await s.addApproval(c.id, 'shop.example.com', 'pay.example.com')
    const got = s.get(c.id) as { approved: { site: string; frameSite: string }[] }
    expect(got.approved).toHaveLength(1)
    expect(got.approved[0]).toMatchObject({ site: 'shop.example.com', frameSite: 'pay.example.com' })
    expect(s.get(c.id)!.updatedAt).toBeGreaterThan(c.updatedAt)
    await s.addApproval('nope', 'a', 'b')
    await s.removeApproval(c.id, 'shop.example.com', 'pay.example.com')
    expect((s.get(c.id) as { approved: unknown[] }).approved).toEqual([])
    expect(((await ready()).get(c.id) as { approved: unknown[] }).approved).toEqual([])
  })

  it('tells onChange listeners and lets them unsubscribe', async () => {
    const s = await ready()
    let calls = 0
    const off = s.onChange(() => calls++)
    const l = await s.save(login)
    await s.delete(l.id)
    expect(calls).toBe(2)
    off()
    await s.save(login)
    expect(calls).toBe(2)
  })

  it('lists grants and agent names, and never hands out its own objects', async () => {
    const s = await ready()
    const l = await s.save({ ...login, agents: ['b', 'a'] })
    await s.save({ ...api, agents: ['a'] })
    expect(s.agents()).toEqual(['a', 'b'])
    expect(s.grantedTo('b').map((i) => i.id)).toEqual([l.id])
    ;(s.get(l.id) as { password: string }).password = 'tampered'
    expect(s.get(l.id)).toMatchObject({ password: 'hunter22' })
  })

  it('hands an agent its items as vault_items shows them: by kind (login, card, contact, apiKey), then by name', async () => {
    const s = await ready()
    const contact: VaultInput = {
      kind: 'contact',
      name: 'Home',
      agents: ['dev'],
      fullName: 'Ada',
      company: '',
      email: '',
      phone: '',
      line1: '',
      line2: '',
      city: '',
      region: '',
      postalCode: '',
      country: ''
    }
    for (const input of [
      { ...api, name: 'Alpha key', env: 'ALPHA' },
      { ...card, name: 'Zeta Visa' },
      { ...login, name: 'mail' },
      { ...contact, name: 'Work' },
      { ...card, name: 'Amex' },
      { ...login, name: 'Bank' },
      { ...contact, name: 'Home' },
      { ...api, name: 'beta key', env: 'BETA' },
      { ...login, name: 'Other agent', agents: ['someone'] }
    ] as VaultInput[])
      await s.save(input)
    expect(s.agentItems('dev').map((i) => `${i.kind} ${i.name}`)).toEqual([
      'login Bank',
      'login mail',
      'card Amex',
      'card Zeta Visa',
      'contact Home',
      'contact Work',
      'apiKey Alpha key',
      'apiKey beta key'
    ])
    // Only what an agent may read: no password, card number or key value.
    const json = JSON.stringify(s.agentItems('dev'))
    for (const secret of ['hunter22', '4242424242424242', '4242 4242 4242 4242', '12/30', 'sk-test-12345678'])
      expect(json).not.toContain(secret)
    expect(s.agentItems('nobody')).toEqual([])
  })

  it('refuses Zumi Bot as an agent', async () => {
    const s = await ready()
    await expect(s.save({ ...login, agents: ['zumi-bot'] })).rejects.toThrow('Zumi Bot cannot use vault items.')
  })

  it("never gives Zumi Bot a grant through the old built-in name's rename", async () => {
    const s = await ready()
    const l = await s.save({ ...login, agents: ['bot-father-agent', 'dev'] })
    const k = await s.save({ ...api, agents: ['bot-father-agent'] })
    // migrateOldBuiltIn runs the agent-rename pipeline from the old name to Zumi Bot's.
    const pending = s.renameAgent('bot-father-agent', 'zumi-bot')
    expect(s.grantedTo('zumi-bot')).toEqual([])
    await pending
    expect(s.get(l.id)?.agents).toEqual(['dev'])
    expect(s.get(k.id)?.agents).toEqual([])
    expect(s.grantedTo('zumi-bot')).toEqual([])
    expect(s.agentItems('zumi-bot')).toEqual([])
    expect(s.agents()).toEqual(['dev'])
    const again = await ready()
    expect(again.grantedTo('zumi-bot')).toEqual([])
    expect(again.get(l.id)?.agents).toEqual(['dev'])
  })

  it('reads no grant to Zumi Bot even when one is on disk (a sync join does not check grants)', async () => {
    const key = newKey()
    await writeKey(keyFile, key)
    const body = {
      id: 'x1',
      updatedAt: 5,
      kind: 'apiKey',
      name: 'PAT',
      agents: ['zumi-bot', 'dev'],
      env: 'AZURE_PAT',
      value: 'sk-test-12345678',
      description: ''
    }
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(
      vaultFile(),
      JSON.stringify({ v: 1, keyId: keyIdOf(key), items: [{ id: 'x1', updatedAt: 5, deleted: false, sealed: seal(key, 'x1', 5, body) }] })
    )
    const s = await ready()
    expect(s.status()).toBe('ready')
    expect(s.grantedTo('zumi-bot')).toEqual([])
    expect(s.agentItems('zumi-bot')).toEqual([])
    expect(s.grantedTo('dev').map((i) => i.id)).toEqual(['x1'])
    // A fill row is labelled with the item's name only for an agent the item is granted to, never Zumi Bot.
    expect(s.itemNameFor('x1', 'zumi-bot')).toBeNull()
    expect(s.itemNameFor('x1', 'dev')).toBe('PAT')
    expect(s.itemNameFor('x1', 'other')).toBeNull()
    expect(s.itemNameFor('nope', 'dev')).toBeNull()
  })

  it('hands a workflow a login only when its switch is on, it has a password, and it is not deleted', async () => {
    const s = await ready()
    const shared = await s.save({ ...login, workflows: true })
    const plain = await s.save({ ...login, name: 'Other' })
    const key = await s.save({ ...api, workflows: true })
    expect(s.get(shared.id)).toMatchObject({ workflows: true })
    expect(s.get(plain.id)).not.toHaveProperty('workflows')
    expect(s.workflowLogin(shared.id)).toEqual({ username: 'ada', password: 'hunter22' })
    expect(s.workflowLogin(plain.id)).toBeNull()
    expect(s.workflowLogin(key.id)).toBeNull()
    expect(s.workflowLogin('nope')).toBeNull()
    // Reopened from disk, the switch is still on; turned off, the login is no longer handed out.
    expect((await ready()).workflowLogin(shared.id)).toEqual({ username: 'ada', password: 'hunter22' })
    const off = await s.save({ ...login, id: shared.id, password: undefined, workflows: false }, shared.updatedAt)
    expect(s.workflowLogin(shared.id)).toBeNull()
    await s.save({ ...login, id: shared.id, password: undefined, workflows: true }, off.updatedAt)
    expect(s.workflowLogin(shared.id)).toEqual({ username: 'ada', password: 'hunter22' })
    await s.delete(shared.id)
    expect(s.workflowLogin(shared.id)).toBeNull()
    // No password: nothing to sign in with.
    const blank = await s.save({ ...login, name: 'Blank', password: undefined, workflows: true })
    expect(s.workflowLogin(blank.id)).toBeNull()
  })

  it('serializes concurrent saves', async () => {
    const s = await ready()
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.save({ ...login, name: `L${i}` })))
    expect(s.list()).toHaveLength(10)
    expect((await ready()).list()).toHaveLength(10)
  })
})
