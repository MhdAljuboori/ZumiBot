import type { PatchHunk } from './files'

/** Lines of a text: split on \n only (a \r stays in its line), and a trailing \n adds no empty last line. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Most edits (lines removed plus added) the diff searches for; a bigger rewrite is shown as the whole middle replaced. */
export const DIFF_MAX_EDITS = 2000

type Op = { t: ' ' | '-' | '+'; line: string }

/** Myers O(ND) edit script over line arrays (common ends are trimmed first, so similar texts stay cheap). */
function editScript(a: string[], b: string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const x = a.slice(start, endA)
  const y = b.slice(start, endB)
  const n = x.length
  const m = y.length
  const max = n + m
  const middle: Op[] = []

  if (max > 0) {
    // trace[d] is the live part of V (k from -d to d) as it stood before round d, so memory is O(D^2), not O(D*(N+M)).
    // Rounds stop at DIFF_MAX_EDITS: past that the middle is replaced whole, so a rewritten file cannot exhaust memory.
    const bound = Math.min(max, DIFF_MAX_EDITS)
    const offset = bound + 1
    const trace: Int32Array[] = []
    const v = new Int32Array(2 * bound + 3)
    let found = false
    for (let d = 0; d <= bound; d++) {
      trace.push(v.slice(offset - d, offset + d + 1))
      let done = false
      for (let k = -d; k <= d; k += 2) {
        let px = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]) ? v[k + 1 + offset] : v[k - 1 + offset] + 1
        let py = px - k
        while (px < n && py < m && x[px] === y[py]) {
          px++
          py++
        }
        v[k + offset] = px
        if (px >= n && py >= m) {
          done = true
          break
        }
      }
      if (done) {
        found = true
        break
      }
    }
    if (!found) {
      for (const line of x) middle.push({ t: '-', line })
      for (const line of y) middle.push({ t: '+', line })
    } else {
      // Walk back from the end, newest round first.
      let cx = n
      let cy = m
      for (let d = trace.length - 1; d >= 0; d--) {
        const pv = trace[d] // index k + d
        const k = cx - cy
        const prevK = k === -d || (k !== d && pv[k - 1 + d] < pv[k + 1 + d]) ? k + 1 : k - 1
        const prevX = d === 0 ? 0 : pv[prevK + d]
        const prevY = d === 0 ? 0 : prevX - prevK
        while (cx > prevX && cy > prevY) {
          cx--
          cy--
          middle.push({ t: ' ', line: x[cx] })
        }
        if (d > 0) {
          if (cx === prevX) {
            cy--
            middle.push({ t: '+', line: y[cy] })
          } else {
            cx--
            middle.push({ t: '-', line: x[cx] })
          }
        }
        cx = prevX
        cy = prevY
      }
      middle.reverse()
    }
  }

  return [...a.slice(0, start).map((line): Op => ({ t: ' ', line })), ...middle, ...a.slice(endA).map((line): Op => ({ t: ' ', line }))]
}

/** Unified-diff hunks turning text a into text b; [] when they are equal. */
export function diffLines(a: string, b: string, context = 3): PatchHunk[] {
  if (a === b) return []
  const ops = editScript(splitLines(a), splitLines(b))
  // Old/new line counts before each op, to give every hunk its start.
  const oldBefore: number[] = []
  const newBefore: number[] = []
  let o = 0
  let nw = 0
  for (const op of ops) {
    oldBefore.push(o)
    newBefore.push(nw)
    if (op.t !== '+') o++
    if (op.t !== '-') nw++
  }

  const hunks: PatchHunk[] = []
  let i = 0
  while (i < ops.length) {
    if (ops[i].t === ' ') {
      i++
      continue
    }
    const from = Math.max(0, i - context)
    // Keep growing while the next change leaves at most 2*context equal lines, so the two contexts meet (as git does).
    let last = i
    for (let j = i; j < ops.length && j - last <= 2 * context + 1; j++) {
      if (ops[j].t !== ' ') last = j
    }
    const to = Math.min(ops.length - 1, last + context)
    const slice = ops.slice(from, to + 1)
    const oldLines = slice.filter((s) => s.t !== '+').length
    const newLines = slice.filter((s) => s.t !== '-').length
    hunks.push({
      oldStart: oldLines === 0 ? 0 : oldBefore[from] + 1,
      oldLines,
      newStart: newLines === 0 ? 0 : newBefore[from] + 1,
      newLines,
      lines: slice.map((s) => s.t + s.line)
    })
    i = to + 1
  }
  return hunks
}
