import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  ROUTINE_RUNS_KEPT,
  ROUTINE_SKIPPED_RUNS_KEPT,
  type Routine,
  type RoutineRun,
  type RoutinesSnapshot,
  type WebhookCall
} from '@zumibot/shared/routines'
import { writeFileAtomic } from '../fsutil'
import { HookFile, type HookRecord } from '../hooks/hookFile'

export { secretMatches, MIN_SECRET_LENGTH, type HookRecord } from '../hooks/hookFile'

export class RoutineStore {
  private readonly files: Record<'routines' | 'runs', string>
  private readonly queues: Record<'routines' | 'runs', Promise<unknown>> = {
    routines: Promise.resolve(),
    runs: Promise.resolve()
  }
  private readonly hooks: HookFile

  constructor(private readonly dataDir: string) {
    this.files = {
      routines: join(dataDir, 'routines.json'),
      runs: join(dataDir, 'routine-runs.json')
    }
    // Owners are read through the routines queue (list), so a corrupt-file rename-aside there never races.
    this.hooks = new HookFile(join(dataDir, 'routine-hooks.json'), async () => (await this.list()).map((r) => r.id))
  }

  private run<T>(key: keyof RoutineStore['queues'], op: () => Promise<T>): Promise<T> {
    const next = this.queues[key].then(op, op)
    this.queues[key] = next.catch(() => undefined)
    return next
  }

  private async read<T>(key: keyof RoutineStore['files'], fallback: T): Promise<T> {
    const file = this.files[key]
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (err) {
      // Only a missing file is empty: any other failure must not end in a write that wipes the rest.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
      throw err
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      await fs.rename(file, `${file}.corrupt-${Date.now()}`)
      console.error(`routines: ${file} is not valid JSON, moved aside`) // name only, never contents (hooks hold secrets)
      return fallback
    }
    if (key === 'routines') return (Array.isArray(value) ? value : fallback) as T
    return (value && typeof value === 'object' && !Array.isArray(value) ? value : fallback) as T
  }

  private async write(key: keyof RoutineStore['files'], value: unknown): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    await writeFileAtomic(this.files[key], JSON.stringify(value))
  }

  list(): Promise<Routine[]> {
    return this.run('routines', async () => this.read('routines', []))
  }

  get(id: string): Promise<Routine | null> {
    return this.run('routines', async () => (await this.read<Routine[]>('routines', [])).find((r) => r.id === id) ?? null)
  }

  put(r: Routine): Promise<void> {
    return this.run('routines', async () => {
      const rows = await this.read<Routine[]>('routines', [])
      await this.write('routines', upsert(rows, r))
    })
  }

  update(id: string, fn: (r: Routine) => Routine | null): Promise<Routine | null> {
    return this.run('routines', async () => {
      const rows = await this.read<Routine[]>('routines', [])
      const index = rows.findIndex((r) => r.id === id)
      if (index < 0) return null

      const updated = fn(rows[index]!)
      if (!updated) return null

      rows[index] = updated
      await this.write('routines', rows)
      return updated
    })
  }

  /** Adds `make(source, all)` in one step on the queue, so the names it reads are the ones it is added among; null when the source is gone. */
  copy(id: string, make: (source: Routine, all: Routine[]) => Routine): Promise<Routine | null> {
    return this.run('routines', async () => {
      const rows = await this.read<Routine[]>('routines', [])
      const source = rows.find((r) => r.id === id)
      if (!source) return null
      const made = make(source, rows)
      rows.push(made)
      await this.write('routines', rows)
      return made
    })
  }

  async remove(id: string): Promise<void> {
    await this.run('routines', async () => {
      const rows = await this.read<Routine[]>('routines', [])
      await this.write(
        'routines',
        rows.filter((r) => r.id !== id)
      )
    })
    await this.run('runs', async () => {
      const rows = await this.read<Record<string, RoutineRun[]>>('runs', {})
      delete rows[id]
      await this.write('runs', rows)
    })
    await this.hooks.dropHook(id)
  }

  runs(): Promise<Record<string, RoutineRun[]>> {
    return this.run('runs', async () => this.read('runs', {}))
  }

  addRun(run: RoutineRun): Promise<void> {
    return this.run('runs', async () => {
      const all = await this.read<Record<string, RoutineRun[]>>('runs', {})
      const others = (all[run.routineId] ?? []).filter((x) => x.id !== run.id)
      let skipped = 0
      all[run.routineId] = [run, ...others]
        .filter((x) => x.status !== 'skipped' || ++skipped <= ROUTINE_SKIPPED_RUNS_KEPT)
        .slice(0, ROUTINE_RUNS_KEPT)
      await this.write('runs', all)
    })
  }

  updateRun(routineId: string, runId: string, patch: Partial<RoutineRun>): Promise<RoutineRun | null> {
    return this.run('runs', async () => {
      const all = await this.read<Record<string, RoutineRun[]>>('runs', {})
      const rows = all[routineId] ?? []
      const i = rows.findIndex((r) => r.id === runId)
      if (i < 0) return null
      rows[i] = { ...rows[i], ...patch, id: runId, routineId }
      await this.write('runs', all)
      return rows[i]
    })
  }

  /** A change read from the run as stored, in the same write (fn's patch; null leaves it). Null when the run is gone or unchanged. */
  changeRun(routineId: string, runId: string, fn: (r: RoutineRun) => Partial<RoutineRun> | null): Promise<RoutineRun | null> {
    return this.run('runs', async () => {
      const all = await this.read<Record<string, RoutineRun[]>>('runs', {})
      const rows = all[routineId] ?? []
      const i = rows.findIndex((r) => r.id === runId)
      if (i < 0) return null
      const patch = fn(rows[i])
      if (!patch) return null
      rows[i] = { ...rows[i], ...patch, id: runId, routineId }
      // An undefined value drops its key, so a cleared mark is not kept as a key with no value.
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (rows[i] as unknown as Record<string, unknown>)[k]
      await this.write('runs', all)
      return rows[i]
    })
  }

  /** One run as stored, or null. */
  async getRun(routineId: string, runId: string): Promise<RoutineRun | null> {
    return ((await this.runs())[routineId] ?? []).find((r) => r.id === runId) ?? null
  }

  hook(id: string): Promise<HookRecord | null> {
    return this.hooks.hook(id)
  }
  putHook(h: HookRecord): Promise<void> {
    return this.hooks.putHook(h)
  }
  recordCall(id: string, secret: string, call: WebhookCall): Promise<boolean> {
    return this.hooks.recordCall(id, secret, call)
  }
  ensureHook(id: string, makeSecret: () => string, draftAt: number | null): Promise<HookRecord> {
    return this.hooks.ensureHook(id, makeSecret, draftAt)
  }
  rotateSecret(id: string, secret: string): Promise<boolean> {
    return this.hooks.rotateSecret(id, secret)
  }
  clearDraft(id: string): Promise<void> {
    return this.hooks.clearDraft(id)
  }
  dropHook(id: string): Promise<void> {
    return this.hooks.dropHook(id)
  }
  dropStaleDrafts(olderThan: number): Promise<string[]> {
    return this.hooks.dropStaleDrafts(olderThan)
  }

  renameAgent(from: string, to: string): Promise<void> {
    return this.run('routines', async () => {
      const rows = await this.read<Routine[]>('routines', [])
      let changed = false
      for (const r of rows) {
        if (r.target.kind === 'new-chat' && r.target.agent === from) {
          r.target = { ...r.target, agent: to }
          changed = true
        } else if (r.target.kind === 'new-group' && r.target.members.includes(from)) {
          r.target = { ...r.target, members: r.target.members.map((m) => (m === from ? to : m)) }
          changed = true
        }
      }
      if (changed) await this.write('routines', rows)
    })
  }

  async snapshot(): Promise<RoutinesSnapshot> {
    const [routines, all] = await Promise.all([this.list(), this.runs()])
    // A run started before its routine's remove can record itself after it: never show it (or its waiting dot).
    const ids = new Set(routines.map((r) => r.id))
    const runs = Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id)))
    return { routines, runs }
  }
}

// Replaces the row with the same id, else appends it.
function upsert<T extends { id: string }>(rows: T[], row: T): T[] {
  const index = rows.findIndex((x) => x.id === row.id)
  if (index < 0) rows.push(row)
  else rows[index] = row
  return rows
}
