import { isScratchFolder, scratchParent } from './scratch'
import type { ChatWorktree, GitStatus, WorktreeKeep } from './types'

// Pure and `/`-only on purpose: the frontend imports this file too, so no `node:` modules.

export const WORKTREE_BRANCH_PREFIX = 'zumibot/'

// Folders a release may discard: build output a fresh checkout makes again.
const CACHE_SEGMENTS = new Set([
  'node_modules',
  '.angular',
  'dist',
  'out',
  'build',
  'coverage',
  '.cache',
  '.turbo',
  '.next',
  '.vite',
  'tmp'
])

/** `<base>-<hex>` with the base reduced to `[a-z0-9-]`, safe in a branch name and a folder name. */
export function worktreeSlug(base: string, hex: string): string {
  const clean = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${clean || 'chat'}-${hex}`
}

export const worktreeBranch = (slug: string): string => WORKTREE_BRANCH_PREFIX + slug

/** The sibling folder `<dirname(top)>/<basename(top)>-<slug>`, so the repo's own tree stays untouched. */
export function worktreePath(top: string, slug: string): string {
  const trimmed = top.replace(/\/+$/, '')
  return `${trimmed}-${slug}`
}

export interface StatusV2 {
  oid: string
  head: string | null
  changed: string[]
  ignored: string[]
}

// Fields before the path: ordinary `1` lines have 8, renames `2` have 9, unmerged `u` have 10. The path is the rest of the line, so spaces stay.
const FIXED_FIELDS: Record<string, number> = { '1': 8, '2': 9, u: 10 }

function afterFields(line: string, n: number): string {
  let at = 0
  for (let i = 0; i < n; i++) {
    at = line.indexOf(' ', at)
    if (at < 0) return ''
    at += 1
  }
  return line.slice(at)
}

/** Reads `git status --porcelain=v2 --branch` (run with `-c core.quotePath=false`, so paths are not quoted). */
export function parseStatusV2(text: string): StatusV2 {
  const out: StatusV2 = { oid: '', head: null, changed: [], ignored: [] }
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.oid ')) out.oid = line.slice('# branch.oid '.length)
    else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length)
      out.head = head === '(detached)' ? null : head
    } else if (line.startsWith('? ')) out.changed.push(line.slice(2))
    else if (line.startsWith('! ')) out.ignored.push(line.slice(2))
    else if (line[1] === ' ' && FIXED_FIELDS[line[0]] !== undefined) {
      const rest = afterFields(line, FIXED_FIELDS[line[0]])
      // A rename's path is followed by TAB and the old path.
      if (rest) out.changed.push(line[0] === '2' ? rest.split('\t')[0] : rest)
    }
  }
  return out
}

/** A node_modules link ZumiBot made (git lists a symlink to a folder without its trailing slash, a folder with one). */
export const isLinkPath = (path: string, links: readonly string[]): boolean => links.includes(path.replace(/\/+$/, ''))

export const isCachePath = (path: string): boolean => path.endsWith('.log') || path.split('/').some((seg) => CACHE_SEGMENTS.has(seg))

export function gitStatusOf(s: StatusV2, links: readonly string[]): GitStatus {
  return { branch: s.head, head: s.oid.slice(0, 7), changed: s.changed.filter((p) => !isLinkPath(p, links)).length }
}

/** Why a release must keep the folder, or null when removing it loses nothing. Dirty comes first, as the spec lists it. */
export function releaseBlock(s: StatusV2, links: readonly string[]): WorktreeKeep | null {
  if (s.changed.some((p) => !isLinkPath(p, links))) return 'dirty'
  if (s.ignored.some((p) => !isLinkPath(p, links) && !isCachePath(p))) return 'ignored'
  if (s.head === null) return 'detached'
  return null
}

/**
 * The folder the sidebar groups a chat under: the one the user picked, not the worktree it runs in.
 * Chats with no picked folder each run in their own scratch folder, but share one "No folder" group.
 */
export const sidebarFolder = (c: { cwd: string; worktree?: ChatWorktree }): string =>
  c.worktree?.folder ?? (isScratchFolder(c.cwd) ? scratchParent(c.cwd) : c.cwd)
