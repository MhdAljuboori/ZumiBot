import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keyIdOf, newKey, open, readKey, seal, writeKey } from '../../src/core/vault/vaultCrypto'
// @ts-expect-error plain .mjs script, no types
import * as vaultSync from '../../../deploy/vaultSync.mjs'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-vault-crypto-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('vaultCrypto', () => {
  it('opens what it sealed', () => {
    const key = newKey()
    const body = { kind: 'login', password: 'hunter22', n: [1, 2] }
    const sealed = seal(key, 'a1', 100, body)
    expect(sealed).not.toContain('hunter22')
    expect(open(key, 'a1', 100, sealed)).toEqual(body)
    expect(seal(key, 'a1', 100, body)).not.toBe(sealed)
  })

  it('fails to open after the id, updatedAt or one byte changed', () => {
    const key = newKey()
    const sealed = seal(key, 'a1', 100, { x: 1 })
    expect(() => open(key, 'a2', 100, sealed)).toThrow()
    expect(() => open(key, 'a1', 101, sealed)).toThrow()
    expect(() => open(newKey(), 'a1', 100, sealed)).toThrow()
    const raw = Buffer.from(sealed, 'base64')
    for (const at of [0, 13, raw.length - 1]) {
      const bad = Buffer.from(raw)
      bad[at] ^= 1
      expect(() => open(key, 'a1', 100, bad.toString('base64'))).toThrow()
    }
    expect(() => open(key, 'a1', 100, 'AAAA')).toThrow()
    expect(() => open(key, 'a1', 100, '')).toThrow()
  })

  it('keyIdOf is stable and 16 hex', () => {
    const key = Buffer.alloc(32, 7)
    expect(keyIdOf(key)).toMatch(/^[0-9a-f]{16}$/)
    expect(keyIdOf(key)).toBe(keyIdOf(Buffer.alloc(32, 7)))
    expect(keyIdOf(key)).not.toBe(keyIdOf(Buffer.alloc(32, 8)))
  })

  it('writeKey makes 0700/0600 and refuses to overwrite', async () => {
    const path = join(dir, 'conf', 'vault.key')
    expect(await readKey(path)).toBeNull()
    const key = newKey()
    expect(key.length).toBe(32)
    await writeKey(path, key)
    if (process.platform !== 'win32') expect((await fs.stat(join(dir, 'conf'))).mode & 0o777).toBe(0o700)
    if (process.platform !== 'win32') expect((await fs.stat(path)).mode & 0o777).toBe(0o600)
    expect((await readKey(path))?.equals(key)).toBe(true)
    await expect(writeKey(path, newKey())).rejects.toThrow()
    expect((await readKey(path))?.equals(key)).toBe(true)
  })

  it('writeKey syncs the key file to disk before returning', async () => {
    const real = fs.open.bind(fs)
    let synced = 0
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...a: Parameters<typeof fs.open>) => {
      const fh = await real(...a)
      const sync = fh.sync.bind(fh)
      fh.sync = async () => {
        synced++
        return sync()
      }
      return fh
    })
    try {
      await writeKey(join(dir, 'conf', 'vault.key'), newKey())
    } finally {
      spy.mockRestore()
    }
    expect(synced).toBeGreaterThan(0)
  })

  it('writeKey removes the file it made when the write fails, so the next save can make the key', async () => {
    const path = join(dir, 'conf', 'vault.key')
    const real = fs.open.bind(fs)
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...a: Parameters<typeof fs.open>) => {
      const fh = await real(...a)
      // A full disk: the file exists, nothing (or part) of the key is in it.
      fh.writeFile = async () => {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      }
      return fh
    })
    try {
      await expect(writeKey(path, newKey())).rejects.toMatchObject({ code: 'ENOSPC' })
    } finally {
      spy.mockRestore()
    }
    expect(
      await fs.access(path).then(
        () => true,
        () => false
      )
    ).toBe(false)
    const key = newKey()
    await writeKey(path, key)
    expect((await readKey(path))?.equals(key)).toBe(true)
  })

  it('writeKey never removes a key file it did not make', async () => {
    const path = join(dir, 'conf', 'vault.key')
    const key = newKey()
    await writeKey(path, key)
    await expect(writeKey(path, newKey())).rejects.toMatchObject({ code: 'EEXIST' })
    expect((await readKey(path))?.equals(key)).toBe(true)
  })

  it('refuses a key file that is not 32 bytes of base64', async () => {
    const path = join(dir, 'vault.key')
    await fs.writeFile(path, 'not a key')
    await expect(readKey(path)).rejects.toThrow()
  })

  // The sync tool cannot import the server's TypeScript, so its own copy of the format must stay byte-compatible.
  it('vaultSync.mjs opens what vaultCrypto sealed and back', async () => {
    const key = newKey()
    const body = { id: 'a1', updatedAt: 100, kind: 'login', name: 'Bank', password: 'hunter22', agents: ['a'] }
    const sealed = seal(key, 'a1', 100, body)
    expect(vaultSync.openItem(key, { id: 'a1', updatedAt: 100, deleted: false, sealed })).toEqual(body)
    expect(() => vaultSync.openItem(key, { id: 'a2', updatedAt: 100, deleted: false, sealed })).toThrow()
    expect(() => vaultSync.openItem(newKey(), { id: 'a1', updatedAt: 100, deleted: false, sealed })).toThrow()
    const back = vaultSync.sealItem(key, 'a1', 100, body) as string
    expect(open(key, 'a1', 100, back)).toEqual(body)
    expect(() => open(key, 'a1', 101, back)).toThrow()
    expect(vaultSync.keyIdOf(key)).toBe(keyIdOf(key))
    // A key file written by the server reads back as the same key.
    const path = join(dir, 'k', 'vault.key')
    await writeKey(path, key)
    expect((vaultSync.keyFromText(await fs.readFile(path, 'utf8')) as Buffer).equals(key)).toBe(true)
    expect(() => vaultSync.keyFromText('not a key')).toThrow()
    expect(() => vaultSync.keyFromText(Buffer.alloc(31).toString('base64'))).toThrow()
  })
})
