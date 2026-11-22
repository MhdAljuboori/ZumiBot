import type { GitChangedFile, GitChangeKind, GitChanges } from './types'
import { isLinkPath } from './worktree'

// Pure, like worktree.ts: the frontend imports this file too.

/** The Changes panel lists this many files; a bigger change set says how many more there are. */
export const GIT_CHANGES_MAX = 500

export interface StatusEntry {
  path: string
  from?: string
  kind: GitChangeKind
  staged: boolean
  submodule: boolean
}
export interface StatusZ {
  oid: string
  head: string | null
  entries: StatusEntry[]
}

// Fields before the path, as in parseStatusV2: ordinary `1` lines have 8, renames `2` have 9, unmerged `u` have 10.
const FIXED_FIELDS: Record<string, number> = { '1': 8, '2': 9, u: 10 }

function kindOf(type: string, xy: string): GitChangeKind {
  if (type === 'u') return 'conflicted'
  const [x, y] = xy
  if (type === '2') return x === 'C' || y === 'C' ? 'copied' : 'renamed'
  if (x === 'A') return 'added' // still added when the folder copy was edited since
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'T' || y === 'T') return 'typechange'
  return 'modified'
}

/**
 * Reads `git status --porcelain=v2 --branch -z`. With -z nothing is quoted, and a rename's old path is the next
 * NUL-separated field, so any path (spaces, tabs, newlines) comes through as it is.
 */
export function parseStatusZ(text: string): StatusZ {
  const out: StatusZ = { oid: '', head: null, entries: [] }
  const fields = text.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (f.startsWith('# branch.oid ')) out.oid = f.slice('# branch.oid '.length)
    else if (f.startsWith('# branch.head ')) {
      const head = f.slice('# branch.head '.length)
      out.head = head === '(detached)' ? null : head
    } else if (f.startsWith('? ')) out.entries.push({ path: f.slice(2), kind: 'untracked', staged: false, submodule: false })
    else if (f[1] === ' ' && FIXED_FIELDS[f[0]] !== undefined) {
      const parts = f.split(' ')
      const n = FIXED_FIELDS[f[0]]
      if (parts.length <= n) continue
      const path = parts.slice(n).join(' ')
      const xy = parts[1] ?? '..'
      const entry: StatusEntry = {
        path,
        kind: kindOf(f[0], xy),
        staged: f[0] !== 'u' && xy[0] !== '.',
        submodule: (parts[2] ?? '').startsWith('S')
      }
      if (f[0] === '2') entry.from = fields[++i]
      out.entries.push(entry)
    }
  }
  return out
}

// `git diff --name-status` letters. With -M a rename or copy carries a score (R100, C90).
const NAME_STATUS: Record<string, GitChangeKind> = {
  A: 'added',
  C: 'copied',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'typechange',
  U: 'conflicted'
}

/**
 * Reads `git diff --name-status -z -M <ref> --`: `<status> NUL <path> NUL`, and for a rename or copy
 * `<status> NUL <old> NUL <new> NUL`. Used by the base diff, where a change may already be committed, so there is no
 * index state to report: every entry reads unstaged.
 */
export function parseNameStatusZ(text: string): StatusEntry[] {
  const out: StatusEntry[] = []
  const fields = text.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (f === '') continue
    const kind = NAME_STATUS[f[0]]
    if (kind === undefined) continue
    const renamed = kind === 'renamed' || kind === 'copied'
    const from = fields[++i]
    const path = renamed ? fields[++i] : from
    if (path === undefined || path === '') continue
    out.push({ path, ...(renamed && from ? { from } : {}), kind, staged: false, submodule: false })
  }
  return out
}

export interface LineCount {
  added: number | null
  removed: number | null
}

/**
 * Reads `git diff --numstat -z`: `added TAB removed TAB path NUL`, or for a rename `added TAB removed TAB NUL old NUL new NUL`.
 * Keyed by the new path. A binary file counts `-` and gets nulls.
 */
export function parseNumstatZ(text: string): Map<string, LineCount> {
  const out = new Map<string, LineCount>()
  const fields = text.split('\0')
  const num = (s: string): number | null => (/^\d+$/.test(s) ? Number(s) : null)
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (f === '') continue
    const a = f.indexOf('\t')
    const b = a < 0 ? -1 : f.indexOf('\t', a + 1)
    if (b < 0) continue
    let path = f.slice(b + 1)
    if (path === '') {
      i += 2 // old path, then new path
      path = fields[i] ?? ''
    }
    if (path !== '') out.set(path, { added: num(f.slice(0, a)), removed: num(f.slice(a + 1, b)) })
  }
  return out
}

/** Lines in a text, counted as git counts them: a last line without its newline still counts. */
export function lineCount(text: string): number {
  if (text === '') return 0
  let n = 0
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
  return text.endsWith('\n') ? n : n + 1
}

/** The entries the panel lists: ZumiBot's links left out (the chip leaves them out too), sorted by path, capped. */
export function listedOf(
  entries: readonly StatusEntry[],
  links: readonly string[],
  max = GIT_CHANGES_MAX
): { entries: StatusEntry[]; more: number } {
  const all = entries.filter((e) => !isLinkPath(e.path, links)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { entries: all.slice(0, max), more: Math.max(0, all.length - max) }
}

export const listedEntries = (s: StatusZ, links: readonly string[], max = GIT_CHANGES_MAX): { entries: StatusEntry[]; more: number } =>
  listedOf(s.entries, links, max)

/**
 * The base diff's entries: what `git diff <base>` reports, plus the untracked files from the status — a file the agent
 * made and never committed is part of the work since the base, and a diff never lists it.
 */
export function baseEntries(diff: readonly StatusEntry[], status: StatusZ): StatusEntry[] {
  const seen = new Set(diff.map((e) => e.path))
  return [...diff, ...status.entries.filter((e) => e.kind === 'untracked' && !seen.has(e.path))]
}

/** The panel's list from a status, its line counts and the repo's top. */
export function gitChangesOf(
  top: string,
  s: StatusZ,
  entries: StatusEntry[],
  more: number,
  counts: ReadonlyMap<string, LineCount>
): GitChanges {
  const files = entries.map((e): GitChangedFile => {
    const c = counts.get(e.path)
    return {
      path: e.path,
      ...(e.from !== undefined ? { from: e.from } : {}),
      kind: e.kind,
      staged: e.staged,
      ...(e.submodule ? { submodule: true as const } : {}),
      added: c?.added ?? null,
      removed: c?.removed ?? null
    }
  })
  return { top, branch: s.head, head: s.oid.slice(0, 7), files, more }
}
