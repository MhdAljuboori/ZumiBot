import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { JevStore } from '../../src/core/jev/jevStore'

let dir: string
let store: JevStore
const file = () => join(dir, 'jev.json')

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-jev-store-'))
  store = new JevStore(dir)
})
afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

describe('JevStore', () => {
  it('starts with no key and every switch on', async () => {
    expect(await store.status()).toEqual({ keySet: false, enabled: true, moderator: true, approvalRisk: true, agentSuggest: true })
    expect(await store.key()).toBeNull()
  })

  it('saves the key readable by the owner only and never shows it in the status', async () => {
    const status = await store.setKey('sk-or-v1-abc')
    expect(status.keySet).toBe(true)
    expect(JSON.stringify(status)).not.toContain('sk-or-v1-abc')
    expect(await store.key()).toBe('sk-or-v1-abc')
    if (process.platform !== 'win32') expect((await fs.stat(file())).mode & 0o777).toBe(0o600)
  })

  it('removes the key', async () => {
    await store.setKey('sk-or-v1-abc')
    expect((await store.setKey(null)).keySet).toBe(false)
    expect(await store.key()).toBeNull()
  })

  it('changes only the switches given and keeps the key', async () => {
    await store.setKey('sk-or-v1-abc')
    expect(await store.setSwitches({ enabled: false, agentSuggest: false })).toEqual({
      keySet: true,
      enabled: false,
      moderator: true,
      approvalRisk: true,
      agentSuggest: false
    })
    expect(await store.key()).toBe('sk-or-v1-abc')
  })

  it('reads a damaged file as defaults and a bad field as its default', async () => {
    await fs.writeFile(file(), '{not json')
    expect((await store.status()).enabled).toBe(true)
    await fs.writeFile(file(), JSON.stringify({ apiKey: 42, enabled: 'no', moderator: false }))
    expect(await store.status()).toEqual({ keySet: false, enabled: true, moderator: false, approvalRisk: true, agentSuggest: true })
  })
})
