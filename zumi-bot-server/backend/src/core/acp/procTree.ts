import { readdirSync, readFileSync } from 'node:fs'

// The process tree below an ACP agent, so an attempt's end reaches what left the agent's process group: a real agent's tool
// shells run in sessions of their own (claude-agent-acp's Bash calls `setsid`), so a group kill misses them. A process
// reparented to init after its parent died has lost its link, so the tree is snapshotted before anything is signalled, and
// every pid is checked to still be the process seen (its start time) before it is signalled. Linux only: where /proc cannot
// be read, nothing is found and the caller's group kill is all there is. See docs/architecture/protocol-engines.md ("The run").

export interface ProcStat {
  pid: number
  ppid: number
  pgid: number
  sid: number
  start: string
}

export interface ProcIo {
  /** Every process now, or null where /proc cannot be read. */
  list(): ProcStat[] | null
  stat(pid: number): ProcStat | null
  kill(target: number, sig: NodeJS.Signals): void
}

const num = (s: string | undefined): number | null => (s !== undefined && /^-?\d+$/.test(s) ? Number(s) : null)

/** One /proc/<pid>/stat line, or null. The name (field 2) may hold spaces and parentheses, so fields are read after its last ')'. */
export function parseStat(text: string): ProcStat | null {
  const open = text.indexOf(' (')
  const close = text.lastIndexOf(')')
  if (open === -1 || close < open) return null
  const pid = num(text.slice(0, open))
  // After the name: state (field 3), ppid, pgrp, session, …, starttime (field 22).
  const f = text.slice(close + 2).split(' ')
  const ppid = num(f[1]),
    pgid = num(f[2]),
    sid = num(f[3]),
    start = f[19]
  if (pid === null || ppid === null || pgid === null || sid === null || num(start) === null) return null
  return { pid, ppid, pgid, sid, start: start! }
}

/** Every process below the roots by ppid links (the roots left out), each once. */
export function descendants(roots: Iterable<number>, procs: readonly ProcStat[]): ProcStat[] {
  const kids = new Map<number, ProcStat[]>()
  for (const p of procs) {
    if (p.pid === p.ppid) continue
    const list = kids.get(p.ppid)
    if (list) list.push(p)
    else kids.set(p.ppid, [p])
  }
  const seen = new Set<number>(roots)
  const out: ProcStat[] = []
  const queue = [...seen]
  for (let i = 0; i < queue.length; i++) {
    for (const k of kids.get(queue[i]) ?? []) {
      if (seen.has(k.pid)) continue
      seen.add(k.pid)
      out.push(k)
      queue.push(k.pid)
    }
  }
  return out
}

const readStat = (pid: number): ProcStat | null => {
  try {
    return parseStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null // gone, or no /proc
  }
}

/** The real /proc. Reads are synchronous: a snapshot must be whole before the first signal. */
export const procIo: ProcIo = {
  list() {
    let names: string[]
    try {
      names = readdirSync('/proc')
    } catch {
      return null
    }
    const out: ProcStat[] = []
    for (const n of names) {
      if (!/^\d+$/.test(n)) continue
      const s = readStat(Number(n))
      if (s) out.push(s)
    }
    return out
  },
  stat: readStat,
  kill(target, sig) {
    try {
      process.kill(target, sig)
    } catch {
      /* ESRCH: gone; EPERM: not ours to signal */
    }
  }
}

/** One agent's tree: `snap` before each signal, then `signal` reaches every process seen below it, once each. */
export class ProcTree {
  private readonly known = new Map<number, ProcStat>()
  private readonly root: ProcStat | null
  private readonly ownGroup: number | null

  constructor(
    private readonly rootPid: number,
    private readonly io: ProcIo = procIo
  ) {
    // Right after spawn the agent is alive: its start time tells it from a later process given the same pid.
    this.root = io.stat(rootPid)
    this.ownGroup = io.stat(process.pid)?.pgid ?? null
  }

  /** Whether /proc showed the agent at all; without it nothing is ever found, and only the caller's group kill is left. */
  get sees(): boolean {
    return this.root !== null
  }

  /** Adds what now runs below the agent, below each known process that is still the one seen, and in the agent's session. */
  snap(): void {
    const all = this.io.list()
    if (!all) return
    const now = new Map(all.map((p) => [p.pid, p]))
    const same = (seen: ProcStat | null | undefined) => !!seen && now.get(seen.pid)?.start === seen.start
    const roots: number[] = []
    if (same(this.root)) roots.push(this.rootPid)
    for (const k of this.known.values()) if (same(k)) roots.push(k.pid)
    // The agent was spawned as a session leader, and only its descendants can be in that session. A pid stays taken while it
    // names a live session, so with the leader gone every member is the agent's (a crash leaves the CLI there, holding its
    // shells); with the pid now someone else's, none is.
    const leader = now.get(this.rootPid)
    const members =
      this.root && this.root.sid === this.rootPid && (leader === undefined || same(this.root))
        ? all.filter((p) => p.sid === this.rootPid && p.pid !== this.rootPid)
        : []
    for (const m of members) roots.push(m.pid)
    for (const p of [...members, ...descendants(roots, all)]) this.known.set(p.pid, p)
  }

  /**
   * Signals each known process that is still the one seen, once: through its current group, or by its pid when that group
   * may not be signalled (this server's, init's, or 0, "every process"). Returns the groups signalled, so the caller does not
   * signal the agent's own group twice. A group holding a process seen here is that process's, never a reused id: a pid
   * stays taken while it names a live group. Never throws.
   */
  signal(sig: NodeJS.Signals): ReadonlySet<number> {
    const groups = new Set<number>()
    const pids: number[] = []
    for (const k of this.known.values()) {
      if (k.pid <= 1 || k.pid === process.pid || k.pid === this.rootPid) continue
      const now = this.io.stat(k.pid)
      if (!now || now.start !== k.start) continue // gone, or the pid is another process now
      if (now.pgid > 1 && now.pgid !== this.ownGroup) groups.add(now.pgid)
      else pids.push(k.pid)
    }
    for (const g of groups) this.io.kill(-g, sig)
    for (const p of pids) this.io.kill(p, sig)
    return groups
  }
}
