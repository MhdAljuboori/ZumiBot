import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { FileChange, Workflow } from '@zumibot/shared/workflows'
import { FILE_BURST_MAX, FILE_BURST_MS, type WorkflowEvent } from '@zumibot/shared/workflowEvents'
import { FileWatchers, fileBusy, type FileWatchDeps } from '../../src/core/workflows/fileWatchers'

type FileEvent = Extract<WorkflowEvent, { kind: 'file' }>
type Kind = 'rename' | 'change'
interface Watch {
  dir: string
  onChange: (rel: string, type: Kind) => void
  onError: (e: Error) => void
  closed: boolean
}

// The watcher joins paths, so they take the platform's separator: build the expected ones the same way.
let watches: Watch[]
let kinds: Record<string, 'file' | 'dir' | null>
let emitted: { e: FileEvent; id: string }[]
let timers: { fn: () => void; ms: number; cleared: boolean }[]
let logs: string[]
let busy: (id: string) => boolean
let fw: FileWatchers

const wf = (id: string, path: string, over: { pattern?: string; changes?: FileChange[]; enabled?: boolean } = {}): Workflow => ({
  id,
  name: `Name ${id}`,
  enabled: over.enabled ?? true,
  timeZone: 'UTC',
  steps: [],
  edges: [],
  nextRunAt: null,
  createdAt: 0,
  updatedAt: 0,
  trigger: { kind: 'file', path, pattern: over.pattern ?? '', changes: over.changes ?? ['added', 'changed', 'removed'], filters: [] }
})
const open = (): Watch[] => watches.filter((w) => !w.closed)
const fire = async (): Promise<void> => {
  const t = timers.filter((x) => !x.cleared).pop()
  if (!t) throw new Error('no timer armed')
  t.cleared = true
  t.fn()
  await new Promise((r) => setTimeout(r, 0)) // the flush stats in parallel, then emits
}

beforeEach(() => {
  watches = []
  kinds = {}
  emitted = []
  timers = []
  logs = []
  busy = () => false
  const d: FileWatchDeps = {
    watch: (dir, onChange, onError) => {
      const w: Watch = { dir, onChange, onError, closed: false }
      watches.push(w)
      return {
        close: () => {
          w.closed = true
        }
      }
    },
    stat: async (p) => (p in kinds ? kinds[p]! : null),
    emit: (e, id) => {
      emitted.push({ e, id })
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return {
        clear: () => {
          t.cleared = true
        }
      }
    },
    log: (l) => {
      logs.push(l)
    },
    busy: (id) => busy(id)
  }
  fw = new FileWatchers(d)
})

describe('FileWatchers.sync', () => {
  it('opens one watch per enabled file workflow with a path', () => {
    fw.sync([wf('a', '/x'), wf('b', '/y'), wf('c', '/z', { enabled: false }), wf('d', '')])
    expect(
      open()
        .map((w) => w.dir)
        .sort()
    ).toEqual(['/x', '/y'])
  })

  it('keeps a watch for the same path and closes it on a new path, a disable or a delete', () => {
    fw.sync([wf('a', '/x'), wf('b', '/y')])
    fw.sync([wf('a', '/x'), wf('b', '/y')])
    expect(watches).toHaveLength(2)
    fw.sync([wf('a', '/x2'), wf('b', '/y', { enabled: false })])
    expect(
      watches
        .filter((w) => w.closed)
        .map((w) => w.dir)
        .sort()
    ).toEqual(['/x', '/y'])
    expect(open().map((w) => w.dir)).toEqual(['/x2'])
    fw.sync([])
    expect(open()).toHaveLength(0)
  })

  it('ignores non-file workflows', () => {
    fw.sync([{ ...wf('a', '/x'), trigger: { kind: 'manual' } }])
    expect(watches).toHaveLength(0)
  })

  it('stop closes every watch and its timer', () => {
    fw.sync([wf('a', '/x')])
    watches[0]!.onChange('a.txt', 'change')
    fw.stop()
    expect(open()).toHaveLength(0)
    expect(timers.every((t) => t.cleared)).toBe(true)
  })
})

describe('FileWatchers bursts', () => {
  it('collects a burst into one emit, files sorted by absolute path, classified at flush', async () => {
    fw.sync([wf('a', '/x')])
    kinds[join('/x/b.txt')] = 'file'
    kinds[join('/x/a.txt')] = 'file'
    kinds[join('/x/sub/c.txt')] = 'file'
    const w = watches[0]!
    w.onChange('sub/c.txt', 'rename')
    w.onChange('b.txt', 'change')
    w.onChange('a.txt', 'change')
    w.onChange('gone.txt', 'rename') // stat null
    w.onChange('b.txt', 'change')
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBe(FILE_BURST_MS)
    await fire()
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.id).toBe('a')
    expect(emitted[0]!.e).toEqual({
      kind: 'file',
      body: {
        folder: '/x',
        count: 4,
        truncated: false,
        files: [
          { path: join('/x/a.txt'), name: 'a.txt', change: 'changed' },
          { path: join('/x/b.txt'), name: 'b.txt', change: 'changed' },
          { path: join('/x/gone.txt'), name: 'gone.txt', change: 'removed' },
          { path: join('/x/sub/c.txt'), name: 'c.txt', change: 'added' }
        ]
      }
    })
  })

  it('does not re-arm the timer while a burst is open, but arms a fresh one after the flush', async () => {
    fw.sync([wf('a', '/x')])
    kinds[join('/x/a.txt')] = 'file'
    const w = watches[0]!
    w.onChange('a.txt', 'change')
    w.onChange('a.txt', 'change')
    w.onChange('a.txt', 'change')
    expect(timers).toHaveLength(1)
    await fire()
    w.onChange('a.txt', 'change')
    expect(timers).toHaveLength(2)
    await fire()
    expect(emitted).toHaveLength(2)
  })

  it('keeps one timer per workflow', () => {
    fw.sync([wf('a', '/x'), wf('b', '/y')])
    watches[0]!.onChange('a.txt', 'change')
    watches[1]!.onChange('a.txt', 'change')
    expect(timers).toHaveLength(2)
  })

  it('ignores .git and node_modules paths', async () => {
    fw.sync([wf('a', '/x')])
    kinds[join('/x/.git/HEAD')] = 'file'
    kinds[join('/x/node_modules/p/i.js')] = 'file'
    kinds[join('/x/ok.txt')] = 'file'
    const w = watches[0]!
    w.onChange('.git/HEAD', 'change')
    w.onChange('node_modules/p/i.js', 'change')
    expect(timers).toHaveLength(0)
    w.onChange('ok.txt', 'change')
    await fire()
    expect(emitted[0]!.e.body.files.map((f) => f.name)).toEqual(['ok.txt'])
  })

  it('drops directories, applies the name pattern and the changes list', async () => {
    fw.sync([wf('a', '/x', { pattern: '*.pdf', changes: ['added'] })])
    kinds[join('/x/new.pdf')] = 'file'
    kinds[join('/x/old.pdf')] = 'file'
    kinds[join('/x/dir.pdf')] = 'dir'
    kinds[join('/x/a.txt')] = 'file'
    const w = watches[0]!
    w.onChange('new.pdf', 'rename')
    w.onChange('old.pdf', 'change')
    w.onChange('dir.pdf', 'rename')
    w.onChange('a.txt', 'rename')
    w.onChange('gone.pdf', 'rename')
    await fire()
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.e.body).toEqual({
      folder: '/x',
      count: 1,
      truncated: false,
      files: [{ path: join('/x/new.pdf'), name: 'new.pdf', change: 'added' }]
    })
  })

  it('emits nothing when nothing is left', async () => {
    fw.sync([wf('a', '/x', { pattern: '*.pdf' })])
    kinds[join('/x/a.txt')] = 'file'
    watches[0]!.onChange('a.txt', 'change')
    await fire()
    expect(emitted).toHaveLength(0)
  })

  it('caps a burst at FILE_BURST_MAX files, counts every matching file and says the list was cut', async () => {
    fw.sync([wf('a', '/x')])
    const w = watches[0]!
    for (let i = 0; i < 150; i++) {
      const rel = `f${String(i).padStart(3, '0')}.txt`
      kinds[join(`/x/${rel}`)] = 'file'
      w.onChange(rel, 'change')
    }
    await fire()
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.e.body.files).toHaveLength(FILE_BURST_MAX)
    expect(emitted[0]!.e.body.count).toBe(150)
    expect(emitted[0]!.e.body.truncated).toBe(true)
  })

  it('reads a pattern or changes edit at flush time, without reopening the watch', async () => {
    fw.sync([wf('a', '/x')])
    kinds[join('/x/a.txt')] = 'file'
    watches[0]!.onChange('a.txt', 'change')
    fw.sync([wf('a', '/x', { pattern: '*.pdf' })])
    expect(watches).toHaveLength(1)
    await fire()
    expect(emitted).toHaveLength(0)
  })

  it('drops a burst whose workflow was closed before the flush', async () => {
    fw.sync([wf('a', '/x')])
    kinds[join('/x/a.txt')] = 'file'
    watches[0]!.onChange('a.txt', 'change')
    const t = timers[0]!
    fw.sync([])
    expect(t.cleared).toBe(true)
    t.fn()
    await new Promise((r) => setTimeout(r, 0))
    expect(emitted).toHaveLength(0)
  })
})

describe("FileWatchers and the workflow's own runs", () => {
  it('drops a change seen while the workflow is busy, at the moment it is seen', async () => {
    fw.sync([wf('a', '/x'), wf('b', '/y')])
    kinds[join('/x/a.txt')] = 'file'
    kinds[join('/y/b.txt')] = 'file'
    busy = (id) => id === 'a'
    watches[0]!.onChange('a.txt', 'change')
    expect(timers).toHaveLength(0) // nothing kept, so nothing to flush
    watches[1]!.onChange('b.txt', 'change')
    busy = () => false
    await fire()
    expect(emitted.map((x) => x.id)).toEqual(['b'])
  })

  it('a run that ends just before the flush does not start the workflow again; a write past the window does', async () => {
    // The runner's view: a run unfinished from 0 to 11.5 s, and its end remembered for FILE_BURST_MS (app.ts wiring).
    let clock = 0
    let running = true
    let endedAt: number | null = null
    busy = fileBusy({ busy: () => running, endedRecently: (_id, ms) => endedAt !== null && clock - endedAt < ms })
    fw.sync([wf('a', '/x')])
    kinds[join('/x/out.txt')] = 'file'
    clock = 10_000
    watches[0]!.onChange('out.txt', 'change') // the run's own last write
    clock = 11_500
    running = false
    endedAt = clock
    clock = 11_600
    watches[0]!.onChange('out.txt', 'change') // that write's late echo, after the end
    clock = 12_000
    expect(timers).toHaveLength(0)
    expect(emitted).toHaveLength(0)
    clock = 11_500 + FILE_BURST_MS + 100
    watches[0]!.onChange('out.txt', 'change')
    await fire()
    expect(emitted).toHaveLength(1)
  })
})

describe('FileWatchers errors', () => {
  it('closes the watch, logs the workflow name and message only, and reopens on the next sync', () => {
    fw.sync([wf('a', '/x')])
    watches[0]!.onError(new Error('ENOENT: folder gone'))
    expect(watches[0]!.closed).toBe(true)
    expect(logs).toEqual(['file watch failed for Name a: ENOENT: folder gone'])
    fw.sync([wf('a', '/x')])
    expect(open()).toHaveLength(1)
    expect(watches).toHaveLength(2)
  })

  it('a watch that throws on open is logged and retried at the next sync', () => {
    let calls = 0
    const f = new FileWatchers({
      watch: () => {
        calls++
        throw new Error('EACCES')
      },
      stat: async () => null,
      emit: () => undefined,
      setTimer: () => ({ clear: () => undefined }),
      log: (l) => {
        logs.push(l)
      },
      busy: () => false
    })
    f.sync([wf('a', '/x')])
    expect(logs).toEqual(['file watch failed for Name a: EACCES'])
    f.sync([wf('a', '/x')])
    expect(calls).toBe(2)
  })

  it('logs a dead folder once per distinct message however often it syncs, and again once the watch has worked', () => {
    let error: string | null = 'ENOENT: no such file or directory'
    const opened: Watch[] = []
    const f = new FileWatchers({
      watch: (dir, onChange, onError) => {
        if (error) throw new Error(error)
        const w: Watch = { dir, onChange, onError, closed: false }
        opened.push(w)
        return {
          close: () => {
            w.closed = true
          }
        }
      },
      stat: async () => null,
      emit: () => undefined,
      setTimer: () => ({ clear: () => undefined }),
      log: (l) => {
        logs.push(l)
      },
      busy: () => false
    })
    for (let i = 0; i < 3; i++) f.sync([wf('a', '/x')])
    expect(logs).toEqual(['file watch failed for Name a: ENOENT: no such file or directory'])
    error = 'EACCES: permission denied'
    f.sync([wf('a', '/x')])
    f.sync([wf('a', '/x')])
    expect(logs).toHaveLength(2)
    // An error the open watch reports counts the same way.
    error = null
    f.sync([wf('a', '/x')])
    opened[0]!.onError(new Error('EACCES: permission denied'))
    expect(logs).toHaveLength(2)
    f.sync([wf('a', '/x')])
    opened[1]!.onChange('a.txt', 'change') // it works: the next failure is news again
    opened[1]!.onError(new Error('EACCES: permission denied'))
    expect(logs).toHaveLength(3)
  })

  it('logs again for a workflow turned off and back on', () => {
    const f = new FileWatchers({
      watch: () => {
        throw new Error('ENOENT')
      },
      stat: async () => null,
      emit: () => undefined,
      setTimer: () => ({ clear: () => undefined }),
      log: (l) => {
        logs.push(l)
      },
      busy: () => false
    })
    f.sync([wf('a', '/x')])
    f.sync([wf('a', '/x', { enabled: false })])
    f.sync([wf('a', '/x')])
    expect(logs).toEqual(['file watch failed for Name a: ENOENT', 'file watch failed for Name a: ENOENT'])
  })
})
