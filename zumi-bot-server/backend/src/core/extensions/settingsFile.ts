import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { EXT_TEXT, type HookFile, type HookInput, type HookPosition } from '@zumibot/shared/extensions'
import { writeFileAtomic } from '../fsutil'

// The page sends these, so they live with the RPC contract.
export type { HookInput, HookPosition }

// Text edits of Claude Code's JSON settings files (and `.mcp.json`, which is the same kind of file). The edits are pure
// functions over the parsed object, so only the keys they touch change and the rest keeps its order. The only I/O is
// `writeSettings`. Errors are EXT_TEXT sentences or a bare error code: a message holding a path or file text would reach the page.

export type Settings = Record<string, unknown>

export interface HookRow {
  event: string
  matcher: string
  at: HookPosition
  type: string
  command: string
  timeout: number | null
}

/** The file's content hash, for the stale check; `'absent'` for a file that is not there. */
export function stampOf(text: string | null): string {
  return text === null ? 'absent' : createHash('sha256').update(text).digest('hex')
}

/** How each file is named in a sentence. */
export const SETTINGS_LABEL: Record<HookFile, string> = {
  user: 'Your settings.json',
  project: 'The project settings.json',
  local: 'The project settings.local.json'
}

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

// A plain assignment would turn a `__proto__` key into a prototype change and drop it.
function setOwn(o: Record<string, unknown>, k: string, value: unknown): void {
  Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true })
}

function parseObject(text: string | null, label: string): Settings {
  if (text === null || text.trim() === '') return {}
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    throw new Error(EXT_TEXT.badJson(label))
  }
  if (!isPlain(v)) throw new Error(EXT_TEXT.badJson(label))
  return v
}

/** Parses the file (none or empty is `{}`), applies the edit and gives the 2-space JSON text. Throws `badJson` for a file that does not parse. */
export function editSettings(text: string | null, edit: (s: Settings) => void, label = 'settings file'): string {
  const obj = parseObject(text, label)
  edit(obj)
  return JSON.stringify(obj, null, 2) + '\n'
}

// ---- skillOverrides ----

/** Off writes exactly `"off"`; on deletes the key, and `skillOverrides` with it once nothing is left in it. */
export function setSkillOverride(s: Settings, name: string, on: boolean): void {
  const current = s['skillOverrides']
  const map = isPlain(current) ? current : undefined
  if (current !== undefined && !map) {
    // A value this page does not understand is never replaced, and turning a skill on has nothing in it to delete.
    if (on) return
    throw new Error(EXT_TEXT.notEditable)
  }
  if (on) {
    if (!map || !has(map, name)) return
    delete map[name]
    if (Object.keys(map).length === 0) delete s['skillOverrides']
    return
  }
  const target = map ?? {}
  setOwn(target, name, 'off')
  if (!map) setOwn(s, 'skillOverrides', target)
}

// ---- hooks ----

const isCommandHook = (h: unknown): h is Record<string, unknown> =>
  isPlain(h) && h['type'] === 'command' && typeof h['command'] === 'string'

/** The `hooks` block and its groups as found; a shape it does not know is never touched. */
function eventGroups(s: Settings, event: string, create: boolean): unknown[] | null {
  let hooks = s['hooks']
  if (hooks === undefined) {
    if (!create) return null
    hooks = {}
    setOwn(s, 'hooks', hooks)
  }
  if (!isPlain(hooks)) throw new Error(EXT_TEXT.notEditable)
  let groups = has(hooks, event) ? hooks[event] : undefined
  if (groups === undefined) {
    if (!create) return null
    groups = []
    setOwn(hooks, event, groups)
  }
  if (!Array.isArray(groups)) throw new Error(EXT_TEXT.notEditable)
  return groups
}

function hooksAt(s: Settings, event: string, at: HookPosition): { groups: unknown[]; group: Record<string, unknown>; list: unknown[] } {
  const groups = eventGroups(s, event, false)
  const group = groups?.[at.group]
  if (!groups || !isPlain(group)) throw new Error(EXT_TEXT.notFound)
  const list = group['hooks']
  if (!Array.isArray(list) || at.hook < 0 || at.hook >= list.length) throw new Error(EXT_TEXT.notFound)
  if (!isCommandHook(list[at.hook])) throw new Error(EXT_TEXT.notEditable)
  return { groups, group, list }
}

const matcherOf = (g: Record<string, unknown>): string => (typeof g['matcher'] === 'string' ? g['matcher'] : '')

function setMatcher(g: Record<string, unknown>, matcher: string): void {
  if (matcher === '') {
    delete g['matcher']
    return
  }
  if (has(g, 'matcher')) g['matcher'] = matcher
  else {
    // `matcher` reads first in a group, as the CLI's own files have it.
    const rest = Object.entries(g)
    for (const k of Object.keys(g)) delete g[k]
    g['matcher'] = matcher
    for (const [k, v] of rest) setOwn(g, k, v)
  }
}

/** One row per hook of `hooks.<Event>[group].hooks[i]`; `at` is its place in the real arrays. A hook that is not a command hook has no command. */
export function hookRows(text: string | null, file: HookFile): HookRow[] {
  const hooks = parseObject(text, SETTINGS_LABEL[file])['hooks']
  if (!isPlain(hooks)) return []
  const rows: HookRow[] = []
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    groups.forEach((group, g) => {
      if (!isPlain(group) || !Array.isArray(group['hooks'])) return
      group['hooks'].forEach((hook: unknown, h: number) => {
        const found = isPlain(hook) && typeof hook['type'] === 'string' ? hook['type'] : 'unknown'
        const command = isCommandHook(hook) ? (hook['command'] as string) : ''
        const timeout = isPlain(hook) && typeof hook['timeout'] === 'number' && Number.isFinite(hook['timeout']) ? hook['timeout'] : null
        rows.push({ event, matcher: matcherOf(group), at: { group: g, hook: h }, type: found, command, timeout })
      })
    })
  }
  return rows
}

/** Adds a command hook, or with `at` edits that one in place (keys it does not know are kept). A hook of another type is refused. */
export function setHook(s: Settings, input: HookInput): void {
  const { event, matcher, command, timeout, at } = input
  if (!event || !command) throw new Error(EXT_TEXT.notEditable)
  const value = (): Record<string, unknown> => ({ type: 'command', command, ...(timeout !== undefined ? { timeout } : {}) })

  if (!at) {
    const groups = eventGroups(s, event, true) as unknown[]
    const group = groups.find((g): g is Record<string, unknown> => isPlain(g) && Array.isArray(g['hooks']) && matcherOf(g) === matcher)
    if (group) (group['hooks'] as unknown[]).push(value())
    else groups.push({ ...(matcher !== '' ? { matcher } : {}), hooks: [value()] })
    return
  }

  const { groups, group, list } = hooksAt(s, event, at)
  const hook = list[at.hook] as Record<string, unknown>
  hook['command'] = command
  if (timeout === undefined) delete hook['timeout']
  else hook['timeout'] = timeout
  if (matcherOf(group) === matcher) return
  // The group's matcher is the hook's own when it holds only this hook; otherwise the hook moves to a group with the new one.
  if (list.length === 1) {
    setMatcher(group, matcher)
    return
  }
  list.splice(at.hook, 1)
  const target = groups.find(
    (g): g is Record<string, unknown> => isPlain(g) && g !== group && Array.isArray(g['hooks']) && matcherOf(g) === matcher
  )
  if (target) (target['hooks'] as unknown[]).push(hook)
  else groups.push({ ...(matcher !== '' ? { matcher } : {}), hooks: [hook] })
}

/** Removes a command hook, and the group or event it leaves empty. */
export function removeHook(s: Settings, event: string, at: HookPosition): void {
  const { groups, list } = hooksAt(s, event, at)
  list.splice(at.hook, 1)
  if (list.length > 0) return
  groups.splice(at.group, 1)
  if (groups.length === 0) delete (s['hooks'] as Record<string, unknown>)[event]
}

// ---- files ----

/** The user file moves with CLAUDE_CONFIG_DIR, as the CLI does; the two project files live in the folder's `.claude`. */
export function settingsPath(file: HookFile, folder: string, home: string, env: NodeJS.ProcessEnv = process.env): string {
  if (file === 'user') return join(env['CLAUDE_CONFIG_DIR'] || join(home, '.claude'), 'settings.json')
  return join(folder, '.claude', file === 'project' ? 'settings.json' : 'settings.local.json')
}

// An fs error names the path in its message; only its code goes on.
const ioError = (err: unknown): Error => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? new Error(code) : err instanceof Error ? err : new Error('EIO')
}

/** The file's text, or null when it is not there. */
export async function readText(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw ioError(err)
  }
}

/**
 * Ruling 25: a project file (`.mcp.json`, `.claude/settings*.json`, the `.claude/skills` folder) is written only where it really lies
 * in the folder: refused (`notEditable`) when the target is a link (a dangling one too) or when a folder between the chosen one and it
 * resolves outside the chosen folder's real path, so a cloned repo cannot point a save at `~/.claude.json`. A part that is not there yet
 * is made by the write as a real folder. User files keep following links (dotfile setups). The check and the write are two steps.
 */
export async function assertProjectPath(folder: string, target: string): Promise<void> {
  let base: string
  try {
    base = await fs.realpath(folder)
  } catch (err) {
    throw ioError(err)
  }
  const rel = relative(resolve(folder), resolve(target))
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(EXT_TEXT.notEditable)
  const parts = rel.split(sep)
  let at = resolve(folder)
  for (let i = 0; i < parts.length; i++) {
    at = join(at, parts[i])
    let st
    try {
      st = await fs.lstat(at)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw ioError(err)
    }
    if (i === parts.length - 1) {
      if (st.isSymbolicLink()) throw new Error(EXT_TEXT.notEditable)
      return
    }
    // A folder on the way may be a link, as long as it leads somewhere inside the chosen folder; a dangling one cannot be followed.
    const real = await fs.realpath(at).catch(() => null)
    if (real === null || (real !== base && !real.startsWith(base + sep))) throw new Error(EXT_TEXT.notEditable)
  }
}

/** Whether `assertProjectPath` lets a write to `target` through, for showing a row read-only before anyone tries. */
export const projectPathOk = (folder: string, target: string): Promise<boolean> =>
  assertProjectPath(folder, target).then(
    () => true,
    () => false
  )

/**
 * Read, stale check, edit, atomic write, mode kept. A null stamp skips the check (a write that holds no page stamp). A file that
 * does not parse is left byte for byte, and a missing one is created (with its folder, 0700) only when the edit leaves something in it.
 * With `inside` (the chosen folder) the path is a project file and must pass `assertProjectPath` first.
 */
export async function writeSettings(
  path: string,
  stamp: string | null,
  edit: (s: Settings) => void,
  label = basename(path),
  inside?: string
): Promise<void> {
  if (inside !== undefined) await assertProjectPath(inside, path)
  const text = await readText(path)
  if (stamp !== null && stampOf(text) !== stamp) throw new Error(EXT_TEXT.stale)
  const out = editSettings(text, edit, label)
  if (text === null && out === '{}\n') return
  try {
    if (text === null) await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
    // The file's own mode goes to the temp file too, so a 0600 file with env values is never briefly readable by others.
    const mode =
      text === null
        ? undefined
        : await fs.stat(path).then(
            (st) => st.mode & 0o7777,
            () => undefined
          )
    await writeFileAtomic(path, out, mode)
  } catch (err) {
    throw ioError(err)
  }
}
