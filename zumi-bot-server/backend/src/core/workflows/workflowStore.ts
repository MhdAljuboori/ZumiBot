import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  summaryOf,
  WORKFLOW_RUNS_KEPT,
  WORKFLOW_SKIPPED_RUNS_KEPT,
  type Step,
  type Workflow,
  type WorkflowRun,
  type WorkflowsSnapshot
} from '@zumibot/shared/workflows'
import type { WorkflowApproval } from '@zumibot/shared/inbox'
import { renameStepAgent } from '@zumibot/shared/workflowRename'
import { writeFileAtomic } from '../fsutil'
import { HookFile } from '../hooks/hookFile'

type Key = 'workflows' | 'runs'

export class WorkflowStore {
  /** The webhook hooks (`workflow-hooks.json`, 0600); one queue of their own. */
  readonly hooks: HookFile
  private readonly files: Record<Key, string>
  private readonly queues: Record<Key, Promise<unknown>> = { workflows: Promise.resolve(), runs: Promise.resolve() }

  constructor(private readonly dataDir: string) {
    this.files = { workflows: join(dataDir, 'workflows.json'), runs: join(dataDir, 'workflow-runs.json') }
    // Owners are read through the workflows queue (list), so a corrupt-file rename-aside there never races.
    this.hooks = new HookFile(join(dataDir, 'workflow-hooks.json'), async () => (await this.list()).map((w) => w.id))
  }

  private run<T>(key: Key, op: () => Promise<T>): Promise<T> {
    const next = this.queues[key].then(op, op)
    this.queues[key] = next.catch(() => undefined)
    return next
  }

  private async read<T>(key: Key, fallback: T): Promise<T> {
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
      console.error(`workflows: ${file} is not valid JSON, moved aside`) // name only, never contents
      return fallback
    }
    if (key === 'workflows') return (Array.isArray(value) ? value : fallback) as T
    return (value && typeof value === 'object' && !Array.isArray(value) ? value : fallback) as T
  }

  private async write(key: Key, value: unknown): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    await writeFileAtomic(this.files[key], JSON.stringify(value))
  }

  list(): Promise<Workflow[]> {
    return this.run('workflows', async () => this.read('workflows', []))
  }

  get(id: string): Promise<Workflow | null> {
    return this.run('workflows', async () => (await this.read<Workflow[]>('workflows', [])).find((w) => w.id === id) ?? null)
  }

  put(w: Workflow): Promise<void> {
    return this.run('workflows', async () => {
      const rows = await this.read<Workflow[]>('workflows', [])
      const index = rows.findIndex((x) => x.id === w.id)
      if (index < 0) rows.push(w)
      else rows[index] = w
      await this.write('workflows', rows)
    })
  }

  update(id: string, fn: (w: Workflow) => Workflow | null): Promise<Workflow | null> {
    return this.run('workflows', async () => {
      const rows = await this.read<Workflow[]>('workflows', [])
      const index = rows.findIndex((w) => w.id === id)
      if (index < 0) return null
      const updated = fn(rows[index]!)
      if (!updated) return null
      rows[index] = updated
      await this.write('workflows', rows)
      return updated
    })
  }

  /** Adds `make(source, all)` in one step on the queue, so the names it reads are the ones it is added among; null when the source is gone. */
  copy(id: string, make: (source: Workflow, all: Workflow[]) => Workflow): Promise<Workflow | null> {
    return this.run('workflows', async () => {
      const rows = await this.read<Workflow[]>('workflows', [])
      const source = rows.find((w) => w.id === id)
      if (!source) return null
      const made = make(source, rows)
      rows.push(made)
      await this.write('workflows', rows)
      return made
    })
  }

  async remove(id: string): Promise<void> {
    await this.run('workflows', async () => {
      const rows = await this.read<Workflow[]>('workflows', [])
      await this.write(
        'workflows',
        rows.filter((w) => w.id !== id)
      )
    })
    await this.run('runs', async () => {
      const all = await this.read<Record<string, WorkflowRun[]>>('runs', {})
      delete all[id]
      await this.write('runs', all)
    })
    await this.hooks.dropHook(id)
  }

  runs(): Promise<Record<string, WorkflowRun[]>> {
    return this.run('runs', async () => this.read('runs', {}))
  }

  getRun(runId: string): Promise<WorkflowRun | null> {
    return this.run('runs', async () => {
      const all = await this.read<Record<string, WorkflowRun[]>>('runs', {})
      for (const rows of Object.values(all)) {
        const found = rows.find((r) => r.id === runId)
        if (found) return found
      }
      return null
    })
  }

  addRun(run: WorkflowRun): Promise<void> {
    return this.run('runs', async () => {
      const all = await this.read<Record<string, WorkflowRun[]>>('runs', {})
      // Own keys only: an inherited member of the runs map must never read as this workflow's runs.
      const others = (Object.hasOwn(all, run.workflowId) ? all[run.workflowId]! : []).filter((x) => x.id !== run.id)
      let kept = 0
      let skipped = 0
      // Newest first. An unfinished run is never pruned (the engine still writes to it), so it takes a slot without needing one.
      all[run.workflowId] = [run, ...others].filter((x) => {
        if (x.status === 'running' || x.status === 'waiting') {
          kept++
          return true
        }
        if (x.status === 'skipped' && ++skipped > WORKFLOW_SKIPPED_RUNS_KEPT) return false
        return kept++ < WORKFLOW_RUNS_KEPT
      })
      await this.write('runs', all)
    })
  }

  updateRun(runId: string, fn: (r: WorkflowRun) => WorkflowRun | null): Promise<WorkflowRun | null> {
    return this.run('runs', async () => {
      const all = await this.read<Record<string, WorkflowRun[]>>('runs', {})
      for (const rows of Object.values(all)) {
        const i = rows.findIndex((r) => r.id === runId)
        if (i < 0) continue
        const updated = fn(rows[i]!)
        if (!updated) return null
        rows[i] = updated
        await this.write('runs', all)
        return updated
      }
      return null
    })
  }

  renameAgent(from: string, to: string): Promise<void> {
    const rename = (steps: Step[]): boolean => {
      let changed = false
      steps.forEach((s, i) => {
        const r = renameStepAgent(s, from, to)
        if (r) {
          steps[i] = r
          changed = true
        }
      })
      return changed
    }
    return (async () => {
      await this.run('workflows', async () => {
        const rows = await this.read<Workflow[]>('workflows', [])
        let changed = false
        for (const w of rows) if (rename(w.steps)) changed = true
        if (changed) await this.write('workflows', rows)
      })
      await this.run('runs', async () => {
        const all = await this.read<Record<string, WorkflowRun[]>>('runs', {})
        let changed = false
        for (const rows of Object.values(all)) for (const r of rows) if (rename(r.snapshot.steps)) changed = true
        if (changed) await this.write('runs', all)
      })
    })()
  }

  /** Approvals waiting for the user, oldest first. The step is the run's snapshot's, so a later edit never changes what was asked. */
  async waitingApprovals(): Promise<WorkflowApproval[]> {
    const [workflows, all] = await Promise.all([this.list(), this.runs()])
    const names = new Map(workflows.map((w) => [w.id, w.name]))
    const out: WorkflowApproval[] = []
    for (const [workflowId, rows] of Object.entries(all)) {
      const workflowName = names.get(workflowId)
      if (workflowName === undefined) continue // its workflow is gone
      for (const r of rows) {
        if (r.status !== 'waiting') continue
        for (const visit of r.visits) {
          if (visit.status !== 'waiting') continue
          const step = r.snapshot.steps.find((s) => s.id === visit.stepId)
          if (step?.kind === 'approval') out.push({ workflowId, workflowName, runId: r.id, visit, step })
        }
      }
    }
    return out.sort((a, b) => a.visit.startedAt - b.visit.startedAt)
  }

  async snapshot(): Promise<WorkflowsSnapshot> {
    const [workflows, all] = await Promise.all([this.list(), this.runs()])
    // A run started before its workflow's remove can record itself after it: never show it.
    const ids = new Set(workflows.map((w) => w.id))
    const runs = Object.fromEntries(
      Object.entries(all)
        .filter(([id]) => ids.has(id))
        .map(([id, rows]) => [id, rows.map(summaryOf)])
    )
    return { workflows, runs }
  }
}
