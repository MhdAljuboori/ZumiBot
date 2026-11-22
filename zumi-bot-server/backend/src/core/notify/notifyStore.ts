import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { isToggles, type NotifyChannel, type NotifyToggles } from '@zumibot/shared/notify'
import { writeFileAtomic } from '../fsutil'
import { b64url, generateVapidKeys, type VapidKeys } from './webPush'

export const DEVICE_CAP = 20

export interface PushBinding {
  endpoint: string
  p256dh: string
  auth: string
  sessionKey: string
  paused: boolean
}
export interface DeviceRecord {
  id: string
  channel: NotifyChannel
  label: string
  toggles: NotifyToggles
  createdAt: number
  lastSeenAt: number
  push?: PushBinding
}

const isRecord = (v: unknown): v is DeviceRecord => {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  if (typeof r.id !== 'string' || (r.channel !== 'push' && r.channel !== 'desktop') || typeof r.label !== 'string') return false
  if (!isToggles(r.toggles) || typeof r.createdAt !== 'number' || typeof r.lastSeenAt !== 'number') return false
  if (r.push === undefined) return true
  const p = r.push as Record<string, unknown> | null
  return (
    !!p &&
    typeof p === 'object' &&
    typeof p.endpoint === 'string' &&
    typeof p.p256dh === 'string' &&
    typeof p.auth === 'string' &&
    typeof p.sessionKey === 'string' &&
    typeof p.paused === 'boolean'
  )
}

const isVapid = (v: unknown): v is VapidKeys => {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.publicKey === 'string' &&
    typeof o.privateKey === 'string' &&
    b64url.decode(o.publicKey).length === 65 &&
    b64url.decode(o.privateKey).length === 32
  )
}

// Only a missing or damaged file counts as "no data". Any other read error (EACCES, EMFILE, EIO...) is
// transient: rethrow, or the next write would overwrite good data (rotating the VAPID keys breaks every subscription).
async function readJson(file: string): Promise<unknown> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    if (err instanceof SyntaxError) return null
    throw err
  }
}

/** notify-devices.json and notify-vapid.json: endpoints, session keys and the VAPID private key, so both are written 0600. */
export class NotifyStore {
  private readonly devicesFile: string
  private readonly vapidFile: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly dataDir: string) {
    this.devicesFile = join(dataDir, 'notify-devices.json')
    this.vapidFile = join(dataDir, 'notify-vapid.json')
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async read(): Promise<DeviceRecord[]> {
    const raw = await readJson(this.devicesFile)
    return Array.isArray(raw) ? raw.filter(isRecord) : []
  }

  private async write(list: DeviceRecord[]): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    await writeFileAtomic(this.devicesFile, JSON.stringify(list, null, 2), 0o600)
  }

  devices(): Promise<DeviceRecord[]> {
    return this.run(() => this.read())
  }

  get(id: string): Promise<DeviceRecord | null> {
    return this.run(async () => (await this.read()).find((d) => d.id === id) ?? null)
  }

  put(rec: DeviceRecord): Promise<void> {
    return this.run(async () => {
      const endpoint = rec.push?.endpoint
      // The same browser with cleared storage comes back under a new id and the same subscription: keep one record, so pushes never double.
      const list = (await this.read()).filter((d) => d.id !== rec.id && !(endpoint !== undefined && d.push?.endpoint === endpoint))
      while (list.length >= DEVICE_CAP) {
        let oldest = 0
        list.forEach((d, i) => {
          if (d.lastSeenAt < list[oldest].lastSeenAt) oldest = i
        })
        list.splice(oldest, 1)
      }
      list.push(rec)
      await this.write(list)
    })
  }

  patch(id: string, fn: (r: DeviceRecord) => DeviceRecord): Promise<DeviceRecord | null> {
    return this.run(async () => {
      const list = await this.read()
      const i = list.findIndex((d) => d.id === id)
      if (i < 0) return null
      // The id is the key: a patch can't move a record to another id.
      const next = { ...fn(list[i]), id }
      list[i] = next
      // Same rule as put: a changed endpoint evicts any other record holding it.
      const endpoint = next.push?.endpoint
      await this.write(endpoint === undefined ? list : list.filter((d) => d.id === id || d.push?.endpoint !== endpoint))
      return next
    })
  }

  remove(id: string): Promise<void> {
    return this.run(async () => {
      const list = await this.read()
      const rest = list.filter((d) => d.id !== id)
      if (rest.length !== list.length) await this.write(rest)
    })
  }

  vapid(): Promise<VapidKeys> {
    return this.run(async () => {
      const existing = await this.readVapid()
      if (existing) return existing
      const keys = generateVapidKeys()
      await fs.mkdir(this.dataDir, { recursive: true })
      await writeFileAtomic(this.vapidFile, JSON.stringify(keys, null, 2), 0o600)
      return keys
    })
  }

  vapidPublicKey(): Promise<string | null> {
    return this.run(async () => (await this.readVapid())?.publicKey ?? null)
  }

  private async readVapid(): Promise<VapidKeys | null> {
    const raw = await readJson(this.vapidFile)
    return isVapid(raw) ? { publicKey: raw.publicKey, privateKey: raw.privateKey } : null
  }
}
