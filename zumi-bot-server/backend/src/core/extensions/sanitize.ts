import {
  EXT_TEXT,
  type HookSource,
  type Loadout,
  type LoadoutHook,
  type LoadoutSection,
  type LoadoutServer,
  type LoadoutSkill,
  type McpScope,
  type ServerSource,
  type ServerStatus,
  type SkillSource
} from '@zumibot/shared/extensions'
import { connectorOf } from '@zumibot/shared/connectors'
import { NAME_PATTERN } from '@zumibot/shared/frontmatter'
import { assertNever, type Engine } from '@zumibot/shared/engine'
import type { ProbeAnswers } from './probe'

// Pure. Turns a probe's raw answers into the rows the page may see. Rows are built field by field from an allow-list, so what a
// CLI answer holds beyond it (an MCP server's `config` with env, headers and expanded args, `serverInfo`, auth state) never
// reaches the page, a log or an error. A shape that is not the expected one is that section's fixed error, never a throw.

/** A section the CLI answered oddly: the fixed sentence names the engine whose answer it was. */
function unsupportedText(engine: Engine, key: Parameters<typeof EXT_TEXT.unsupported>[0]): string {
  switch (engine) {
    case 'claude':
      return EXT_TEXT.unsupported(key)
    case 'codex':
      return EXT_TEXT.codexUnsupported(key)
    case 'acp':
      return EXT_TEXT.acpUnsupported
    case 'ag-ui':
      return EXT_TEXT.aguiUnsupported
    default:
      return assertNever(engine)
  }
}

export interface LoadoutContext {
  engine: Engine
  folder: string
  agent: string | null
  now: number
  /** The user and project skill folders found on disk, by skill name: only those are editable. */
  skillDirs: Map<string, 'user' | 'project'>
}

type Obj = Record<string, any>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** Rows of one section, or null when the answer is not the shape this reader knows. */
type Rows<T> = T[] | null

const STATUSES: ReadonlySet<string> = new Set<ServerStatus>(['connected', 'needs-auth', 'failed', 'pending'])
const statusOf = (v: unknown): ServerStatus => (typeof v === 'string' && STATUSES.has(v) ? (v as ServerStatus) : 'unknown')
const SCOPES: ReadonlySet<string> = new Set<McpScope>(['user', 'local', 'project'])

// ---- Claude ----

// `plugin:<plugin>:<server>`: the plugin's own name, not its `name@marketplace` id.
const pluginOfServer = (name: string): string | null => {
  const m = /^plugin:([^:]+):/.exec(name)
  return m ? m[1] : null
}

function claudeServers(answer: unknown): Rows<LoadoutServer> {
  const list = obj(answer)?.mcpServers
  if (!Array.isArray(list)) return null
  const rows: LoadoutServer[] = []
  for (const e of list) {
    const s = obj(e)
    const name = nonEmpty(s?.name)
    if (!s || !name) return null
    const scope = typeof s.scope === 'string' && SCOPES.has(s.scope) ? (s.scope as McpScope) : null
    let source: ServerSource
    if (scope) source = scope
    else if (s.scope === 'claudeai' || s.source === 'claudeai') source = 'claudeai'
    else if (s.source === 'plugin') source = 'plugin'
    else source = 'other'
    rows.push({
      name,
      status: statusOf(s.status),
      source,
      transport: text(s.transport),
      plugin: source === 'plugin' ? pluginOfServer(name) : null,
      tools: Array.isArray(s.tools)
        ? s.tools.map((t) => (typeof t === 'string' ? t : text(obj(t)?.name))).filter((t): t is string => !!t)
        : [],
      scope,
      note: null,
      // From the raw URL, which stops here: only the catalog id goes on.
      connector: connectorOf(nonEmpty(obj(s.config)?.url), name)
    })
  }
  return rows
}

function claudeSkills(answer: unknown, ctx: LoadoutContext): Rows<LoadoutSkill> {
  const list = obj(answer)?.skills
  if (!Array.isArray(list)) return null
  const rows: LoadoutSkill[] = []
  for (const e of list) {
    const s = obj(e)
    const name = nonEmpty(s?.name)
    if (!s || !name) return null
    const source: SkillSource =
      s.source === 'user' || s.source === 'project' || s.source === 'plugin' || s.source === 'bundled'
        ? s.source
        : s.source === 'claude.ai sync'
          ? 'claudeai'
          : 'other'
    rows.push({
      name,
      description: text(s.description) ?? '',
      source,
      plugin: source === 'plugin' && name.includes(':') ? name.slice(0, name.indexOf(':')) : null,
      tokens: num(s.tokens),
      on: s.state === 'on',
      editable: editable(name, source, ctx)
    })
  }
  return rows
}

// A skill folder of that name only counts for a skill the CLI also calls a user or project one, under a name the skill RPCs take
// (`skillName` in handlers.ts), so a row that shows Edit can always be saved.
const SKILL_NAME_MAX = 100
const editable = (name: string, source: SkillSource, ctx: LoadoutContext) =>
  ctx.skillDirs.has(name) && (source === 'user' || source === 'project') && name.length <= SKILL_NAME_MAX && NAME_PATTERN.test(name)

function claudeHooks(answer: unknown, ctx: LoadoutContext): Rows<LoadoutHook> {
  const list = obj(answer)?.hooks
  if (!Array.isArray(list)) return null
  const rows: LoadoutHook[] = []
  for (const e of list) {
    const h = obj(e)
    const event = nonEmpty(h?.event)
    if (!h || !event) return null
    let source: HookSource
    switch (h.source) {
      case 'userSettings':
        source = 'user'
        break
      case 'projectSettings':
        source = 'project'
        break
      case 'localSettings':
        source = 'local'
        break
      case 'pluginHook':
        source = 'plugin'
        break
      // The probe passes only the agent's own settings, so a flag-sourced hook is the agent's.
      case 'flagSettings':
        source = ctx.agent !== null ? 'agent' : 'other'
        break
      default:
        source = 'other'
    }
    rows.push({
      event,
      matcher: text(h.matcher) ?? '',
      type: text(h.type) ?? 'command',
      command: text(h.commandText) ?? '',
      timeout: num(h.timeout),
      source,
      plugin: nonEmpty(h.pluginName),
      // File-backed rows are replaced later by the ones that know their place in the file.
      at: null,
      stamp: null
    })
  }
  return rows
}

// ---- Codex (0.164.0: mcpServerStatus/list, skills/list, hooks/list) ----

function codexStatus(s: Obj): ServerStatus {
  switch (s.runtimeStatus) {
    case 'connected':
      return 'connected'
    case 'authenticationRequired':
      return 'needs-auth'
    case 'failed':
      return 'failed'
    case 'starting':
    case 'notStarted':
      return 'pending'
    case 'disabled':
      return 'disabled'
  }
  // No runtime status (the usual case for a server codex lists from its config): read it from what the listing shows.
  if (s.runtimeStatus === null || s.runtimeStatus === undefined) {
    if (typeof s.toolsError === 'string') return 'failed'
    if (s.authStatus === 'notLoggedIn') return 'needs-auth'
    if (obj(s.tools) && Object.keys(s.tools).length > 0) return 'connected'
  }
  return 'unknown'
}

function codexServers(answer: unknown): Rows<LoadoutServer> {
  const list = obj(answer)?.data
  if (!Array.isArray(list)) return null
  const rows: LoadoutServer[] = []
  for (const e of list) {
    const s = obj(e)
    const name = nonEmpty(s?.name)
    if (!s || !name) return null
    const plugin = nonEmpty(s.pluginId)
    rows.push({
      name,
      status: codexStatus(s),
      source: plugin ? 'plugin' : 'other',
      transport: typeof s.httpOrigin === 'string' ? 'http' : null,
      plugin,
      // Tool names only: the listing maps each name to its whole definition.
      tools: Object.keys(obj(s.tools) ?? {}),
      scope: null,
      note: null,
      connector: null
    })
  }
  return rows
}

function codexSkills(answer: unknown, ctx: LoadoutContext): Rows<LoadoutSkill> {
  const folders = obj(answer)?.data
  if (!Array.isArray(folders)) return null
  const rows: LoadoutSkill[] = []
  for (const f of folders) {
    const list = obj(f)?.skills
    if (!Array.isArray(list)) return null
    for (const e of list) {
      const s = obj(e)
      const name = nonEmpty(s?.name)
      if (!s || !name) return null
      const plugin = nonEmpty(s.pluginId)
      const source: SkillSource = plugin
        ? 'plugin'
        : s.scope === 'user'
          ? 'user'
          : s.scope === 'repo'
            ? 'project'
            : s.scope === 'system'
              ? 'bundled'
              : 'other'
      rows.push({
        name,
        description: text(s.description) ?? '',
        source,
        plugin,
        tokens: null,
        on: s.enabled === true,
        editable: editable(name, source, ctx)
      })
    }
  }
  return rows
}

// Codex names its events in camelCase; the page groups them as Claude's.
const pascal = (event: string) => event[0].toUpperCase() + event.slice(1)

function codexHooks(answer: unknown, ctx: LoadoutContext): Rows<LoadoutHook> {
  const folders = obj(answer)?.data
  if (!Array.isArray(folders)) return null
  const rows: LoadoutHook[] = []
  for (const f of folders) {
    const list = obj(f)?.hooks
    if (!Array.isArray(list)) return null
    for (const e of list) {
      const h = obj(e)
      const event = nonEmpty(h?.eventName)
      if (!h || !event) return null
      let source: HookSource
      switch (h.source) {
        case 'user':
          source = 'user'
          break
        case 'project':
          source = 'project'
          break
        case 'plugin':
          source = 'plugin'
          break
        case 'sessionFlags':
          source = ctx.agent !== null ? 'agent' : 'other'
          break
        default:
          source = 'other'
      }
      const server = nonEmpty(h.server)
      const tool = nonEmpty(h.tool)
      rows.push({
        event: pascal(event),
        matcher: text(h.matcher) ?? '',
        type: text(h.handlerType) ?? 'command',
        command: text(h.command) ?? (server && tool ? `${server}.${tool}` : ''),
        timeout: num(h.timeoutSec),
        source,
        plugin: nonEmpty(h.pluginId),
        at: null,
        stamp: null
      })
    }
  }
  return rows
}

/**
 * The loadout of one probe, less the plugins (the service joins those from `claude plugin list`). A section the probe could not
 * read keeps its fixed sentence; one whose answer has an unexpected shape gets `EXT_TEXT.unsupported`; the others still show.
 */
interface Readers {
  servers(answer: unknown): Rows<LoadoutServer>
  skills(answer: unknown, ctx: LoadoutContext): Rows<LoadoutSkill>
  hooks(answer: unknown, ctx: LoadoutContext): Rows<LoadoutHook>
}

/** Each engine's own readers of its CLI's answers: a Record, so a new engine writes its own instead of falling into another's. */
const READERS: Record<Engine, Readers> = {
  claude: { servers: claudeServers, skills: claudeSkills, hooks: claudeHooks },
  codex: { servers: codexServers, skills: codexSkills, hooks: codexHooks },
  // No probe runs for an ACP agent (extensionsService): an answer reaching here reads as unsupported in every section.
  acp: { servers: () => null, skills: () => null, hooks: () => null },
  // Nor for a remote agent: its server's parts are its own.
  'ag-ui': { servers: () => null, skills: () => null, hooks: () => null }
}

export function toLoadout(a: ProbeAnswers, ctx: LoadoutContext): Omit<Loadout, 'plugins'> {
  const errors: Partial<Record<LoadoutSection, string>> = {}
  const section = <T>(probeKey: 'mcp' | 'skills' | 'hooks', key: LoadoutSection, read: () => Rows<T>): T[] => {
    const carried = a.errors[probeKey]
    if (carried) {
      errors[key] = carried
      return []
    }
    let rows: Rows<T> = null
    try {
      rows = read()
    } catch {
      /* an odd answer is an unsupported section, never a failed page */
    }
    if (!rows) {
      errors[key] = unsupportedText(ctx.engine, key)
      return []
    }
    return rows
  }
  const read = READERS[ctx.engine]
  return {
    engine: ctx.engine,
    version: a.version,
    folder: ctx.folder,
    agent: ctx.agent,
    servers: section('mcp', 'servers', () => read.servers(a.mcp)),
    skills: section('skills', 'skills', () => read.skills(a.skills, ctx)),
    hooks: section('hooks', 'hooks', () => read.hooks(a.hooks, ctx)),
    errors,
    at: ctx.now
  }
}
