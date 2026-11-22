import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAgentsSync, detectRemovals, detectRenames } from '../../src/core/agents/agentsSync'
import type { AgentSummary } from '@zumibot/shared/types'

// The sync keys agents by resolved path, which gains a drive letter and backslashes on Windows.
const abs = (p: string): string => resolve(p)

const a = (filePath: string, name: string, over: Partial<AgentSummary> = {}): AgentSummary => ({
  filePath,
  name,
  description: 'd',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...over
})

describe('agentsSync', () => {
  it('detects a name change at the same path', () => {
    const { renames, next } = detectRenames(new Map([[abs('/d/x/x.md'), 'old']]), [a('/d/x/x.md', 'new')])
    expect(renames).toEqual([{ from: 'old', to: 'new' }])
    expect([...next]).toEqual([[abs('/d/x/x.md'), 'new']])
  })

  it('ignores new, removed and moved agents', () => {
    const prev = new Map([
      [abs('/d/a.md'), 'a'],
      [abs('/d/gone.md'), 'gone']
    ])
    expect(detectRenames(prev, [a('/d/b.md', 'a'), a('/d/c.md', 'c')]).renames).toEqual([])
  })

  it('ignores a rename while another agent still has the old name', () => {
    const prev = new Map([[abs('/d/a.md'), 'old']])
    expect(detectRenames(prev, [a('/d/a.md', 'new'), a('/d/b.md', 'old')]).renames).toEqual([])
  })

  it('ignores entries with errors and the built-in agent', () => {
    const prev = new Map([
      [abs('/d/a.md'), 'old'],
      [abs('/d/zumi-bot.md'), 'zumi-bot']
    ])
    const list = [a('/d/a.md', 'a', { error: 'bad' }), a('/d/zumi-bot.md', 'x', { builtIn: true })]
    expect(detectRenames(prev, list).renames).toEqual([])
  })

  it('changed() restores the built-in, moves chats and notifies', async () => {
    const calls: string[] = []
    let list = [a('/d/x/x.md', 'old')]
    const sync = createAgentsSync({
      ensureBuiltIn: async () => {
        calls.push('ensure')
      },
      list: async () => {
        calls.push('list')
        return list
      },
      rename: async (f, t) => {
        calls.push(`rename ${f}->${t}`)
      },
      notify: (r) => {
        calls.push(`notify ${JSON.stringify(r)}`)
      },
      onError: (e) => {
        throw e
      }
    })
    await sync.start()
    list = [a('/d/x/x.md', 'new')]
    await sync.changed()
    expect(calls).toEqual(['ensure', 'list', 'ensure', 'list', 'rename old->new', 'notify [{"from":"old","to":"new"}]'])
  })

  it('changed() runs one call at a time', async () => {
    let active = 0
    let maxActive = 0
    const sync = createAgentsSync({
      ensureBuiltIn: async () => {},
      list: async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
        return []
      },
      rename: async () => {},
      notify: () => {},
      onError: (e) => {
        throw e
      }
    })
    await Promise.all([sync.changed(), sync.changed(), sync.changed()])
    expect(maxActive).toBe(1)
  })

  it('reports an error and keeps running later changes', async () => {
    const errors: unknown[] = []
    const notify = vi.fn()
    let fail = true
    const sync = createAgentsSync({
      ensureBuiltIn: async () => {
        if (fail) throw new Error('EACCES')
      },
      list: async () => [],
      rename: async () => {},
      notify,
      onError: (e) => errors.push(e)
    })
    await sync.changed()
    fail = false
    await sync.changed()
    expect(errors).toHaveLength(1)
    expect(notify).toHaveBeenCalledWith([])
  })
  it('start() still seeds prev when ensureBuiltIn fails', async () => {
    const errors: unknown[] = []
    const notify = vi.fn()
    const rename = vi.fn(async () => {})
    let list = [a('/d/x/x.md', 'old')]
    const sync = createAgentsSync({
      ensureBuiltIn: async () => {
        throw new Error('EACCES')
      },
      list: async () => list,
      rename,
      notify,
      onError: (e) => errors.push(e)
    })
    await sync.start()
    list = [a('/d/x/x.md', 'new')]
    await sync.changed()
    expect(errors).toHaveLength(2)
    expect(rename).toHaveBeenCalledWith('old', 'new')
    expect(notify).toHaveBeenCalledWith([{ from: 'old', to: 'new' }])
  })

  it('changed() with a failing ensureBuiltIn still lists, renames and notifies', async () => {
    const errors: unknown[] = []
    const notify = vi.fn()
    const rename = vi.fn(async () => {})
    let list = [a('/d/x/x.md', 'old')]
    const sync = createAgentsSync({
      ensureBuiltIn: async () => {
        throw new Error('EACCES')
      },
      list: async () => list,
      rename,
      notify,
      onError: (e) => errors.push(e)
    })
    await sync.start()
    list = [a('/d/x/x.md', 'new')]
    await sync.changed()
    expect(rename).toHaveBeenCalledWith('old', 'new')
    expect(notify).toHaveBeenCalledWith([{ from: 'old', to: 'new' }])
  })

  it('a throwing rename is reported, notify still fires with the successes, and the failure retries', async () => {
    const errors: unknown[] = []
    const notify = vi.fn()
    let failB = true
    const rename = vi.fn(async (f: string) => {
      if (f === 'b' && failB) throw new Error('boom')
    })
    let list = [a('/d/a.md', 'a'), a('/d/b.md', 'b')]
    const sync = createAgentsSync({
      ensureBuiltIn: async () => {},
      list: async () => list,
      rename,
      notify,
      onError: (e) => errors.push(e)
    })
    await sync.start()
    list = [a('/d/a.md', 'a2'), a('/d/b.md', 'b2')]
    await sync.changed()
    expect(errors).toHaveLength(1)
    expect(notify).toHaveBeenLastCalledWith([{ from: 'a', to: 'a2' }])
    failB = false
    await sync.changed()
    expect(notify).toHaveBeenLastCalledWith([{ from: 'b', to: 'b2' }])
  })

  it('a throwing onError does not wedge later calls', async () => {
    const notify = vi.fn()
    let fail = true
    const sync = createAgentsSync({
      ensureBuiltIn: async () => {},
      list: async () => {
        if (fail) throw new Error('x')
        return []
      },
      rename: async () => {},
      notify,
      onError: () => {
        throw new Error('onError broke')
      }
    })
    await expect(sync.changed()).resolves.toBeUndefined()
    fail = false
    await sync.changed()
    expect(notify).toHaveBeenCalledWith([])
  })

  describe('detectRemovals', () => {
    it('reports a name whose path left the list', () => {
      const r = detectRemovals(
        new Map([
          [abs('/d/gone.md'), 'gone'],
          [abs('/d/a.md'), 'a']
        ]),
        [a('/d/a.md', 'a')]
      )
      expect(r.removed).toEqual(['gone'])
      expect([...r.known]).toEqual([[abs('/d/a.md'), 'a']])
    })

    it('keeps the last good name for a present file that fails to parse', () => {
      const r = detectRemovals(new Map([[abs('/d/a.md'), 'a']]), [a('/d/a.md', 'broken', { error: 'bad' })])
      expect(r.removed).toEqual([])
      expect([...r.known]).toEqual([[abs('/d/a.md'), 'a']])
    })

    it('does not add a new errored entry', () => {
      expect([...detectRemovals(new Map(), [a('/d/n.md', 'n', { error: 'bad' })]).known]).toEqual([])
    })

    it('keeps a name another file now holds', () => {
      const r = detectRemovals(new Map([[abs('/d/a.md'), 'x']]), [a('/d/b.md', 'x')])
      expect(r.removed).toEqual([])
    })

    it('never removes the built-in', () => {
      const r = detectRemovals(new Map([[abs('/d/b.md'), 'zumi-bot']]), [a('/d/b.md', 'zumi-bot', { builtIn: true })])
      expect(r.removed).toEqual([])
      expect([...r.known]).toEqual([])
    })
  })

  it('changed() calls removed with the names of deleted files only', async () => {
    let list = [a('/d/gone.md', 'gone'), a('/d/x.md', 'x')]
    const removed = vi.fn(async () => {})
    const sync = createAgentsSync({
      ensureBuiltIn: async () => {},
      list: async () => list,
      rename: async () => {},
      notify: () => {},
      removed,
      onError: (e) => {
        throw e
      }
    })
    await sync.start()
    list = [a('/d/x.md', 'x', { error: 'bad frontmatter' })]
    await sync.changed()
    expect(removed).toHaveBeenCalledTimes(1)
    expect(removed).toHaveBeenCalledWith(['gone'])
  })

  it("start() forgets rules of agents deleted while the server was off, never Zumi Bot's", async () => {
    const removed = vi.fn(async () => {})
    const sync = createAgentsSync({
      // The built-in failed to restore, so Zumi Bot is not listed: its rules still stay.
      ensureBuiltIn: async () => {},
      list: async () => [a('/d/x.md', 'x')],
      rename: async () => {},
      notify: () => {},
      removed,
      remembered: () => ['x', 'gone', 'zumi-bot'],
      onError: (e) => {
        throw e
      }
    })
    await sync.start()
    expect(removed).toHaveBeenCalledTimes(1)
    expect(removed).toHaveBeenCalledWith(['gone'])
  })

  it('start() forgets nothing while a listed file is broken', async () => {
    const removed = vi.fn(async () => {})
    const sync = createAgentsSync({
      ensureBuiltIn: async () => {},
      list: async () => [a('/d/x.md', 'x'), a('/d/y.md', 'y', { error: 'bad' })],
      rename: async () => {},
      notify: () => {},
      removed,
      remembered: () => ['x', 'gone'],
      onError: (e) => {
        throw e
      }
    })
    await sync.start()
    expect(removed).not.toHaveBeenCalled()
  })

  it('start() writes nothing when every remembered agent is listed', async () => {
    const removed = vi.fn(async () => {})
    const sync = createAgentsSync({
      ensureBuiltIn: async () => {},
      list: async () => [a('/d/x.md', 'x')],
      rename: async () => {},
      notify: () => {},
      removed,
      remembered: () => ['x'],
      onError: (e) => {
        throw e
      }
    })
    await sync.start()
    expect(removed).not.toHaveBeenCalled()
  })

  it('changed() does not call removed for a broken frontmatter alone', async () => {
    let list = [a('/d/x.md', 'x')]
    const removed = vi.fn(async () => {})
    const sync = createAgentsSync({
      ensureBuiltIn: async () => {},
      list: async () => list,
      rename: async () => {},
      notify: () => {},
      removed,
      onError: (e) => {
        throw e
      }
    })
    await sync.start()
    list = [a('/d/x.md', 'x', { error: 'bad' })]
    await sync.changed()
    expect(removed).not.toHaveBeenCalled()
  })
})

it('preserves a browser agent name through a malformed file so a later external rename still moves its profile', async () => {
  let list = [a('/d/helper.md', 'helper')]
  const rename = vi.fn(async () => {})
  const removed = vi.fn(async () => {})
  const sync = createAgentsSync({
    ensureBuiltIn: async () => {},
    list: async () => list,
    rename,
    removed,
    remembered: () => ['helper'],
    notify: () => {},
    onError: (e) => {
      throw e
    }
  })
  await sync.start()
  list = [a('/d/helper.md', 'helper', { error: 'Malformed frontmatter' })]
  await sync.changed()
  expect(removed).not.toHaveBeenCalled()
  list = [a('/d/helper.md', 'renamed')]
  await sync.changed()
  expect(rename).toHaveBeenCalledWith('helper', 'renamed')
})

it('reconciles preserved browser mappings after a startup-malformed file is actually deleted', async () => {
  let list = [a('/d/mismatched-file.md', 'mismatched-file', { error: 'Malformed frontmatter' })]
  const removed = vi.fn(async () => {})
  const sync = createAgentsSync({
    ensureBuiltIn: async () => {},
    list: async () => list,
    rename: async () => {},
    removed,
    remembered: () => ['canonical-agent-name'],
    notify: () => {},
    onError: (e) => {
      throw e
    }
  })
  await sync.start()
  expect(removed).not.toHaveBeenCalled()
  list = []
  await sync.changed()
  expect(removed).toHaveBeenCalledWith(['canonical-agent-name'])
})
