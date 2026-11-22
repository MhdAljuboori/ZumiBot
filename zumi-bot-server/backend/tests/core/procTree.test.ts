import { describe, expect, it } from 'vitest'
import { descendants, parseStat, procIo, ProcTree, type ProcIo, type ProcStat } from '../../src/core/acp/procTree'

// The stat line's fields after the name: state, ppid, pgrp, session, then 15 more up to starttime (field 22).
const line = (pid: number, comm: string, ppid: number, pgid: number, sid: number, start: number) =>
  `${pid} (${comm}) S ${ppid} ${pgid} ${sid} 0 -1 4194304 91 0 0 0 0 0 0 0 20 0 1 0 ${start} 8646656 429 18446744073709551615 0 0`
const p = (pid: number, ppid: number, pgid: number, sid = pgid, start = pid * 10): ProcStat => ({
  pid,
  ppid,
  pgid,
  sid,
  start: String(start)
})

describe('parseStat', () => {
  it('reads pid, ppid, pgid, sid and the start time of a /proc/<pid>/stat line', () => {
    expect(parseStat(line(3096754, 'cat', 3096750, 3096754, 3096750, 5026796))).toEqual({
      pid: 3096754,
      ppid: 3096750,
      pgid: 3096754,
      sid: 3096750,
      start: '5026796'
    })
  })

  it('reads past a name holding spaces and parentheses (fields are read after the last ")")', () => {
    expect(parseStat(line(42, 'a (b) c) d', 7, 40, 39, 99))).toEqual({ pid: 42, ppid: 7, pgid: 40, sid: 39, start: '99' })
  })

  it('is null for a line that does not parse', () => {
    for (const bad of [
      '',
      'garbage',
      '12 (x',
      '12 (x) S',
      'x (y) S 1 2 3 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 5',
      line(12, 'x', 1, 2, 2, 3).replace(' 1 2 ', ' one 2 ')
    ]) {
      expect(parseStat(bad)).toBeNull()
    }
  })
})

describe('descendants', () => {
  const procs = [p(1, 0, 1), p(10, 1, 10), p(11, 10, 10), p(12, 11, 12), p(13, 12, 13), p(20, 1, 20), p(21, 20, 20)]

  it('walks ppid links down from the roots, every depth, roots left out', () => {
    expect(
      descendants([10], procs)
        .map((x) => x.pid)
        .sort()
    ).toEqual([11, 12, 13])
  })

  it('takes several roots, each process once (a root below another root is still left out)', () => {
    expect(
      descendants([10, 11, 20], procs)
        .map((x) => x.pid)
        .sort()
    ).toEqual([12, 13, 21])
  })

  it('is empty for a root with no children or one not in the list', () => {
    expect(descendants([13], procs)).toEqual([])
    expect(descendants([999], procs)).toEqual([])
  })

  it('never loops on a self-parent or a ppid cycle', () => {
    expect(
      descendants([5], [p(5, 5, 5), p(6, 5, 6), p(7, 6, 7), p(6, 7, 6)])
        .map((x) => x.pid)
        .sort()
    ).toEqual([6, 7])
  })
})

// An io over a mutable process table, recording every signal. This process is in it as itself, in group 4242.
function fakeIo(table: ProcStat[] | null) {
  const sent: Array<[number, string]> = []
  const self = p(process.pid, 1, 4242)
  const all = () => (io.table === null ? null : [...io.table, self])
  const io: ProcIo & { table: ProcStat[] | null } = {
    table,
    list: () => all(),
    stat: (pid) => all()?.find((x) => x.pid === pid) ?? null,
    kill: (target, sig) => {
      sent.push([target, sig])
    }
  }
  return { io, sent }
}
const targets = (sent: Array<[number, string]>) => sent.map(([x]) => x).sort((a, b) => a - b)

describe('ProcTree', () => {
  // agent 100 (its own session and group) -> cli 101 (same group) -> shell 102 (its own session) -> sleep 103 (the shell's group)
  const tree = () => [p(1, 0, 1), p(100, 1, 100), p(101, 100, 100), p(102, 101, 102), p(103, 102, 102), p(500, 1, 500)]

  it('signals each descendant once, through its group, and says which groups it reached; never anything outside the tree', () => {
    const { io, sent } = fakeIo(tree())
    const t = new ProcTree(100, io)
    t.snap()
    expect([...t.signal('SIGTERM')].sort()).toEqual([100, 102])
    expect(targets(sent)).toEqual([-102, -100])
    expect(sent.every(([, s]) => s === 'SIGTERM')).toBe(true)
    expect(t.sees).toBe(true)
  })

  it('keeps what it saw once the agent is gone: the reparented shell and sleep are still signalled', () => {
    const { io, sent } = fakeIo(tree())
    const t = new ProcTree(100, io)
    t.snap()
    // The agent and the CLI exited; the shell went to init.
    io.table = [p(1, 0, 1), p(102, 1, 102), p(103, 102, 102), p(500, 1, 500)]
    t.snap()
    t.signal('SIGKILL')
    expect(targets(sent)).toEqual([-102])
  })

  it('finds a child a known process started after the agent died (walked from known processes still alive)', () => {
    const { io, sent } = fakeIo(tree())
    const t = new ProcTree(100, io)
    t.snap()
    io.table = [p(1, 0, 1), p(102, 1, 102), p(103, 102, 102), p(104, 102, 104), p(500, 1, 500)]
    t.snap()
    t.signal('SIGTERM')
    expect(targets(sent)).toEqual([-104, -102])
  })

  it('with no snapshot before the agent died, walks from what is left in its session (a crash): the CLI and its shell', () => {
    const { io, sent } = fakeIo([p(1, 0, 1), p(100, 1, 100)])
    const t = new ProcTree(100, io)
    // The agent crashed: the CLI (still in the agent's session) went to init, with its shell below it.
    io.table = [p(1, 0, 1), p(101, 1, 100), p(102, 101, 102), p(103, 102, 102), p(500, 1, 500)]
    t.snap()
    t.signal('SIGKILL')
    expect(targets(sent)).toEqual([-102, -100])
  })

  it('never signals a pid now held by another process (its start time differs), nor walks from it', () => {
    const { io, sent } = fakeIo(tree())
    const t = new ProcTree(100, io)
    t.snap()
    // 102 and 103 exited and both pids were reused by unrelated processes; 102's new owner has a child of its own.
    io.table = [p(1, 0, 1), p(102, 1, 102, 102, 9999), p(103, 1, 1, 1, 8888), p(600, 102, 102)]
    t.snap()
    t.signal('SIGKILL')
    expect(sent).toEqual([])
  })

  it("never walks from a root, or its session, once its pid is another process's", () => {
    const { io, sent } = fakeIo([p(1, 0, 1), p(100, 1, 100)])
    const t = new ProcTree(100, io)
    io.table = [p(1, 0, 1), p(100, 1, 100, 100, 7777), p(101, 100, 101, 100), p(102, 1, 102, 100)]
    t.snap()
    t.signal('SIGKILL')
    expect(sent).toEqual([])
  })

  it('a process moved to a new group since the snapshot gets its current group signalled', () => {
    const { io, sent } = fakeIo(tree())
    const t = new ProcTree(100, io)
    t.snap()
    io.table = tree().map((x) => (x.pid === 103 ? { ...x, pgid: 103, sid: 103 } : x))
    t.signal('SIGTERM')
    expect(targets(sent)).toContain(-103)
  })

  it('never signals pid or group 0 or 1, its own process or its own group: a process in such a group gets its pid signalled', () => {
    const { io, sent } = fakeIo([p(1, 0, 1), p(100, 1, 100), p(101, 100, 1), p(102, 100, 0), p(103, 100, 4242), p(process.pid, 100, 4242)])
    const t = new ProcTree(100, io)
    t.snap()
    expect(t.signal('SIGKILL').size).toBe(0)
    expect(targets(sent)).toEqual([101, 102, 103])
  })

  it('does nothing where /proc cannot be read, and says it sees nothing', () => {
    const { io, sent } = fakeIo(null)
    const t = new ProcTree(100, io)
    t.snap()
    expect(t.signal('SIGKILL').size).toBe(0)
    expect(sent).toEqual([])
    expect(t.sees).toBe(false)
  })

  // Windows and macOS have no /proc.
  it.skipIf(process.platform !== 'linux')(
    'reads the real /proc: this process is listed with its own stat, and a pid that cannot exist has none',
    () => {
      const me = procIo.stat(process.pid)
      expect(me).toMatchObject({ pid: process.pid, ppid: process.ppid })
      expect(procIo.list()!.some((x) => x.pid === process.pid && x.start === me!.start)).toBe(true)
      expect(procIo.stat(2 ** 31 - 1)).toBeNull()
    }
  )
})
