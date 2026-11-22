import { describe, expect, it } from 'vitest'
import {
  MISS_TEXT,
  diffRows,
  diffSource,
  explainFileText,
  filesCount,
  idsOf,
  isTextAttachment,
  looksBinary,
  neededIds,
  quoteBlock,
  rowsFromHunks,
  rowsFromStrings,
  rowsFromTexts,
  rowsOfText,
  restoreButton,
  restoredText,
  selectedLines,
  sidesOf,
  splitPath,
  stepLabel,
  viewRows,
  whoLabel,
  withFileQuote,
  type Row
} from '../src/state/filesPanel'
import { RESTORE_REFUSALS } from '@zumibot/shared/fileRestore'
import { diffLines } from '@zumibot/shared/lineDiff'
import { fromMarkdown } from '../src/state/composerMarkdown'
import type { ChangedFile, ChangeStep, PatchHunk } from '@zumibot/shared/files'

const step = (over: Partial<ChangeStep> = {}): ChangeStep => ({
  itemId: 'i',
  id: 's',
  ts: 1,
  op: 'update',
  patch: null,
  before: null,
  after: null,
  ...over
})
const file = (changes: ChangeStep[], created = false): ChangedFile => ({ path: '/p/a.md', shown: 'a.md', created, changes })
const lbl = (i: number): string => `Step ${i + 1}`

describe('MISS_TEXT', () => {
  it('has the exact copy', () => {
    expect(MISS_TEXT).toEqual({
      created: 'File did not exist before this chat',
      'too-big': 'Not kept: file over 1 MB',
      binary: 'Not kept: binary file',
      'not-sent': "Not kept: Claude Code didn't send this version",
      unrebuilt: "Not kept: couldn't rebuild this version exactly",
      unreadable: "Not kept: couldn't read the file after the change",
      deleted: 'File was deleted by this change',
      legacy: 'Not kept for changes made before this feature'
    })
  })
})

describe('sidesOf', () => {
  it('uses the ids of a recorded update', () => {
    expect(sidesOf(file([step({ before: 'b1', after: 'a1' })]), 0)).toEqual({ before: { id: 'b1' }, after: { id: 'a1' } })
  })
  it('says a created file had no before', () => {
    expect(sidesOf(file([step({ op: 'create', after: 'a1' })], true), 0)).toEqual({ before: { miss: 'created' }, after: { id: 'a1' } })
  })
  it('names why a side is missing', () => {
    const s = step({ why: { before: 'too-big', after: 'binary' } })
    expect(sidesOf(file([s]), 0)).toEqual({ before: { miss: 'too-big' }, after: { miss: 'binary' } })
  })
  it('falls back to legacy for an unrecorded side', () => {
    const s = step({ op: 'unknown', legacy: { oldString: 'a', newString: 'b' } })
    expect(sidesOf(file([s]), 0)).toEqual({ before: { miss: 'legacy' }, after: { miss: 'legacy' } })
  })
  it('gives a legacy Write its content as the after text', () => {
    const s = step({ op: 'unknown', legacy: { content: 'hello' } })
    expect(sidesOf(file([s]), 0)).toEqual({ before: { miss: 'legacy' }, after: { text: 'hello' } })
  })
  it('takes the first before and the last after for all', () => {
    const f = file([step({ before: 'b1', after: 'a1' }), step({ before: 'a1', after: 'a2' })])
    expect(sidesOf(f, 'all')).toEqual({ before: { id: 'b1' }, after: { id: 'a2' } })
  })
})

describe('diffSource', () => {
  const hunks: PatchHunk[] = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]

  it("gives a file with one change that change's own source for All changes", () => {
    const one = file([step({ patch: hunks, before: 'b', after: 'a' })])
    expect(diffSource(one, 'all', lbl)).toEqual(diffSource(one, 0, lbl))
    expect(diffSource(one, 'all', lbl)).toEqual({ kind: 'patch', hunks })
    const miss = file([step({ op: 'update', why: { after: 'unrebuilt' } })])
    expect(diffSource(miss, 'all', lbl)).toEqual(diffSource(miss, 0, lbl))
  })

  it('prefers the patch of one step', () => {
    expect(diffSource(file([step({ patch: hunks, before: 'b', after: 'a' })]), 0, lbl)).toEqual({ kind: 'patch', hunks })
  })
  it('diffs the texts when both snapshots exist and there is no patch', () => {
    expect(diffSource(file([step({ before: 'b', after: 'a' })]), 0, lbl)).toEqual({
      kind: 'texts',
      before: { id: 'b' },
      after: { id: 'a' }
    })
  })
  it('uses the snippet strings when a snapshot is missing', () => {
    const s = step({ snippet: { old: 'x', new: 'y' }, why: { before: 'too-big' } })
    expect(diffSource(file([s]), 0, lbl)).toEqual({ kind: 'strings', old: 'x', new: 'y' })
  })
  it('uses the strings of a legacy Edit', () => {
    const s = step({ op: 'unknown', legacy: { oldString: 'x', newString: 'y' } })
    expect(diffSource(file([s]), 0, lbl)).toEqual({ kind: 'strings', old: 'x', new: 'y' })
  })
  it('falls back to texts so the component shows the miss', () => {
    expect(diffSource(file([step({ op: 'unknown', legacy: { content: 'c' } })]), 0, lbl)).toEqual({
      kind: 'texts',
      before: { miss: 'legacy' },
      after: { text: 'c' }
    })
  })
  it('diffs first before against last after for all', () => {
    const f = file([step({ before: 'b1', after: 'a1' }), step({ before: 'a1', after: 'a2' })])
    expect(diffSource(f, 'all', lbl)).toEqual({ kind: 'texts', before: { id: 'b1' }, after: { id: 'a2' } })
  })
  it('accepts a created first step for all', () => {
    const f = file([step({ op: 'create', after: 'a1' }), step({ before: 'a1', after: 'a2' })], true)
    expect(diffSource(f, 'all', lbl)).toEqual({ kind: 'texts', before: { miss: 'created' }, after: { id: 'a2' } })
  })
  it('lists each step when the ends are not usable', () => {
    const f = file([step({ patch: hunks, why: { before: 'too-big' } }), step({ before: 'a1', after: 'a2' })])
    expect(diffSource(f, 'all', lbl)).toEqual({
      kind: 'steps',
      parts: [
        { label: 'Step 1', source: { kind: 'patch', hunks } },
        { label: 'Step 2', source: { kind: 'texts', before: { id: 'a1' }, after: { id: 'a2' } } }
      ]
    })
  })
  it('shows a Write update with equal snapshots as texts, which have no changes', () => {
    const src = diffSource(file([step({ before: 'same', after: 'same' })]), 0, lbl)
    expect(src).toEqual({ kind: 'texts', before: { id: 'same' }, after: { id: 'same' } })
    expect(rowsFromHunks(diffLines('x\ny\n', 'x\ny\n'))).toEqual([{ kind: 'same', text: 'No changes' }])
  })
})

describe('rows', () => {
  it('numbers the lines of a hunk', () => {
    const h: PatchHunk = { oldStart: 4, oldLines: 3, newStart: 4, newLines: 3, lines: [' a', '-b', '+c', ' d'] }
    expect(rowsFromHunks([h])).toEqual([
      { kind: 'hunk', text: '@@ -4,3 +4,3 @@' },
      { kind: 'ctx', text: 'a', oldNo: 4, newNo: 4 },
      { kind: 'del', text: 'b', oldNo: 5, newNo: null },
      { kind: 'add', text: 'c', oldNo: null, newNo: 5 },
      { kind: 'ctx', text: 'd', oldNo: 6, newNo: 6 }
    ])
  })
  it('says no changes for no hunks', () => {
    expect(rowsFromHunks([])).toEqual([{ kind: 'same', text: 'No changes' }])
  })
  it('numbers an added-only hunk from its new start', () => {
    const h: PatchHunk = { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }
    expect(rowsFromHunks([h]).slice(1)).toEqual([
      { kind: 'add', text: 'a', oldNo: null, newNo: 1 },
      { kind: 'add', text: 'b', oldNo: null, newNo: 2 }
    ])
  })
  it('shows strings with no line numbers', () => {
    expect(rowsFromStrings('a\nb', 'a\nc')).toEqual([
      { kind: 'ctx', text: 'a', oldNo: null, newNo: null },
      { kind: 'del', text: 'b', oldNo: null, newNo: null },
      { kind: 'add', text: 'c', oldNo: null, newNo: null }
    ])
    expect(rowsFromStrings('a', 'a')).toEqual([{ kind: 'same', text: 'No changes' }])
  })
  it('numbers a whole text for the old or new view', () => {
    expect(rowsOfText('a\nb\n', 'old')).toEqual([
      { kind: 'ctx', text: 'a', oldNo: 1, newNo: null },
      { kind: 'ctx', text: 'b', oldNo: 2, newNo: null }
    ])
    expect(rowsOfText('a', 'new')).toEqual([{ kind: 'ctx', text: 'a', oldNo: null, newNo: 1 }])
  })
  it('keeps the \\r of a CRLF line', () => {
    const rows = rowsOfText('a\r\nb', 'new') as Extract<Row, { newNo: number | null }>[]
    expect(rows.map((r) => [r.text, r.newNo])).toEqual([
      ['a\r', 1],
      ['b', 2]
    ])
  })
})

describe('selectedLines', () => {
  const diff: Row[] = [
    { kind: 'ctx', text: 'a', oldNo: 4, newNo: 4 },
    { kind: 'del', text: 'b', oldNo: 5, newNo: null },
    { kind: 'add', text: 'c', oldNo: null, newNo: 5 },
    { kind: 'ctx', text: 'd', oldNo: 6, newNo: 6 }
  ]
  it('uses the new numbers when the selection reaches a numbered new line', () => {
    expect(selectedLines(diff, 0, 3, 'diff')).toEqual({ from: 4, to: 6, old: false })
  })
  it('uses the old numbers when only deleted lines are selected', () => {
    expect(selectedLines(diff, 1, 1, 'diff')).toEqual({ from: 5, to: 5, old: true })
  })
  it('accepts either order', () => {
    expect(selectedLines(diff, 3, 2, 'new')).toEqual({ from: 5, to: 6, old: false })
  })
  it('uses old numbers in the old view', () => {
    expect(selectedLines(rowsOfText('a\nb\nc', 'old'), 0, 1, 'old')).toEqual({ from: 1, to: 2, old: true })
  })
  it('gives null when no row is numbered', () => {
    const rows = rowsFromStrings('a', 'b')
    expect(selectedLines(rows, 0, 1, 'diff')).toBeNull()
    expect(selectedLines([{ kind: 'hunk', text: '@@' }], 0, 0, 'diff')).toBeNull()
  })
})

describe('selectedLines on a huge selection', () => {
  it('does not overflow the stack with 200,000 rows', () => {
    const rows: Row[] = Array.from({ length: 200_000 }, (_, i) => ({ kind: 'ctx', text: 'x', oldNo: i + 1, newNo: i + 1 }))
    expect(selectedLines(rows, 0, rows.length - 1, 'diff')).toEqual({ from: 1, to: 200_000, old: false })
    expect(selectedLines(rows, 0, rows.length - 1, 'old')).toEqual({ from: 1, to: 200_000, old: true })
  })
  it('quotes a text with 200,000 backtick runs', () => {
    const text = '`a'.repeat(200_000) + '````'
    expect(quoteBlock('a.md', null, text).startsWith('`a.md`\n`````\n')).toBe(true)
  })
})

describe('quoting', () => {
  it('names the file and the line range', () => {
    expect(quoteBlock('a.md', { from: 2, to: 3, old: false }, 'x\ny')).toBe('`a.md:2-3`\n```\nx\ny\n```')
  })
  it('names one line without a range', () => {
    expect(quoteBlock('a.md', { from: 2, to: 2, old: false }, 'x')).toBe('`a.md:2`\n```\nx\n```')
  })
  it('marks old lines', () => {
    expect(quoteBlock('a.md', { from: 5, to: 5, old: true }, 'x')).toBe('`a.md:5` (old)\n```\nx\n```')
  })
  it('names only the file with no lines', () => {
    expect(quoteBlock('a.md', null, 'x')).toBe('`a.md`\n```\nx\n```')
  })
  it('lengthens the fence past the longest backtick run', () => {
    expect(quoteBlock('a.md', { from: 2, to: 3, old: false }, 'x ``` y')).toBe('`a.md:2-3`\n````\nx ``` y\n````')
  })
  it('round-trips through the composer as a code block', () => {
    const md = withFileQuote('', quoteBlock('a.md', { from: 1, to: 1, old: false }, 'x'))
    expect(JSON.stringify(fromMarkdown(md))).toContain('codeBlock')
  })
  it('appends the block to the draft with an empty line after', () => {
    expect(withFileQuote('hello  \n', 'B')).toBe('hello\nB\n')
    expect(withFileQuote('', 'B')).toBe('B\n')
  })
  it('asks to explain, naming the member in a room', () => {
    expect(explainFileText('B')).toBe('B\nExplain this selected text')
    expect(explainFileText('B', 'ada')).toBe('@ada B\nExplain this selected text')
  })
})

describe('whoLabel', () => {
  const name = (a: string): string => a.toUpperCase()
  it('names the agent and the subagent', () => {
    expect(whoLabel(step({ agent: 'ada', subagent: 'sub' }), name)).toBe('ADA › sub')
    expect(whoLabel(step({ agent: 'ada' }), name)).toBe('ADA')
  })
  it('gives the subagent alone, or nothing, in a single chat', () => {
    expect(whoLabel(step({ subagent: 'sub' }), name)).toBe('sub')
    expect(whoLabel(step(), name)).toBe('')
  })
})

describe('filesCount', () => {
  it('adds changed and attached files', () => {
    expect(filesCount({ changed: [file([]), file([])], attached: [{ itemId: 'i', ts: 1, attachment: {} as never }] })).toBe(3)
    expect(filesCount(null)).toBe(0)
  })
})

describe('diffRows', () => {
  const texts =
    (m: Record<string, string>) =>
    (id: string): string | undefined =>
      m[id]

  it('diffs two kept copies, and waits until both are loaded', () => {
    const src = { kind: 'texts' as const, before: { id: 'b' }, after: { id: 'a' } }
    expect(idsOf(src)).toEqual(['b', 'a'])
    expect(diffRows(src, texts({ b: 'x\n' }))).toBeNull()
    const rows = diffRows(src, texts({ b: 'x\n', a: 'y\n' }))!
    expect(rows.map((r) => r.kind)).toEqual(['hunk', 'del', 'add'])
  })
  it('says no changes for the same copy twice', () => {
    const rows = diffRows({ kind: 'texts', before: { id: 'c' }, after: { id: 'c' } }, texts({ c: 'x' }))
    expect(rows).toEqual([{ kind: 'same', text: 'No changes' }])
  })
  it('says only the final newline changed when the texts differ by nothing else', () => {
    const rows = diffRows({ kind: 'texts', before: { id: 'b' }, after: { id: 'a' } }, texts({ b: 'x\ny\n', a: 'x\ny' }))
    expect(rows).toEqual([{ kind: 'same', text: 'Only the final newline changed' }])
    expect(rowsFromTexts('x\n', 'x\n')).toEqual([{ kind: 'same', text: 'No changes' }])
    expect(rowsFromTexts('x\n', 'y\n').map((r) => r.kind)).toEqual(['hunk', 'del', 'add'])
  })
  it('diffs a created file against nothing', () => {
    const rows = diffRows({ kind: 'texts', before: { miss: 'created' }, after: { id: 'a' } }, texts({ a: 'one\ntwo' }))!
    expect(rows.filter((r) => r.kind === 'add')).toHaveLength(2)
  })
  it('shows why a side is missing', () => {
    expect(diffRows({ kind: 'texts', before: { miss: 'too-big' }, after: { text: 'x' } }, texts({}))).toEqual([
      { kind: 'miss', text: MISS_TEXT['too-big'] }
    ])
    expect(diffRows({ kind: 'texts', before: { id: 'b' }, after: { miss: 'binary' } }, texts({}))).toEqual([
      { kind: 'miss', text: MISS_TEXT.binary }
    ])
  })
  it('lists each step under its label', () => {
    const rows = diffRows(
      {
        kind: 'steps',
        parts: [
          { label: 'One', source: { kind: 'strings', old: 'a', new: 'b' } },
          { label: 'Two', source: { kind: 'texts', before: { miss: 'unrebuilt' }, after: { miss: 'unrebuilt' } } }
        ]
      },
      texts({})
    )!
    expect(rows.map((r) => r.kind)).toEqual(['step', 'del', 'add', 'step', 'miss'])
  })
})

describe('viewRows', () => {
  it('numbers a whole file, says when it is empty, and says why it is missing', () => {
    const none = (): undefined => undefined
    expect(viewRows({ text: 'a\nb' }, 'new', none)!.map((r) => ('newNo' in r ? r.newNo : null))).toEqual([1, 2])
    expect(viewRows({ text: '' }, 'old', none)).toEqual([{ kind: 'same', text: 'Empty file' }])
    expect(viewRows({ miss: 'created' }, 'old', none)).toEqual([{ kind: 'miss', text: MISS_TEXT.created }])
    expect(viewRows({ id: 'x' }, 'new', none)).toBeNull()
  })
})

describe('neededIds', () => {
  const sides = { before: { id: 'b' }, after: { id: 'a' } }
  it('is the diff copies in the diff view, one side in the others', () => {
    expect(neededIds('diff', { kind: 'strings', old: '', new: '' }, sides)).toEqual([])
    expect(neededIds('diff', { kind: 'texts', ...sides }, sides)).toEqual(['b', 'a'])
    expect(neededIds('old', null, sides)).toEqual(['b'])
    expect(neededIds('new', null, { before: { id: 'b' }, after: { miss: 'binary' } })).toEqual([])
  })
})

describe('small helpers', () => {
  it('knows text attachments up to 1 MiB', () => {
    expect(isTextAttachment({ mime: 'text/markdown', size: 10 })).toBe(true)
    expect(isTextAttachment({ mime: 'application/json', size: 10 })).toBe(true)
    expect(isTextAttachment({ mime: 'text/plain', size: 1024 * 1024 + 1 })).toBe(false)
    expect(isTextAttachment({ mime: 'application/pdf', size: 10 })).toBe(false)
    // Staged files come as octet-stream: a text file is known by its name.
    expect(isTextAttachment({ mime: 'application/octet-stream', size: 10, name: 'notes.TXT' })).toBe(true)
    expect(isTextAttachment({ mime: 'application/octet-stream', size: 10, name: 'app.config.yml' })).toBe(true)
    expect(isTextAttachment({ mime: 'application/octet-stream', size: 10, name: 'Dockerfile' })).toBe(true)
    expect(isTextAttachment({ mime: 'application/octet-stream', size: 10, name: 'data.zip' })).toBe(false)
    expect(isTextAttachment({ mime: 'application/octet-stream', size: 10, name: 'report.pdf' })).toBe(false)
    expect(isTextAttachment({ mime: 'application/octet-stream', size: 10, name: 'mdfile' })).toBe(false)
    expect(isTextAttachment({ mime: 'application/octet-stream', size: 2 * 1024 * 1024, name: 'big.log' })).toBe(false)
    expect(looksBinary('a\u0000b')).toBe(true)
    expect(looksBinary('plain')).toBe(false)
  })
  it('splits a path', () => {
    expect(splitPath('drafts/a/launch.md')).toEqual({ name: 'launch.md', dir: 'drafts/a' })
    expect(splitPath('launch.md')).toEqual({ name: 'launch.md', dir: '' })
  })
  it('labels a step', () => {
    expect(stepLabel(step({ op: 'create' }), 0, 'Ada', '10:32')).toBe('1. Created · Ada · 10:32')
    expect(stepLabel(step(), 1, '', '10:40')).toBe('2. Edited · 10:40')
  })
})

describe('restoreButton', () => {
  const f = (...changes: ChangeStep[]): ChangedFile => ({ path: '/w/a', shown: 'a', created: false, changes })
  it('undoes the picked step, or all steps for "all"', () => {
    const file = f(step({ id: 's1', before: 'b', after: 'a1' }), step({ id: 's2', before: 'a1', after: 'a2' }))
    expect(restoreButton(file, 1, false)).toMatchObject({
      fromId: 's2',
      toId: 's2',
      label: 'Restore to before this change',
      disabled: null
    })
    expect(restoreButton(file, 'all', false)).toMatchObject({
      fromId: 's1',
      toId: 's2',
      label: 'Restore to before all changes',
      disabled: null
    })
  })
  it('is disabled with the reason while running or when a copy was not kept', () => {
    expect(restoreButton(f(step({ id: 's1', before: 'b', after: 'a' })), 'all', true)?.disabled).toBe(RESTORE_REFUSALS.running)
    expect(restoreButton(f(step({ id: 's1', after: 'a' })), 0, false)?.disabled).toBe(RESTORE_REFUSALS.noBefore)
  })
  it('says a created file goes to the Trash', () => {
    expect(restoreButton(f(step({ id: 's1', op: 'create', after: 'a' })), 'all', false)?.confirm).toMatch(/Trash/)
    expect(restoredText('trashed')).toBe('Moved to the Trash.')
  })
})
