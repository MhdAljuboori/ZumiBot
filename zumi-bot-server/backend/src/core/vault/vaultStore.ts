import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CONTACT_FIELDS,
  VAULT_CHANGED,
  VAULT_FULL,
  VAULT_MAX_ITEMS,
  VAULT_UNAVAILABLE,
  agentView,
  cardDigits,
  normalizeSite,
  totpSecretOf,
  vaultInputError,
  type VaultAgentItem,
  type VaultInput,
  type VaultItem,
  type VaultStatus
} from '@zumibot/shared/vault'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { writeFileAtomic } from '../fsutil'
import { keyIdOf, newKey, open, readKey, seal, writeKey } from './vaultCrypto'

interface RawItem {
  id: string
  updatedAt: number
  deleted: boolean
  sealed: string | null
}
interface VaultFile {
  v: 1
  keyId: string
  items: RawItem[]
}

// Also the order `vault_items` lists them in.
const KINDS = ['login', 'card', 'contact', 'apiKey']
const PASSWORD_SCRUB_MIN = 6

const isRaw = (r: unknown): r is RawItem => {
  if (typeof r !== 'object' || r === null) return false
  const x = r as Record<string, unknown>
  if (typeof x.id !== 'string' || typeof x.updatedAt !== 'number' || !Number.isFinite(x.updatedAt)) return false
  return x.deleted === true ? x.sealed === null : x.deleted === false && typeof x.sealed === 'string'
}

/** vault.json: every item sealed on its own, the key in a file outside the data folder. Never logs a value. */
export class VaultStore {
  private readonly file: string
  private readonly now: () => number
  private readonly newId: () => string
  private queue: Promise<unknown> = Promise.resolve()
  private state: VaultStatus = 'empty'
  private key: Buffer | null = null
  private keyBad = false
  private raw = new Map<string, RawItem>()
  private items = new Map<string, VaultItem>()
  private readonly listeners = new Set<() => void>()
  // Server-only secrets kept outside vault.json (channel bot tokens): never listed or granted, but scrubbed like any value.
  private extraSecrets: () => string[] = () => []
  // Grant changes (rename, forget) made while a write is in flight: the item being written was built from the old
  // names, so they are replayed onto it. Kept only while `active` writes exist; marks are indexes into the list.
  private maps: Array<(agents: string[]) => string[]> = []
  private active = 0

  constructor(private readonly o: { dataDir: string; keyFile: string; now?: () => number; newId?: () => string }) {
    this.file = join(o.dataDir, 'vault.json')
    this.now = o.now ?? Date.now
    this.newId = o.newId ?? randomUUID
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  // Reads --------------------------------------------------------------

  status(): VaultStatus {
    return this.state
  }

  /** Where the key is looked for: a path, never the key. The Vault page names it when the key is missing or wrong. */
  keyFile(): string {
    return this.o.keyFile
  }

  list(): VaultItem[] {
    return [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((i) => structuredClone(i))
  }

  get(id: string): VaultItem | null {
    const item = this.items.get(id)
    return item ? structuredClone(item) : null
  }

  // Never Zumi Bot, even for a grant on disk: a sync join takes grants as they come, and nothing else may hand it one.
  grantedTo(agent: string): VaultItem[] {
    if (agent === ZUMI_BOT_NAME) return []
    return this.list().filter((i) => i.agents.includes(agent))
  }

  /** The name a fill row shows: only for an item granted to that agent (so never for Zumi Bot), else null. */
  itemNameFor(id: string, agent: string): string | null {
    return this.grantedTo(agent).find((i) => i.id === id)?.name ?? null
  }

  /** What `vault_items` answers an agent: its granted items as it may see them, by kind (login, card, contact, apiKey), then name. */
  agentItems(agent: string): VaultAgentItem[] {
    return this.grantedTo(agent)
      .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map(agentView)
  }

  /** An API key a workflow HTTP step may send: its name (for the scrub tag) and value, or null. */
  workflowKey(id: string): { name: string; value: string } | null {
    const item = this.items.get(id)
    if (!item || item.kind !== 'apiKey' || item.workflows !== true || item.value === '') return null
    return { name: item.name, value: item.value }
  }

  /** A login a workflow's email trigger may sign in with, or null. Read per check, so a switch turned off stops the next one. */
  workflowLogin(id: string): { username: string; password: string } | null {
    const item = this.items.get(id)
    if (!item || item.kind !== 'login' || item.workflows !== true || item.username === '' || item.password === '') return null
    return { username: item.username, password: item.password }
  }

  agents(): string[] {
    return [...new Set([...this.items.values()].flatMap((i) => i.agents))].sort()
  }

  /** What must never appear in anything stored or shown: short passwords are left out, since they would blank common text. */
  secrets(): { values: string[]; cards: string[] } {
    const values = new Set<string>()
    const cards = new Set<string>()
    for (const i of this.items.values()) {
      if (i.kind === 'login' && i.password.length >= PASSWORD_SCRUB_MIN) values.add(i.password)
      else if (i.kind === 'apiKey' && i.value !== '') values.add(i.value)
      else if (i.kind === 'card') {
        const d = cardDigits(i.number)
        if (d !== null) cards.add(d)
      }
    }
    for (const v of this.extraSecrets()) if (v !== '') values.add(v)
    return { values: [...values], cards: [...cards] }
  }

  /** The values of secrets kept outside vault.json under this key (channel bot tokens), added to `secrets()`. */
  setExtraSecrets(fn: () => string[]): void {
    this.extraSecrets = fn
  }

  /**
   * Seals a server-only body under the vault key, made at the first use as a save makes it. The id goes into the additional
   * data, so a sealed body can't be moved to another id or time. Refused (`VAULT_UNAVAILABLE`) while the vault can't be opened.
   */
  sealExtra(id: string, updatedAt: number, body: unknown): Promise<string> {
    return this.run(async () => {
      this.writable()
      return seal(await this.ensureKey(), id, updatedAt, body)
    })
  }

  /** The body `sealExtra` sealed, or null: no key, another key, or a body that does not open. */
  openExtra(id: string, updatedAt: number, sealed: string): unknown {
    if (this.key === null || this.keyBad) return null
    try {
      return open(this.key, id, updatedAt, sealed)
    } catch {
      return null
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try {
        cb()
      } catch {
        /* a listener never fails a write */
      }
    }
  }

  // Loading --------------------------------------------------------------

  load(): Promise<void> {
    return this.run(async () => {
      const before = this.state
      await this.doLoad()
      // A ready load emits from doLoad itself; the UI must also learn the vault just became unreadable.
      if (this.state !== before && (this.state === 'keyMissing' || this.state === 'keyMismatch')) this.emit()
    })
  }

  private clear(state: VaultStatus): void {
    this.raw = new Map()
    this.items = new Map()
    this.state = state
  }

  private async doLoad(): Promise<void> {
    this.key = null
    this.keyBad = false
    try {
      this.key = await readKey(this.o.keyFile)
    } catch {
      this.keyBad = true
    }
    let file: VaultFile | null
    try {
      file = await this.readFile()
    } catch {
      // An unreadable file is never treated as empty: the next save would overwrite what may still be recoverable.
      this.clear('keyMismatch')
      return
    }
    if (this.keyBad) return this.clear('keyMismatch')
    if (file === null || file.items.length === 0) return this.clear('empty')
    const live = file.items.filter((r) => !r.deleted)
    const raw = new Map(file.items.map((r) => [r.id, r] as const))
    if (raw.size !== file.items.length) return this.clear('keyMismatch')
    if (live.length === 0) {
      this.raw = raw
      this.items = new Map()
      this.state = this.key === null ? 'empty' : 'ready'
      return
    }
    if (this.key === null) return this.clear('keyMissing')
    if (file.keyId !== keyIdOf(this.key)) return this.clear('keyMismatch')
    const items = new Map<string, VaultItem>()
    try {
      for (const r of live) items.set(r.id, this.openItem(this.key, r))
    } catch {
      return this.clear('keyMismatch')
    }
    this.raw = raw
    this.items = items
    this.state = 'ready'
    this.emit()
  }

  private openItem(key: Buffer, r: RawItem): VaultItem {
    const body = open(key, r.id, r.updatedAt, r.sealed as string) as Partial<VaultItem> | null
    if (typeof body !== 'object' || body === null || body.id !== r.id || body.updatedAt !== r.updatedAt)
      throw new Error('item does not match its record')
    if (typeof body.kind !== 'string' || !KINDS.includes(body.kind) || typeof body.name !== 'string' || !Array.isArray(body.agents))
      throw new Error('bad item')
    return body as VaultItem
  }

  private async readFile(): Promise<VaultFile | null> {
    let text: string
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    const f = JSON.parse(text) as Partial<VaultFile> | null
    if (typeof f !== 'object' || f === null || f.v !== 1 || typeof f.keyId !== 'string' || !Array.isArray(f.items) || !f.items.every(isRaw))
      throw new Error('unknown vault file')
    return f as VaultFile
  }

  // Writes -----------------------------------------------------------------

  private writable(): void {
    if (this.state !== 'empty' && this.state !== 'ready') throw new Error(VAULT_UNAVAILABLE)
  }

  // The key is made by the first save only, so two machines that never used the vault never make two keys.
  private async ensureKey(): Promise<Buffer> {
    if (this.key !== null) return this.key
    const key = newKey()
    try {
      await writeKey(this.o.keyFile, key)
      this.key = key
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      try {
        this.key = await readKey(this.o.keyFile)
      } catch {
        throw new Error(VAULT_UNAVAILABLE)
      }
    }
    if (this.key === null) throw new Error(VAULT_UNAVAILABLE)
    return this.key
  }

  private track(): number {
    this.active++
    return this.maps.length
  }

  private untrack(): void {
    if (--this.active === 0) this.maps = []
  }

  /** The grant changes made since `mark`, put onto the items about to be written; true when any item changed. */
  private replay(upserts: VaultItem[], mark: number): boolean {
    let changed = false
    for (const u of upserts) {
      let agents = u.agents
      for (let i = mark; i < this.maps.length; i++) agents = [...new Set(this.maps[i](agents))]
      if (agents.length !== u.agents.length || agents.some((a, i) => a !== u.agents[i])) {
        u.agents = agents
        changed = true
      }
    }
    return changed
  }

  /** Seals the upserts, tombstones the deletes, writes the file, and only then changes what the reads return. `mark`: see `maps`. */
  private async apply(upserts: VaultItem[], deletes: string[] = [], mark?: number): Promise<void> {
    const own = mark === undefined
    let from = mark ?? this.track()
    try {
      const key = await this.ensureKey()
      for (;;) {
        this.replay(upserts, from)
        from = this.maps.length
        const raw = new Map(this.raw)
        const items = new Map(this.items)
        for (const u of upserts) {
          raw.set(u.id, { id: u.id, updatedAt: u.updatedAt, deleted: false, sealed: seal(key, u.id, u.updatedAt, u) })
          items.set(u.id, u)
        }
        for (const id of deletes) {
          const at = Math.max(this.now(), (this.raw.get(id)?.updatedAt ?? 0) + 1)
          raw.set(id, { id, updatedAt: at, deleted: true, sealed: null })
          items.delete(id)
        }
        const body: VaultFile = { v: 1, keyId: keyIdOf(key), items: [...raw.values()] }
        await fs.mkdir(this.o.dataDir, { recursive: true })
        await writeFileAtomic(this.file, JSON.stringify(body, null, 2), 0o600)
        // A grant change that landed during the write is not in what was just written: write again under a new time.
        if (from !== this.maps.length) {
          const changed = this.replay(upserts, from)
          from = this.maps.length
          if (changed) {
            for (const u of upserts) u.updatedAt = this.next(u)
            continue
          }
        }
        this.raw = raw
        this.items = items
        this.state = 'ready'
        this.emit()
        return
      }
    } finally {
      if (own) this.untrack()
    }
  }

  private next(prev: VaultItem | undefined): number {
    return Math.max(this.now(), (prev?.updatedAt ?? 0) + 1)
  }

  /**
   * `check`: the caller's own checks of the input (the RPC's agents list), started only once the mark is taken, so a rename or a
   * forget that lands while they read is replayed onto this save instead of leaving a grant under the old name. A rejection
   * fails the save with its error.
   */
  save(input: VaultInput, updatedAt?: number, check?: () => Promise<void>): Promise<VaultItem> {
    // Taken now, not when the save's turn starts: a rename while it waits in the queue must reach it too.
    const mark = this.track()
    const checked = check ? Promise.resolve().then(check) : null
    // Awaited in the save's turn; handled here too, so a quick rejection is never reported as unhandled meanwhile.
    checked?.catch(() => undefined)
    return this.run(async () => {
      // Awaited while this save holds the queue: a check must never wait on vault queue work (a save, a rename's reseal, a
      // load), or each waits on the other for ever. Reading the agents folder is fine.
      if (checked) await checked
      this.writable()
      const prev = input.id === undefined ? undefined : this.items.get(input.id)
      // An id that is gone (deleted elsewhere) is as stale as a changed time.
      if (input.id !== undefined && (prev === undefined || prev.updatedAt !== updatedAt)) throw new Error(VAULT_CHANGED)
      if (prev === undefined && this.items.size >= VAULT_MAX_ITEMS) throw new Error(VAULT_FULL)
      if (prev !== undefined && prev.kind !== input.kind) throw new Error('An item cannot change its kind.')

      let clean: VaultInput = { ...input, agents: [...new Set(input.agents)] }
      if (clean.kind === 'login') {
        const sites: string[] = []
        for (const s of clean.sites) {
          const host = normalizeSite(s)
          if (host === null) throw new Error('One of the sites is not a valid host.')
          if (!sites.includes(host)) sites.push(host)
        }
        clean = { ...clean, sites }
      }
      const problem = vaultInputError(clean, [...this.items.values()])
      if (problem !== null) throw new Error(problem)

      const id = prev?.id ?? this.newId()
      const base = { id, updatedAt: this.next(prev), name: clean.name.trim(), agents: clean.agents }
      let item: VaultItem
      switch (clean.kind) {
        case 'login': {
          const was = prev?.kind === 'login' ? prev : undefined
          // A pasted otpauth link is kept as its base32 secret.
          const totp = clean.totp === undefined ? (was?.totp ?? null) : clean.totp === null ? null : totpSecretOf(clean.totp)
          item = {
            ...base,
            kind: 'login',
            sites: clean.sites,
            username: clean.username,
            password: clean.password ?? was?.password ?? '',
            totp,
            ...(clean.workflows ? { workflows: true as const } : {})
          }
          break
        }
        case 'card': {
          const was = prev?.kind === 'card' ? prev : undefined
          item = {
            ...base,
            kind: 'card',
            holder: clean.holder,
            number: clean.number ?? was?.number ?? '',
            expiry: clean.expiry ?? was?.expiry ?? '',
            cvc: clean.cvc ?? was?.cvc ?? '',
            approved: was?.approved ?? []
          }
          break
        }
        case 'contact': {
          const fields = Object.fromEntries(CONTACT_FIELDS.map((f) => [f, (clean as Record<string, string>)[f]])) as Record<
            (typeof CONTACT_FIELDS)[number],
            string
          >
          item = { ...base, kind: 'contact', ...fields }
          break
        }
        case 'apiKey': {
          const was = prev?.kind === 'apiKey' ? prev : undefined
          item = {
            ...base,
            kind: 'apiKey',
            env: clean.env,
            value: clean.value ?? was?.value ?? '',
            description: clean.description,
            ...(clean.workflows ? { workflows: true as const } : {})
          }
          break
        }
      }
      await this.apply([item], [], mark)
      return structuredClone(item)
    }).finally(() => this.untrack())
  }

  delete(id: string): Promise<void> {
    return this.run(async () => {
      this.writable()
      if (this.items.has(id)) await this.apply([], [id])
    })
  }

  addApproval(id: string, site: string, frameSite: string): Promise<void> {
    return this.run(async () => {
      this.writable()
      const prev = this.items.get(id)
      if (prev?.kind !== 'card' || prev.approved.some((a) => a.site === site && a.frameSite === frameSite)) return
      await this.apply([{ ...prev, updatedAt: this.next(prev), approved: [...prev.approved, { site, frameSite, at: this.now() }] }])
    })
  }

  removeApproval(id: string, site: string, frameSite: string): Promise<void> {
    return this.run(async () => {
      this.writable()
      const prev = this.items.get(id)
      if (prev?.kind !== 'card' || !prev.approved.some((a) => a.site === site && a.frameSite === frameSite)) return
      await this.apply([
        { ...prev, updatedAt: this.next(prev), approved: prev.approved.filter((a) => !(a.site === site && a.frameSite === frameSite)) }
      ])
    })
  }

  // Memory changes before the first await: the agents-folder watcher's removal pass runs right after a rename
  // and must already find the grants moved, or it would drop them.
  // Zumi Bot never ends up with a grant: the old built-in's rename (migrateOldBuiltIn) runs this pipeline onto its name.
  private moveGrants(move: (agents: string[]) => string[]): string[] {
    const map = (agents: string[]) => move(agents).filter((a) => a !== ZUMI_BOT_NAME)
    if (this.active > 0) this.maps.push(map)
    const touched: string[] = []
    for (const item of this.items.values()) {
      const agents = [...new Set(map(item.agents))]
      if (agents.length === item.agents.length && agents.every((a, i) => a === item.agents[i])) continue
      item.agents = agents
      touched.push(item.id)
    }
    return touched
  }

  // The grants are already changed in memory; this seals them under a new time and writes the file.
  private reseal(ids: string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve()
    return this.run(async () => {
      const upserts: VaultItem[] = []
      for (const id of ids) {
        const item = this.items.get(id)
        if (item) upserts.push({ ...item, updatedAt: this.next(item) })
      }
      if (upserts.length > 0) await this.apply(upserts)
    })
  }

  renameAgent(from: string, to: string): Promise<void> {
    return this.reseal(this.moveGrants((agents) => agents.map((a) => (a === from ? to : a))))
  }

  forgetAgents(names: readonly string[]): Promise<void> {
    return this.reseal(this.moveGrants((agents) => agents.filter((a) => !names.includes(a))))
  }

  /** "Start a new vault": the old file is moved aside, never deleted. */
  reset(): Promise<void> {
    return this.run(async () => {
      const stamp = new Date(this.now()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
      await this.moveAside(this.file, stamp)
      if (this.keyBad) {
        await this.moveAside(this.o.keyFile, stamp)
        this.keyBad = false
      }
      this.clear('empty')
      this.emit()
    })
  }

  private async moveAside(path: string, stamp: string): Promise<void> {
    const base = `${path}.unreadable-${stamp}`
    let target = base
    for (
      let n = 2;
      await fs.access(target).then(
        () => true,
        () => false
      );
      n++
    )
      target = `${base}-${n}`
    try {
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.rename(path, target)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}
