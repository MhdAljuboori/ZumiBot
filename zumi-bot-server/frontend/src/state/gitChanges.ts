import type { GitChangedFile, GitChangeKind, GitChanges, GitFileDiff, GitSide, GitSideMiss } from '@zumibot/shared/types'
import { rowsFromTexts, rowsOfText, type FileView, type Row } from './filesPanel'

/** The letter in a Changes row's badge and the word its tooltip says, as source-control panels write them. */
export const KIND: Record<GitChangeKind, { letter: string; label: string }> = {
  modified: { letter: 'M', label: 'Modified' },
  added: { letter: 'A', label: 'Added' },
  deleted: { letter: 'D', label: 'Deleted' },
  renamed: { letter: 'R', label: 'Renamed' },
  copied: { letter: 'C', label: 'Copied' },
  typechange: { letter: 'T', label: 'Type changed' },
  untracked: { letter: 'U', label: 'Untracked' },
  conflicted: { letter: '!', label: 'Conflict' }
}

// 'absent' has its own words per view, below.
const SIDE_MISS: Record<Exclude<GitSideMiss, 'absent'>, string> = {
  binary: 'Binary file',
  'too-big': 'File over 1 MB',
  unreadable: "Couldn't read this file",
  submodule: 'Submodule: no text to show'
}

const textOf = (s: GitSide): string | null => ('text' in s ? s.text : null)
const missRows = (text: string): Row[] => [{ kind: 'miss', text }]
const note = (text: string): Row[] => [{ kind: 'same', text }]

/** What the preview draws for one file in one view. A side that has no text explains itself; a missing side is empty. */
export function changeRows(d: GitFileDiff, view: FileView): Row[] {
  if (view === 'diff') {
    for (const s of [d.before, d.after]) if ('miss' in s && s.miss !== 'absent') return missRows(SIDE_MISS[s.miss])
    const before = textOf(d.before)
    const after = textOf(d.after)
    if (before === after) return note(before === null ? 'No changes' : 'No changes to its text')
    if ((before ?? '') === '' && (after ?? '') === '') return note('Empty file')
    return rowsFromTexts(before ?? '', after ?? '')
  }
  const side = view === 'old' ? d.before : d.after
  if ('miss' in side)
    return side.miss === 'absent'
      ? missRows(view === 'old' ? 'Not in the last commit' : 'Deleted from the folder')
      : missRows(SIDE_MISS[side.miss])
  return side.text === '' ? note('Empty file') : rowsOfText(side.text, view)
}

/** The text Copy takes: the old file in the Old view, else the file as it is now. */
export function copyText(d: GitFileDiff, view: FileView): string | null {
  return textOf(view === 'old' ? d.before : d.after)
}

/** Added and removed lines over the files that have counts. */
export function lineTotals(files: readonly GitChangedFile[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const f of files) {
    added += f.added ?? 0
    removed += f.removed ?? 0
  }
  return { added, removed }
}

/** "3 files changed" (one file: "1 file changed"), counting the ones past the cap too. */
export function filesLine(c: GitChanges): string {
  const n = c.files.length + c.more
  return n === 0 ? 'No uncommitted changes' : `${n} ${n === 1 ? 'file' : 'files'} changed`
}

/** The file the preview shows: the one picked while it is still listed, else the first. */
export function shownPath(files: readonly GitChangedFile[], picked: string | null): string | null {
  if (picked !== null && files.some((f) => f.path === picked)) return picked
  return files[0]?.path ?? null
}

/** The path line over the preview; a rename or copy names where it came from. */
export function pathLine(f: GitChangedFile): string {
  return f.from !== undefined ? `${f.from} → ${f.path}` : f.path
}
