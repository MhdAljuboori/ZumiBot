import { isAbsolute, relative, resolve, sep } from 'node:path'
import { CODEX_CARD_DIFF_MAX, CODEX_DIFF_MAX, cardChanges } from '../codex/codexEvents'

// Gives an ACP tool call the stable tool name and input the card and the remembered rules key on. Pure.

// What an AcpEdit card shows of each diff, and of all of them together: the same as Codex's ApplyPatch cards.
export const ACP_DIFF_MAX = CODEX_DIFF_MAX
export const ACP_CARD_DIFF_MAX = CODEX_CARD_DIFF_MAX

export interface AcpToolCall {
  kind?: unknown
  title?: unknown
  rawInput?: unknown
  content?: unknown
  locations?: unknown
}
export interface AcpDiff {
  path: string
  oldText: string | null
  newText: string
}
export interface Classified {
  toolName: string
  input: unknown
  rememberable: boolean
}

type Obj = Record<string, any>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** The `diff` items of a tool call's content, as before and after text (`oldText` null for a new file). */
export function diffsOf(content: unknown): AcpDiff[] {
  const out: AcpDiff[] = []
  for (const c of list(content)) {
    const o = obj(c)
    const path = str(o?.path)
    const newText = str(o?.newText)
    if (o?.type !== 'diff' || path === null || newText === null) continue
    out.push({ path, oldText: str(o.oldText), newText })
  }
  return out
}

// The files a call names: its diffs, its locations, then the usual rawInput keys. First sight wins, order kept.
function pathsOf(tc: Obj, diffs: AcpDiff[]): string[] {
  const seen = new Set<string>()
  const add = (p: unknown) => {
    if (typeof p === 'string' && p !== '') seen.add(p)
  }
  for (const d of diffs) add(d.path)
  for (const l of list(tc.locations)) add(obj(l)?.path)
  const raw = obj(tc.rawInput)
  add(raw?.path)
  add(raw?.file_path)
  add(raw?.filePath)
  return [...seen]
}

function inside(root: string, p: string): boolean {
  if (root === '' || p.includes('\0')) return false
  const rel = relative(resolve(root), resolve(root, p))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

// A readable change for the card; the whole text is what the digest covers when it is cut.
function diffText(d: AcpDiff): string {
  const lines = (t: string, mark: string) =>
    t
      .split('\n')
      .map((l) => mark + l)
      .join('\n')
  return `--- ${d.path}\n+++ ${d.path}\n${d.oldText === null ? '' : lines(d.oldText, '-') + '\n'}${lines(d.newText, '+')}`
}

export function classifyTool(tc: AcpToolCall, root: string): Classified {
  const o = obj(tc) ?? {}
  const kind = str(o.kind)
  const title = str(o.title) ?? ''
  const raw = obj(o.rawInput)
  if (kind === 'execute') {
    const command = str(raw?.command)
    if (command !== null && command.trim() !== '') return { toolName: 'Bash', input: { command }, rememberable: true }
  } else if (kind === 'edit' || kind === 'delete' || kind === 'move') {
    const diffs = diffsOf(o.content)
    const paths = pathsOf(o, diffs)
    const cut = cardChanges(diffs.map((d) => ({ path: d.path, kind, diff: diffText(d), movePath: null })))
    // A move's destination may sit in a rawInput key nothing here reads, so a move is asked every time, marked on its card.
    if (kind === 'move') return { toolName: 'AcpEdit', input: { paths, diffs: cut, move: true }, rememberable: false }
    return { toolName: 'AcpEdit', input: { paths, diffs: cut }, rememberable: paths.length > 0 && paths.every((p) => inside(root, p)) }
  } else if (kind === 'read' || kind === 'search') {
    const paths = pathsOf(o, [])
    return { toolName: 'AcpRead', input: paths.length ? { paths } : { title }, rememberable: true }
  } else if (kind === 'fetch') {
    const url = str(raw?.url)
    return { toolName: 'AcpFetch', input: url !== null ? { url } : { title }, rememberable: true }
  }
  // think, switch_mode, other, a missing or unknown kind, execute with no command: asked every time.
  return { toolName: 'AcpCall', input: { title, rawInput: o.rawInput }, rememberable: false }
}

/**
 * Whether a card may be remembered (chat memory, the agent's rules, a workflow step's rules), from what the permission event
 * carries: its classified tool name and input. The same rule as `classifyTool`'s `rememberable`, which the event does not carry.
 * An unclassified call never; a move never; an edit only when every path it names is inside `root` (the chat's folder or
 * worktree); any other name is asked every time.
 */
export function acpRememberable(toolName: string, input: unknown, root: string): boolean {
  switch (toolName) {
    case 'Bash':
    case 'AcpRead':
    case 'AcpFetch':
      return true
    case 'AcpEdit': {
      const o = obj(input)
      if (o?.move === true) return false // a move: its destination may be anywhere (classifyTool)
      const paths = o?.paths
      return Array.isArray(paths) && paths.length > 0 && paths.every((p) => typeof p === 'string' && p !== '' && inside(root, p))
    }
    default:
      return false
  }
}
