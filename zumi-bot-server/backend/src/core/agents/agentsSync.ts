import { resolve } from 'node:path'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import type { AgentRename, AgentSummary } from '@zumibot/shared/types'

/** Compares the previous path-to-name map with the current list; a rename is a same-path name change. */
export function detectRenames(
  prev: ReadonlyMap<string, string>,
  list: readonly AgentSummary[]
): { renames: AgentRename[]; next: Map<string, string> } {
  const next = new Map<string, string>()
  for (const s of list) {
    if (s.builtIn) continue
    const path = resolve(s.filePath)
    if (s.error === null) next.set(path, s.name)
    else if (prev.has(path)) next.set(path, prev.get(path)!)
  }
  const names = new Set(next.values())
  const renames: AgentRename[] = []
  for (const [path, name] of next) {
    const old = prev.get(path)
    if (old !== undefined && old !== name && !names.has(old)) renames.push({ from: old, to: name })
  }
  return { renames, next }
}

/** Agents whose file is gone. A file still present but failing to parse keeps its last good name. */
export function detectRemovals(
  known: ReadonlyMap<string, string>,
  list: readonly AgentSummary[]
): { removed: string[]; known: Map<string, string> } {
  const next = new Map<string, string>()
  const present = new Set<string>()
  const held = new Set<string>()
  for (const s of list) {
    if (s.builtIn) {
      held.add(s.name) // never forgotten, even if a stale entry names it
      continue
    }
    const path = resolve(s.filePath)
    present.add(path)
    if (s.error === null) {
      next.set(path, s.name)
      held.add(s.name)
    } else {
      const old = known.get(path)
      if (old !== undefined) next.set(path, old)
    }
  }
  const removed: string[] = []
  for (const [path, name] of known) {
    if (!present.has(path) && !held.has(name) && !removed.includes(name)) removed.push(name)
  }
  return { removed, known: next }
}

export interface AgentsSyncDeps {
  ensureBuiltIn(): Promise<unknown>
  list(): Promise<AgentSummary[]>
  rename(from: string, to: string): Promise<void>
  /** Names whose agent file is gone. */
  removed?(names: string[]): Promise<void>
  /** Names that hold remembered approvals; at start, those no listed agent has go to `removed`. */
  remembered?(): string[]
  notify(renamed: AgentRename[]): void
  onError(err: unknown): void
}

/** Self-heals the built-in agent and moves chats when an agent is renamed outside the app. */
export function createAgentsSync(d: AgentsSyncDeps): { start(): Promise<void>; changed(): Promise<void> } {
  let prev: Map<string, string> = new Map()
  let known: Map<string, string> = new Map()
  let queue: Promise<void> = Promise.resolve()

  const report = (err: unknown): void => {
    try {
      d.onError(err)
    } catch {
      /* a broken reporter must not wedge the queue */
    }
  }
  const ensure = async (): Promise<void> => {
    try {
      await d.ensureBuiltIn()
    } catch (err) {
      report(err)
    }
  }
  const forget = async (names: string[]): Promise<void> => {
    if (!names.length || !d.removed) return
    try {
      await d.removed(names)
    } catch (err) {
      report(err)
    }
  }
  const enqueue = (job: () => Promise<void>): Promise<void> => {
    const run = queue.then(job).catch(report)
    queue = run
    return run
  }

  return {
    start: () =>
      enqueue(async () => {
        await ensure()
        const list = await d.list()
        prev = detectRenames(new Map(), list).next
        known = detectRemovals(new Map(), list).known
        // Agents deleted while the server was off. A broken file's name may not be its agent's, so then none goes.
        if (d.remembered && list.every((s) => s.error === null)) {
          const names = new Set(list.map((s) => s.name))
          await forget(d.remembered().filter((n) => !names.has(n) && n !== ZUMI_BOT_NAME))
        }
      }),
    changed: () =>
      enqueue(async () => {
        await ensure()
        const list = await d.list()
        const { renames, next } = detectRenames(prev, list)
        const done: AgentRename[] = []
        const failed = new Set<string>()
        for (const r of renames) {
          try {
            await d.rename(r.from, r.to)
            done.push(r)
          } catch (err) {
            report(err)
            failed.add(r.from)
            // Keep the old name for this path so the next change retries the rename.
            for (const [path, name] of next) if (name === r.to && prev.get(path) === r.from) next.set(path, r.from)
          }
        }
        prev = next
        const gone = detectRemovals(known, list)
        known = gone.known
        // Startup may have retained unknown mappings while a file was malformed.
        // Once every file is loadable, missing names can finally be detached.
        const names = new Set(list.map((s) => s.name))
        const stale = list.every((s) => s.error === null)
          ? (d.remembered?.() ?? []).filter((n) => !names.has(n) && n !== ZUMI_BOT_NAME && !failed.has(n))
          : []
        await forget([...new Set([...gone.removed, ...stale])])
        d.notify(done)
      })
  }
}
