import { existsSync, promises as fs, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  EXT_TEXT,
  parseMcpDef,
  type McpScope,
  type McpServerDef,
  type McpServerInput,
  type McpServerView
} from '@zumibot/shared/extensions'
import { readText, stampOf, writeSettings } from './settingsFile'

// MCP server definitions on disk. `~/.claude.json` is READ ONLY here: the CLI rewrites it all the time, so its servers are
// changed through the CLI (`claudeCli.ts`) and never by a second writer. The folder's `.mcp.json` is a plain project file
// and is written directly. Errors are EXT_TEXT sentences or a bare error code; env and header values never leave these functions
// except into the file being edited.

type Defs = Record<string, McpServerDef>

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

// Own properties, so a server or env name `__proto__` is kept as a key instead of changing a prototype.
function setOwn(o: object, k: string, value: unknown): void {
  Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true })
}

/** The defs of an `mcpServers` object; one the editor does not know (an unknown key, a wrong type) is skipped, not an error. */
function defsOf(v: unknown): Defs {
  const out: Defs = {}
  if (!isPlain(v)) return out
  for (const [name, raw] of Object.entries(v)) {
    const def = parseMcpDef(raw)
    if (def) setOwn(out, name, def)
  }
  return out
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try {
    const v: unknown = JSON.parse(text)
    return isPlain(v) ? v : null
  } catch {
    return null
  }
}

/**
 * The `projects[...]` key the CLI files a folder's local servers under (seen on claude 2.1.322): the real path of the nearest folder, from
 * this one up, that holds a `.git` entry (a repo's directory or a worktree's file), else the folder's own real path. So a folder inside a
 * repo shares the repo root's local servers, and a symlinked folder is never keyed by the link. A folder that is not there walks up from
 * its resolved path.
 */
export function localProjectKey(folder: string): string {
  let real: string
  try {
    real = realpathSync(folder)
  } catch {
    real = resolve(folder)
  }
  for (let dir = real; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return real
  }
}

/** `mcpServers` at the top of `~/.claude.json` (user scope) and under `projects[<key>]` (local scope; pass `localProjectKey(folder)`, matched exactly). */
export function readUserServers(claudeJson: string, folder: string): { user: Defs; local: Defs } {
  const root = parseJsonObject(claudeJson)
  if (!root) return { user: {}, local: {} }
  const projects = root['projects']
  const mine = isPlain(projects) && has(projects, folder) ? projects[folder] : undefined
  return { user: defsOf(root['mcpServers']), local: defsOf(isPlain(mine) ? mine['mcpServers'] : undefined) }
}

/** The server names stored at the top of `~/.claude.json` and under `projects[<localKey>]`, read or not: only names, never a definition. */
export function storedServerNames(claudeJson: string, localKey: string): Set<string> {
  const root = parseJsonObject(claudeJson)
  if (!root) return new Set()
  const projects = root['projects']
  const mine = isPlain(projects) && has(projects, localKey) ? projects[localKey] : undefined
  const keys = (v: unknown): string[] => (isPlain(v) ? Object.keys(v) : [])
  return new Set([...keys(root['mcpServers']), ...keys(isPlain(mine) ? mine['mcpServers'] : undefined)])
}

const mcpPath = (folder: string): string => join(folder, '.mcp.json')

/**
 * Every folder from `folder` up (its real path first, as the CLI walks from its own working folder) whose `.mcp.json` names servers,
 * nearest first, with those names (an entry this page does not read whole counts too). A file that is missing or does not parse is skipped.
 */
export async function projectMcpNames(folder: string): Promise<Array<{ dir: string; names: Set<string> }>> {
  let dir: string
  try {
    dir = await fs.realpath(folder)
  } catch {
    dir = resolve(folder)
  }
  const out: Array<{ dir: string; names: Set<string> }> = []
  for (;;) {
    const text = await readText(mcpPath(dir)).catch(() => null)
    const servers = parseJsonObject(text)?.['mcpServers']
    if (isPlain(servers)) out.push({ dir, names: new Set(Object.keys(servers)) })
    if (dirname(dir) === dir) return out
    dir = dirname(dir)
  }
}

/** The folder's `.mcp.json` servers and the stamp of its text (`'absent'` when there is none); a file that does not parse reads as none. */
export async function readProjectServers(folder: string): Promise<{ servers: Defs; stamp: string }> {
  const text = await readText(mcpPath(folder))
  return { servers: defsOf(parseJsonObject(text)?.['mcpServers']), stamp: stampOf(text) }
}

// The def's keys in a fixed order, so a written file reads the same however the form built the object.
const DEF_KEYS = ['type', 'command', 'args', 'env', 'url', 'headers'] as const
const ordered = (def: McpServerDef): Record<string, unknown> =>
  Object.fromEntries(DEF_KEYS.filter((k) => def[k] !== undefined).map((k) => [k, def[k]]))

/**
 * Sets (a def) or removes (null) one server of `<folder>/.mcp.json`; the other servers and top-level keys, and their order, stay.
 * The file is created when missing; a stale stamp, invalid JSON, a `mcpServers` that is no object, or an existing entry of a shape this page
 * does not read whole (replacing it would drop keys) is refused with the file untouched; removing such an entry is allowed. A file that is
 * a link, a dangling one too, is refused (`notEditable`, Ruling 25).
 */
export async function writeProjectServer(folder: string, name: string, def: McpServerDef | null, stamp: string | null): Promise<void> {
  const written = def === null ? null : parseMcpDef(def)
  if (def !== null && !written) throw new Error(EXT_TEXT.badName)
  // No server is ever written into a folder that is not there: a typo would make the folder.
  if (
    !(await fs.stat(folder).then(
      (s) => s.isDirectory(),
      () => false
    ))
  )
    throw new Error(EXT_TEXT.notFound)
  // Ruling 25: a `.mcp.json` that is a link (a cloned repo pointing it at ~/.claude.json) is never written through.
  await writeSettings(
    mcpPath(folder),
    stamp,
    (s) => {
      const current = s['mcpServers']
      if (current !== undefined && !isPlain(current)) throw new Error(EXT_TEXT.notEditable)
      if (written === null) {
        if (!current || !has(current, name)) throw new Error(EXT_TEXT.notFound)
        delete current[name]
        return
      }
      // An entry this page does not read whole (`oauth`, `headersHelper`, ...) would lose those keys if replaced, so it is never written over.
      if (current && has(current, name) && parseMcpDef(current[name]) === null) throw new Error(EXT_TEXT.notEditable)
      const servers = current ?? {}
      setOwn(servers, name, ordered(written))
      if (!current) setOwn(s, 'mcpServers', servers)
    },
    '.mcp.json',
    folder
  )
}

/** What the page may see of a stored server: every env and header value is empty, and the names are listed in `hidden`. */
export function serverView(def: McpServerDef, scope: McpScope, name: string, stamp: string): McpServerView {
  const blank = (map: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (!map) return undefined
    const out: Record<string, string> = {}
    for (const k of Object.keys(map)) setOwn(out, k, '')
    return out
  }
  const view: McpServerDef = { ...def, ...(def.args ? { args: [...def.args] } : {}) }
  if (def.env) view.env = blank(def.env)
  if (def.headers) view.headers = blank(def.headers)
  return { name, scope, def: view, hidden: { env: Object.keys(def.env ?? {}), headers: Object.keys(def.headers ?? {}) }, stamp }
}

// A null value keeps the stored text of that name (a name with none is dropped), a text replaces it, a name not in the input is gone.
function mergeValues(
  stored: Record<string, string> | undefined,
  input: Record<string, string | null> | undefined
): Record<string, string> | undefined {
  if (input === undefined) return undefined
  // Untyped JSON reaches here: a non-object is handed on as it is, and `parseMcpDef` refuses it.
  if (!isPlain(input)) return input as never
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    if (v !== null) setOwn(out, k, v)
    else if (stored && has(stored, k)) setOwn(out, k, stored[k])
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** The def a form's input stands for. Throws `badName` when it is not a server the CLI format has. */
export function mergeInput(stored: McpServerDef, input: McpServerInput): McpServerDef {
  // Built key by key from the six the format has, so a key the input carries beyond them never reaches the file.
  const candidate: Record<string, unknown> = {}
  for (const k of DEF_KEYS) {
    if (k === 'env') candidate[k] = mergeValues(stored.env, input.env)
    else if (k === 'headers') candidate[k] = mergeValues(stored.headers, input.headers)
    else candidate[k] = input[k]
  }
  const def = parseMcpDef(Object.fromEntries(Object.entries(candidate).filter(([, v]) => v !== undefined)))
  if (!def) throw new Error(EXT_TEXT.badName)
  return def
}
