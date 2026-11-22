import { describe, expect, it } from 'vitest'
import {
  baseEntries,
  gitChangesOf,
  lineCount,
  listedEntries,
  parseNameStatusZ,
  parseNumstatZ,
  parseStatusZ
} from '@zumibot/shared/gitChanges'

const z = (...fields: string[]): string => fields.join('\0') + '\0'

describe('parseStatusZ', () => {
  it("reads the branch, each kind of entry and a rename's old path", () => {
    const s = parseStatusZ(
      z(
        '# branch.oid 0123456789abcdef',
        '# branch.head main',
        '1 .M N... 100644 100644 100644 aaa aaa src/app.ts',
        '1 M. N... 100644 100644 100644 aaa bbb staged.ts',
        '1 A. N... 000000 100644 100644 000 bbb new file.ts',
        '1 AM N... 000000 100644 100644 000 bbb added-then-edited.ts',
        '1 D. N... 100644 000000 000000 aaa 000 gone.ts',
        '1 .D N... 100644 100644 000000 aaa aaa gone-unstaged.ts',
        '1 .T N... 100644 100644 120000 aaa aaa link',
        '2 R. N... 100644 100644 100644 aaa aaa R100 to/name.ts',
        'from/name.ts',
        '2 C. N... 100644 100644 100644 aaa aaa C90 copy.ts',
        'orig.ts',
        'u UU N... 100644 100644 100644 100644 a b c clash.ts',
        '1 .M S.M. 160000 160000 160000 aaa aaa vendor/lib',
        '? notes  two spaces.md'
      )
    )
    expect(s.oid).toBe('0123456789abcdef')
    expect(s.head).toBe('main')
    expect(s.entries).toEqual([
      { path: 'src/app.ts', kind: 'modified', staged: false, submodule: false },
      { path: 'staged.ts', kind: 'modified', staged: true, submodule: false },
      { path: 'new file.ts', kind: 'added', staged: true, submodule: false },
      { path: 'added-then-edited.ts', kind: 'added', staged: true, submodule: false },
      { path: 'gone.ts', kind: 'deleted', staged: true, submodule: false },
      { path: 'gone-unstaged.ts', kind: 'deleted', staged: false, submodule: false },
      { path: 'link', kind: 'typechange', staged: false, submodule: false },
      { path: 'to/name.ts', from: 'from/name.ts', kind: 'renamed', staged: true, submodule: false },
      { path: 'copy.ts', from: 'orig.ts', kind: 'copied', staged: true, submodule: false },
      { path: 'clash.ts', kind: 'conflicted', staged: false, submodule: false },
      { path: 'vendor/lib', kind: 'modified', staged: false, submodule: true },
      { path: 'notes  two spaces.md', kind: 'untracked', staged: false, submodule: false }
    ])
  })

  it('keeps tabs and newlines in a path, and reads a detached HEAD', () => {
    const s = parseStatusZ(z('# branch.oid abc', '# branch.head (detached)', '? a\tb\nc.txt'))
    expect(s.head).toBeNull()
    expect(s.entries.map((e) => e.path)).toEqual(['a\tb\nc.txt'])
  })

  it('reads an empty status', () => {
    expect(parseStatusZ('')).toEqual({ oid: '', head: null, entries: [] })
  })
})

describe('parseNumstatZ', () => {
  it('reads counts, binary files and renames by their new path', () => {
    const m = parseNumstatZ(z('3\t1\tsrc/app.ts', '-\t-\tlogo.png', '2\t2\t', 'old name.ts', 'new name.ts', '0\t5\tgone.ts'))
    expect([...m]).toEqual([
      ['src/app.ts', { added: 3, removed: 1 }],
      ['logo.png', { added: null, removed: null }],
      ['new name.ts', { added: 2, removed: 2 }],
      ['gone.ts', { added: 0, removed: 5 }]
    ])
  })

  it('reads nothing from nothing', () => {
    expect(parseNumstatZ('').size).toBe(0)
  })
})

describe('lineCount', () => {
  it('counts a last line with or without its newline', () => {
    expect(lineCount('')).toBe(0)
    expect(lineCount('a')).toBe(1)
    expect(lineCount('a\n')).toBe(1)
    expect(lineCount('a\nb')).toBe(2)
    expect(lineCount('\n\n')).toBe(2)
  })
})

describe('listedEntries and gitChangesOf', () => {
  const s = parseStatusZ(
    z(
      '# branch.oid 0123456789abcdef',
      '# branch.head zumibot/x',
      '1 .M N... 100644 100644 100644 aaa aaa b.ts',
      '2 R. N... 100644 100644 100644 aaa aaa R100 c.ts',
      'old-c.ts',
      '? angular/node_modules',
      '? a.ts'
    )
  )

  it("leaves out ZumiBot's links, sorts by path and caps", () => {
    const all = listedEntries(s, ['angular/node_modules'])
    expect(all.entries.map((e) => e.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(all.more).toBe(0)
    const capped = listedEntries(s, ['angular/node_modules'], 2)
    expect(capped.entries.map((e) => e.path)).toEqual(['a.ts', 'b.ts'])
    expect(capped.more).toBe(1)
  })

  it('joins the counts and keeps only the fields that apply', () => {
    const { entries, more } = listedEntries(s, ['angular/node_modules'])
    const counts = new Map([
      ['b.ts', { added: 4, removed: 1 }],
      ['c.ts', { added: 0, removed: 0 }]
    ])
    expect(gitChangesOf('/repo', s, entries, more, counts)).toEqual({
      top: '/repo',
      branch: 'zumibot/x',
      head: '0123456',
      more: 0,
      files: [
        { path: 'a.ts', kind: 'untracked', staged: false, added: null, removed: null },
        { path: 'b.ts', kind: 'modified', staged: false, added: 4, removed: 1 },
        { path: 'c.ts', from: 'old-c.ts', kind: 'renamed', staged: true, added: 0, removed: 0 }
      ]
    })
  })
})

describe('parseNameStatusZ', () => {
  it("reads each status letter, a rename's two paths and a path with spaces", () => {
    expect(
      parseNameStatusZ(
        z(
          'M',
          'src/app.ts',
          'A',
          'new dir/one.md',
          'D',
          'gone.ts',
          'T',
          'link',
          'R100',
          'from/name.ts',
          'to/name.ts',
          'C90',
          'orig.ts',
          'copy.ts',
          'U',
          'clash.ts'
        )
      )
    ).toEqual([
      { path: 'src/app.ts', kind: 'modified', staged: false, submodule: false },
      { path: 'new dir/one.md', kind: 'added', staged: false, submodule: false },
      { path: 'gone.ts', kind: 'deleted', staged: false, submodule: false },
      { path: 'link', kind: 'typechange', staged: false, submodule: false },
      { path: 'to/name.ts', from: 'from/name.ts', kind: 'renamed', staged: false, submodule: false },
      { path: 'copy.ts', from: 'orig.ts', kind: 'copied', staged: false, submodule: false },
      { path: 'clash.ts', kind: 'conflicted', staged: false, submodule: false }
    ])
  })

  it('reads nothing from empty output and skips a letter it does not know', () => {
    expect(parseNameStatusZ('')).toEqual([])
    expect(parseNameStatusZ(z('X', 'odd.ts'))).toEqual([])
  })
})

describe('baseEntries', () => {
  it('adds the untracked files to the diff, since a diff never lists them', () => {
    const status = parseStatusZ(
      z(
        '# branch.oid 0123456789abcdef',
        '# branch.head main',
        '1 .M N... 100644 100644 100644 aaa aaa committed.ts',
        '? fresh.ts',
        '? also-in-diff.ts'
      )
    )
    const diff = parseNameStatusZ(z('M', 'committed.ts', 'A', 'also-in-diff.ts'))
    expect(baseEntries(diff, status).map((e) => [e.path, e.kind])).toEqual([
      ['committed.ts', 'modified'],
      ['also-in-diff.ts', 'added'],
      ['fresh.ts', 'untracked']
    ])
  })
})
