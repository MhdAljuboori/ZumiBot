import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, chmod, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  AUDIT_CAP_DEFAULT,
  AUDIT_CAPS,
  AUDIT_FILE_MAX,
  AUDIT_PAGE_MAX,
  auditRowOf,
  matchesAudit,
  type AuditFacets,
  type AuditFilter,
  type AuditPage,
  type AuditRecord,
  type AuditStatus,
  type AuditVerify
} from '@zumibot/shared/audit'
import { writeFileAtomic } from '../fsutil'

// Append-only JSON Lines under <data>/audit (0700, files 0600). One writer queue; whole files are the only thing ever deleted,
// oldest first, once the folder passes its cap. See docs/architecture/governance.md, Part 1.

const FILE_RE = /^audit-\d{8}-\d{6}-\d{3}(?:-\d+)?\.jsonl$/
const CAP_FILE = 'cap.json'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

interface Head {
  v: 1
  kind: 'head'
  machine: string
  created: number
  prevFile: string | null
  prevHash: string | null
}
interface FileInfo {
  name: string
  size: number
  count: number
  firstTs: number | null
  lastTs: number | null
}

export interface AuditLogDeps {
  dir: string
  machine: string
  now(): number
  /** Told after each append (at most once a second by the caller's own throttle). */
  onAppend?(): void
  /** Tests only: a smaller rotation size and cap than the real ones. */
  fileMax?: number
  capOverride?: number
}

const isHead = (v: unknown): v is Head => typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'head'

function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}`
}

/** A place in the log: a file and a line index in it. Lines only ever grow at a file's end, so a place stays put. */
export function parsePlace(place: string): { file: string; line: number } | null {
  const at = place.lastIndexOf(':')
  if (at < 0) return null
  const file = place.slice(0, at)
  const line = Number(place.slice(at + 1))
  return FILE_RE.test(file) && Number.isInteger(line) && line >= 0 ? { file, line } : null
}

export class AuditLog {
  private files: FileInfo[] = [] // oldest first
  private lastHash: string | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private failures = 0
  private records = 0
  private cap = AUDIT_CAP_DEFAULT
  private facets: { agents: Set<string>; tools: Set<string>; chats: Set<string> } | null = null
  private started = false
  // The newest files read for a page, so scrolling does not reread 16 MiB per page.
  private cache = new Map<string, string[]>()

  constructor(private d: AuditLogDeps) {}

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  async start(): Promise<void> {
    await this.run(async () => {
      await mkdir(this.d.dir, { recursive: true, mode: 0o700 })
      await chmod(this.d.dir, 0o700)
      try {
        const c = JSON.parse(await readFile(join(this.d.dir, CAP_FILE), 'utf8')) as { bytes?: unknown }
        if (typeof c.bytes === 'number' && (AUDIT_CAPS as readonly number[]).includes(c.bytes)) this.cap = c.bytes
      } catch {
        /* none yet: the default */
      }
      if (this.d.capOverride !== undefined) this.cap = this.d.capOverride
      const names = (await readdir(this.d.dir)).filter((n) => FILE_RE.test(n)).sort()
      this.files = []
      for (const name of names) {
        const s = await stat(join(this.d.dir, name))
        this.files.push({ name, size: s.size, count: 0, firstTs: null, lastTs: null })
      }
      // Times and counts for every file, and the newest file's last hash so the chain continues across a restart.
      for (const f of this.files) {
        const lines = await this.lines(f.name)
        for (const line of lines) {
          let v: unknown
          try {
            v = JSON.parse(line)
          } catch {
            continue
          }
          if (isHead(v)) continue
          const ts = (v as { ts?: unknown }).ts
          if (typeof ts === 'number') {
            f.firstTs ??= ts
            f.lastTs = ts
          }
          f.count++
        }
      }
      this.records = this.files.reduce((a, f) => a + f.count, 0)
      const newest = this.files.at(-1)
      if (newest) {
        const lines = await this.lines(newest.name)
        this.lastHash = lines.length > 0 ? sha(lines[lines.length - 1]) : null
      }
      this.cache.clear()
      this.started = true
    })
  }

  private async lines(name: string): Promise<string[]> {
    const hit = this.cache.get(name)
    if (hit) return hit
    let text = ''
    try {
      text = await readFile(join(this.d.dir, name), 'utf8')
    } catch {
      return []
    }
    const lines = text.split('\n').filter((l) => l !== '')
    this.cache.set(name, lines)
    while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value as string)
    return lines
  }

  private async newFile(now: number): Promise<FileInfo> {
    const prev = this.files.at(-1) ?? null
    let name = `audit-${stamp(now)}.jsonl`
    for (let n = 1; this.files.some((f) => f.name === name); n++) name = `audit-${stamp(now)}-${n}.jsonl`
    const head: Head = { v: 1, kind: 'head', machine: this.d.machine, created: now, prevFile: prev?.name ?? null, prevHash: this.lastHash }
    const line = JSON.stringify(head)
    await appendFile(join(this.d.dir, name), line + '\n', { mode: 0o600, flag: 'a' })
    const info: FileInfo = { name, size: Buffer.byteLength(line) + 1, count: 0, firstTs: null, lastTs: null }
    this.files.push(info)
    this.lastHash = sha(line)
    return info
  }

  /** Adds one record. Never throws: a failure is counted and logged by its code only. */
  append(record: Omit<AuditRecord, 'prev'>): Promise<void> {
    return this.run(async () => {
      try {
        if (!this.started) throw Object.assign(new Error('audit log not started'), { code: 'ENOTSTARTED' })
        let file = this.files.at(-1)
        if (!file || file.size >= (this.d.fileMax ?? AUDIT_FILE_MAX)) file = await this.newFile(this.d.now())
        const line = JSON.stringify({ ...record, prev: this.lastHash ?? '' })
        await appendFile(join(this.d.dir, file.name), line + '\n', { mode: 0o600, flag: 'a' })
        file.size += Buffer.byteLength(line) + 1
        file.firstTs ??= record.ts
        file.lastTs = record.ts
        this.lastHash = sha(line)
        file.count++
        this.records++
        this.cache.delete(file.name)
        if (this.facets) {
          this.facets.agents.add(record.agent)
          this.facets.tools.add(record.tool)
          this.facets.chats.add(record.chatId)
        }
        await this.enforceCap()
        this.d.onAppend?.()
      } catch (err) {
        this.failures++
        const code = (err as { code?: unknown } | null)?.code
        console.error('audit write failed:', typeof code === 'string' ? code : 'error')
      }
    })
  }

  // Whole files only, oldest first, never the one being written.
  private async enforceCap(): Promise<void> {
    let total = this.files.reduce((a, f) => a + f.size, 0)
    while (total > this.cap && this.files.length > 1) {
      const oldest = this.files.shift()!
      await rm(join(this.d.dir, oldest.name), { force: true })
      this.cache.delete(oldest.name)
      total -= oldest.size
      this.facets = null // rebuilt on the next ask: what the dropped file named may be gone
      this.records -= oldest.count
    }
  }

  async setCap(bytes: number): Promise<void> {
    if (!(AUDIT_CAPS as readonly number[]).includes(bytes)) throw new TypeError('cap must be one of the offered sizes')
    await this.run(async () => {
      this.cap = bytes
      await writeFileAtomic(join(this.d.dir, CAP_FILE), JSON.stringify({ bytes }), 0o600)
      await this.enforceCap()
    })
  }

  /** Newest first, `limit` records that pass the filter, from the cursor on. Each row carries its place, for `get`. */
  list(filter: AuditFilter, cursor: string | null, limit = 100): Promise<AuditPage> {
    return this.run(async () => {
      const max = Math.max(1, Math.min(AUDIT_PAGE_MAX, Math.floor(limit)))
      const from = cursor === null ? null : parsePlace(cursor)
      if (cursor !== null && from === null) throw new TypeError('cursor is not valid')
      const files = [...this.files].reverse()
      let i = from === null ? 0 : files.findIndex((f) => f.name === from.file)
      const rows: AuditPage['rows'] = []
      // A cursor whose file the cap dropped meanwhile: nothing older is left.
      if (i < 0) return { rows, next: null }
      for (let first = true; i < files.length; i++, first = false) {
        const f = files[i]
        if (filter.from !== undefined && f.lastTs !== null && f.lastTs < filter.from) break
        if (filter.to !== undefined && f.firstTs !== null && f.firstTs > filter.to) continue
        const lines = await this.lines(f.name)
        const top = first && from !== null ? Math.min(from.line, lines.length - 1) : lines.length - 1
        for (let j = top; j >= 0; j--) {
          let r: AuditRecord
          try {
            r = JSON.parse(lines[j]) as AuditRecord
          } catch {
            continue
          }
          if (isHead(r) || !matchesAudit(r, filter)) continue
          if (rows.length === max) return { rows, next: `${f.name}:${j}` }
          rows.push(auditRowOf(r, `${f.name}:${j}`))
        }
      }
      return { rows, next: null }
    })
  }

  /** One record by its id, at the place its row was listed from (`<file>:<line>`). */
  get(id: string, place: string): Promise<AuditRecord | null> {
    return this.run(async () => {
      const p = parsePlace(place)
      if (!p || !this.files.some((f) => f.name === p.file)) return null
      const { file, line } = p
      const lines = await this.lines(file)
      try {
        const r = JSON.parse(lines[line] ?? 'null') as AuditRecord | null
        return r && !isHead(r) && r.id === id ? r : null
      } catch {
        return null
      }
    })
  }

  async getFacets(): Promise<AuditFacets> {
    if (!this.facets) {
      const f = { agents: new Set<string>(), tools: new Set<string>(), chats: new Set<string>() }
      for await (const r of this.each()) {
        f.agents.add(r.agent)
        f.tools.add(r.tool)
        f.chats.add(r.chatId)
      }
      this.facets = f
    }
    const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b))
    return { agents: sorted(this.facets.agents), tools: sorted(this.facets.tools), chats: sorted(this.facets.chats) }
  }

  /** Every record, oldest first, streamed line by line (export, facets). */
  async *each(filter: AuditFilter = {}): AsyncGenerator<AuditRecord> {
    for (const f of [...this.files]) {
      if (filter.from !== undefined && f.lastTs !== null && f.lastTs < filter.from) continue
      if (filter.to !== undefined && f.firstTs !== null && f.firstTs > filter.to) continue
      const stream = createReadStream(join(this.d.dir, f.name), { encoding: 'utf8' })
      const rl = createInterface({ input: stream, crlfDelay: Infinity })
      try {
        for await (const line of rl) {
          if (line === '') continue
          let r: unknown
          try {
            r = JSON.parse(line)
          } catch {
            continue
          }
          if (isHead(r)) continue
          if (matchesAudit(r as AuditRecord, filter)) yield r as AuditRecord
        }
      } catch (err) {
        // A file the cap dropped mid-read: the export goes on with the next.
        if ((err as { code?: unknown } | null)?.code !== 'ENOENT') throw err
      } finally {
        rl.close()
        stream.destroy()
      }
    }
  }

  /** Walks every file's chain; the first link that does not match is reported. */
  verify(): Promise<AuditVerify> {
    return this.run(async () => {
      let prevFileHash: string | null = null
      let prevName: string | null = null
      for (const f of this.files) {
        const lines = await this.lines(f.name)
        let last: string | null = null
        for (let j = 0; j < lines.length; j++) {
          let v: unknown
          try {
            v = JSON.parse(lines[j])
          } catch {
            return { ok: false as const, file: f.name, line: j + 1 }
          }
          if (j === 0) {
            if (!isHead(v)) return { ok: false as const, file: f.name, line: 1 }
            // The previous file may be gone (the cap); only a file still here is checked against.
            if (prevName !== null && v.prevFile === prevName && v.prevHash !== prevFileHash)
              return { ok: false as const, file: f.name, line: 1 }
          } else {
            const prev = (v as { prev?: unknown }).prev
            if (isHead(v) || prev !== sha(last ?? '')) return { ok: false as const, file: f.name, line: j + 1 }
          }
          last = lines[j]
        }
        prevName = f.name
        prevFileHash = last === null ? null : sha(last)
      }
      return { ok: true as const, files: this.files.length }
    })
  }

  status(): AuditStatus {
    return {
      machine: this.d.machine,
      bytes: this.files.reduce((a, f) => a + f.size, 0),
      cap: this.cap,
      failures: this.failures,
      records: this.records
    }
  }

  /** Waits for every write queued so far (tests, shutdown). */
  flush(): Promise<void> {
    return this.run(async () => {})
  }
}
