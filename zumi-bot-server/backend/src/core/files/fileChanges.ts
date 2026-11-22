import type { ChatItem } from '@zumibot/shared/types'
import type { FileChange, PatchHunk } from '@zumibot/shared/files'
import { resolvePath } from '@zumibot/shared/chatFiles'
import { diffLines, splitLines } from '@zumibot/shared/lineDiff'
import { parseUnifiedDiff, reversePatch } from '@zumibot/shared/unifiedDiff'
import type { RunEvent } from '../chat/streamParser'
import { SNAPSHOT_MAX_BYTES, type SnapshotStore } from './snapshotStore'

export const PATCH_MAX_BYTES = 256 * 1024

type Obj = Record<string, unknown>
type Why = NonNullable<FileChange['why']>
type EditArgs = { old: string; new: string; all: boolean }
type Kept = { id: string | null; text: string | null }
type Read = { buf: Buffer } | { err: unknown }

// One `diff` block of an ACP edit result (`detail.acpDiffs`): a whole file's text, or one hunk of it.
type AcpText = { oldText: string | null; newText: string }

// One change of a Codex ApplyPatch result (`detail.codexChanges`); `cut` marks a diff the mapper had to shorten.
type CodexChange = { path: string; kind: string; movePath: string | null; diff: string; cut: boolean }

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is string => typeof v === 'string' && v !== ''
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

/** The Edit tool's own replacement: null when `find` is empty, absent, or (not `all`) found more than once. */
export function replaceString(text: string, find: string, repl: string, all: boolean): string | null {
  if (find === '') return null
  const parts = text.split(find)
  if (parts.length === 1) return null
  if (!all && parts.length > 2) return null
  // Joined by hand, never String.replace, so `$&` in the replacement means nothing.
  return all ? parts.join(repl) : parts[0] + repl + parts.slice(1).join(find)
}

/** What the CLI's Edit does: plain replacement, except that deleting text which ends mid-line also takes the newline after it. */
export function editAfter(orig: string, old: string, neu: string, all: boolean): string | null {
  const plain = replaceString(orig, old, neu, all)
  if (plain === null) return null // the CLI would have refused too, so the strings are not what it matched
  if (neu === '' && !old.endsWith('\n') && orig.includes(old + '\n')) return replaceString(orig, old + '\n', neu, all)
  return plain
}

const noCr = (l: string): string => (l.endsWith('\r') ? l.slice(0, -1) : l)
// The CLI may write a patch with leading tabs turned into spaces, so indentation is not compared.
const loose = (l: string): string => noCr(l).trimStart()

/** Applies hunks to the old lines; null when a hunk does not fit. A '\r' at a line's end and leading whitespace are ignored when matching. */
export function patchLines(lines: readonly string[], hunks: readonly PatchHunk[]): string[] | null {
  const out: string[] = []
  let pos = 0
  for (const h of hunks) {
    // With no old lines the start names the line before the insertion.
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1
    if (start < pos || start > lines.length) return null
    for (; pos < start; pos++) out.push(lines[pos])
    let oldN = 0
    let newN = 0
    for (const l of h.lines) {
      const text = l.slice(1)
      if (l[0] === '+') {
        out.push(text)
        newN++
      } else if (l[0] === ' ' || l[0] === '-') {
        if (pos >= lines.length || loose(lines[pos]) !== loose(text)) return null
        if (l[0] === ' ') {
          out.push(lines[pos])
          newN++
        }
        pos++
        oldN++
      } else return null
    }
    if (oldN !== h.oldLines || newN !== h.newLines) return null
  }
  for (; pos < lines.length; pos++) out.push(lines[pos])
  return out
}

// True only when the patch, applied to the old file, gives this text (line by line, CR and indentation aside).
function patchGives(orig: string, patch: PatchHunk[], text: string): boolean {
  const got = patchLines(splitLines(orig), patch)
  if (got === null) return false
  const want = splitLines(text)
  return got.length === want.length && got.every((l, i) => loose(l) === loose(want[i]))
}

/** The old file of an Edit, exactly or not at all. `prior` is an earlier kept copy of the same path. */
export function rebuildBefore(after: string, edit: EditArgs, prior: string | null): string | null {
  if (prior !== null && replaceString(prior, edit.old, edit.new, edit.all) === after) return prior
  if (edit.all || edit.new === '') return null
  const i = after.indexOf(edit.new)
  // An overlapping second hit counts too: the spot is then not certain.
  if (i < 0 || after.indexOf(edit.new, i + 1) >= 0) return null
  const candidate = after.slice(0, i) + edit.old + after.slice(i + edit.new.length)
  return replaceString(candidate, edit.old, edit.new, false) === after ? candidate : null
}

function patchBytes(patch: PatchHunk[]): number {
  let n = 0
  for (const h of patch) for (const l of h.lines) n += bytes(l) + 1
  return n
}

const withinCap = (p: PatchHunk[]): PatchHunk[] | null => (patchBytes(p) <= PATCH_MAX_BYTES ? p : null)

// Only hunks shaped as PatchHunk says, within the cap; anything else is null, never a guess.
function wellFormedPatch(v: unknown): PatchHunk[] | null {
  if (!Array.isArray(v)) return null
  const out: PatchHunk[] = []
  for (const h of v) {
    if (!isObj(h) || !isNum(h.oldStart) || !isNum(h.oldLines) || !isNum(h.newStart) || !isNum(h.newLines)) return null
    if (!Array.isArray(h.lines) || !h.lines.every((l) => typeof l === 'string' && /^[ +-]/.test(l))) return null
    out.push({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines as string[] })
  }
  return withinCap(out)
}

function codexChange(v: unknown): CodexChange | null {
  if (!isObj(v) || !isId(v.path) || typeof v.diff !== 'string') return null
  return {
    path: v.path,
    kind: typeof v.kind === 'string' ? v.kind : 'update',
    movePath: isId(v.movePath) ? v.movePath : null,
    diff: v.diff,
    cut: v.cut === true
  }
}

// A file's bytes as a copy: one regular file of at most 1 MiB, no NUL, valid UTF-8; else the reason it is not kept.
function decodeRead(got: Read): { text: string } | { miss: NonNullable<Why['after']> } {
  if ('err' in got) return { miss: 'unreadable' }
  if (got.buf.length > SNAPSHOT_MAX_BYTES) return { miss: 'too-big' }
  if (got.buf.includes(0)) return { miss: 'binary' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(got.buf) } // ignoreBOM keeps a leading BOM, so the copy is the file's bytes
  } catch {
    return { miss: 'binary' }
  }
}

export interface TrackerDeps {
  cwd: string
  chatId: string
  snapshots: Pick<SnapshotStore, 'put' | 'read'>
  now(): number
  items(): readonly ChatItem[] // the turn's live list, for earlier copies and parent items
  readFile(path: string): Promise<Buffer> // must reject unless a regular file; app passes an fstat-checked read
  log(msg: string, err?: unknown): void
}

type SubCall =
  | { kind: 'Edit'; path: string; edit: EditArgs; subagent: string | null }
  | { kind: 'Write'; path: string; content: string; subagent: string | null }

/** Turns Edit/Write results into FileChange records with whole-file copies. A rule that cannot be exact gives null and says why. */
export class FileTracker {
  private readonly calls = new Map<string, SubCall>()
  private readonly nested = new Map<string, string>() // a subagent's own Agent/Task call id -> the call it ran under
  private readonly patches = new Map<string, string | null>() // a Codex subagent's ApplyPatch call id -> the subagent

  constructor(private readonly d: TrackerDeps) {}

  async own(tool: { id: string; name: string; input: unknown }, detail: unknown): Promise<FileChange | null> {
    try {
      if ((tool.name !== 'Edit' && tool.name !== 'Write') || !isObj(detail) || !isId(tool.id)) return null
      const input = isObj(tool.input) ? tool.input : {}
      const file = isId(input.file_path) ? input.file_path : detail.filePath
      if (!isId(file)) return null
      const path = resolvePath(file, this.d.cwd)
      return tool.name === 'Edit' ? await this.ownEdit(tool.id, path, input, detail) : await this.ownWrite(tool.id, path, input, detail)
    } catch (err) {
      this.d.log('file change not recorded', err)
      return null
    }
  }

  // Not async, like subResult: each file's disk read starts before anything is awaited, so it is the file as the patch left it.
  // `subagent`: the Codex subagent that made the patch, which the Files panel names.
  ownPatch(tool: { id: string; name: string; input: unknown }, detail: unknown, subagent: string | null = null): Promise<FileChange[]> {
    try {
      if (tool.name !== 'ApplyPatch' || !isId(tool.id) || !isObj(detail) || !Array.isArray(detail.codexChanges)) return Promise.resolve([])
      const ts = this.d.now()
      const jobs: Promise<FileChange | null>[] = []
      for (const raw of detail.codexChanges) {
        const c = codexChange(raw)
        if (!c) continue
        const id = `${tool.id}:${jobs.length}`
        // An update's new file is on disk (at the moved path); an add's and a delete's whole text is the diff itself, unless cut.
        const path = resolvePath(c.kind === 'update' ? (c.movePath ?? c.path) : c.path, this.d.cwd)
        const read = c.kind === 'delete' || (c.kind === 'add' && !c.cut) ? null : this.startRead(path)
        const job =
          c.kind === 'add'
            ? this.patchAdd(id, ts, path, c, read, subagent)
            : c.kind === 'delete'
              ? this.patchDelete(id, ts, path, c, subagent)
              : this.patchUpdate(id, ts, path, c, read!, subagent)
        jobs.push(
          job.catch((err: unknown) => {
            this.d.log('file change not recorded', err)
            return null
          })
        )
      }
      return Promise.all(jobs).then((all) => all.filter((c): c is FileChange => c !== null))
    } catch (err) {
      this.d.log('file change not recorded', err)
      return Promise.resolve([])
    }
  }

  /**
   * An ACP edit's result: one change per path. A `diff` block is the file's whole old and new text, or (claude-agent-acp, for
   * a longer file) one hunk of it, one block per hunk; the file on disk tells them apart (`acpChange`). A missing `oldText`
   * is a new file.
   */
  async ownAcp(tool: { id: string; name: string; input: unknown }, detail: unknown): Promise<FileChange[]> {
    try {
      if (tool.name !== 'AcpEdit' || !isId(tool.id) || !isObj(detail) || !Array.isArray(detail.acpDiffs)) return []
      const ts = this.d.now()
      // One read per path, each started before anything is awaited, so it is the file as the edit left it.
      const files = new Map<string, { diffs: AcpText[]; read: Promise<Read> }>()
      for (const raw of detail.acpDiffs) {
        if (
          !isObj(raw) ||
          !isId(raw.path) ||
          typeof raw.newText !== 'string' ||
          (raw.oldText !== null && raw.oldText !== undefined && typeof raw.oldText !== 'string')
        )
          continue
        const path = resolvePath(raw.path, this.d.cwd)
        const diff = { oldText: typeof raw.oldText === 'string' ? raw.oldText : null, newText: raw.newText }
        const file = files.get(path)
        if (file) file.diffs.push(diff)
        else files.set(path, { diffs: [diff], read: this.startRead(path) })
      }
      const out: FileChange[] = []
      for (const [path, file] of files) {
        const id = `${tool.id}:${out.length}`
        try {
          out.push(await this.acpChange(id, ts, path, file.diffs, file.read))
        } catch (err) {
          this.d.log('file change not recorded', err)
        }
      }
      return out
    } catch (err) {
      this.d.log('file change not recorded', err)
      return []
    }
  }

  subUse(e: Extract<RunEvent, { kind: 'subToolUse' }>): void {
    try {
      // A malformed line can lack either id; such a call is never remembered.
      if (!isId(e.id) || !isId(e.parent)) return
      if (e.name === 'Agent' || e.name === 'Task') {
        this.nested.set(e.id, e.parent)
        return
      }
      // A Codex subagent's patch: its result carries the changes (subPatch). No Claude tool has this name.
      if (e.name === 'ApplyPatch') {
        this.patches.set(e.id, e.subagent)
        return
      }
      if (!isObj(e.input) || !isId(e.input.file_path)) return
      const path = resolvePath(e.input.file_path, this.d.cwd)
      if (e.name === 'Edit') {
        const { old_string: o, new_string: n, replace_all: all } = e.input
        if (typeof o !== 'string' || typeof n !== 'string') return
        this.calls.set(e.id, { kind: 'Edit', path, edit: { old: o, new: n, all: all === true }, subagent: e.subagent })
      } else if (e.name === 'Write' && typeof e.input.content === 'string') {
        this.calls.set(e.id, { kind: 'Write', path, content: e.input.content, subagent: e.subagent })
      }
    } catch (err) {
      this.d.log('file change not recorded', err)
    }
  }

  // Not async: an Edit's disk read must start before anything is awaited, so the file is still as the edit left it
  // (the subagent's next call needs another model round trip).
  subResult(e: Extract<RunEvent, { kind: 'subToolResult' }>): Promise<{ itemId: string; change: FileChange } | null> {
    try {
      if (!isId(e.toolUseId) || !isId(e.parent)) return Promise.resolve(null)
      const call = this.calls.get(e.toolUseId)
      if (!call) return Promise.resolve(null)
      this.calls.delete(e.toolUseId)
      if (e.isError) return Promise.resolve(null)
      const itemId = this.topLevel(e.parent)
      if (itemId === null) return Promise.resolve(null)
      const ts = this.d.now()
      let done: Promise<FileChange>
      if (call.kind === 'Edit') {
        done = this.subEdit(e.toolUseId, ts, call, this.startRead(call.path))
      } else {
        done = this.subWrite(e.toolUseId, ts, call, e.content)
      }
      return done.then(
        (change) => ({ itemId, change }),
        (err: unknown) => {
          this.d.log('file change not recorded', err)
          return null
        }
      )
    } catch (err) {
      this.d.log('file change not recorded', err)
      return Promise.resolve(null)
    }
  }

  /**
   * A Codex subagent's patch result, as ownPatch reads the main thread's, its changes labelled with the subagent and landing on
   * the top-level tool item (the Agent row). Null when the call is not a patch subUse remembered, or has no item to land on.
   * Not async: the disk reads start before anything is awaited.
   */
  subPatch(e: Extract<RunEvent, { kind: 'subToolResult' }>): { itemId: string; changes: Promise<FileChange[]> } | null {
    try {
      if (!isId(e.toolUseId) || !isId(e.parent) || !this.patches.has(e.toolUseId)) return null
      const subagent = this.patches.get(e.toolUseId) ?? null
      this.patches.delete(e.toolUseId)
      const itemId = this.topLevel(e.parent)
      if (itemId === null) return null
      if (e.isError) return { itemId, changes: Promise.resolve([]) }
      return { itemId, changes: this.ownPatch({ id: e.toolUseId, name: 'ApplyPatch', input: {} }, e.detail, subagent) }
    } catch (err) {
      this.d.log('file change not recorded', err)
      return null
    }
  }

  // The top-level tool item a subagent call belongs to, followed up through nested subagent calls.
  private topLevel(parent: string): string | null {
    const tools = new Set<string>()
    for (const it of this.d.items()) if (it.type === 'tool') tools.add(it.id)
    const seen = new Set<string>()
    let cur = parent
    while (!seen.has(cur)) {
      if (tools.has(cur)) return cur
      seen.add(cur)
      const up = this.nested.get(cur)
      if (up === undefined) return null
      cur = up
    }
    return null
  }

  private async keep(text: string, why: Why, side: 'before' | 'after'): Promise<Kept> {
    const r = await this.d.snapshots.put(this.d.chatId, text)
    if ('id' in r) return { id: r.id, text }
    why[side] = r.miss
    return { id: null, text: null }
  }

  private async ownEdit(id: string, path: string, input: Obj, detail: Obj): Promise<FileChange> {
    const why: Why = {}
    const oldS = typeof detail.oldString === 'string' ? detail.oldString : input.old_string
    const newS = typeof detail.newString === 'string' ? detail.newString : input.new_string
    const all = typeof detail.replaceAll === 'boolean' ? detail.replaceAll : input.replace_all === true
    const orig = typeof detail.originalFile === 'string' ? detail.originalFile : null
    let before: Kept = { id: null, text: null }
    let after: Kept = { id: null, text: null }
    if (orig === null) why.before = 'not-sent'
    else before = await this.keep(orig, why, 'before')
    // The CLI's own replacement, not the hunks (re-applying hunks can trip on CRLF), but a valid patch must agree with it.
    const patch = wellFormedPatch(detail.structuredPatch)
    let replaced = orig !== null && typeof oldS === 'string' && typeof newS === 'string' ? editAfter(orig, oldS, newS, all) : null
    if (replaced !== null && patch !== null && !patchGives(orig!, patch, replaced)) replaced = null
    if (replaced === null) why.after = 'unrebuilt'
    else after = await this.keep(replaced, why, 'after')
    return this.change(id, this.d.now(), path, 'update', patch, before.id, after.id, why)
  }

  private async ownWrite(id: string, path: string, input: Obj, detail: Obj): Promise<FileChange | null> {
    if (detail.type !== 'create' && detail.type !== 'update') return null
    const content = typeof detail.content === 'string' ? detail.content : input.content
    if (typeof content !== 'string') return null
    const why: Why = {}
    let before: Kept = { id: null, text: null }
    let patch: PatchHunk[] | null = null
    if (detail.type === 'update') {
      if (typeof detail.originalFile === 'string') before = await this.keep(detail.originalFile, why, 'before')
      else why.before = 'not-sent'
      patch = wellFormedPatch(detail.structuredPatch)
    }
    const after = await this.keep(content, why, 'after')
    return this.change(id, this.d.now(), path, detail.type, patch, before.id, after.id, why)
  }

  private async subWrite(id: string, ts: number, call: Extract<SubCall, { kind: 'Write' }>, result: string): Promise<FileChange> {
    const why: Why = {}
    const op = result.startsWith('File created successfully') ? 'create' : 'update'
    if (op === 'update') why.before = 'not-sent' // the stream never carried the old file
    const after = await this.keep(call.content, why, 'after')
    return this.change(id, ts, call.path, op, null, null, after.id, why, call.subagent)
  }

  private async subEdit(id: string, ts: number, call: Extract<SubCall, { kind: 'Edit' }>, read: Promise<Read>): Promise<FileChange> {
    const why: Why = {}
    const got = await read
    const decoded = decodeRead(got)
    const afterText = 'text' in decoded ? decoded.text : null
    if ('miss' in decoded) why.after = decoded.miss
    const after: Kept = afterText === null ? { id: null, text: null } : await this.keep(afterText, why, 'after')
    let before: Kept = { id: null, text: null }
    if (after.text === null) {
      why.before = 'unrebuilt' // nothing to rebuild from
    } else {
      const rebuilt = rebuildBefore(after.text, call.edit, await this.priorAfter(call.path))
      if (rebuilt === null) why.before = 'unrebuilt'
      else before = await this.keep(rebuilt, why, 'before')
    }
    const patch = before.text !== null && after.text !== null ? withinCap(diffLines(before.text, after.text)) : null
    // Without a patch the strings are all the panel can show; only when they fit the cap.
    const snippet =
      patch === null && bytes(call.edit.old) + bytes(call.edit.new) <= PATCH_MAX_BYTES
        ? { old: call.edit.old, new: call.edit.new }
        : undefined
    return this.change(id, ts, call.path, 'update', patch, before.id, after.id, why, call.subagent, snippet)
  }

  private startRead(path: string): Promise<Read> {
    let started: Promise<Buffer>
    try {
      started = this.d.readFile(path)
    } catch (err) {
      started = Promise.reject(err)
    }
    return started.then(
      (buf): Read => ({ buf }),
      (err: unknown): Read => ({ err })
    )
  }

  private async patchAdd(
    id: string,
    ts: number,
    path: string,
    c: CodexChange,
    read: Promise<Read> | null,
    subagent: string | null
  ): Promise<FileChange> {
    const why: Why = {}
    let text: string | null = null
    if (read === null) {
      if (c.diff.includes('\0')) why.after = 'binary'
      else text = c.diff // an add's diff is the whole new text, as a Write's content is
    } else {
      const got = decodeRead(await read) // cut: the diff is only the start, so the file is the one source
      if ('text' in got) text = got.text
      else why.after = got.miss
    }
    const after: Kept = text === null ? { id: null, text: null } : await this.keep(text, why, 'after')
    return this.change(id, ts, path, 'create', null, null, after.id, why, subagent)
  }

  private async patchDelete(id: string, ts: number, path: string, c: CodexChange, subagent: string | null): Promise<FileChange> {
    const why: Why = { after: 'deleted' }
    let before: Kept = { id: null, text: null }
    if (c.cut) why.before = 'too-big'
    else if (c.diff.includes('\0')) why.before = 'binary'
    else before = await this.keep(c.diff, why, 'before') // a delete's diff is the whole old text
    // The panel draws a patch first, so a deleted file still shows its lines.
    // An empty file has no lines to show: no patch, so the panel says it was deleted rather than "No changes".
    const patch = before.text === null || before.text === '' ? null : withinCap(diffLines(before.text, ''))
    return this.change(id, ts, path, 'update', patch, before.id, null, why, subagent)
  }

  private async patchUpdate(
    id: string,
    ts: number,
    path: string,
    c: CodexChange,
    read: Promise<Read>,
    subagent: string | null
  ): Promise<FileChange> {
    const why: Why = {}
    const got = decodeRead(await read)
    let after: Kept = { id: null, text: null }
    if ('miss' in got) why.after = got.miss
    else after = await this.keep(got.text, why, 'after')
    let before: Kept = { id: null, text: null }
    let patch: PatchHunk[] | null = null
    if (c.cut) {
      why.before = 'too-big' // only the start of the diff was kept
    } else {
      const hunks = after.text === null ? null : parseUnifiedDiff(c.diff)
      const rebuilt = hunks === null ? null : reversePatch(after.text!, hunks)
      if (rebuilt === null) {
        why.before = 'unrebuilt'
      } else {
        before = await this.keep(rebuilt, why, 'before')
        if (before.text !== null) patch = withinCap(hunks!)
      }
    }
    return this.change(id, ts, path, 'update', patch, before.id, after.id, why, subagent)
  }

  private async acpChange(id: string, ts: number, path: string, diffs: AcpText[], read: Promise<Read>): Promise<FileChange> {
    const disk = decodeRead(await read)
    if (diffs.length === 1) {
      let { oldText, newText } = diffs[0]
      // The whole file. Exactly the new text and a newline: the agent cut the file's last newline, so both copies get it back
      // (the old one only when it was written the same way), or the panel shows "no newline at end" and Restore's check of the
      // file against the after copy never matches.
      if ('text' in disk && (disk.text === newText || disk.text === newText + '\n')) {
        if (disk.text !== newText && oldText !== null && oldText !== '' && oldText.endsWith('\r') === newText.endsWith('\r'))
          oldText += '\n'
        return this.acpWhole(id, ts, path, oldText, disk.text)
      }
      // A new file's text is all of it (claude-agent-acp's null `oldText` means the old file had no lines): as sent, whatever the
      // disk says. Any other diff the disk cannot settle is never kept as a whole file: a hunk stored as one would let Restore
      // write it over the whole file.
      if (oldText === null) return this.acpWhole(id, ts, path, oldText, newText)
    }
    return this.acpHunks(id, ts, path, diffs, disk)
  }

  // Hunks, as a subagent's Edit: the disk is the after copy, and the before is rebuilt by putting each hunk's old text back in
  // the one place its new text is, last hunk first, exactly or not at all. Never the fragments as whole files.
  private async acpHunks(id: string, ts: number, path: string, diffs: AcpText[], disk: ReturnType<typeof decodeRead>): Promise<FileChange> {
    const why: Why = {}
    let after: Kept = { id: null, text: null }
    if ('miss' in disk) why.after = disk.miss
    else after = await this.keep(disk.text, why, 'after')
    // An earlier kept copy settles a lone hunk whose new text is found twice (rebuildBefore checks it gives the disk text).
    const prior = diffs.length === 1 && after.text !== null ? await this.priorAfter(path) : null
    let rebuilt = after.text
    for (let i = diffs.length - 1; i >= 0 && rebuilt !== null; i--) {
      const d = diffs[i]
      rebuilt = d.oldText === null ? null : rebuildBefore(rebuilt, { old: d.oldText, new: d.newText, all: false }, prior)
    }
    let before: Kept = { id: null, text: null }
    if (rebuilt === null) why.before = 'unrebuilt'
    else before = await this.keep(rebuilt, why, 'before')
    const patch = before.text !== null && after.text !== null ? withinCap(diffLines(before.text, after.text)) : null
    // Without a patch a lone hunk's strings are all the panel can show; only when they fit the cap.
    const lone = diffs.length === 1 ? diffs[0] : null
    const snippet =
      patch === null && lone !== null && lone.oldText !== null && bytes(lone.oldText) + bytes(lone.newText) <= PATCH_MAX_BYTES
        ? { old: lone.oldText, new: lone.newText }
        : undefined
    return this.change(id, ts, path, 'update', patch, before.id, after.id, why, null, snippet)
  }

  private async acpWhole(id: string, ts: number, path: string, oldText: string | null, newText: string): Promise<FileChange> {
    const why: Why = {}
    const before: Kept = oldText === null ? { id: null, text: null } : await this.keep(oldText, why, 'before')
    const after = await this.keep(newText, why, 'after')
    const patch = before.text !== null && after.text !== null ? withinCap(diffLines(before.text, after.text)) : null
    return this.change(id, ts, path, oldText === null ? 'create' : 'update', patch, before.id, after.id, why)
  }

  // Text of the newest earlier kept "after" of this path, the likely old file of the next edit.
  private async priorAfter(path: string): Promise<string | null> {
    const items = this.d.items()
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.type !== 'tool' || !it.changes) continue
      for (let j = it.changes.length - 1; j >= 0; j--) {
        const c = it.changes[j]
        if (c.path === path && c.after !== null) return this.d.snapshots.read(this.d.chatId, c.after)
      }
    }
    return null
  }

  private change(
    id: string,
    ts: number,
    path: string,
    op: FileChange['op'],
    patch: PatchHunk[] | null,
    before: string | null,
    after: string | null,
    why: Why,
    subagent: string | null = null,
    snippet?: { old: string; new: string }
  ): FileChange {
    const c: FileChange = { id, ts, path, op, patch, before, after }
    if (why.before || why.after) c.why = why
    if (snippet) c.snippet = snippet
    if (subagent !== null) c.subagent = subagent
    return c
  }
}
