import type { MemoryStore } from './memoryStore'

type Store = Pick<MemoryStore, 'moveAgent' | 'trashAgent'>

// A running claude keeps its spawn-time --agent name, so its next memory write
// recreates the old folder; the move is applied again when its last turn ends.
export class MemoryTurns {
  private running = new Map<string, number>()
  // Where a running name's folder must end up; null = trash.
  private target = new Map<string, string | null>()

  constructor(private d: { store: Store; log(line: string): void }) {}

  started(agent: string): void {
    // A turn starting under a pending name means the name is live again (a new
    // same-named agent); its folder stays with it rather than risk losing data.
    if (this.target.delete(agent)) this.d.log(`memory: agent ${agent} is live again, pending folder move dropped`)
    this.running.set(agent, (this.running.get(agent) ?? 0) + 1)
  }

  ended(agent: string): void {
    const n = (this.running.get(agent) ?? 0) - 1
    if (n > 0) {
      this.running.set(agent, n)
      return
    }
    this.running.delete(agent)
    if (!this.target.has(agent)) return
    const to = this.target.get(agent) ?? null
    this.target.delete(agent)
    if (to === null) void this.trash(agent)
    else this.move(agent, to)
  }

  renamed(from: string, to: string): void {
    // A chain a->b->c while `a` runs must end at c, so retarget earlier hops.
    for (const [name, t] of this.target) if (t === from) this.target.set(name, to)
    if (this.running.has(from)) this.target.set(from, to)
    // `to` is a live name now (also covers a->b->a).
    this.target.delete(to)
    this.move(from, to)
  }

  async deleted(name: string): Promise<void> {
    for (const [n, t] of this.target) if (t === name) this.target.set(n, null)
    if (this.running.has(name)) this.target.set(name, null)
    await this.trash(name)
  }

  private move(from: string, to: string): void {
    if (from === to) return
    try {
      this.d.store.moveAgent(from, to)
    } catch {
      this.d.log(`memory: moving the folder of agent ${from} failed`)
    }
  }

  private async trash(name: string): Promise<void> {
    try {
      await this.d.store.trashAgent(name)
    } catch {
      this.d.log(`memory: trashing the folder of agent ${name} failed`)
    }
  }
}
