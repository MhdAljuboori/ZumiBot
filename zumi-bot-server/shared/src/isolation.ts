// Agent isolation (docs/architecture/governance.md, Part 2). Level 2, "Sandboxed", runs the agent's Bash in the Claude CLI's OS
// sandbox and holds its file tools to its folders and its WebFetch to its network list. The setting lives in a server-owned file,
// never in the agent's own .md: Zumi Bot edits agent files with its file tools, and must not be able to lower it.

export type IsolationLevel = 'off' | 'sandbox' | 'container'

export const ISOLATION_LEVELS: readonly IsolationLevel[] = ['off', 'sandbox', 'container']

export interface AgentIsolation {
  level: IsolationLevel
  write: string[] // extra folders the agent may change (absolute); in a container, mounted read-write
  read: string[] // extra folders the agent may only read (absolute); in a container, mounted read-only
  network: string[] // host names, `*.` wildcards allowed; empty = no network
  webSearch: boolean // WebSearch stays denied unless this is on
  autoBash: boolean // the one looser choice: Bash runs without a card (sandboxed or contained only)
}

export const ISOLATION_OFF: AgentIsolation = { level: 'off', write: [], read: [], network: [], webSearch: false, autoBash: false }

export const ISOLATION_LIST_MAX = 50
export const ISOLATION_ITEM_MAX = 500

export type SandboxSupport = { available: true } | { available: false; reason: string }

export interface IsolationStatus {
  sandbox: SandboxSupport
  /** Level 3: rootless Podman and the agent image (governance.md 2.4). */
  container: SandboxSupport
  /** Folders under home every sandboxed run may read (the toolchain on PATH, git's own config). */
  toolchain: string[]
}

/** What Agent Studio shows for one agent. */
export interface AgentIsolationView {
  isolation: AgentIsolation
  /** Why this agent cannot be sandboxed even where the machine can (a Codex agent), else null. */
  refused: string | null
}

// A host name: labels of letters, digits and hyphens, an optional leading `*.`, or localhost / 127.0.0.1.
const HOST = /^(\*\.)?(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

export function hostError(h: string): string | null {
  if (h === 'localhost' || h === '127.0.0.1') return null
  if (/^\d+(\.\d+){3}$/.test(h)) return `${h}: an IP address is not allowed (only 127.0.0.1)`
  if (/[/:?#@\s]/.test(h)) return `${h}: a host name only, without scheme, port or path`
  if (!HOST.test(h)) return `${h}: not a host name`
  if (h.startsWith('*.') && h.split('.').length < 3) return `${h}: a wildcard must name a domain under it (like *.example.com)`
  return null
}

export function pathError(p: string): string | null {
  if (!p.startsWith('/')) return `${p}: an absolute path is needed`
  if (p.split('/').includes('..') || p.split('/').includes('.')) return `${p}: no . or .. parts`
  if (p === '/' || /\/{2,}/.test(p)) return `${p}: not a folder ZumiBot can grant`
  return null
}

/** Whether `host` is on a list of names and `*.` wildcards (a wildcard covers sub-domains, not the bare domain). */
export function hostAllowed(host: string, list: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return list.some((e) => (e.startsWith('*.') ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : h === e))
}

const strList = (v: unknown, name: string, check: (s: string) => string | null, norm: (s: string) => string): string[] => {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > ISOLATION_LIST_MAX) throw new TypeError(`${name} must be a list of at most ${ISOLATION_LIST_MAX}`)
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string' || x.length === 0 || x.length > ISOLATION_ITEM_MAX)
      throw new TypeError(`${name} holds a value that is not a short string`)
    const s = norm(x.trim())
    const err = check(s)
    if (err) throw new TypeError(err)
    if (!out.includes(s)) out.push(s)
  }
  return out
}

/** Checks an untyped isolation value field by field; throws a TypeError naming the first bad field. */
export function parseIsolation(v: unknown): AgentIsolation {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError('isolation must be an object')
  const o = v as Record<string, unknown>
  if (!ISOLATION_LEVELS.includes(o.level as IsolationLevel)) throw new TypeError('level must be off, sandbox or container')
  const bool = (x: unknown, name: string): boolean => {
    if (x === undefined) return false
    if (typeof x !== 'boolean') throw new TypeError(`${name} must be true or false`)
    return x
  }
  const trimSlash = (s: string) => (s.length > 1 ? s.replace(/\/+$/, '') : s)
  return {
    level: o.level as IsolationLevel,
    write: strList(o.write, 'write', pathError, trimSlash),
    read: strList(o.read, 'read', pathError, trimSlash),
    network: strList(o.network, 'network', hostError, (s) => s.toLowerCase()),
    webSearch: bool(o.webSearch, 'webSearch'),
    autoBash: bool(o.autoBash, 'autoBash')
  }
}

export interface SandboxBlock {
  kind: 'network' | 'file'
  target: string
}

/**
 * What the sandbox refused in one tool result, if anything. Network blocks come in the CLI's own `<sandbox_violations>` block;
 * file blocks only as the OS error ("Read-only file system") or the CLI's "outside the working directories" refusal.
 * A label only: the OS enforces the block either way.
 */
export function sandboxBlocks(text: string, o: { osErrors?: boolean } = {}): SandboxBlock[] {
  const out: SandboxBlock[] = []
  const add = (kind: SandboxBlock['kind'], target: string) => {
    if (!out.some((b) => b.target === target)) out.push({ kind, target })
  }
  const block = /<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/.exec(text)
  if (block) {
    for (const line of block[1].split('\n')) {
      const m = /deny network-outbound ([^\s:]+)/.exec(line)
      if (m) add('network', m[1])
    }
  }
  const fetch = /^Blocked by the sandbox: (\S+) is not on this agent's network list/m.exec(text)
  if (fetch) add('network', fetch[1])
  const file = /Blocked by the sandbox: (.+?) is outside this agent's folders/.exec(text)
  if (file) add('file', file[1])
  // "Read-only file system" also comes from unsandboxed commands (a write under /proc): only a caller that knows the run was
  // sandboxed may read it as the sandbox's.
  if (o.osErrors) for (const m of text.matchAll(/(\/[^\s:'"]+): Read-only file system/g)) add('file', m[1])
  const outside = /^(\/\S+) is outside .*permissions\.block(Reads|Writes)OutsideWorkingDirectories/m.exec(text)
  if (outside) add('file', outside[1])
  return out
}

/** The line a chat shows under a tool row the sandbox blocked. */
export function sandboxBlockLine(blocks: readonly SandboxBlock[]): string | null {
  if (blocks.length === 0) return null
  return `Blocked by the sandbox: ${blocks.map((b) => b.target).join(', ')}`
}

/** The file guard hook's block line (core/isolation/fileGuard.ts). */
export const sandboxFileBlocked = (path: string): string =>
  `Blocked by the sandbox: ${path} is outside this agent's folders. Work inside the chat's folder, or ask the user to add the folder in Agent Studio.`

export const WEBFETCH_BLOCKED = (host: string): string =>
  `Blocked by the sandbox: ${host} is not on this agent's network list. ZumiBot does not fetch it; ask the user to add the host in Agent Studio if it is needed.`

/**
 * What a contained run's network proxy refused while a tool ran, in the sandbox's own `<sandbox_violations>` form, appended to that
 * tool's result as ZumiBot stores it, so the chat line and the audit read it the same way as a sandboxed run's.
 */
export const containerNetBlocked = (hosts: readonly string[]): string =>
  `<sandbox_violations>\n${hosts.map((h) => `deny network-outbound ${h} (host is not on this agent's network list)`).join('\n')}\n</sandbox_violations>`
