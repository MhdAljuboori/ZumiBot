import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { MEMORY_CHANGED, memoryFull, type MemoryInput } from '@zumibot/shared/memory'
import { MemoryStore, isAutoMemoryOff, memoryRoot } from '../../src/core/memory/memoryStore'
import { isWindows, symlinksWork } from '../support/platform'

let tmp: string
let root: string
let trashed: string[]
let logs: string[]
let store: MemoryStore

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-memory-'))
  root = join(tmp, 'agent-memory')
  trashed = []
  logs = []
  store = new MemoryStore({ root, trash: async (p) => void trashed.push(p), log: (l) => void logs.push(l) })
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const opts = { scope: 'user', limit: 100, autoMemoryOff: false }
const input = (o: Partial<MemoryInput> = {}): MemoryInput => ({
  title: 'Never commit',
  description: 'ask first',
  type: 'feedback',
  body: 'Body text',
  ...o
})
const put = async (agent: string, file: string, text: string) => {
  await fs.mkdir(join(root, agent), { recursive: true })
  await fs.writeFile(join(root, agent, file), text)
}
const read = (agent: string, file: string) => fs.readFile(join(root, agent, file), 'utf8')
const mtime = async (agent: string, file: string) => (await fs.lstat(join(root, agent, file))).mtimeMs
const doc = (name: string, desc: string, body = 'b') =>
  `---\nname: ${name}\ndescription: ${desc}\nmetadata:\n  type: user\n---\n\n${body}\n`

describe('memoryRoot / isAutoMemoryOff', () => {
  it('uses CLAUDE_CONFIG_DIR else home/.claude', () => {
    expect(memoryRoot({ CLAUDE_CONFIG_DIR: '/c' }, '/h')).toBe(join('/c', 'agent-memory'))
    expect(memoryRoot({}, '/h')).toBe(join('/h', '.claude', 'agent-memory'))
  })
  it('env, settings and unreadable settings', async () => {
    expect(await isAutoMemoryOff({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, tmp)).toBe(true)
    expect(await isAutoMemoryOff({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: 'TRUE' }, tmp)).toBe(true)
    expect(await isAutoMemoryOff({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }, tmp)).toBe(false)
    expect(await isAutoMemoryOff({}, tmp)).toBe(false)
    await fs.writeFile(join(tmp, 'settings.json'), '{"autoMemoryEnabled": false}')
    expect(await isAutoMemoryOff({}, tmp)).toBe(true)
    await fs.writeFile(join(tmp, 'settings.json'), '{broken')
    expect(await isAutoMemoryOff({}, tmp)).toBe(false)
  })
})

describe('list', () => {
  it('missing root gives an empty list', async () => {
    const l = await store.list('a', opts)
    expect(l).toEqual({ scope: 'user', limit: 100, autoMemoryOff: false, indexLines: 0, entries: [] })
  })
  it('reads plain, CRLF and indexed files with titles and line numbers', async () => {
    await put('a', 'plain.md', 'just text\n')
    await put('a', 'crlf.md', '---\r\nname: crlf\r\ndescription: d\r\n---\r\n\r\nhello\r\n')
    await put('a', 'MEMORY.md', 'intro\n- [Nice Title](crlf.md) — d\n')
    await put('a', 'notes.txt', 'ignored')
    await fs.mkdir(join(root, 'a', 'sub.md'))
    const l = await store.list('a', opts)
    const by = Object.fromEntries(l.entries.map((e) => [e.file, e]))
    expect(Object.keys(by).sort()).toEqual(['crlf.md', 'plain.md'])
    expect(by['crlf.md']).toMatchObject({ title: 'Nice Title', indexLine: 2, description: 'd', body: 'hello' })
    expect(by['plain.md']).toMatchObject({ name: 'plain', body: 'just text\n', type: null })
    expect(by['plain.md'].indexLine).toBe(3)
    expect(by['plain.md'].title).toBe('plain')
    expect(l.indexLines).toBe(3)
    expect(typeof by['plain.md'].modified).toBe('number')
  })
})

describe('index repair', () => {
  it('appends missing lines, keeps other lines byte for byte, idempotent', async () => {
    await put('a', 'one.md', doc('one-name', 'one desc'))
    const before = 'prose line\n\n- [Gone](gone.md) — missing file\n- [One](one.md) — one desc\n'
    await put('a', 'MEMORY.md', before)
    await put('a', 'two.md', doc('two-name', 'two desc'))
    await store.repairIndex('a')
    const after = await read('a', 'MEMORY.md')
    expect(after).toBe(`${before}- [two-name](two.md) — two desc\n`)
    await store.repairIndex('a')
    expect(await read('a', 'MEMORY.md')).toBe(after)
  })
  it('adds a newline only when it appends', async () => {
    await put('a', 'one.md', doc('one', 'd'))
    await put('a', 'MEMORY.md', '- [one](one.md) — d')
    await store.repairIndex('a')
    expect(await read('a', 'MEMORY.md')).toBe('- [one](one.md) — d')
    await put('a', 'two.md', doc('two', 'e'))
    await store.repairIndex('a')
    expect(await read('a', 'MEMORY.md')).toBe('- [one](one.md) — d\n- [two](two.md) — e\n')
  })
  it('list repairs first', async () => {
    await put('a', 'one.md', doc('one', 'd'))
    const l = await store.list('a', opts)
    expect(l.entries[0].indexLine).toBe(1)
    expect(await read('a', 'MEMORY.md')).toBe('- [one](one.md) — d\n')
  })
})

describe('index repair with odd file names', () => {
  it('adds exactly one line each for names with spaces or parens, then nothing', async () => {
    await put('a', 'my notes.md', doc('my-notes', 'd'))
    await put('a', 'a(1).md', doc('a1', 'e'))
    // NTFS cannot hold < or > in a name, so Windows checks the other two alone.
    if (!isWindows) await put('a', 'bad <x> y.md', doc('bad', 'f'))
    await store.repairIndex('a')
    const once = await read('a', 'MEMORY.md')
    expect(once.trim().split('\n')).toHaveLength(2)
    await store.repairIndex('a')
    await store.list('a', opts)
    expect(await read('a', 'MEMORY.md')).toBe(once)
    if (!isWindows) expect(logs.some((l) => l.includes('bad <x> y.md'))).toBe(true)
  })
})

describe('index repair, newlines', () => {
  // NTFS cannot hold a newline in a name.
  it.skipIf(isWindows)('skips a file name with a newline; repair twice adds nothing for it', async () => {
    await put('a', 'a\nb.md', doc('ab', 'd'))
    await put('a', 'ok.md', doc('ok', 'd'))
    await store.repairIndex('a')
    const once = await read('a', 'MEMORY.md')
    await store.repairIndex('a')
    expect(await read('a', 'MEMORY.md')).toBe(once)
    expect(once.trim().split('\n')).toHaveLength(1)
    expect((await store.list('a', opts)).entries.map((e) => e.file)).toEqual(['ok.md'])
  })
  it('a block scalar name becomes one single-line index line, then nothing', async () => {
    await put('a', 'b.md', '---\nname: |\n  two\n  lines\ndescription: d\nmetadata:\n  type: user\n---\n\nb\n')
    await store.repairIndex('a')
    const once = await read('a', 'MEMORY.md')
    expect(once.trim().split('\n')).toHaveLength(1)
    await store.repairIndex('a')
    expect(await read('a', 'MEMORY.md')).toBe(once)
  })
})

describe('save', () => {
  it('create writes <type>_<slug>.md and the index line, creating MEMORY.md', async () => {
    await store.save('a', null, input(), null, 100)
    expect(await read('a', 'feedback_never_commit.md')).toContain('name: never-commit')
    expect(await read('a', 'MEMORY.md')).toBe('- [Never commit](feedback_never_commit.md) — ask first\n')
    await store.save('a', null, input(), null, 100)
    expect((await store.list('a', opts)).entries.map((e) => e.file).sort()).toEqual([
      'feedback_never_commit.md',
      'feedback_never_commit_2.md'
    ])
    expect(await store.count('a')).toBe(2)
  })
  it('create at the limit throws memoryFull', async () => {
    for (let i = 0; i < 100; i++) await put('a', `m${i}.md`, doc(`m${i}`, 'd'))
    await expect(store.save('a', null, input(), null, 100)).rejects.toThrow(memoryFull(100))
    expect(await store.count('a')).toBe(100)
  })
  it('update keeps file name and name:, replaces only its own index line', async () => {
    await store.save('a', null, input(), null, 100)
    await store.save('a', null, input({ title: 'Other' }), null, 100)
    const file = 'feedback_never_commit.md'
    await store.save('a', file, input({ title: 'Renamed title', description: 'new', body: 'New body' }), await mtime('a', file), 100)
    const raw = await read('a', file)
    expect(raw).toContain('name: never-commit')
    expect(raw).toContain('New body')
    expect(await read('a', 'MEMORY.md')).toBe(
      '- [Renamed title](feedback_never_commit.md) — new\n- [Other](feedback_other.md) — ask first\n'
    )
  })
  it('update appends a line when the index has none', async () => {
    await put('a', 'x.md', doc('x', 'd'))
    await put('a', 'MEMORY.md', '')
    await store.save('a', 'x.md', input({ type: 'user' }), await mtime('a', 'x.md'), 100)
    expect(await read('a', 'MEMORY.md')).toBe('- [Never commit](x.md) — ask first\n')
  })
  it('stale modified throws MEMORY_CHANGED and leaves the file', async () => {
    await put('a', 'x.md', doc('x', 'd'))
    const before = await read('a', 'x.md')
    await expect(store.save('a', 'x.md', input(), (await mtime('a', 'x.md')) - 5, 100)).rejects.toThrow(MEMORY_CHANGED)
    await expect(store.save('a', 'x.md', input(), null, 100)).rejects.toThrow(MEMORY_CHANGED)
    expect(await read('a', 'x.md')).toBe(before)
  })
  it('type: create needs one of the four or null; update may keep the file own odd type', async () => {
    await expect(store.save('a', null, input({ type: 'weird' }), null, 100)).rejects.toThrow(
      'type must be user, feedback, project or reference'
    )
    await store.save('a', null, input({ type: null }), null, 100)
    expect(await read('a', 'other_never_commit.md')).not.toContain('type')
    await put('a', 'odd.md', '---\nname: odd\ndescription: d\nmetadata:\n  type: weird\n---\n\nb\n')
    const m = await mtime('a', 'odd.md')
    await expect(store.save('a', 'odd.md', input({ type: 'other' }), m, 100)).rejects.toThrow('type must be')
    await store.save('a', 'odd.md', input({ type: 'weird' }), m, 100)
    expect(await read('a', 'odd.md')).toContain('type: weird')
  })
  it('serializes concurrent creates', async () => {
    await Promise.all([1, 2, 3, 4].map((i) => store.save('a', null, input({ title: `T${i}` }), null, 100)))
    expect((await read('a', 'MEMORY.md')).trim().split('\n')).toHaveLength(4)
  })
})

describe('remove', () => {
  it('trashes the file and drops only its index line', async () => {
    await store.save('a', null, input({ title: 'A' }), null, 100)
    await store.save('a', null, input({ title: 'B' }), null, 100)
    const m = await mtime('a', 'feedback_a.md')
    await store.remove('a', 'feedback_a.md', m)
    expect(trashed).toEqual([join(root, 'a', 'feedback_a.md')])
    expect(await read('a', 'MEMORY.md')).toBe('- [B](feedback_b.md) — ask first\n')
  })
  it('stale modified is refused', async () => {
    await put('a', 'x.md', doc('x', 'd'))
    await expect(store.remove('a', 'x.md', 1)).rejects.toThrow(MEMORY_CHANGED)
    expect(trashed).toEqual([])
  })
})

describe('path safety', () => {
  it('throws before touching disk', async () => {
    await put('a', 'real.md', doc('real', 'd'))
    // A symlink needs Developer Mode or admin on Windows; the other checks run without it.
    if (symlinksWork) await fs.symlink(join(root, 'a', 'real.md'), join(root, 'a', 'link.md'))
    await expect(store.save('a', '../x.md', input(), 1, 100)).rejects.toThrow()
    await expect(store.remove('a', 'MEMORY.md', 1)).rejects.toThrow()
    await expect(store.remove('a', '.hidden.md', 1)).rejects.toThrow()
    if (symlinksWork) await expect(store.save('a', 'link.md', input(), await mtime('a', 'link.md'), 100)).rejects.toThrow()
    if (symlinksWork) await expect(store.remove('a', 'link.md', 1)).rejects.toThrow()
    await expect(store.save('../x', null, input(), null, 100)).rejects.toThrow()
    expect(() => store.dirOf('../x')).toThrow()
    expect(trashed).toEqual([])
    await expect(fs.stat(join(tmp, 'x.md'))).rejects.toThrow()
    await expect(fs.stat(join(tmp, 'x'))).rejects.toThrow()
    // the symlinked file is not listed
    expect((await store.list('a', opts)).entries.map((e) => e.file)).toEqual(['real.md'])
  })
})

describe('moveAgent', () => {
  it('no old folder is a no-op', async () => {
    store.moveAgent('old', 'new')
    await expect(fs.stat(join(root, 'new'))).rejects.toThrow()
  })
  it('no new folder renames', async () => {
    await put('old', 'x.md', doc('x', 'd'))
    store.moveAgent('old', 'new')
    expect(await read('new', 'x.md')).toContain('name: x')
    await expect(fs.stat(join(root, 'old'))).rejects.toThrow()
  })
  it('both exist merges with _2 for clashes, trashes the old folder, is idempotent', async () => {
    await put('old', 'x.md', 'OLD X')
    await put('old', 'y.md', 'OLD Y')
    await put('old', 'MEMORY.md', 'old index')
    await put('new', 'x.md', 'NEW X')
    store.moveAgent('old', 'new')
    expect(await read('new', 'x.md')).toBe('NEW X')
    expect(await read('new', 'x_2.md')).toBe('OLD X')
    expect(await read('new', 'y.md')).toBe('OLD Y')
    expect(await fs.readdir(join(root, 'old'))).toEqual(['MEMORY.md'])
    expect(trashed).toEqual([join(root, 'old')])
    store.moveAgent('old', 'new')
    expect((await fs.readdir(join(root, 'new'))).sort()).toEqual(['x.md', 'x_2.md', 'y.md'])
  })
  it('a failing trash is logged, not thrown', async () => {
    const bad = new MemoryStore({ root, trash: () => Promise.reject(new Error('boom')), log: (l) => void logs.push(l) })
    await put('old', 'x.md', 'a')
    await put('new', 'y.md', 'b')
    bad.moveAgent('old', 'new')
    await vi.waitFor(() => expect(logs.some((l) => l.includes('old'))).toBe(true))
  })
})

describe('trashAgent', () => {
  it('trashes the folder, ignores a missing one', async () => {
    await store.trashAgent('ghost')
    await put('a', 'x.md', 'a')
    await store.trashAgent('a')
    expect(trashed).toEqual([join(root, 'a')])
  })
})

describe('watch', () => {
  it('reports the changed agent once, debounced', async () => {
    const seen: string[] = []
    const stop = store.watch((a) => seen.push(a))
    await put('a', 'x.md', 'a')
    await put('a', 'y.md', 'b')
    await vi.waitFor(() => expect(seen).toContain('a'), { timeout: 2000 })
    expect(seen.filter((s) => s === 'a')).toHaveLength(1)
    stop()
  })
  it('a throwing listener does not escape', async () => {
    const stop = store.watch(() => {
      throw new Error('boom')
    })
    // macOS starts its FSEvents stream asynchronously and drops events from before it runs, so one write right after
    // watch() can go unseen: write again until the listener has run.
    await vi.waitFor(
      async () => {
        await put('a', 'x.md', 'a')
        await new Promise((r) => setTimeout(r, 300))
        expect(logs.some((l) => l.includes('listener failed for a'))).toBe(true)
      },
      { timeout: 4000 }
    )
    stop()
  })
})
