import { describe, expect, it } from 'vitest'
import { DIFF_MAX_EDITS, diffLines, splitLines } from '@zumibot/shared/lineDiff'
import type { PatchHunk } from '@zumibot/shared/files'

describe('splitLines', () => {
  it('drops the empty last line after a trailing newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
  })
  it('splits text with no trailing newline', () => {
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
  })
  it('gives no lines for empty text', () => {
    expect(splitLines('')).toEqual([])
  })
  it('keeps \\r in the line', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a\r', 'b\r'])
  })
})

// Applies hunks to the old lines; the result must equal the new lines.
function rebuild(a: string[], hunks: PatchHunk[]): string[] {
  const out: string[] = []
  let at = 0 // next old line (0-based) not yet copied
  for (const h of hunks) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1
    out.push(...a.slice(at, start))
    at = start
    for (const l of h.lines) {
      if (l[0] !== '+') at++
      if (l[0] !== '-') out.push(l.slice(1))
    }
  }
  out.push(...a.slice(at))
  return out
}

const text = (lines: string[]): string => lines.map((l) => l + '\n').join('')

const numbered = (n: number): string[] => Array.from({ length: n }, (_, i) => `line${i + 1}`)

describe('diffLines', () => {
  it('returns one hunk with context for a single changed line', () => {
    expect(diffLines('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }
    ])
  })
  it('starts at 0 on the empty side when creating', () => {
    expect(diffLines('', 'x\ny\n')).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+x', '+y'] }])
  })
  it('starts at 0 on the new side when everything is deleted', () => {
    expect(diffLines('x\ny\n', '')).toEqual([{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ['-x', '-y'] }])
  })
  it('splits changes far apart into two hunks with 3 context lines each side', () => {
    const a = numbered(30)
    const b = [...a]
    b[9] = 'CHANGED10'
    b[19] = 'CHANGED20'
    const hunks = diffLines(a.join('\n') + '\n', b.join('\n') + '\n')
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toEqual({
      oldStart: 7,
      oldLines: 7,
      newStart: 7,
      newLines: 7,
      lines: [' line7', ' line8', ' line9', '-line10', '+CHANGED10', ' line11', ' line12', ' line13']
    })
    expect(hunks[1]).toEqual({
      oldStart: 17,
      oldLines: 7,
      newStart: 17,
      newLines: 7,
      lines: [' line17', ' line18', ' line19', '-line20', '+CHANGED20', ' line21', ' line22', ' line23']
    })
  })
  it('merges changes whose context touches into one hunk', () => {
    const a = numbered(20)
    const b = [...a]
    b[4] = 'X'
    b[9] = 'Y' // 4 unchanged lines between: the two contexts of 3 overlap
    expect(diffLines(a.join('\n'), b.join('\n'))).toHaveLength(1)
  })
  it('changes only the differing line when both texts use CRLF', () => {
    const hunks = diffLines('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n')
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines.filter((l) => l[0] === '-' || l[0] === '+')).toEqual(['-b\r', '+B\r'])
  })
  it('returns no hunks for equal text', () => {
    expect(diffLines('a\nb\n', 'a\nb\n')).toEqual([])
    expect(diffLines('', '')).toEqual([])
  })
  it('honours a custom context size', () => {
    expect(diffLines('a\nb\nc\nd\ne\n', 'a\nb\nC\nd\ne\n', 1)).toEqual([
      { oldStart: 2, oldLines: 3, newStart: 2, newLines: 3, lines: [' b', '-c', '+C', ' d'] }
    ])
  })
  it('produces hunks that rebuild the new text from the old, for random edits', () => {
    let seed = 7
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: rnd(25) }, () => `l${rnd(6)}`)
      const b = Array.from({ length: rnd(25) }, () => `l${rnd(6)}`)
      expect(rebuild(a, diffLines(text(a), text(b), 2))).toEqual(b)
    }
  })
  it('handles an insert and a delete in one file', () => {
    const lines = diffLines('a\nb\nc\nd\n', 'a\nc\nd\ne\n').flatMap((h) => h.lines)
    expect(lines.filter((l) => l[0] === '-')).toEqual(['-b'])
    expect(lines.filter((l) => l[0] === '+')).toEqual(['+e'])
  })
  it('pins the merge boundary: 6 equal lines between changes merge, 7 split', () => {
    const a = numbered(30)
    const change = (...at: number[]): string => {
      const b = [...a]
      for (const i of at) b[i] = 'X' + i
      return text(b)
    }
    expect(diffLines(text(a), change(5, 12))).toHaveLength(1) // lines 6..11 between
    expect(diffLines(text(a), change(5, 13))).toHaveLength(2) // lines 6..12 between
  })

  describe('big rewrites', () => {
    it('replaces the whole middle fast and still rebuilds the new text', () => {
      const a = Array.from({ length: 20000 }, (_, i) => `old${i}`)
      const b = Array.from({ length: 20000 }, (_, i) => `new${i}`)
      const t0 = Date.now()
      const hunks = diffLines(text(a), text(b))
      expect(Date.now() - t0).toBeLessThan(2000)
      expect(rebuild(a, hunks)).toEqual(b)
    })
    it('gives all removals then all additions for the middle, keeping the common ends as context', () => {
      const mid = DIFF_MAX_EDITS + 500
      const oldMid = Array.from({ length: mid }, (_, i) => `old${i}`)
      const newMid = Array.from({ length: mid }, (_, i) => `new${i}`)
      const head = ['p1', 'p2', 'p3', 'p4']
      const tail = ['s1', 's2', 's3', 's4']
      const hunks = diffLines(text([...head, ...oldMid, ...tail]), text([...head, ...newMid, ...tail]))
      expect(hunks).toEqual([
        {
          oldStart: 2,
          oldLines: 3 + mid + 3,
          newStart: 2,
          newLines: 3 + mid + 3,
          lines: [' p2', ' p3', ' p4', ...oldMid.map((l) => '-' + l), ...newMid.map((l) => '+' + l), ' s1', ' s2', ' s3']
        }
      ])
    })
    it('still finds a minimal diff just under the limit', () => {
      const a = Array.from({ length: 5000 }, (_, i) => `l${i}`)
      const b = [...a]
      const changed = DIFF_MAX_EDITS / 2 - 10 // each change is one - and one +
      for (let i = 0; i < changed; i++) b[i * 2] = `X${i}`
      const hunks = diffLines(text(a), text(b))
      const lines = hunks.flatMap((h) => h.lines)
      expect(lines.filter((l) => l[0] === '-')).toHaveLength(changed)
      expect(lines.filter((l) => l[0] === '+')).toHaveLength(changed)
      expect(rebuild(a, hunks)).toEqual(b)
    })
  })
})
