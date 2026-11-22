import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TOGGLES } from '@zumibot/shared/notify'
import { DEVICE_CAP, NotifyStore, type DeviceRecord } from '../../src/core/notify/notifyStore'

let dir: string
let store: NotifyStore
const devFile = () => join(dir, 'notify-devices.json')
const vapidFile = () => join(dir, 'notify-vapid.json')
const mode = async (f: string) => (await fs.stat(f)).mode & 0o777
const exists = (f: string) =>
  fs.access(f).then(
    () => true,
    () => false
  )

const dev = (id: string, lastSeenAt = 1, endpoint?: string): DeviceRecord => ({
  id,
  channel: 'push',
  label: `Device ${id}`,
  toggles: { ...DEFAULT_TOGGLES },
  createdAt: 1,
  lastSeenAt,
  ...(endpoint ? { push: { endpoint, p256dh: 'p', auth: 'a', sessionKey: 's', paused: false } } : {})
})

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-notify-store-'))
  store = new NotifyStore(dir)
})
afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

describe('NotifyStore devices', () => {
  it('starts empty and keeps what is put, readable by the owner only', async () => {
    expect(await store.devices()).toEqual([])
    await store.put(dev('device-aaa', 5, 'https://push.example/a'))
    expect(await store.get('device-aaa')).toEqual(dev('device-aaa', 5, 'https://push.example/a'))
    expect(await store.get('nope')).toBeNull()
    if (process.platform !== 'win32') expect(await mode(devFile())).toBe(0o600)
  })

  it('replaces a record with the same id', async () => {
    await store.put(dev('device-aaa', 1))
    await store.put({ ...dev('device-aaa', 2), label: 'renamed' })
    const all = await store.devices()
    expect(all).toHaveLength(1)
    expect(all[0].label).toBe('renamed')
  })

  it('drops the least recently seen device past the cap', async () => {
    for (let i = 0; i < DEVICE_CAP; i++) await store.put(dev(`device-${String(i).padStart(2, '0')}`, 100 + i))
    expect(await store.devices()).toHaveLength(DEVICE_CAP)
    await store.put(dev('device-new', 500))
    const ids = (await store.devices()).map((d) => d.id)
    expect(ids).toHaveLength(DEVICE_CAP)
    expect(ids).not.toContain('device-00')
    expect(ids).toContain('device-01')
    expect(ids).toContain('device-new')
  })

  it('drops another record that holds the same push endpoint', async () => {
    await store.put(dev('device-aaa', 1, 'https://push.example/same'))
    await store.put(dev('device-bbb', 2, 'https://push.example/same'))
    expect((await store.devices()).map((d) => d.id)).toEqual(['device-bbb'])
  })

  it('keeps a record when its own endpoint is re-put', async () => {
    await store.put(dev('device-aaa', 1, 'https://push.example/same'))
    await store.put(dev('device-aaa', 2, 'https://push.example/same'))
    expect((await store.devices()).map((d) => d.id)).toEqual(['device-aaa'])
  })

  it('patches a record, returns null for an unknown id, and ignores a patch that changes the id', async () => {
    await store.put(dev('device-aaa', 1))
    const out = await store.patch('device-aaa', (r) => ({ ...r, label: 'x', id: 'other-id-1' }))
    expect(out?.label).toBe('x')
    expect(out?.id).toBe('device-aaa')
    expect((await store.get('device-aaa'))?.label).toBe('x')
    expect(await store.patch('nope', (r) => r)).toBeNull()
  })

  it('evicts an existing device, not the incoming one, when the incoming is the least recently seen', async () => {
    for (let i = 0; i < DEVICE_CAP; i++) await store.put(dev(`device-${String(i).padStart(2, '0')}`, 100 + i))
    await store.put(dev('device-old', 1))
    const ids = (await store.devices()).map((d) => d.id)
    expect(ids).toHaveLength(DEVICE_CAP)
    expect(ids).toContain('device-old')
    expect(ids).not.toContain('device-00')
  })

  it('drops the other record when a patch moves a device onto an endpoint another record holds', async () => {
    await store.put(dev('device-aaa', 1, 'https://push.example/a'))
    await store.put(dev('device-bbb', 2, 'https://push.example/b'))
    await store.patch('device-bbb', (r) => ({ ...r, push: { ...r.push!, endpoint: 'https://push.example/a' } }))
    const all = await store.devices()
    expect(all.map((d) => d.id)).toEqual(['device-bbb'])
    expect(all[0].push?.endpoint).toBe('https://push.example/a')
  })

  it('fails on a read error that is not "missing" and leaves the devices file alone', async () => {
    await store.put(dev('device-aaa'))
    const saved = await fs.readFile(devFile(), 'utf8')
    await fs.rm(devFile())
    await fs.mkdir(devFile()) // readFile throws EISDIR
    await expect(store.devices()).rejects.toThrow()
    await expect(store.put(dev('device-bbb'))).rejects.toThrow()
    await expect(store.remove('device-aaa')).rejects.toThrow()
    await expect(store.patch('device-aaa', (r) => r)).rejects.toThrow()
    await fs.rmdir(devFile())
    await fs.writeFile(devFile(), saved)
    expect((await store.devices()).map((d) => d.id)).toEqual(['device-aaa'])
  })

  it('removes a device; an unknown id is a no-op', async () => {
    await store.put(dev('device-aaa'))
    await store.remove('nope')
    expect(await store.devices()).toHaveLength(1)
    await store.remove('device-aaa')
    expect(await store.devices()).toEqual([])
  })

  it('reads a corrupt file as no devices', async () => {
    await fs.writeFile(devFile(), '{not json')
    expect(await store.devices()).toEqual([])
    await fs.writeFile(devFile(), JSON.stringify({ not: 'an array' }))
    expect(await store.devices()).toEqual([])
    await store.put(dev('device-aaa'))
    expect(await store.devices()).toHaveLength(1)
  })

  it('serializes concurrent puts', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.put(dev(`device-${i}0000`, i))))
    expect(await store.devices()).toHaveLength(10)
  })
})

describe('NotifyStore vapid', () => {
  it('has no public key and creates no file until vapid() is called', async () => {
    expect(await store.vapidPublicKey()).toBeNull()
    expect(await exists(vapidFile())).toBe(false)
  })

  it('creates keys once, 0600, and returns the same keys later and from a new store', async () => {
    const a = await store.vapid()
    if (process.platform !== 'win32') expect(await mode(vapidFile())).toBe(0o600)
    expect(await store.vapid()).toEqual(a)
    expect(await new NotifyStore(dir).vapid()).toEqual(a)
    expect(await store.vapidPublicKey()).toBe(a.publicKey)
  })

  it('rewrites a damaged or wrong-shaped vapid file', async () => {
    await fs.writeFile(vapidFile(), '{not json')
    const a = await store.vapid()
    expect(await store.vapid()).toEqual(a)
    await fs.writeFile(vapidFile(), JSON.stringify({ publicKey: 'x', privateKey: 'y' }))
    expect((await store.vapid()).publicKey).not.toBe('x')
  })

  it('never rotates the keys on a read error that is not "missing"', async () => {
    const a = await store.vapid()
    const saved = await fs.readFile(vapidFile(), 'utf8')
    await fs.rm(vapidFile())
    await fs.mkdir(vapidFile()) // readFile throws EISDIR
    await expect(store.vapid()).rejects.toThrow()
    await expect(store.vapidPublicKey()).rejects.toThrow()
    await fs.rmdir(vapidFile())
    await fs.writeFile(vapidFile(), saved)
    expect(await store.vapid()).toEqual(a)
  })

  it('creates the keys once even when called concurrently', async () => {
    const [a, b] = await Promise.all([store.vapid(), store.vapid()])
    expect(a).toEqual(b)
  })
})
