import type { PatchHunk } from './files'
import { splitLines } from './lineDiff'

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Reads the `@@ -a,b +c,d @@` hunks of a unified diff (leading `---`/`+++` lines are ignored). Null on anything it cannot read exactly:
 * counts that do not match the lines, stray text, or a `\ No newline at end of file` marker, which a PatchHunk cannot carry.
 */
export function parseUnifiedDiff(diff: string): PatchHunk[] | null {
  const lines = diff.split('\n')
  if (lines[lines.length - 1] === '') lines.pop() // the diff's own last newline
  const hunks: PatchHunk[] = []
  let i = 0
  // File headers come only before the first hunk: later, a line starting with `--` is a deleted line.
  while (i < lines.length && (lines[i].startsWith('--- ') || lines[i].startsWith('+++ '))) i++
  while (i < lines.length) {
    const m = HEADER.exec(lines[i++])
    if (!m) return null
    const oldStart = Number(m[1])
    const oldLines = m[2] === undefined ? 1 : Number(m[2])
    const newStart = Number(m[3])
    const newLines = m[4] === undefined ? 1 : Number(m[4])
    const body: string[] = []
    let oldN = 0
    let newN = 0
    // Exactly the counted lines: one more or fewer is a diff we do not understand.
    while (oldN < oldLines || newN < newLines) {
      if (i >= lines.length) return null
      const l = lines[i++]
      const c = l === '' ? ' ' : l[0] // a blank context line may have lost its space
      if (c === ' ') {
        oldN++
        newN++
        body.push(l === '' ? ' ' : l)
      } else if (c === '-') {
        oldN++
        body.push(l)
      } else if (c === '+') {
        newN++
        body.push(l)
      } else return null
    }
    if (oldN !== oldLines || newN !== newLines) return null
    hunks.push({ oldStart, oldLines, newStart, newLines, lines: body })
  }
  return hunks
}

/**
 * The old text from the new one: each hunk's new-side lines must be exactly where it says, else null.
 * The final newline is taken from `after`, which is right for a diff with no no-newline marker (the parser refuses those).
 */
export function reversePatch(after: string, hunks: readonly PatchHunk[]): string | null {
  const lines = splitLines(after)
  const out: string[] = []
  let pos = 0
  for (const h of hunks) {
    // With no new lines the start names the line before the deletion.
    const start = h.newLines === 0 ? h.newStart : h.newStart - 1
    if (start < pos || start > lines.length) return null
    for (; pos < start; pos++) out.push(lines[pos])
    // The old side must start where the header says too, or a diff for another file shape would be trusted on its new side alone.
    if (out.length !== (h.oldLines === 0 ? h.oldStart : h.oldStart - 1)) return null
    let oldN = 0
    let newN = 0
    for (const l of h.lines) {
      const text = l.slice(1)
      if (l[0] === '-') {
        out.push(text)
        oldN++
      } else if (l[0] === ' ' || l[0] === '+') {
        if (pos >= lines.length || lines[pos] !== text) return null
        if (l[0] === ' ') {
          out.push(text)
          oldN++
        }
        pos++
        newN++
      } else return null
    }
    if (oldN !== h.oldLines || newN !== h.newLines) return null
  }
  for (; pos < lines.length; pos++) out.push(lines[pos])
  if (out.length === 0) return ''
  return out.join('\n') + (after === '' || after.endsWith('\n') ? '\n' : '')
}
