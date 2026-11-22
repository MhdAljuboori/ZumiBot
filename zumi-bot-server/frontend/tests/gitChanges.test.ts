import { describe, expect, it } from 'vitest'
import type { GitChangedFile, GitChanges, GitFileDiff } from '@zumibot/shared/types'
import { changeRows, copyText, filesLine, lineTotals, pathLine, shownPath } from '../src/state/gitChanges'

const diff = (before: GitFileDiff['before'], after: GitFileDiff['after']): GitFileDiff => ({ path: 'a.ts', before, after })
const file = (path: string, extra: Partial<GitChangedFile> = {}): GitChangedFile => ({
  path,
  kind: 'modified',
  staged: false,
  added: 1,
  removed: 1,
  ...extra
})
const kinds = (rows: ReturnType<typeof changeRows>): string[] => rows.map((r) => r.kind)

describe('changeRows', () => {
  it('diffs the two texts', () => {
    const rows = changeRows(diff({ text: 'a\nb\n' }, { text: 'a\nc\n' }), 'diff')
    expect(kinds(rows)).toEqual(['hunk', 'ctx', 'del', 'add'])
  })
  it('shows a new file as all added and a deleted one as all removed', () => {
    expect(kinds(changeRows(diff({ miss: 'absent' }, { text: 'x\ny\n' }), 'diff'))).toEqual(['hunk', 'add', 'add'])
    expect(kinds(changeRows(diff({ text: 'x\n' }, { miss: 'absent' }), 'diff'))).toEqual(['hunk', 'del'])
  })
  it('says why there is no diff: binary, too big, a submodule, no text change, an empty new file', () => {
    expect(changeRows(diff({ text: 'a' }, { miss: 'binary' }), 'diff')).toEqual([{ kind: 'miss', text: 'Binary file' }])
    expect(changeRows(diff({ miss: 'too-big' }, { text: 'a' }), 'diff')).toEqual([{ kind: 'miss', text: 'File over 1 MB' }])
    expect(changeRows(diff({ miss: 'submodule' }, { miss: 'submodule' }), 'diff')).toEqual([
      { kind: 'miss', text: 'Submodule: no text to show' }
    ])
    expect(changeRows(diff({ text: 'a\n' }, { text: 'a\n' }), 'diff')).toEqual([{ kind: 'same', text: 'No changes to its text' }])
    expect(changeRows(diff({ miss: 'absent' }, { text: '' }), 'diff')).toEqual([{ kind: 'same', text: 'Empty file' }])
    expect(changeRows(diff({ miss: 'absent' }, { miss: 'absent' }), 'diff')).toEqual([{ kind: 'same', text: 'No changes' }])
  })
  it('shows either whole side, numbered on its own side', () => {
    const d = diff({ text: 'a\nb\n' }, { miss: 'absent' })
    expect(changeRows(d, 'old')).toEqual([
      { kind: 'ctx', text: 'a', oldNo: 1, newNo: null },
      { kind: 'ctx', text: 'b', oldNo: 2, newNo: null }
    ])
    expect(changeRows(d, 'new')).toEqual([{ kind: 'miss', text: 'Deleted from the folder' }])
    expect(changeRows(diff({ miss: 'absent' }, { text: 'z\n' }), 'old')).toEqual([{ kind: 'miss', text: 'Not in the last commit' }])
    expect(changeRows(diff({ miss: 'absent' }, { text: '' }), 'new')).toEqual([{ kind: 'same', text: 'Empty file' }])
  })
})

describe('copyText', () => {
  it('copies the old file in Old and the file now otherwise; nothing without text', () => {
    const d = diff({ text: 'old' }, { text: 'new' })
    expect(copyText(d, 'old')).toBe('old')
    expect(copyText(d, 'new')).toBe('new')
    expect(copyText(d, 'diff')).toBe('new')
    expect(copyText(diff({ text: 'old' }, { miss: 'absent' }), 'diff')).toBeNull()
  })
})

describe('list helpers', () => {
  const changes = (files: GitChangedFile[], more = 0): GitChanges => ({ top: '/r', branch: 'main', head: 'abc1234', files, more })

  it('totals the counted lines', () => {
    expect(
      lineTotals([file('a', { added: 3, removed: 1 }), file('b', { added: null, removed: null }), file('c', { added: 2, removed: 0 })])
    ).toEqual({ added: 5, removed: 1 })
  })
  it('counts files, the ones past the cap too', () => {
    expect(filesLine(changes([]))).toBe('No uncommitted changes')
    expect(filesLine(changes([file('a')]))).toBe('1 file changed')
    expect(filesLine(changes([file('a'), file('b')], 3))).toBe('5 files changed')
  })
  it('keeps the pick while it is listed, else shows the first', () => {
    const files = [file('a'), file('b')]
    expect(shownPath(files, 'b')).toBe('b')
    expect(shownPath(files, 'gone')).toBe('a')
    expect(shownPath(files, null)).toBe('a')
    expect(shownPath([], 'a')).toBeNull()
  })
  it("names a rename's old path", () => {
    expect(pathLine(file('new.ts', { kind: 'renamed', from: 'old.ts' }))).toBe('old.ts → new.ts')
    expect(pathLine(file('a.ts'))).toBe('a.ts')
  })
})
