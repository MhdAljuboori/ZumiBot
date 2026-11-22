import type { ChangedFile, ChangeStep, ChatFileList, PatchHunk, SnapshotMiss } from '@zumibot/shared/files'
import { RESTORE_REFUSALS, restorePlan } from '@zumibot/shared/fileRestore'
import type { Attachment } from '@zumibot/shared/types'
import { diffLines, splitLines } from '@zumibot/shared/lineDiff'

export type FileView = 'diff' | 'old' | 'new'
export type StepPick = 'all' | number // index into ChangedFile.changes
export type MissReason = SnapshotMiss | 'created' | 'legacy'
export type Side = { id: string } | { text: string } | { miss: MissReason }

export const MISS_TEXT: Record<MissReason, string> = {
  created: 'File did not exist before this chat',
  'too-big': 'Not kept: file over 1 MB',
  binary: 'Not kept: binary file',
  'not-sent': "Not kept: Claude Code didn't send this version",
  unrebuilt: "Not kept: couldn't rebuild this version exactly",
  unreadable: "Not kept: couldn't read the file after the change",
  deleted: 'File was deleted by this change',
  legacy: 'Not kept for changes made before this feature'
}

const NO_CHANGES = 'No changes'
const FINAL_NEWLINE_ONLY = 'Only the final newline changed'

function stepSides(s: ChangeStep): { before: Side; after: Side } {
  const before: Side =
    s.before !== null
      ? { id: s.before }
      : s.op === 'create'
        ? { miss: 'created' }
        : s.why?.before
          ? { miss: s.why.before }
          : { miss: 'legacy' }
  const after: Side =
    s.after !== null
      ? { id: s.after }
      : s.legacy && 'content' in s.legacy
        ? { text: s.legacy.content } // a legacy Write kept its content on the item
        : s.why?.after
          ? { miss: s.why.after }
          : { miss: 'legacy' }
  return { before, after }
}

/** The two texts a pick compares: one step's own, or the first step's before against the last step's after. */
export function sidesOf(file: ChangedFile, pick: StepPick): { before: Side; after: Side } {
  const { changes } = file
  if (changes.length === 0) return { before: { miss: 'legacy' }, after: { miss: 'legacy' } }
  if (pick === 'all') return { before: stepSides(changes[0]).before, after: stepSides(changes[changes.length - 1]).after }
  return stepSides(changes[pick] ?? changes[changes.length - 1])
}

export type DiffSource =
  | { kind: 'patch'; hunks: PatchHunk[] }
  | { kind: 'texts'; before: Side; after: Side }
  | { kind: 'strings'; old: string; new: string } // snippet or legacy: no line numbers
  | { kind: 'steps'; parts: Array<{ label: string; source: Exclude<DiffSource, { kind: 'steps' }> }> }

function stepSource(s: ChangeStep): Exclude<DiffSource, { kind: 'steps' }> {
  if (s.patch) return { kind: 'patch', hunks: s.patch }
  const sides = stepSides(s)
  if ('id' in sides.before && 'id' in sides.after) return { kind: 'texts', ...sides }
  if (s.snippet) return { kind: 'strings', old: s.snippet.old, new: s.snippet.new }
  if (s.legacy && 'oldString' in s.legacy) return { kind: 'strings', old: s.legacy.oldString, new: s.legacy.newString }
  return { kind: 'texts', ...sides } // the component shows the miss text
}

/** What to draw for a pick. `all` over steps whose ends are not both kept lists each step's own diff instead. */
export function diffSource(file: ChangedFile, pick: StepPick, label: (i: number) => string): DiffSource {
  const { changes } = file
  if (changes.length === 0) return { kind: 'texts', before: { miss: 'legacy' }, after: { miss: 'legacy' } }
  if (pick !== 'all') return stepSource(changes[pick] ?? changes[changes.length - 1])
  if (changes.length === 1) return stepSource(changes[0]) // one change: its own patch
  const { before, after } = sidesOf(file, 'all')
  const beforeUsable = 'id' in before || ('miss' in before && before.miss === 'created')
  if (beforeUsable && 'id' in after) return { kind: 'texts', before, after }
  return { kind: 'steps', parts: changes.map((s, i) => ({ label: label(i), source: stepSource(s) })) }
}

export type Row =
  | { kind: 'hunk' | 'step' | 'same' | 'miss'; text: string }
  | { kind: 'ctx' | 'add' | 'del'; text: string; oldNo: number | null; newNo: number | null }

const same = (): Row[] => [{ kind: 'same', text: NO_CHANGES }]

/** The diff of two whole texts. Texts that differ only in the final newline have no line rows, so they get a row saying so. */
export function rowsFromTexts(before: string, after: string): Row[] {
  const hunks = diffLines(before, after)
  if (hunks.length === 0 && before !== after) return [{ kind: 'same', text: FINAL_NEWLINE_ONLY }]
  return rowsFromHunks(hunks)
}

/** A hunk header row, then each line numbered from the hunk's starts. */
export function rowsFromHunks(hunks: PatchHunk[]): Row[] {
  if (hunks.length === 0) return same()
  const rows: Row[] = []
  for (const h of hunks) {
    rows.push({ kind: 'hunk', text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` })
    let o = h.oldStart
    let n = h.newStart
    for (const line of h.lines) {
      const text = line.slice(1)
      if (line[0] === '-') rows.push({ kind: 'del', text, oldNo: o++, newNo: null })
      else if (line[0] === '+') rows.push({ kind: 'add', text, oldNo: null, newNo: n++ })
      else rows.push({ kind: 'ctx', text, oldNo: o++, newNo: n++ })
    }
  }
  return rows
}

/** A diff of two snippets with no line numbers, since they are not whole files. */
export function rowsFromStrings(old: string, neu: string): Row[] {
  const hunks = diffLines(old, neu, Number.MAX_SAFE_INTEGER) // one hunk, so no gaps between changes
  if (hunks.length === 0) return same()
  return rowsFromHunks(hunks)
    .filter((r) => r.kind !== 'hunk')
    .map((r) => (r.kind === 'ctx' || r.kind === 'add' || r.kind === 'del' ? { ...r, oldNo: null, newNo: null } : r))
}

/** A whole file as numbered rows, for the old and new views. */
export function rowsOfText(text: string, view: 'old' | 'new'): Row[] {
  return splitLines(text).map((line, i): Row => ({
    kind: 'ctx',
    text: line,
    oldNo: view === 'old' ? i + 1 : null,
    newNo: view === 'new' ? i + 1 : null
  }))
}

type Numbered = Extract<Row, { oldNo: number | null }>

/** The file line range of rows a..b (either order). Old lines are reported only when no new-side line is selected. */
export function selectedLines(rows: Row[], a: number, b: number, view: FileView): { from: number; to: number; old: boolean } | null {
  const lo = Math.max(0, Math.min(a, b))
  const hi = Math.min(rows.length - 1, Math.max(a, b))
  const picked = rows.slice(lo, hi + 1).filter((r): r is Numbered => 'oldNo' in r)
  // Looped, since spreading a long array into Math.min/max throws past ~120k items.
  const range = (nums: number[], old: boolean): { from: number; to: number; old: boolean } | null => {
    if (nums.length === 0) return null
    let from = nums[0]
    let to = nums[0]
    for (const n of nums) {
      if (n < from) from = n
      if (n > to) to = n
    }
    return { from, to, old }
  }
  const olds = picked.flatMap((r) => (r.oldNo === null ? [] : [r.oldNo]))
  if (view === 'old') return range(olds, true)
  const news = picked.flatMap((r) => (r.newNo === null ? [] : [r.newNo]))
  return news.length > 0 ? range(news, false) : range(olds, true)
}

/** The block a Quote or Explain carries: file and lines on the first line, then the text in a fence longer than any backtick run in it. */
export function quoteBlock(shown: string, lines: ReturnType<typeof selectedLines>, text: string): string {
  const where = lines === null ? shown : lines.from === lines.to ? `${shown}:${lines.from}` : `${shown}:${lines.from}-${lines.to}`
  let longest = 0
  for (const m of text.match(/`+/g) ?? []) if (m.length > longest) longest = m.length
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `\`${where}\`${lines?.old ? ' (old)' : ''}\n${fence}\n${text}\n${fence}`
}

/** The draft with the block after it, then an empty line for what is typed next. */
export function withFileQuote(draft: string, block: string): string {
  const before = draft.trimEnd()
  return `${before}${before === '' ? '' : '\n'}${block}\n`
}

/** The message Explain sends. In a room the `@member` sits before the block, because code spans are masked from mentions. */
export function explainFileText(block: string, member?: string): string {
  return `${member ? `@${member} ` : ''}${block}\nExplain this selected text`
}

/** Who made a change: the agent, and the subagent it ran, when it ran one. */
export function whoLabel(step: ChangeStep, name: (agent: string) => string): string {
  if (!step.agent) return step.subagent ?? ''
  return step.subagent ? `${name(step.agent)} › ${step.subagent}` : name(step.agent)
}

export function filesCount(list: ChatFileList | null): number {
  return list ? list.changed.length + list.attached.length : 0
}

const EMPTY_FILE = 'Empty file'
const missRows = (reason: MissReason): Row[] => [{ kind: 'miss', text: MISS_TEXT[reason] }]

type Read = { text: string } | { miss: MissReason } | null

/** A side's text; null while its copy is still being fetched. */
function readSide(s: Side, textOf: (id: string) => string | undefined): Read {
  if ('text' in s) return { text: s.text }
  if ('miss' in s) return { miss: s.miss }
  const t = textOf(s.id)
  return t === undefined ? null : { text: t }
}

/** The ids of the kept copies a diff reads. */
export function idsOf(source: DiffSource): string[] {
  if (source.kind === 'steps') return source.parts.flatMap((p) => idsOf(p.source))
  if (source.kind !== 'texts') return []
  if (missOf(source) !== null) return [] // the miss is the answer; nothing to fetch for it
  return [source.before, source.after].flatMap((s) => ('id' in s ? [s.id] : []))
}

/** The reason a texts diff cannot be drawn: its after side is not kept, or its before side is not (a created file has none by design). */
function missOf(source: Extract<DiffSource, { kind: 'texts' }>): MissReason | null {
  if ('miss' in source.after) return source.after.miss
  return 'miss' in source.before && source.before.miss !== 'created' ? source.before.miss : null
}

/** The rows of a diff; null until every copy it reads is loaded. A side that is not kept becomes one `miss` row saying why. */
export function diffRows(source: DiffSource, textOf: (id: string) => string | undefined): Row[] | null {
  switch (source.kind) {
    case 'patch':
      return rowsFromHunks(source.hunks)
    case 'strings':
      return rowsFromStrings(source.old, source.new)
    case 'steps': {
      const rows: Row[] = []
      for (const part of source.parts) {
        const sub = diffRows(part.source, textOf)
        if (sub === null) return null
        rows.push({ kind: 'step', text: part.label }, ...sub)
      }
      return rows
    }
    case 'texts': {
      const miss = missOf(source)
      if (miss !== null) return missRows(miss)
      const before = readSide(source.before, textOf)
      const after = readSide(source.after, textOf)
      if (before === null || after === null) return null
      // The same copy twice: nothing to compare.
      if ('id' in source.before && 'id' in source.after && source.before.id === source.after.id) return rowsFromHunks([])
      // After missOf, the after side has text, and the before side has text or is a created file's (empty).
      return rowsFromTexts('text' in before ? before.text : '', 'text' in after ? after.text : '')
    }
  }
}

/** The rows of the Old or New view; null until the copy is loaded. */
export function viewRows(side: Side, view: 'old' | 'new', textOf: (id: string) => string | undefined): Row[] | null {
  const r = readSide(side, textOf)
  if (r === null) return null
  if ('miss' in r) return missRows(r.miss)
  return r.text === '' ? [{ kind: 'same', text: EMPTY_FILE }] : rowsOfText(r.text, view)
}

/** The snapshot ids the current view needs: the diff's, or the one side shown. */
export function neededIds(view: FileView, source: DiffSource | null, sides: { before: Side; after: Side }): string[] {
  if (view === 'diff') return source ? idsOf(source) : []
  const side = view === 'old' ? sides.before : sides.after
  return 'id' in side ? [side.id] : []
}

const TEXT_MIME = /^text\/|(?:json|xml|yaml|toml|javascript|x-sh)$/
export const TEXT_ATTACHMENT_MAX = 1024 * 1024

// The server stages every file but an image as application/octet-stream, so a text file is known by its name too.
const TEXT_NAME =
  /(?:^|\.)(?:txt|text|md|markdown|rst|adoc|tex|log|csv|tsv|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|properties|env|xml|html?|svg|css|scss|less|js|mjs|cjs|jsx|ts|mts|cts|tsx|vue|svelte|py|rb|go|rs|java|kts?|scala|swift|c|h|cc|cpp|hpp|cs|php|pl|lua|r|sh|bash|zsh|fish|ps1|sql|graphql|gql|proto|diff|patch|srt|vtt|gradle|dockerfile|makefile|gitignore|editorconfig)$/i

/** An attachment shown as text in the panel and the viewer: a text type or a text file's name, up to 1 MiB. */
export function isTextAttachment(a: Pick<Attachment, 'mime' | 'size'> & { name?: string }): boolean {
  return a.size <= TEXT_ATTACHMENT_MAX && (TEXT_MIME.test(a.mime) || (a.name !== undefined && TEXT_NAME.test(a.name)))
}

/** Text that holds a NUL is a binary file under a text name: shown as a file, not as garbage. */
export const looksBinary = (text: string): boolean => text.includes('\u0000')

/** A shown path split into its file name and folder. */
export function splitPath(shown: string): { name: string; dir: string } {
  const i = Math.max(shown.lastIndexOf('/'), shown.lastIndexOf('\\'))
  return i < 0 ? { name: shown, dir: '' } : { name: shown.slice(i + 1), dir: shown.slice(0, i) }
}

/** A step in the picker: its number, what it did, who, and when. */
export function stepLabel(step: ChangeStep, i: number, who: string, time: string): string {
  return [`${i + 1}. ${step.op === 'create' ? 'Created' : 'Edited'}`, who, time].filter((p) => p !== '').join(' · ')
}

export type RestoreButton =
  | { fromId: string; toId: string; label: string; confirm: string; disabled: null }
  | { fromId: string; toId: string; label: string; confirm: string; disabled: string } // the reason, as a tooltip

/**
 * The Restore button for a pick: undo one step, or every step (back to the file before this chat). Greyed out by the
 * server's own rule (`restorePlan`), plus while the chat runs; whether the disk still matches is only known on press.
 */
export function restoreButton(file: ChangedFile, pick: StepPick, running: boolean): RestoreButton | null {
  const { changes } = file
  if (changes.length === 0) return null
  const all = pick === 'all' && changes.length > 1
  const first = pick === 'all' ? changes[0] : (changes[pick] ?? changes[changes.length - 1])
  const last = pick === 'all' ? changes[changes.length - 1] : first
  const plan = restorePlan(file, first.id, last.id)
  const removes = !('refused' in plan) && 'remove' in plan.put
  const label = all ? 'Restore to before all changes' : 'Restore to before this change'
  const confirm = removes
    ? 'The file did not exist before, so it will be moved to the Trash.'
    : all
      ? 'The file on disk will be put back as it was before the first change in this chat.'
      : 'The file on disk will be put back as it was before this change.'
  const base = { fromId: first.id, toId: last.id, label, confirm }
  if ('refused' in plan) return { ...base, disabled: RESTORE_REFUSALS[plan.refused] }
  if (running) return { ...base, disabled: RESTORE_REFUSALS.running }
  return { ...base, disabled: null }
}

/** What the panel says after a restore. */
export function restoredText(done: 'written' | 'trashed' | 'unchanged'): string {
  return done === 'trashed' ? 'Moved to the Trash.' : done === 'unchanged' ? 'Already as it was.' : 'Restored.'
}
