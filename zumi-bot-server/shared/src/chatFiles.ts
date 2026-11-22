import type { ChangeStep, ChangedFile, AttachedFile, ChatFileList } from './files'
import type { ChatItem } from './types'

// Pure string work: shared also runs in the browser, so no node:path. A Windows server's paths start with a drive
// (`C:\` or `C:/`): those take either slash, come out with backslashes, and compare without letter case, as NTFS does.
const DRIVE = /^[A-Za-z]:[\\/]/
const isWin = (p: string): boolean => DRIVE.test(p)

function normalize(p: string): string {
  const win = isWin(p)
  const out: string[] = []
  for (const part of (win ? p.slice(2) : p).split(win ? /[\\/]/ : '/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return win ? `${p[0]!.toUpperCase()}:\\${out.join('\\')}` : '/' + out.join('/')
}

export function resolvePath(p: string, cwd: string): string {
  if (isWin(p)) return normalize(p)
  // A rooted path without a drive (`\x`) is on the cwd's drive.
  if (isWin(cwd)) return normalize(/^[\\/]/.test(p) ? `${cwd.slice(0, 2)}${p}` : `${cwd}\\${p}`)
  return normalize(p.startsWith('/') ? p : `${cwd}/${p}`)
}

/** The part of path under dir with `/` separators (so callers match it the same everywhere), or null. */
function inside(path: string, dir: string): string | null {
  if (isWin(dir)) {
    if (!isWin(path)) return null
    const base = normalize(dir).replace(/\\+$/, '')
    const full = normalize(path)
    return full.toLowerCase().startsWith(base.toLowerCase() + '\\') ? full.slice(base.length + 1).replace(/\\/g, '/') : null
  }
  const base = dir.replace(/\/+$/, '')
  return path.startsWith(base + '/') ? path.slice(base.length + 1) : null
}

export function shownPath(path: string, cwd: string, home: string): string {
  const rel = inside(path, cwd)
  if (rel !== null) return rel
  const underHome = inside(path, home)
  return underHome !== null ? `~/${underHome}` : path
}

// The CLI's own notes (project memory, plans) and agent memory are not the user's files. They live in the CLI's
// config dir, which CLAUDE_CONFIG_DIR can move away from ~/.claude.
export function isBookkeeping(path: string, home: string, claudeDir = `${home}/.claude`): boolean {
  const rel = inside(path, claudeDir) ?? inside(path, `${home}/.claude`)
  if (rel === null) return false
  return rel.startsWith('plans/') || rel.startsWith('agent-memory/') || /^projects\/[^/]+\/memory\//.test(rel)
}

type ToolItem = Extract<ChatItem, { type: 'tool' }>

// Steps for a tool item saved before changes were recorded; a failed, blocked or unfinished call changed nothing.
function legacyStep(item: ToolItem, cwd: string): { path: string; step: ChangeStep } | null {
  if (item.name !== 'Edit' && item.name !== 'Write') return null
  if (item.isError || item.blocked || item.result === null) return null
  const input = item.input
  if (typeof input !== 'object' || input === null) return null
  const i = input as Record<string, unknown>
  if (typeof i.file_path !== 'string') return null
  const base = { itemId: item.id, id: item.id, ts: item.ts, agent: item.agent, patch: null, before: null, after: null }
  if (item.name === 'Edit') {
    if (typeof i.old_string !== 'string' || typeof i.new_string !== 'string') return null
    return {
      path: resolvePath(i.file_path, cwd),
      step: { ...base, op: 'update', legacy: { oldString: i.old_string, newString: i.new_string } }
    }
  }
  if (typeof i.content !== 'string') return null
  return { path: resolvePath(i.file_path, cwd), step: { ...base, op: 'unknown', legacy: { content: i.content } } }
}

export function listChatFiles(items: readonly ChatItem[], cwd: string, home: string, claudeDir?: string): ChatFileList {
  const byPath = new Map<string, ChangeStep[]>()
  const add = (path: string, step: ChangeStep) => {
    if (isBookkeeping(path, home, claudeDir)) return
    const steps = byPath.get(path)
    if (steps) steps.push(step)
    else byPath.set(path, [step])
  }
  const attached: AttachedFile[] = []

  for (const item of items) {
    if (item.type === 'user') {
      for (const attachment of item.attachments ?? []) attached.push({ itemId: item.id, ts: item.ts, attachment })
    } else if (item.type === 'tool') {
      if (item.changes) {
        for (const { path, ...c } of item.changes) add(path, { ...c, itemId: item.id, agent: item.agent })
      } else {
        const legacy = legacyStep(item, cwd)
        if (legacy) add(legacy.path, legacy.step)
      }
    }
  }

  const changed: ChangedFile[] = []
  for (const [path, steps] of byPath) {
    steps.sort((a, b) => a.ts - b.ts) // stable, so equal ts keep item order
    changed.push({ path, shown: shownPath(path, cwd, home), created: steps[0].op === 'create', changes: steps })
  }
  changed.sort((a, b) => b.changes[b.changes.length - 1].ts - a.changes[a.changes.length - 1].ts)
  attached.sort((a, b) => b.ts - a.ts)
  return { changed, attached }
}
