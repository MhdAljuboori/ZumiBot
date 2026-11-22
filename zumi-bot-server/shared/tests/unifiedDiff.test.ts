import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff, reversePatch } from '@zumibot/shared/unifiedDiff'

// The a.txt diff probe check 10 recorded from codex-cli 0.164.0 (hunks only, no ---/+++ headers).
const CHECK10 = '@@ -1,3 +1,3 @@\n line one\n-line two\n+line TWO changed\n line three\n'
const AFTER = 'line one\nline TWO changed\nline three\n'
const BEFORE = 'line one\nline two\nline three\n'

describe('parseUnifiedDiff', () => {
  it('reads the recorded check-10 format', () => {
    expect(parseUnifiedDiff(CHECK10)).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' line one', '-line two', '+line TWO changed', ' line three'] }
    ])
  })
  it('ignores leading --- and +++ headers, and a section name after @@', () => {
    const got = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@ fn main\n-a\n+b\n')
    expect(got).toEqual([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }])
  })
  it('reads several hunks, and a deleted line that starts with --', () => {
    const got = parseUnifiedDiff('@@ -1,2 +1,1 @@\n a\n--b\n@@ -9,0 +8,1 @@\n+z\n')
    expect(got).toHaveLength(2)
    expect(got![0].lines).toEqual([' a', '--b'])
    expect(got![1]).toEqual({ oldStart: 9, oldLines: 0, newStart: 8, newLines: 1, lines: ['+z'] })
  })
  it('reads a blank line inside a hunk as blank context', () => {
    expect(parseUnifiedDiff('@@ -1,3 +1,3 @@\n a\n\n-c\n+C\n')![0].lines).toEqual([' a', ' ', '-c', '+C'])
  })
  it('gives no hunks for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })
  it('gives null when counts do not match the lines', () => {
    expect(parseUnifiedDiff('@@ -1,3 +1,3 @@\n a\n-b\n+B\n')).toBeNull() // runs out
    expect(parseUnifiedDiff('@@ -1,1 +1,1 @@\n-a\n+b\n+c\n')).toBeNull() // too many
    expect(parseUnifiedDiff('@@ -1,2 +1,1 @@\n-a\n+b\n')).toBeNull() // old count lies
  })
  it('gives null for text it cannot read exactly', () => {
    expect(parseUnifiedDiff('not a diff\n')).toBeNull()
    expect(parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\nstray\n')).toBeNull()
    expect(parseUnifiedDiff('@@ -x +1 @@\n-a\n+b\n')).toBeNull()
  })
  it('gives null on a no-newline marker, which a hunk cannot carry', () => {
    expect(parseUnifiedDiff('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n')).toBeNull()
  })
})

describe('reversePatch', () => {
  it('rebuilds the file before the recorded check-10 patch', () => {
    expect(reversePatch(AFTER, parseUnifiedDiff(CHECK10)!)).toBe(BEFORE)
  })
  it('rebuilds across several hunks, inserts and deletions', () => {
    const before = 'a\nb\nc\nd\ne\nf\n'
    const after = 'a\nB\nc\nd\nf\ng\n'
    const diff = '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -4,3 +4,3 @@\n d\n-e\n f\n+g\n'
    expect(reversePatch(after, parseUnifiedDiff(diff)!)).toBe(before)
  })
  it('rebuilds a file that was emptied or filled', () => {
    expect(reversePatch('', parseUnifiedDiff('@@ -1,2 +0,0 @@\n-x\n-y\n')!)).toBe('x\ny\n')
    expect(reversePatch('x\n', parseUnifiedDiff('@@ -0,0 +1 @@\n+x\n')!)).toBe('')
  })
  it('keeps a missing final newline that the patch did not touch', () => {
    expect(reversePatch('A\nb\nc', parseUnifiedDiff('@@ -1,2 +1,2 @@\n-a\n+A\n b\n')!)).toBe('a\nb\nc')
  })
  it('keeps CR in the lines and compares them exactly', () => {
    expect(reversePatch('a\r\nB\r\n', [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a\r', '-b\r', '+B\r'] }])).toBe(
      'a\r\nb\r\n'
    )
    expect(reversePatch('a\r\nB\r\n', parseUnifiedDiff('@@ -1,2 +1,2 @@\n a\n-b\n+B\n')!)).toBeNull()
  })
  it('gives null when the context does not match', () => {
    expect(reversePatch('line one\nsomething else\nline three\n', parseUnifiedDiff(CHECK10)!)).toBeNull()
    expect(reversePatch('line one\n', parseUnifiedDiff(CHECK10)!)).toBeNull() // past the end
  })
  it('gives null when the hunk lines exist but at a shifted position', () => {
    expect(reversePatch('x\n' + AFTER, parseUnifiedDiff(CHECK10)!)).toBeNull() // new side matches at line 2, header says 1
    expect(reversePatch(AFTER, parseUnifiedDiff(CHECK10.replace('-1,3 +1,3', '-2,3 +1,3'))!)).toBeNull() // old start lies
  })
  it('gives null when hunks overlap, are out of order, or counts lie', () => {
    const h = (oldStart: number, oldLines: number, newStart: number, newLines: number, lines: string[]) => ({
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines
    })
    expect(reversePatch('a\nb\n', [h(2, 1, 2, 1, ['-x', '+b']), h(1, 1, 1, 1, ['-y', '+a'])])).toBeNull()
    expect(reversePatch('a\nb\n', [h(1, 2, 1, 2, ['-x', '+a'])])).toBeNull()
  })
})
