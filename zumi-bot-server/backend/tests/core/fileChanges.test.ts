import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ChatItem } from '@zumibot/shared/types'
import type { FileChange } from '@zumibot/shared/files'
import {
  FileTracker,
  PATCH_MAX_BYTES,
  editAfter,
  patchLines,
  rebuildBefore,
  replaceString,
  type TrackerDeps
} from '../../src/core/files/fileChanges'
import { SNAPSHOT_MAX_BYTES, SnapshotStore } from '../../src/core/files/snapshotStore'
import { diffLines } from '@zumibot/shared/lineDiff'
import { parseLine, type RunEvent } from '../../src/core/chat/streamParser'

const FIX = join(__dirname, '..', 'fixtures', 'stream')
const CHAT = 'chat-1'

let tmp: string
let store: SnapshotStore
let items: ChatItem[]
let log: Mock<(msg: string, err?: unknown) => void>

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'fc-'))
  store = new SnapshotStore(join(tmp, 'snaps'))
  items = []
  log = vi.fn<(msg: string, err?: unknown) => void>()
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

function tracker(over: Partial<TrackerDeps> = {}): FileTracker {
  return new FileTracker({
    cwd: '/work',
    chatId: CHAT,
    snapshots: store,
    now: () => 1234,
    items: () => items,
    readFile: async (p) => fs.readFile(p),
    log,
    ...over
  })
}

async function events(file: string): Promise<RunEvent[]> {
  const text = await fs.readFile(join(FIX, file), 'utf8')
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => parseLine(l))
}

const text = async (id: string | null): Promise<string | null> => (id === null ? null : store.read(CHAT, id))

function toolItem(id: string, changes?: FileChange[]): ChatItem {
  return { type: 'tool', id, name: 'Agent', input: {}, result: null, isError: false, blocked: false, ts: 1, changes }
}

describe('replaceString', () => {
  it('replaces one, all, or refuses', () => {
    expect(replaceString('a b a', 'a', 'x', false)).toBeNull()
    expect(replaceString('a b a', 'a', 'x', true)).toBe('x b x')
    expect(replaceString('abc', 'b', 'B', false)).toBe('aBc')
    expect(replaceString('abc', '', 'B', false)).toBeNull()
    expect(replaceString('abc', '', 'B', true)).toBeNull()
    expect(replaceString('abc', 'z', 'B', true)).toBeNull()
  })
  it('treats $ patterns in the replacement literally', () => {
    expect(replaceString('abc', 'b', '$&$1', false)).toBe('a$&$1c')
  })
})

describe('editAfter', () => {
  it('is the plain replacement, except a mid-line deletion also takes the newline', () => {
    expect(editAfter('abc', 'b', 'B', false)).toBe('aBc')
    expect(editAfter('a\nb\nc\n', 'b', '', false)).toBe('a\nc\n')
    expect(editAfter('a\nb\nc\n', 'b\n', '', false)).toBe('a\nc\n')
    expect(editAfter('ab\n', 'b', '', false)).toBe('a')
    expect(editAfter('a\nb', 'b', '', false)).toBe('a\n') // no newline after: plain
    expect(editAfter('x\nx\n', 'x', '', true)).toBe('')
  })
  it('refuses what the plain replacement refuses', () => {
    expect(editAfter('a b a', 'a', 'x', false)).toBeNull()
    expect(editAfter('abc', 'z', '', false)).toBeNull()
    expect(editAfter('abc', '', 'x', false)).toBeNull()
  })
})

describe('patchLines', () => {
  const h = (oldStart: number, oldLines: number, newStart: number, newLines: number, lines: string[]) => ({
    oldStart,
    oldLines,
    newStart,
    newLines,
    lines
  })
  it('applies hunks in order, keeping the lines between', () => {
    const lines = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(patchLines(lines, [h(2, 1, 2, 1, ['-b', '+B']), h(5, 2, 5, 1, ['-e', ' f'])])).toEqual(['a', 'B', 'c', 'd', 'f'])
    expect(patchLines(lines, [])).toEqual(lines)
  })
  it('handles inserts and deletes at the edges', () => {
    expect(patchLines([], [h(0, 0, 1, 1, ['+x'])])).toEqual(['x'])
    expect(patchLines(['a'], [h(1, 0, 2, 1, ['+x'])])).toEqual(['a', 'x'])
    expect(patchLines(['a', 'b'], [h(1, 2, 0, 0, ['-a', '-b'])])).toEqual([])
  })
  it('ignores a trailing CR when matching and keeps the file line', () => {
    expect(patchLines(['a\r', 'b\r'], [h(1, 2, 1, 2, [' a', '-b', '+B'])])).toEqual(['a\r', 'B'])
  })
  it('gives null when a hunk does not fit', () => {
    expect(patchLines(['a', 'b'], [h(1, 1, 1, 1, ['-z', '+y'])])).toBeNull()
    expect(patchLines(['a', 'b'], [h(5, 1, 5, 1, ['-b', '+y'])])).toBeNull()
    expect(patchLines(['a', 'b'], [h(2, 1, 2, 1, ['-b', '+y']), h(1, 1, 1, 1, ['-a', '+y'])])).toBeNull() // out of order
    expect(patchLines(['a', 'b'], [h(1, 2, 1, 2, ['-a', '+y'])])).toBeNull() // header counts lie
    expect(patchLines(['a'], [h(1, 2, 1, 1, ['-a', '-b'])])).toBeNull() // runs past the end
  })
})

describe('rebuildBefore', () => {
  it('rebuilds from after when the new string is unique', () => {
    expect(rebuildBefore('aBc', { old: 'b', new: 'B', all: false }, null)).toBe('abc')
  })
  it('refuses when the new string is not unique, or empty, or replace_all', () => {
    expect(rebuildBefore('B B', { old: 'b', new: 'B', all: false }, null)).toBeNull()
    expect(rebuildBefore('ac', { old: 'b', new: '', all: false }, null)).toBeNull()
    expect(rebuildBefore('XBX', { old: 'b', new: 'B', all: true }, null)).toBeNull()
  })
  it('prefers a prior copy that the edit turns into after', () => {
    expect(rebuildBefore('B B', { old: 'b', new: 'B', all: false }, 'b B')).toBe('b B')
  })
  it('ignores a prior that does not give after', () => {
    expect(rebuildBefore('aBc', { old: 'b', new: 'B', all: false }, 'zzz')).toBe('abc')
    expect(rebuildBefore('B B', { old: 'b', new: 'B', all: false }, 'zzz')).toBeNull()
  })
  it('refuses a candidate whose old string is not unique', () => {
    // after 'b-B': replacing B by b gives 'b-b', which the edit could not have started from
    expect(rebuildBefore('b-B', { old: 'b', new: 'B', all: false }, null)).toBeNull()
  })
  it('refuses overlapping hits of the new string', () => {
    expect(rebuildBefore('xaaax', { old: 'q', new: 'aa', all: false }, null)).toBeNull()
  })
})

describe('FileTracker.own', () => {
  async function ownFixture() {
    const tools = new Map<string, { id: string; name: string; input: unknown }>()
    const out: { tool: { id: string; name: string; input: unknown }; detail: unknown }[] = []
    for (const e of await events('files-own.jsonl')) {
      if (e.kind === 'toolUse') tools.set(e.id, e)
      if (e.kind === 'toolResult' && tools.has(e.toolUseId)) out.push({ tool: tools.get(e.toolUseId)!, detail: e.detail })
    }
    return out
  }

  it('records an Edit from the recorded result: copies, op and one-hunk patch', async () => {
    const edit = (await ownFixture()).find((x) => x.tool.name === 'Edit')!
    const c = (await tracker().own(edit.tool, edit.detail))!
    expect(c.id).toBe(edit.tool.id)
    expect(c.ts).toBe(1234)
    expect(c.path).toBe('/work/a.txt')
    expect(c.op).toBe('update')
    expect(await text(c.before)).toBe('alpha\nbeta\ngamma\n')
    expect(await text(c.after)).toBe('alpha\nBETA\ngamma\n')
    expect(c.why).toBeUndefined()
    expect(c.patch).toHaveLength(1)
    expect(c.patch![0].lines).toEqual([' alpha', '-beta', '+BETA', ' gamma'])
  })

  it('records a Write create without a before and without a reason', async () => {
    const w = (await ownFixture()).find((x) => x.tool.name === 'Write' && (x.detail as { type: string }).type === 'create')!
    const c = (await tracker().own(w.tool, w.detail))!
    expect(c.op).toBe('create')
    expect(c.path).toBe('/work/b.txt')
    expect(c.before).toBeNull()
    expect(c.why).toBeUndefined()
    expect(c.patch).toBeNull()
    expect(await text(c.after)).toBe('hello')
  })

  it('records a Write update with its originalFile and patch', async () => {
    const w = (await ownFixture()).find((x) => x.tool.name === 'Write' && (x.detail as { type: string }).type === 'update')!
    const c = (await tracker().own(w.tool, w.detail))!
    expect(c.op).toBe('update')
    expect(await text(c.before)).toBe('old body\n')
    expect(await text(c.after)).toBe('new body\n')
    expect(c.patch).toHaveLength(1)
  })

  it('a Write update without originalFile is not-sent, never reverse-patched', async () => {
    const detail = {
      type: 'update',
      filePath: '/work/c.txt',
      content: 'new body\n',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old body', '+new body'] }]
    }
    const c = (await tracker().own({ id: 't1', name: 'Write', input: { file_path: 'c.txt', content: 'new body\n' } }, detail))!
    expect(c.before).toBeNull()
    expect(c.why).toEqual({ before: 'not-sent' })
    expect(await text(c.after)).toBe('new body\n')
  })

  const hunk = (oldStart: number, oldLines: number, newStart: number, newLines: number, lines: string[]) => ({
    oldStart,
    oldLines,
    newStart,
    newLines,
    lines
  })
  const ownEdit = (id: string, input: Obj2, detail: Obj2) => tracker().own({ id, name: 'Edit', input }, detail)
  type Obj2 = Record<string, unknown>

  it('keeps CRLF exactly, and a patch whose lines lack the CR still verifies', async () => {
    const detail = {
      filePath: '/work/w.txt',
      oldString: 'b',
      newString: 'B',
      originalFile: 'a\r\nb\r\nc\r\n',
      replaceAll: false,
      structuredPatch: [hunk(1, 3, 1, 3, [' a', '-b', '+B', ' c'])]
    }
    const c = (await ownEdit('t2', { file_path: '/work/w.txt', old_string: 'b', new_string: 'B' }, detail))!
    expect(await text(c.after)).toBe('a\r\nB\r\nc\r\n')
    expect(await text(c.before)).toBe('a\r\nb\r\nc\r\n')
    expect(c.why).toBeUndefined()
  })

  it("a patch whose lines use spaces for the file's tabs still verifies, and after keeps the tabs", async () => {
    const detail = {
      filePath: '/work/t.txt',
      oldString: '\tb',
      newString: '\tB',
      originalFile: 'a\n\tb\n\tc\n',
      replaceAll: false,
      structuredPatch: [hunk(1, 3, 1, 3, [' a', '-  b', '+  B', '   c'])]
    }
    const c = (await ownEdit('tab1', { file_path: '/work/t.txt', old_string: '\tb', new_string: '\tB' }, detail))!
    expect(await text(c.after)).toBe('a\n\tB\n\tc\n')
    expect(c.why).toBeUndefined()
  })

  it('a space-indented patch that changes different content still has no after', async () => {
    const detail = {
      filePath: '/work/t.txt',
      oldString: '\tb',
      newString: '\tB',
      originalFile: 'a\n\tb\n\tc\n',
      replaceAll: false,
      structuredPatch: [hunk(1, 3, 1, 3, [' a', '-  b', '+  Q', '   c'])]
    }
    const c = (await ownEdit('tab2', { file_path: '/work/t.txt', old_string: '\tb', new_string: '\tB' }, detail))!
    expect(c.after).toBeNull()
    expect(c.why).toEqual({ after: 'unrebuilt' })
  })

  it('a deletion that ends mid-line takes the newline too, as the CLI does, and agrees with the patch', async () => {
    const detail = {
      filePath: '/work/a.txt',
      oldString: 'beta',
      newString: '',
      originalFile: 'alpha\nbeta\ngamma\n',
      replaceAll: false,
      structuredPatch: [hunk(1, 3, 1, 2, [' alpha', '-beta', ' gamma'])]
    }
    const c = (await ownEdit('d1', { file_path: 'a.txt' }, detail))!
    expect(await text(c.after)).toBe('alpha\ngamma\n')
    expect(c.why).toBeUndefined()
  })

  it('a quote-normalised edit, whose strings are not in the file, has no after', async () => {
    const detail = {
      filePath: '/work/a.txt',
      oldString: 'say "hi"',
      newString: 'say "yo"',
      originalFile: 'say “hi”\n',
      replaceAll: false,
      structuredPatch: [hunk(1, 1, 1, 1, ['-say “hi”', '+say “yo”'])]
    }
    const c = (await ownEdit('q1', { file_path: 'a.txt' }, detail))!
    expect(c.after).toBeNull()
    expect(c.why).toEqual({ after: 'unrebuilt' })
    expect(await text(c.before)).toBe('say “hi”\n')
    expect(c.patch).toHaveLength(1)
  })

  it('a replacement that disagrees with the patch has no after', async () => {
    const detail = {
      filePath: '/work/a.txt',
      oldString: 'b',
      newString: 'B',
      originalFile: 'a\nb\nc\n',
      replaceAll: false,
      structuredPatch: [hunk(1, 3, 1, 3, [' a', '-b', '+Q', ' c'])]
    }
    const c = (await ownEdit('x1', { file_path: 'a.txt' }, detail))!
    expect(c.after).toBeNull()
    expect(c.why).toEqual({ after: 'unrebuilt' })
  })

  it('a patch that does not apply to originalFile has no after', async () => {
    const detail = {
      filePath: '/work/a.txt',
      oldString: 'b',
      newString: 'B',
      originalFile: 'a\nb\nc\n',
      replaceAll: false,
      structuredPatch: [hunk(1, 3, 1, 3, [' a', '-z', '+B', ' c'])]
    }
    const c = (await ownEdit('x2', { file_path: 'a.txt' }, detail))!
    expect(c.after).toBeNull()
    expect(c.why).toEqual({ after: 'unrebuilt' })
  })

  it('without a valid patch the replacement stands unverified', async () => {
    const detail = {
      filePath: '/work/a.txt',
      oldString: 'b',
      newString: 'B',
      originalFile: 'a\nb\nc\n',
      replaceAll: false,
      structuredPatch: 'junk'
    }
    const c = (await ownEdit('x3', { file_path: 'a.txt' }, detail))!
    expect(await text(c.after)).toBe('a\nB\nc\n')
    expect(c.patch).toBeNull()
  })

  it('keeps a leading BOM of a subagent-edited file', async () => {
    items = [toolItem('top')]
    const t = tracker({ readFile: async () => Buffer.from('﻿hello B\n', 'utf8') })
    t.subUse({
      kind: 'subToolUse',
      parent: 'top',
      id: 'e1',
      name: 'Edit',
      input: { file_path: 'a.txt', old_string: 'b', new_string: 'B' },
      subagent: null
    })
    const r = (await t.subResult({ kind: 'subToolResult', parent: 'top', toolUseId: 'e1', content: 'ok', isError: false }))!
    expect(await text(r.change.after)).toBe('﻿hello B\n')
    expect(await text(r.change.before)).toBe('﻿hello b\n')
  })

  it('an Edit with no originalFile has neither copy and says why', async () => {
    const detail = { filePath: '/work/big.txt', oldString: 'b', newString: 'B', replaceAll: false }
    const c = (await tracker().own({ id: 't3', name: 'Edit', input: { file_path: '/work/big.txt' } }, detail))!
    expect(c.before).toBeNull()
    expect(c.after).toBeNull()
    expect(c.why).toEqual({ before: 'not-sent', after: 'unrebuilt' })
    expect(c.patch).toBeNull()
  })

  it('an Edit whose strings do not apply to originalFile has no after', async () => {
    const detail = { filePath: '/work/a.txt', oldString: 'zzz', newString: 'B', originalFile: 'abc', replaceAll: false }
    const c = (await tracker().own({ id: 't4', name: 'Edit', input: { file_path: 'a.txt' } }, detail))!
    expect(c.after).toBeNull()
    expect(c.why).toEqual({ after: 'unrebuilt' })
    expect(await text(c.before)).toBe('abc')
  })

  it('falls back to the input strings and honours replace_all', async () => {
    const detail = { filePath: '/work/a.txt', originalFile: 'x x' }
    const c = (await tracker().own(
      { id: 't5', name: 'Edit', input: { file_path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true } },
      detail
    ))!
    expect(await text(c.after)).toBe('y y')
  })

  it('drops a malformed or over-cap structuredPatch', async () => {
    const base = { filePath: '/work/a.txt', oldString: 'b', newString: 'B', originalFile: 'abc', replaceAll: false }
    const t = (id: string, structuredPatch: unknown) =>
      tracker().own({ id, name: 'Edit', input: { file_path: 'a.txt' } }, { ...base, structuredPatch })
    expect((await t('p1', 'nope'))!.patch).toBeNull()
    expect((await t('p2', [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['x'] }]))!.patch).toBeNull()
    expect((await t('p3', [{ oldStart: 1, lines: [' a'] }]))!.patch).toBeNull()
    const big = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+' + 'x'.repeat(PATCH_MAX_BYTES)] }]
    expect((await t('p4', big))!.patch).toBeNull()
  })

  it('gives null for other tools, a non-object detail, a missing path or an unknown Write type', async () => {
    const t = tracker()
    expect(await t.own({ id: 'a', name: 'Read', input: { file_path: 'a' } }, {})).toBeNull()
    expect(await t.own({ id: 'a', name: 'Edit', input: { file_path: 'a' } }, 'x')).toBeNull()
    expect(await t.own({ id: 'a', name: 'Edit', input: { file_path: 'a' } }, [])).toBeNull()
    expect(await t.own({ id: 'a', name: 'Edit', input: {} }, { originalFile: 'a' })).toBeNull()
    expect(await t.own({ id: 'a', name: 'Write', input: { file_path: 'a', content: 'x' } }, { type: 'other', content: 'x' })).toBeNull()
    expect(log).not.toHaveBeenCalled()
  })

  it('a copy that misses sets the matching why', async () => {
    const detail = { filePath: '/work/a.txt', oldString: 'b', newString: 'B', originalFile: 'a\u0000b', replaceAll: false }
    const c = (await tracker().own({ id: 'm', name: 'Edit', input: { file_path: 'a.txt' } }, detail))!
    expect(c.before).toBeNull()
    expect(c.after).toBeNull()
    expect(c.why).toEqual({ before: 'binary', after: 'binary' })
  })

  it('never throws: a failing store gives null and one log without file text', async () => {
    const snapshots = { put: vi.fn().mockRejectedValue(new Error('disk full')), read: vi.fn() }
    const detail = { filePath: '/work/a.txt', oldString: 'SECRET-OLD', newString: 'B', originalFile: 'SECRET-OLD text', replaceAll: false }
    const c = await tracker({ snapshots }).own({ id: 'f', name: 'Edit', input: { file_path: 'a.txt' } }, detail)
    expect(c).toBeNull()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toBe('file change not recorded')
    expect(String(log.mock.calls[0][0])).not.toContain('SECRET')
  })
})

describe('FileTracker subagent', () => {
  async function feed(t: FileTracker, evs: RunEvent[]) {
    const results: ({ itemId: string; change: FileChange } | null)[] = []
    for (const e of evs) {
      if (e.kind === 'subToolUse') t.subUse(e)
      else if (e.kind === 'subToolResult') results.push(await t.subResult(e))
    }
    return results
  }

  it('records the subagent Edit (before rebuilt, patch diffed) and Write (not-sent) under the Agent item', async () => {
    const evs = await events('files-subagent.jsonl')
    const agent = evs.find((e) => e.kind === 'toolUse' && e.name === 'Agent')
    if (agent?.kind !== 'toolUse') throw new Error('no Agent in fixture')
    items = [toolItem(agent.id)]
    await fs.writeFile(join(tmp, 'a.txt'), 'alpha\nBETA\ngamma\n')
    const t = tracker({ readFile: async (p) => fs.readFile(join(tmp, p.replace('/work/', ''))) })
    const results = (await feed(t, evs)).filter((r) => r !== null)
    expect(results).toHaveLength(2)

    const edit = results[0]!
    expect(edit.itemId).toBe(agent.id)
    expect(edit.change.path).toBe('/work/a.txt')
    expect(edit.change.op).toBe('update')
    expect(edit.change.subagent).toBe('general-purpose')
    expect(edit.change.ts).toBe(1234)
    expect(await text(edit.change.before)).toBe('alpha\nbeta\ngamma\n')
    expect(await text(edit.change.after)).toBe('alpha\nBETA\ngamma\n')
    expect(edit.change.patch).toHaveLength(1)
    expect(edit.change.snippet).toBeUndefined()
    expect(edit.change.why).toBeUndefined()

    const write = results[1]!
    expect(write.itemId).toBe(agent.id)
    expect(write.change.path).toBe('/work/c.txt')
    expect(write.change.op).toBe('update')
    expect(write.change.before).toBeNull()
    expect(write.change.why).toEqual({ before: 'not-sent' })
    expect(await text(write.change.after)).toBe('new body')
    expect(write.change.patch).toBeNull()
  })

  it('a Write whose result says created is a create', async () => {
    items = [toolItem('top')]
    const t = tracker()
    t.subUse({ kind: 'subToolUse', parent: 'top', id: 'w1', name: 'Write', input: { file_path: 'n.txt', content: 'hi' }, subagent: null })
    const r = (await t.subResult({
      kind: 'subToolResult',
      parent: 'top',
      toolUseId: 'w1',
      content: 'File created successfully at: /work/n.txt',
      isError: false
    }))!
    expect(r.change.op).toBe('create')
    expect(r.change.why).toBeUndefined()
    expect(r.change.subagent).toBeUndefined()
  })

  it('starts the disk read before the first await', () => {
    items = [toolItem('top')]
    const readFile = vi.fn().mockResolvedValue(Buffer.from('x'))
    const t = tracker({ readFile })
    t.subUse({
      kind: 'subToolUse',
      parent: 'top',
      id: 'e1',
      name: 'Edit',
      input: { file_path: 'a.txt', old_string: 'a', new_string: 'x' },
      subagent: null
    })
    const p = t.subResult({ kind: 'subToolResult', parent: 'top', toolUseId: 'e1', content: 'ok', isError: false })
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledWith('/work/a.txt')
    return p
  })

  it('an unreadable file gives no after, no before, and the strings as a snippet', async () => {
    items = [toolItem('top')]
    const t = tracker({
      readFile: async () => {
        throw new Error('EACCES')
      }
    })
    t.subUse({
      kind: 'subToolUse',
      parent: 'top',
      id: 'e1',
      name: 'Edit',
      input: { file_path: 'a.txt', old_string: 'a', new_string: 'x' },
      subagent: 'sub'
    })
    const r = (await t.subResult({ kind: 'subToolResult', parent: 'top', toolUseId: 'e1', content: 'ok', isError: false }))!
    expect(r.change.after).toBeNull()
    expect(r.change.before).toBeNull()
    expect(r.change.why?.after).toBe('unreadable')
    expect(r.change.patch).toBeNull()
    expect(r.change.snippet).toEqual({ old: 'a', new: 'x' })
    expect(r.change.subagent).toBe('sub')
  })

  it('a binary or over-cap file is marked, not decoded', async () => {
    items = [toolItem('top')]
    const files: Record<string, Buffer> = {
      '/work/n.bin': Buffer.from([0x61, 0, 0x62]),
      '/work/big.txt': Buffer.alloc(1024 * 1024 + 1, 0x61),
      '/work/bad.txt': Buffer.from([0xff, 0xfe, 0x61])
    }
    const t = tracker({ readFile: async (p) => files[p] })
    const why: Record<string, string | undefined> = {}
    for (const name of ['n.bin', 'big.txt', 'bad.txt']) {
      t.subUse({
        kind: 'subToolUse',
        parent: 'top',
        id: name,
        name: 'Edit',
        input: { file_path: name, old_string: 'a', new_string: 'x' },
        subagent: null
      })
      why[name] = (await t.subResult({ kind: 'subToolResult', parent: 'top', toolUseId: name, content: 'ok', isError: false }))!.change.why
        ?.after
    }
    expect(why).toEqual({ 'n.bin': 'binary', 'big.txt': 'too-big', 'bad.txt': 'binary' })
  })

  it('an ambiguous edit leaves before null with unrebuilt but keeps after and the snippet', async () => {
    items = [toolItem('top')]
    const t = tracker({ readFile: async () => Buffer.from('B B') })
    t.subUse({
      kind: 'subToolUse',
      parent: 'top',
      id: 'e1',
      name: 'Edit',
      input: { file_path: 'a.txt', old_string: 'b', new_string: 'B' },
      subagent: null
    })
    const r = (await t.subResult({ kind: 'subToolResult', parent: 'top', toolUseId: 'e1', content: 'ok', isError: false }))!
    expect(await text(r.change.after)).toBe('B B')
    expect(r.change.before).toBeNull()
    expect(r.change.why).toEqual({ before: 'unrebuilt' })
    expect(r.change.patch).toBeNull()
    expect(r.change.snippet).toEqual({ old: 'b', new: 'B' })
  })

  it('uses the newest earlier kept after of the same path as before', async () => {
    const prior = await store.put(CHAT, 'b B')
    if (!('id' in prior)) throw new Error('put')
    const other = await store.put(CHAT, 'other')
    if (!('id' in other)) throw new Error('put')
    const mk = (path: string, after: string): FileChange => ({
      id: path + after,
      ts: 1,
      path,
      op: 'update',
      patch: null,
      before: null,
      after
    })
    items = [toolItem('top'), toolItem('earlier', [mk('/work/a.txt', prior.id), mk('/work/z.txt', other.id)])]
    const t = tracker({ readFile: async () => Buffer.from('B B') })
    t.subUse({
      kind: 'subToolUse',
      parent: 'top',
      id: 'e1',
      name: 'Edit',
      input: { file_path: 'a.txt', old_string: 'b', new_string: 'B' },
      subagent: null
    })
    const r = (await t.subResult({ kind: 'subToolResult', parent: 'top', toolUseId: 'e1', content: 'ok', isError: false }))!
    expect(await text(r.change.before)).toBe('b B')
    expect(r.change.why).toBeUndefined()
    expect(r.change.patch).toHaveLength(1)
  })

  describe('newest prior wins', () => {
    // Either prior turns into 'B B' by the edit b -> B, so the before that comes back tells which one was used.
    const run = async (arrange: (older: string, newer: string, mk: (after: string) => FileChange) => ChatItem[]) => {
      const keep = async (s: string) => {
        const r = await store.put(CHAT, s)
        if (!('id' in r)) throw new Error('put')
        return r.id
      }
      const older = await keep('B b')
      const newer = await keep('b B')
      const mk = (after: string): FileChange => ({ id: after, ts: 1, path: '/work/a.txt', op: 'update', patch: null, before: null, after })
      items = [toolItem('top'), ...arrange(older, newer, mk)]
      const t = tracker({ readFile: async () => Buffer.from('B B') })
      t.subUse({
        kind: 'subToolUse',
        parent: 'top',
        id: 'e1',
        name: 'Edit',
        input: { file_path: 'a.txt', old_string: 'b', new_string: 'B' },
        subagent: null
      })
      const r = (await t.subResult({ kind: 'subToolResult', parent: 'top', toolUseId: 'e1', content: 'ok', isError: false }))!
      return text(r.change.before)
    }
    it('across two items', async () => {
      expect(await run((o, n, mk) => [toolItem('i1', [mk(o)]), toolItem('i2', [mk(n)])])).toBe('b B')
    })
    it('within one item', async () => {
      expect(await run((o, n, mk) => [toolItem('i1', [mk(o), mk(n)])])).toBe('b B')
    })
    it('skips a later change of the same path that kept no after', async () => {
      expect(await run((o, n, mk) => [toolItem('i1', [mk(n)]), toolItem('i2', [{ ...mk(o), after: null }])])).toBe('b B')
    })
  })

  it('resolves a nested subagent call up to the top-level item, and drops an unknown parent', async () => {
    items = [toolItem('top')]
    const t = tracker({ readFile: async () => Buffer.from('xB') })
    t.subUse({ kind: 'subToolUse', parent: 'top', id: 'inner', name: 'Agent', input: {}, subagent: 'a' })
    t.subUse({
      kind: 'subToolUse',
      parent: 'inner',
      id: 'e1',
      name: 'Edit',
      input: { file_path: 'a.txt', old_string: 'b', new_string: 'B' },
      subagent: 'a'
    })
    const r = await t.subResult({ kind: 'subToolResult', parent: 'inner', toolUseId: 'e1', content: 'ok', isError: false })
    expect(r?.itemId).toBe('top')

    t.subUse({
      kind: 'subToolUse',
      parent: 'ghost',
      id: 'e2',
      name: 'Edit',
      input: { file_path: 'a.txt', old_string: 'b', new_string: 'B' },
      subagent: 'a'
    })
    expect(await t.subResult({ kind: 'subToolResult', parent: 'ghost', toolUseId: 'e2', content: 'ok', isError: false })).toBeNull()
  })

  it('does not loop on a cycle of nested calls', async () => {
    items = [toolItem('top')]
    const t = tracker()
    t.subUse({ kind: 'subToolUse', parent: 'y', id: 'x', name: 'Agent', input: {}, subagent: null })
    t.subUse({ kind: 'subToolUse', parent: 'x', id: 'y', name: 'Agent', input: {}, subagent: null })
    t.subUse({ kind: 'subToolUse', parent: 'x', id: 'e1', name: 'Write', input: { file_path: 'a', content: 'c' }, subagent: null })
    expect(await t.subResult({ kind: 'subToolResult', parent: 'x', toolUseId: 'e1', content: 'ok', isError: false })).toBeNull()
  })

  it('ignores errors, unknown ids and malformed ids', async () => {
    items = [toolItem('top')]
    const t = tracker()
    t.subUse({ kind: 'subToolUse', parent: 'top', id: 'e1', name: 'Write', input: { file_path: 'a', content: 'c' }, subagent: null })
    expect(await t.subResult({ kind: 'subToolResult', parent: 'top', toolUseId: 'e1', content: 'boom', isError: true })).toBeNull()
    expect(await t.subResult({ kind: 'subToolResult', parent: 'top', toolUseId: 'nope', content: 'ok', isError: false })).toBeNull()
    t.subUse({ kind: 'subToolUse', parent: '', id: 'e2', name: 'Write', input: { file_path: 'a', content: 'c' }, subagent: null })
    t.subUse({
      kind: 'subToolUse',
      parent: 'top',
      id: undefined as unknown as string,
      name: 'Write',
      input: { file_path: 'a', content: 'c' },
      subagent: null
    })
    expect(await t.subResult({ kind: 'subToolResult', parent: '', toolUseId: 'e2', content: 'ok', isError: false })).toBeNull()
    expect(
      await t.subResult({ kind: 'subToolResult', parent: 'top', toolUseId: undefined as unknown as string, content: 'ok', isError: false })
    ).toBeNull()
    expect(log).not.toHaveBeenCalled()
  })

  it('a failing store gives null and one log without file text', async () => {
    items = [toolItem('top')]
    const snapshots = { put: vi.fn().mockRejectedValue(new Error('disk full')), read: vi.fn() }
    const t = tracker({ snapshots, readFile: async () => Buffer.from('SECRET body') })
    t.subUse({
      kind: 'subToolUse',
      parent: 'top',
      id: 'e1',
      name: 'Edit',
      input: { file_path: 'a.txt', old_string: 'SECRET-OLD', new_string: 'SECRET' },
      subagent: null
    })
    expect(await t.subResult({ kind: 'subToolResult', parent: 'top', toolUseId: 'e1', content: 'ok', isError: false })).toBeNull()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toBe('file change not recorded')
  })
})

describe('FileTracker.ownPatch (Codex ApplyPatch)', () => {
  // The three changes probe check 10 recorded (codex-cli 0.164.0): an update's diff is hunks only, an add's diff is the whole new text, a delete's the whole old text.
  const A_DIFF = '@@ -1,3 +1,3 @@\n line one\n-line two\n+line TWO changed\n line three\n'
  type Ch = { path: string; kind: string; movePath: string | null; diff: string; cut?: boolean }
  const tool = { id: 'p1', name: 'ApplyPatch', input: {} }
  const run = (changes: Ch[], over: Partial<TrackerDeps> = {}) => tracker({ cwd: tmp, ...over }).ownPatch(tool, { codexChanges: changes })
  const at = (name: string) => join(tmp, name)

  it('turns add, update and delete into three changes whose copies are the expected texts', async () => {
    await fs.writeFile(at('a.txt'), 'line one\nline TWO changed\nline three\n')
    await fs.writeFile(at('b.txt'), 'brand new\n')
    const got = await run([
      { path: at('a.txt'), kind: 'update', movePath: null, diff: A_DIFF },
      { path: at('b.txt'), kind: 'add', movePath: null, diff: 'brand new\n' },
      { path: at('c.txt'), kind: 'delete', movePath: null, diff: 'to be deleted\n' }
    ])
    expect(got).toHaveLength(3)
    expect(new Set(got.map((c) => c.id)).size).toBe(3)
    const [upd, add, del] = got
    expect(upd).toMatchObject({ path: at('a.txt'), op: 'update', ts: 1234 })
    expect(await text(upd.before)).toBe('line one\nline two\nline three\n')
    expect(await text(upd.after)).toBe('line one\nline TWO changed\nline three\n')
    expect(upd.why).toBeUndefined()
    expect(upd.patch).toHaveLength(1)
    expect(add).toMatchObject({ path: at('b.txt'), op: 'create', before: null })
    expect(await text(add.after)).toBe('brand new\n')
    expect(add.why).toBeUndefined()
    expect(del).toMatchObject({ path: at('c.txt'), op: 'update', after: null, why: { after: 'deleted' } })
    expect(await text(del.before)).toBe('to be deleted\n')
    expect(del.patch).toEqual([{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-to be deleted'] }])
  })

  it('an add takes its text from the diff, never the disk', async () => {
    const readFile = vi.fn(async () => Buffer.from('other'))
    const [add] = await run([{ path: at('n.txt'), kind: 'add', movePath: null, diff: 'from the diff\n' }], { readFile })
    expect(await text(add.after)).toBe('from the diff\n')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('a cut add reads the file from disk, and a cut delete has no before', async () => {
    await fs.writeFile(at('big.txt'), 'whole file\n')
    const [add, del] = await run([
      { path: at('big.txt'), kind: 'add', movePath: null, diff: 'whole', cut: true },
      { path: at('gone.txt'), kind: 'delete', movePath: null, diff: 'whole', cut: true }
    ])
    expect(await text(add.after)).toBe('whole file\n')
    expect(del.before).toBeNull()
    expect(del.why).toEqual({ before: 'too-big', after: 'deleted' })
  })

  it('an update with a cut diff keeps its after and gives no before (too-big)', async () => {
    await fs.writeFile(at('a.txt'), 'line one\nline TWO changed\nline three\n')
    const [c] = await run([{ path: at('a.txt'), kind: 'update', movePath: null, diff: A_DIFF.slice(0, 20), cut: true }])
    expect(await text(c.after)).toBe('line one\nline TWO changed\nline three\n')
    expect(c.before).toBeNull()
    expect(c.why).toEqual({ before: 'too-big' })
    expect(c.patch).toBeNull()
  })

  it('a move records the change under the new path, reading the file there; the old path gets none', async () => {
    await fs.writeFile(at('new.txt'), 'line one\nline TWO changed\nline three\n')
    const got = await run([{ path: at('old.txt'), kind: 'update', movePath: at('new.txt'), diff: A_DIFF }])
    expect(got).toHaveLength(1)
    expect(got[0].path).toBe(at('new.txt'))
    expect(await text(got[0].before)).toBe('line one\nline two\nline three\n')
    expect(await text(got[0].after)).toBe('line one\nline TWO changed\nline three\n')
  })

  it('a relative path resolves against the cwd', async () => {
    await fs.writeFile(at('r.txt'), 'x\n')
    const [c] = await run([{ path: 'r.txt', kind: 'update', movePath: null, diff: '@@ -1 +1 @@\n-w\n+x\n' }])
    expect(c.path).toBe(at('r.txt'))
    expect(await text(c.before)).toBe('w\n')
  })

  it('an update whose diff does not fit the file keeps after and says unrebuilt', async () => {
    await fs.writeFile(at('a.txt'), 'line one\nsomething else\nline three\n')
    const [c] = await run([{ path: at('a.txt'), kind: 'update', movePath: null, diff: A_DIFF }])
    expect(c.before).toBeNull()
    expect(c.why).toEqual({ before: 'unrebuilt' })
    expect(await text(c.after)).toBe('line one\nsomething else\nline three\n')
  })

  it('an unreadable diff (hunk counts that lie) is unrebuilt, never a guess', async () => {
    await fs.writeFile(at('a.txt'), 'line one\nline TWO changed\nline three\n')
    const [c] = await run([
      { path: at('a.txt'), kind: 'update', movePath: null, diff: '@@ -1,3 +1,3 @@\n line one\n-line two\n+line TWO changed\n' }
    ])
    expect(c.before).toBeNull()
    expect(c.why).toEqual({ before: 'unrebuilt' })
    expect(c.patch).toBeNull()
  })

  it('binary or oversized file gives a null change', async () => {
    await fs.writeFile(at('bin.dat'), Buffer.from([65, 0, 66]))
    await fs.writeFile(at('huge.txt'), 'x'.repeat(1024 * 1024 + 1))
    const [bin, huge] = await run([
      { path: at('bin.dat'), kind: 'update', movePath: null, diff: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: at('huge.txt'), kind: 'update', movePath: null, diff: '@@ -1 +1 @@\n-a\n+b\n' }
    ])
    expect(bin.after).toBeNull()
    expect(bin.why).toMatchObject({ after: 'binary', before: 'unrebuilt' })
    expect(huge.after).toBeNull()
    expect(huge.why).toMatchObject({ after: 'too-big', before: 'unrebuilt' })
  })

  it('a missing file after an update is unreadable', async () => {
    const [c] = await run([{ path: at('nope.txt'), kind: 'update', movePath: null, diff: '@@ -1 +1 @@\n-a\n+b\n' }])
    expect(c.after).toBeNull()
    expect(c.why).toMatchObject({ after: 'unreadable' })
  })

  it('a deleted empty file has no patch, so the panel can say it was deleted', async () => {
    const [del] = await run([{ path: at('empty.txt'), kind: 'delete', movePath: null, diff: '' }])
    expect(await text(del.before)).toBe('')
    expect(del.patch).toBeNull()
    expect(del.why).toEqual({ after: 'deleted' })
  })

  it('a NUL byte in an add or delete diff is a binary copy', async () => {
    const [add, del] = await run([
      { path: at('b.bin'), kind: 'add', movePath: null, diff: 'a\0b' },
      { path: at('c.bin'), kind: 'delete', movePath: null, diff: 'a\0b' }
    ])
    expect(add.after).toBeNull()
    expect(add.why).toEqual({ after: 'binary' })
    expect(del.before).toBeNull()
    expect(del.why).toEqual({ before: 'binary', after: 'deleted' })
  })

  it('starts every disk read before awaiting anything, so a later change cannot alter what was read', async () => {
    const order: string[] = []
    const readFile = vi.fn(async (p: string) => {
      order.push(p)
      return Buffer.from('x\n')
    })
    const pending = run(
      [
        { path: at('1.txt'), kind: 'update', movePath: null, diff: '@@ -1 +1 @@\n-w\n+x\n' },
        { path: at('2.txt'), kind: 'update', movePath: null, diff: '@@ -1 +1 @@\n-w\n+x\n' }
      ],
      { readFile }
    )
    expect(order).toEqual([at('1.txt'), at('2.txt')]) // before the promise is awaited
    await pending
  })

  it('ignores other tools, errors and malformed details; skips malformed entries', async () => {
    const t = tracker({ cwd: tmp })
    expect(await t.ownPatch({ id: 'x', name: 'Edit', input: {} }, { codexChanges: [] })).toEqual([])
    expect(await t.ownPatch(tool, undefined)).toEqual([])
    expect(await t.ownPatch(tool, { codexChanges: 'no' })).toEqual([])
    const got = await t.ownPatch(tool, {
      codexChanges: [null, { path: 5 }, { path: at('ok.txt'), kind: 'add', movePath: null, diff: 'x\n' }]
    })
    expect(got).toHaveLength(1)
  })

  it('one failing change (the snapshot store) is dropped and logged by code only; the others stay', async () => {
    const put = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue({ id: 'abc' })
    const got = await run(
      [
        { path: at('1.txt'), kind: 'add', movePath: null, diff: 'one\n' },
        { path: at('2.txt'), kind: 'add', movePath: null, diff: 'two\n' }
      ],
      { snapshots: { put, read: async () => null } }
    )
    expect(got.map((c) => c.path)).toEqual([at('2.txt')])
    expect(log).toHaveBeenCalledWith('file change not recorded', expect.any(Error))
  })
})

// A Codex subagent's patch (R21): its fileChange arrives as a sub tool use and result under the dispatch, and goes through
// ownPatch with the subagent's name, onto the top-level Agent row, as a Claude subagent's Edit/Write does.
describe('FileTracker.subPatch (a Codex subagent ApplyPatch)', () => {
  const at = (name: string) => join(tmp, name)
  const use = (id: string, parent: string, subagent: string | null): Extract<RunEvent, { kind: 'subToolUse' }> => ({
    kind: 'subToolUse',
    parent,
    id,
    name: 'ApplyPatch',
    input: { changes: [] },
    subagent
  })
  const result = (toolUseId: string, parent: string, changes: unknown, isError = false): Extract<RunEvent, { kind: 'subToolResult' }> => ({
    kind: 'subToolResult',
    parent,
    toolUseId,
    content: 'ok',
    isError,
    detail: { codexChanges: changes }
  })

  it('labels each change with the subagent and lands them on the top-level Agent row, through a nested one too', async () => {
    items = [toolItem('sp1')]
    const t = tracker({ cwd: tmp })
    t.subUse(use('p1', 'sp1', 'helper'))
    const got = t.subPatch(result('p1', 'sp1', [{ path: at('a.txt'), kind: 'add', movePath: null, diff: 'hello\n' }]))!
    expect(got.itemId).toBe('sp1')
    const changes = await got.changes
    expect(changes).toEqual([expect.objectContaining({ id: 'p1:0', path: at('a.txt'), op: 'create', subagent: 'helper' })])
    expect(await text(changes[0].after)).toBe('hello\n')
    // A grandchild's patch, under the child's own dispatch, still lands on the Agent row, with the grandchild's name.
    t.subUse({ kind: 'subToolUse', parent: 'sp1', id: 'sp2', name: 'Agent', input: {}, subagent: 'helper' })
    t.subUse(use('p2', 'sp2', 'grand'))
    const nested = t.subPatch(result('p2', 'sp2', [{ path: at('b.txt'), kind: 'add', movePath: null, diff: 'b\n' }]))!
    expect(nested.itemId).toBe('sp1')
    expect((await nested.changes).map((c) => c.subagent)).toEqual(['grand'])
  })

  it('is null for what is not a remembered patch (a Claude subagent call, an unknown id), and empty for a failed one', async () => {
    items = [toolItem('sp1')]
    const t = tracker({ cwd: tmp })
    t.subUse({
      kind: 'subToolUse',
      parent: 'sp1',
      id: 'e1',
      name: 'Edit',
      input: { file_path: at('x'), old_string: 'a', new_string: 'b' },
      subagent: 'general-purpose'
    })
    expect(t.subPatch({ kind: 'subToolResult', parent: 'sp1', toolUseId: 'e1', content: 'ok', isError: false })).toBeNull()
    expect(t.subPatch(result('never-seen', 'sp1', []))).toBeNull()
    t.subUse(use('p1', 'sp1', 'helper'))
    const failed = t.subPatch(result('p1', 'sp1', [{ path: at('a.txt'), kind: 'add', movePath: null, diff: 'x' }], true))!
    expect(await failed.changes).toEqual([])
    // Each patch is taken once.
    expect(t.subPatch(result('p1', 'sp1', []))).toBeNull()
    // A patch under no Agent row in this turn has nowhere to land.
    t.subUse(use('p3', 'gone', 'helper'))
    expect(t.subPatch(result('p3', 'gone', [{ path: at('c.txt'), kind: 'add', movePath: null, diff: 'c' }]))).toBeNull()
  })
})

describe('FileTracker.ownAcp (an ACP diff: exact before and after)', () => {
  const tool = { id: 'e1', name: 'AcpEdit', input: { paths: [] } }
  const run = (acpDiffs: unknown, over: Partial<TrackerDeps> = {}) => tracker({ cwd: tmp, ...over }).ownAcp(tool, { acpDiffs })
  const at = (name: string) => join(tmp, name)

  it('a whole-file diff (the file on disk is its new text) keeps both texts from the diff, with a patch between them', async () => {
    const readFile = vi.fn(async () => Buffer.from('one\nTWO\n'))
    const got = await run([{ path: at('a.txt'), oldText: 'one\ntwo\n', newText: 'one\nTWO\n' }], { readFile })
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ id: 'e1:0', ts: 1234, path: at('a.txt'), op: 'update' })
    expect(await text(got[0].before)).toBe('one\ntwo\n')
    expect(await text(got[0].after)).toBe('one\nTWO\n')
    expect(got[0].patch).toEqual(diffLines('one\ntwo\n', 'one\nTWO\n'))
    expect(got[0].patch!.flatMap((h) => h.lines)).toEqual(expect.arrayContaining(['-two', '+TWO']))
    expect(got[0].why).toBeUndefined()
    // Read to tell a whole file from a hunk (below).
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  // claude-agent-acp 0.108.0 sends a diff as the file's lines joined by "\n": the whole file, less its last newline.
  const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')

  it("a whole-file diff without the file's last newline: both copies get it back, so Restore's hash check matches the file", async () => {
    const disk = 'one\ntwo\nTHREE\nfour\nfive\n'
    await fs.writeFile(at('f.txt'), disk)
    const got = await run([{ path: at('f.txt'), oldText: 'one\ntwo\nthree\nfour\nfive', newText: 'one\ntwo\nTHREE\nfour\nfive' }])
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ op: 'update', after: sha256(disk) })
    expect(got[0].why).toBeUndefined()
    expect(await text(got[0].after)).toBe(disk)
    expect(await text(got[0].before)).toBe('one\ntwo\nthree\nfour\nfive\n')
    expect(got[0].patch).toEqual(diffLines('one\ntwo\nthree\nfour\nfive\n', disk))
  })

  it('a new file the same way gets its after from the disk, and still no before', async () => {
    await fs.writeFile(at('n.txt'), 'made\n')
    const got = await run([{ path: 'n.txt', oldText: null, newText: 'made' }])
    expect(got[0]).toMatchObject({ op: 'create', before: null, after: sha256('made\n') })
  })

  it('the before gets the newline only when it was written the same way: never to an empty old text, nor across a CR ending', async () => {
    await fs.writeFile(at('e.txt'), 'x\n')
    await fs.writeFile(at('cr.txt'), 'a\r\nb\r\n')
    const got = await run([
      { path: at('e.txt'), oldText: '', newText: 'x' },
      { path: at('cr.txt'), oldText: 'a\nb', newText: 'a\r\nb\r' }
    ])
    expect(await text(got[0].before)).toBe('')
    expect(await text(got[0].after)).toBe('x\n')
    expect(await text(got[1].before)).toBe('a\nb')
    expect(await text(got[1].after)).toBe('a\r\nb\r\n')
  })

  // claude-agent-acp's diff of a longer file is a hunk: the changed lines with three lines of context each side, joined by
  // "\n" (so no last newline), one diff per hunk.
  const numbered = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
  const whole = (ls: string[]) => ls.join('\n') + '\n'
  const hunk = (path: string, old: string[], neu: string[], from: number, to: number) => ({
    path,
    oldText: old.slice(from, to).join('\n'),
    newText: neu.slice(from, to).join('\n')
  })

  it('a hunk of a longer file (one changed line of 20): the disk is the after copy, and the before is rebuilt from it exactly', async () => {
    const after = numbered.map((l, i) => (i === 9 ? 'LINE 10' : l))
    await fs.writeFile(at('h.txt'), whole(after))
    const got = await run([hunk(at('h.txt'), numbered, after, 6, 13)])
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({
      id: 'e1:0',
      path: at('h.txt'),
      op: 'update',
      before: sha256(whole(numbered)),
      after: sha256(whole(after))
    })
    expect(got[0].why).toBeUndefined()
    expect(got[0].snippet).toBeUndefined()
    expect(got[0].patch).toEqual(diffLines(whole(numbered), whole(after)))
  })

  it('two separate changes in one file (two diff entries): one change from one read, rebuilt last hunk first', async () => {
    const after = numbered.map((l, i) => (i === 2 ? 'LINE 3' : i === 16 ? 'LINE 17' : l))
    await fs.writeFile(at('two.txt'), whole(after))
    const readFile = vi.fn((p: string) => fs.readFile(p))
    const got = await run([hunk(at('two.txt'), numbered, after, 0, 6), hunk(at('two.txt'), numbered, after, 13, 20)], { readFile })
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ id: 'e1:0', op: 'update', before: sha256(whole(numbered)), after: sha256(whole(after)) })
    expect(got[0].patch).toEqual(diffLines(whole(numbered), whole(after)))
  })

  it('a hunk whose new text is in the file twice, or not at all, is unrebuilt: the disk as after, no before, no patch, never the fragments as whole files', async () => {
    const pair = numbered.map((l, i) => (i === 1 ? 'LINE 2' : l))
    await fs.writeFile(at('twice.txt'), 'a\nb\nc\na\nb\nc\n')
    await fs.writeFile(at('later.txt'), 'one\nLATER\n')
    await fs.writeFile(at('pair.txt'), whole(pair))
    const got = await run([
      { path: at('twice.txt'), oldText: 'a\nX\nc', newText: 'a\nb\nc' },
      { path: at('later.txt'), oldText: 'one\ntwo', newText: 'one\nTWO' },
      // Of two hunks, the second no longer fits: the change is unrebuilt as a whole.
      hunk(at('pair.txt'), numbered, pair, 0, 5),
      { path: at('pair.txt'), oldText: 'line 19', newText: 'not in the file' }
    ])
    expect(got.map((c) => c.path)).toEqual([at('twice.txt'), at('later.txt'), at('pair.txt')])
    for (const [c, disk] of [
      [got[0], 'a\nb\nc\na\nb\nc\n'],
      [got[1], 'one\nLATER\n'],
      [got[2], whole(pair)]
    ] as const) {
      expect(c).toMatchObject({ op: 'update', before: null, patch: null, why: { before: 'unrebuilt' }, after: sha256(disk) })
    }
    // A lone hunk's strings are what the panel can show, as for a subagent's Edit; several hunks have no one snippet.
    expect(got[0].snippet).toEqual({ old: 'a\nX\nc', new: 'a\nb\nc' })
    expect(got[2].snippet).toBeUndefined()
  })

  it('a lone hunk found twice is rebuilt from an earlier kept copy of the file when the hunk turns it into the disk text', async () => {
    const before = 'a\nX\nc\na\nb\nc\n'
    await fs.writeFile(at('twice.txt'), 'a\nb\nc\na\nb\nc\n')
    const kept = await store.put(CHAT, before)
    items = [
      toolItem('t0', [
        { id: 't0:0', ts: 1, path: at('twice.txt'), op: 'update', patch: null, before: null, after: 'id' in kept ? kept.id : null }
      ])
    ]
    const got = await run([{ path: at('twice.txt'), oldText: 'a\nX\nc', newText: 'a\nb\nc' }])
    expect(got[0]).toMatchObject({ before: sha256(before), after: sha256('a\nb\nc\na\nb\nc\n') })
    expect(got[0].why).toBeUndefined()
  })

  it("a diff whose file cannot be used (binary, too big, gone or unreadable) keeps neither copy, only the hunk's strings", async () => {
    await fs.writeFile(at('bin.txt'), 'one\0\n')
    await fs.mkdir(at('dir.txt'))
    const readFile = async (p: string) => (p.endsWith('big.txt') ? Buffer.alloc(SNAPSHOT_MAX_BYTES + 1, 'x') : fs.readFile(p))
    const sent = (path: string) => ({ path, oldText: 'one\ntwo', newText: 'one\nTWO' })
    const got = await run([sent(at('bin.txt')), sent(at('big.txt')), sent(at('gone.txt')), sent(at('dir.txt'))], { readFile })
    expect(got[0]).toMatchObject({ before: null, after: null, patch: null, why: { before: 'unrebuilt', after: 'binary' } })
    expect(got[1]).toMatchObject({ before: null, after: null, patch: null, why: { before: 'unrebuilt', after: 'too-big' } })
    // Nothing on disk to tell a whole file from a hunk, so neither copy: a 7-line hunk kept as a whole file's before could later
    // be written over the whole file by Restore.
    for (const c of got.slice(2))
      expect(c).toMatchObject({ before: null, after: null, patch: null, why: { before: 'unrebuilt', after: 'unreadable' } })
    for (const c of got) expect(c.snippet).toEqual({ old: 'one\ntwo', new: 'one\nTWO' })
  })

  it('a new file (no oldText) is whole, so it is taken as sent even when the disk cannot tell', async () => {
    const got = await run([{ path: at('gone-new.txt'), oldText: null, newText: 'fresh\n' }])
    expect(got[0]).toMatchObject({ op: 'create', before: null, after: sha256('fresh\n') })
    expect(got[0].why).toBeUndefined()
  })

  it('each file is read before anything is awaited, so it is the file as the edit left it', async () => {
    const readFile = vi.fn(async () => Buffer.from('b\n'))
    const pending = tracker({ cwd: tmp, readFile }).ownAcp(tool, {
      acpDiffs: [
        { path: at('a'), oldText: 'a', newText: 'b' },
        { path: at('c'), oldText: null, newText: 'b' }
      ]
    })
    expect(readFile.mock.calls).toEqual([[at('a')], [at('c')]])
    const got = await pending
    expect(await text(got[0].after)).toBe('b\n')
    expect(await text(got[0].before)).toBe('a\n')
  })

  it("a missing oldText is a new file; a relative path is the chat folder's; several diffs land together", async () => {
    await fs.writeFile(at('c.txt'), 'y')
    const got = await run([
      { path: 'b.txt', oldText: null, newText: 'brand new\n' },
      { path: at('c.txt'), oldText: 'x', newText: 'y' }
    ])
    expect(got.map((c) => c.id)).toEqual(['e1:0', 'e1:1'])
    expect(got[0]).toMatchObject({ path: at('b.txt'), op: 'create', before: null, patch: null })
    expect(await text(got[0].after)).toBe('brand new\n')
    expect(got[1]).toMatchObject({ path: at('c.txt'), op: 'update' })
    expect(await text(got[1].before)).toBe('x')
  })

  it('a text the store cannot keep says why, and gets no patch', async () => {
    await fs.writeFile(at('bin'), 'c')
    const got = await run([{ path: at('bin'), oldText: 'a\0b', newText: 'c' }])
    expect(got[0]).toMatchObject({ before: null, why: { before: 'binary' }, patch: null })
    expect(await text(got[0].after)).toBe('c')
  })

  it('is empty for what is not an ACP edit result', async () => {
    const t = tracker({ cwd: tmp })
    expect(await t.ownAcp({ id: 'x', name: 'Edit', input: {} }, { acpDiffs: [{ path: 'a', oldText: null, newText: 'b' }] })).toEqual([])
    expect(await t.ownAcp(tool, undefined)).toEqual([])
    expect(await t.ownAcp(tool, { acpDiffs: 'no' })).toEqual([])
    // Malformed entries are skipped, the good one kept.
    const got = await t.ownAcp(tool, {
      acpDiffs: [null, { path: 7, newText: 'x' }, { path: 'a', newText: 3 }, { path: 'ok.txt', oldText: null, newText: 'ok' }]
    })
    expect(got.map((c) => c.path)).toEqual([at('ok.txt')])
  })
})
