export const NO_FRONTMATTER = 'No frontmatter block (file must start with ---)'

import YAML from 'yaml'
import { parseCommands, type AgentCommand } from './commands'
import { parseHooks, parseMcpDef, type AgentExtensions, type AgentOwnServer, type HooksConfig, type McpServerDef } from './extensions'
import { parseSpendCap } from './spendCaps'
import { parseProvider, type Provider } from './engine'
import { ACP_TEXT, acpLaunchError, parseAcpLaunch, refusedArg, type AcpLaunch } from './acp'
import { AGUI_TEXT, aguiLaunchError, parseAguiLaunch, type AguiLaunch } from './agui'

export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export { displayName } from './agentName'
export const MODEL_OPTIONS = ['inherit', 'opus', 'sonnet', 'haiku'] as const
// The CLI's own color names: it drops any other `color:` value, so the palette keeps exactly these.
export const COLOR_OPTIONS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'] as const
// The shapes an agent can pick, first one the default. `zumi-z` is Zumi Bot's own and never listed here.
export const ICON_OPTIONS = [
  'robot',
  'lightning',
  'cat',
  'rocket',
  'planet',
  'layers',
  'chat',
  'sprout',
  'cube',
  'gear',
  'sparkle',
  'infinity',
  'gamepad',
  'shield',
  'honeycomb',
  'cloud',
  'flame',
  'wave',
  'magnifier',
  'folder'
] as const
export type BotShape = (typeof ICON_OPTIONS)[number]
/** Faces from before 0.1.0, shown as their nearest shape; the file keeps the old value until the user picks another. */
export const LEGACY_ICONS: Readonly<Record<string, BotShape>> = { triangles: 'robot', wink: 'cat', circles: 'chat' }

export interface AgentFields {
  name: string
  description: string
  /** null means the key is absent. */
  model: string | null
  color: string | null
  /** null means the key is absent. */
  icon: string | null
  /** null means the key is absent (all tools). */
  tools: string[] | null
  /** null means the key is absent. */
  commands: AgentCommand[] | null
  /** Raw `memory:` scope; null means the key is absent. */
  memory: string | null
  /** ZumiBot-only cap (like `icon`); null means absent or not a whole number. */
  memoryLimit: number | null
  /** ZumiBot-only opt-in; null means absent, true only for YAML `true`. */
  computerUse: boolean | null
  /** ZumiBot-only engine pick; null means absent or anything but the exact string `codex` (= Claude). */
  provider: Provider | null
  /**
   * Tokens at which the agent's session compacts. The CLI's own key, but it applies it only when the agent runs as a
   * subagent; ZumiBot passes it to the agent's own runs too. null means absent or outside what the CLI accepts.
   */
  autoCompactWindow: number | null
  /** ZumiBot-only daily spend cap in USD (spendCaps.ts); null means absent or not a valid amount. */
  dailySpendCap: number | null
  /** ZumiBot-only: servers this agent does not get, by the name the CLI lists; null means absent. */
  serversOff: string[] | null
  /** ZumiBot-only: skills this agent does not get; null means absent. */
  skillsOff: string[] | null
  /** ZumiBot-only per-agent plugin overrides (booleans only); null means absent or none usable. */
  plugins: Record<string, boolean> | null
  /** The CLI's subagent key. `editable` is false for a shape the editor could not write back whole; null means absent. */
  mcpServers: { entries: AgentOwnServer[]; editable: boolean } | null
  /** The CLI's subagent key, settings.json format. `editable` is false for a `prompt` hook or an extra key; null means absent. */
  hooks: { config: HooksConfig; editable: boolean } | null
  /** ZumiBot-only launch of an ACP agent. null means absent, or an `acp:` that does not parse (see `ParsedAgent.acpEditable`). */
  acp: AcpLaunch | null
  /** ZumiBot-only endpoint of a remote AG-UI agent. null means absent, or an `agui:` that does not parse (see `ParsedAgent.aguiEditable`). */
  agui: AguiLaunch | null
}

/** The range the CLI accepts for an auto-compact window. */
export const COMPACT_WINDOW_MIN = 100_000
export const COMPACT_WINDOW_MAX = 1_000_000

export type ParsedAgent =
  // `acpEditable` is false when the file has an `acp:` that does not parse: `fields.acp` is null and Save keeps the key untouched.
  // `aguiEditable` is the same for `agui:`.
  { ok: true; fields: AgentFields; body: string; acpEditable: boolean; aguiEditable: boolean } | { ok: false; error: string }

export const NEW_AGENT_TEMPLATE =
  "---\nname: new-agent\ndescription: Describe when Claude should use this agent.\n---\nDescribe the agent's role and how it should work.\n"

const FRONTMATTER = /^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m

export interface Split {
  /** Everything up to and including the closing --- line, verbatim. */
  head: string
  yaml: string
  body: string
}

export function split(raw: string): Split | null {
  const m = FRONTMATTER.exec(raw)
  if (!m || m.index !== 0) return null
  return { head: m[0], yaml: m[1].replace(/\r\n/g, '\n'), body: raw.slice(m[0].length) }
}

function optionalString(v: unknown): string | null {
  return v === undefined || v === null ? null : String(v)
}

function parseLimit(v: unknown): number | null {
  if (typeof v !== 'number' && typeof v !== 'string') return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}

function parseWindow(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= COMPACT_WINDOW_MIN && v <= COMPACT_WINDOW_MAX ? v : null
}

function parseTools(v: unknown): string[] | null {
  if (v === undefined || v === null) return null
  if (Array.isArray(v)) return v.map(String)
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// A list of names; items that are not non-empty strings are dropped, and no name left reads as absent.
function parseNames(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const names = v.filter((x): x is string => typeof x === 'string' && x !== '')
  return names.length > 0 ? names : null
}

function parsePlugins(v: unknown): Record<string, boolean> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const kept = Object.entries(v).filter((e): e is [string, boolean] => typeof e[1] === 'boolean')
  // fromEntries makes own properties, so a `__proto__` key survives.
  return kept.length > 0 ? Object.fromEntries(kept) : null
}

const isPlainMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

// Editable only when every item is a bare name or a one-key `{name: def}` whose def the CLI format has; the rest is
// kept in the file and listed (what parsed) for display, never rewritten.
function parseOwnServers(v: unknown): { entries: AgentOwnServer[]; editable: boolean } | null {
  if (v === undefined || v === null) return null
  const entries: AgentOwnServer[] = []
  if (isPlainMap(v)) {
    for (const [name, def] of Object.entries(v)) {
      const parsed = parseMcpDef(def)
      if (parsed) entries.push({ name, def: parsed })
    }
    return { entries, editable: false }
  }
  if (!Array.isArray(v)) return { entries, editable: false }
  let editable = true
  for (const item of v) {
    if (typeof item === 'string' && item !== '') {
      entries.push({ name: item, def: null })
      continue
    }
    const keys = isPlainMap(item) ? Object.keys(item) : []
    const def = keys.length === 1 ? parseMcpDef((item as Record<string, unknown>)[keys[0]]) : null
    if (def) entries.push({ name: keys[0], def })
    else editable = false
  }
  return { entries, editable }
}

function parseOwnHooks(v: unknown): { config: HooksConfig; editable: boolean } | null {
  if (v === undefined || v === null) return null
  // A shape that is not a map of lists is kept in the file and shown as empty.
  return parseHooks(v) ?? { config: {}, editable: false }
}

function fieldsOf(doc: YAML.Document.Parsed): AgentFields | null {
  const data = doc.toJS()
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const name = data.name
  if (name === undefined || name === null || String(name) === '') return null
  return {
    name: String(name),
    description: optionalString(data.description) ?? '',
    model: optionalString(data.model),
    color: optionalString(data.color),
    icon: optionalString(data.icon),
    tools: parseTools(data.tools),
    commands: data.commands === undefined || data.commands === null ? null : parseCommands(data.commands),
    memory: optionalString(data.memory),
    memoryLimit: parseLimit(data.memoryLimit),
    // Strict: a quoted "true" must not turn on control of the user's PC.
    computerUse: data.computerUse === undefined || data.computerUse === null ? null : data.computerUse === true,
    autoCompactWindow: parseWindow(data.autoCompactWindow),
    dailySpendCap: parseSpendCap(data.dailySpendCap),
    // Strict, like computerUse: "Codex" or "codex " must not switch the engine.
    provider: parseProvider(data.provider),
    serversOff: parseNames(data.serversOff),
    skillsOff: parseNames(data.skillsOff),
    plugins: parsePlugins(data.plugins),
    mcpServers: parseOwnServers(data.mcpServers),
    hooks: parseOwnHooks(data.hooks),
    acp: data.acp === undefined || data.acp === null ? null : parseAcpLaunch(data.acp),
    agui: data.agui === undefined || data.agui === null ? null : parseAguiLaunch(data.agui)
  }
}

// True when the file has an `acp:` value the editor could not read whole.
const acpUnreadable = (doc: YAML.Document.Parsed, f: AgentFields): boolean =>
  f.acp === null && doc.get('acp') !== undefined && doc.get('acp') !== null
// Likewise for an `agui:`.
const aguiUnreadable = (doc: YAML.Document.Parsed, f: AgentFields): boolean =>
  f.agui === null && doc.get('agui') !== undefined && doc.get('agui') !== null

/** The extension keys as the page and the run read them: null becomes an empty list, and every call returns fresh objects. */
export function extensionsOf(f: AgentFields): AgentExtensions {
  return {
    serversOff: [...(f.serversOff ?? [])],
    skillsOff: [...(f.skillsOff ?? [])],
    plugins: { ...(f.plugins ?? {}) },
    servers: (f.mcpServers?.entries ?? []).map((e) => ({
      name: e.name,
      def: e.def === null ? null : (JSON.parse(JSON.stringify(e.def)) as McpServerDef)
    })),
    serversEditable: f.mcpServers?.editable ?? true,
    hooks: JSON.parse(JSON.stringify(f.hooks?.config ?? {})) as HooksConfig,
    hooksEditable: f.hooks?.editable ?? true
  }
}

export function parseAgent(raw: string): ParsedAgent {
  const s = split(raw)
  if (!s) return { ok: false, error: NO_FRONTMATTER }
  const doc = YAML.parseDocument(s.yaml)
  if (doc.errors.length > 0) return { ok: false, error: doc.errors[0].message }
  const fields = fieldsOf(doc)
  if (!fields) return { ok: false, error: 'Frontmatter has no name' }
  return { ok: true, fields, body: s.body, acpEditable: !acpUnreadable(doc, fields), aguiEditable: !aguiUnreadable(doc, fields) }
}

function sameTools(a: string[] | null, b: string[] | null): boolean {
  return a === b || (a !== null && b !== null && a.length === b.length && a.every((t, i) => t === b[i]))
}

// An absent key and an empty list both mean "no commands", so neither may rewrite the other's file.
function sameCommands(a: AgentCommand[] | null, b: AgentCommand[] | null): boolean {
  const x = a ?? []
  const y = b ?? []
  return (
    x === y ||
    (x.length === y.length &&
      x.every(
        (c, i) =>
          c.name === y[i].name &&
          c.description === y[i].description &&
          c.prompt === y[i].prompt &&
          (c.todos === true) === (y[i].todos === true) &&
          c.model === y[i].model
      ))
  )
}

const DEF_KEYS = ['type', 'command', 'args', 'env', 'url', 'headers'] as const
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// The def's keys in a fixed order, so a written file reads the same however the editor built the object.
function writeDef(def: McpServerDef): Record<string, unknown> {
  return Object.fromEntries(DEF_KEYS.filter((k) => def[k] !== undefined).map((k) => [k, def[k]]))
}

function writeHooks(config: HooksConfig): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config)
      .filter(([, groups]) => groups.length > 0)
      .map(([event, groups]) => [
        event,
        groups.map((g) => ({
          ...(g.matcher ? { matcher: g.matcher } : {}),
          hooks: g.hooks.map((h) => {
            const c = h as { type?: unknown; command?: unknown; timeout?: unknown }
            return { type: c.type, command: c.command, ...(c.timeout !== undefined ? { timeout: c.timeout } : {}) }
          })
        }))
      ])
  )
}

// Only the body changed: the frontmatter is spliced back verbatim. Otherwise the document is re-stringified for every key
// (tools and commands too), so an untouched block keeps its parsed value and its comments, but its indentation and flow
// style may be normalised (a comment after a key can move to its own line); bytes are not preserved.
export function serializeAgent(original: string, fields: AgentFields, body: string): string {
  const s = split(original)
  if (!s) throw new Error('Cannot serialize: original has no frontmatter block')
  const doc = YAML.parseDocument(s.yaml)
  const before = fieldsOf(doc)
  if (!before) throw new Error('Cannot serialize: original frontmatter is not valid')
  if (
    before.name === fields.name &&
    before.description === fields.description &&
    before.model === fields.model &&
    before.color === fields.color &&
    before.icon === fields.icon &&
    before.memory === fields.memory &&
    before.memoryLimit === fields.memoryLimit &&
    before.computerUse === fields.computerUse &&
    before.provider === fields.provider &&
    before.autoCompactWindow === fields.autoCompactWindow &&
    before.dailySpendCap === fields.dailySpendCap &&
    same(before.serversOff, fields.serversOff) &&
    same(before.skillsOff, fields.skillsOff) &&
    same(before.plugins, fields.plugins) &&
    same(before.mcpServers, fields.mcpServers) &&
    same(before.hooks, fields.hooks) &&
    same(before.acp, fields.acp) &&
    same(before.agui, fields.agui) &&
    sameTools(before.tools, fields.tools) &&
    sameCommands(before.commands, fields.commands)
  ) {
    // Only the body may have changed: splice the original frontmatter verbatim.
    return s.head + body
  }

  if (before.name !== fields.name) doc.set('name', fields.name)
  if (before.description !== fields.description) doc.set('description', fields.description)
  for (const key of ['model', 'color', 'icon', 'memory'] as const) {
    if (before[key] === fields[key]) continue
    const value = fields[key]
    if (value === null) doc.delete(key)
    else if (key === 'icon' && !doc.has('icon')) {
      const map = doc.contents as YAML.YAMLMap
      const at = map.items.findIndex((p) => YAML.isScalar(p.key) && p.key.value === 'color')
      if (at >= 0) map.items.splice(at + 1, 0, doc.createPair('icon', value))
      else doc.set('icon', value)
    } else doc.set(key, value)
  }
  if (before.memoryLimit !== fields.memoryLimit) {
    if (fields.memoryLimit === null) doc.delete('memoryLimit')
    else doc.set('memoryLimit', fields.memoryLimit)
  }
  if (before.computerUse !== fields.computerUse) {
    if (fields.computerUse === null) doc.delete('computerUse')
    else doc.set('computerUse', fields.computerUse)
  }
  if (before.provider !== fields.provider) {
    // Claude is the absence of the key, so `provider: claude` is never written.
    if (fields.provider === null) doc.delete('provider')
    else doc.set('provider', fields.provider)
  }
  if (before.autoCompactWindow !== fields.autoCompactWindow) {
    if (fields.autoCompactWindow === null) doc.delete('autoCompactWindow')
    else doc.set('autoCompactWindow', fields.autoCompactWindow)
  }
  if (before.dailySpendCap !== fields.dailySpendCap) {
    if (fields.dailySpendCap === null) doc.delete('dailySpendCap')
    else doc.set('dailySpendCap', fields.dailySpendCap)
  }
  if (!sameTools(before.tools, fields.tools)) {
    if (fields.tools === null) doc.delete('tools')
    else if (YAML.isSeq(doc.get('tools', true))) doc.set('tools', doc.createNode(fields.tools))
    else doc.set('tools', fields.tools.join(', '))
  }
  if (!sameCommands(before.commands, fields.commands)) {
    if (fields.commands === null || fields.commands.length === 0) doc.delete('commands')
    // Multi-line prompts come out as block scalars. The key order is fixed here, because the editor appends `todos` last.
    else
      doc.set(
        'commands',
        doc.createNode(
          fields.commands.map(({ name, description, prompt, todos, model }) => ({
            name,
            description,
            ...(model !== undefined ? { model } : {}),
            ...(todos === true ? { todos: true } : {}),
            prompt
          }))
        )
      )
  }
  // A list written empty is an absent key, as with commands.
  for (const key of ['serversOff', 'skillsOff'] as const) {
    if (same(before[key], fields[key])) continue
    const list = fields[key]
    if (list === null || list.length === 0) doc.delete(key)
    else doc.set(key, doc.createNode(list))
  }
  if (!same(before.plugins, fields.plugins)) {
    if (fields.plugins === null || Object.keys(fields.plugins).length === 0) doc.delete('plugins')
    else doc.set('plugins', doc.createNode(fields.plugins))
  }
  // The FILE's own flag guards `mcpServers` and `hooks`: a block the editor could not read whole (`before.<key>.editable`
  // false) is never rewritten or deleted by a caller's value, whatever flag that value carries, and the call is a silent no-op.
  // Only an explicit null removes it.
  if (!same(before.mcpServers, fields.mcpServers)) {
    const own = fields.mcpServers
    if (own === null) doc.delete('mcpServers')
    else if (before.mcpServers?.editable !== false && own.editable) {
      if (own.entries.length === 0) doc.delete('mcpServers')
      // writeDef keeps only the CLI's keys, so a def outside that format is never written (it would lose the rest).
      else if (own.entries.every((e) => e.def === null || parseMcpDef(e.def) !== null))
        doc.set('mcpServers', doc.createNode(own.entries.map((e) => (e.def === null ? e.name : { [e.name]: writeDef(e.def) }))))
    }
  }
  if (!same(before.hooks, fields.hooks)) {
    const own = fields.hooks
    if (own === null) doc.delete('hooks')
    // Likewise a config with a `prompt` hook or an extra key is never written, whatever its flag says.
    else if (before.hooks?.editable !== false && own.editable && parseHooks(own.config)?.editable === true) {
      const written = writeHooks(own.config)
      if (Object.keys(written).length === 0) doc.delete('hooks')
      else doc.set('hooks', doc.createNode(written))
    }
  }

  // Same guard as the two blocks above, by the FILE's own state: an `acp:` that did not parse is never rewritten from a caller's value.
  if (!same(before.acp, fields.acp) && !acpUnreadable(doc, before)) {
    if (fields.acp === null) doc.delete('acp')
    else if (parseAcpLaunch(fields.acp) !== null)
      doc.set('acp', doc.createNode({ command: fields.acp.command, args: fields.acp.args, authEnv: fields.acp.authEnv }))
  }

  // The same guard for `agui:`. authKey and authHeader are written only when set, so a null never lands in the file.
  if (!same(before.agui, fields.agui) && !aguiUnreadable(doc, before)) {
    if (fields.agui === null) doc.delete('agui')
    else if (parseAguiLaunch(fields.agui) !== null) {
      const { endpoint, authKey, authHeader } = fields.agui
      doc.set(
        'agui',
        doc.createNode({ endpoint, ...(authKey === null ? {} : { authKey }), ...(authHeader === null ? {} : { authHeader }) })
      )
    }
  }

  const crlf = original.includes('\r\n')
  let yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false })
  if (!yaml.endsWith('\n')) yaml += '\n'
  const eol = crlf ? '\r\n' : '\n'
  if (crlf) yaml = yaml.replace(/\n/g, '\r\n')
  return `---${eol}${yaml}---${eol}${body}`
}

/**
 * The fields' errors. `acpReadable` is `ParsedAgent.acpEditable`: false when the file holds an `acp:` that does not parse;
 * `aguiReadable` is `ParsedAgent.aguiEditable` likewise. An ACP agent needs a readable launch with a command, and a remote
 * agent a readable endpoint, so Save never writes an agent that can't run; a caller's launch that serializeAgent would drop
 * is refused instead of silently kept as it was.
 */
export function validateFields(f: AgentFields, acpReadable = true, aguiReadable = true): string[] {
  const errors: string[] = []
  if (!NAME_PATTERN.test(f.name)) errors.push('Name must be lowercase letters, digits and single hyphens')
  if (f.description.trim() === '') errors.push('Description is required')
  if (f.acp !== null) {
    const bad = acpLaunchError(f.acp)
    const flag = bad === null ? refusedArg(f.acp.args) : null
    if (bad !== null) errors.push(bad)
    else if (flag !== null) errors.push(ACP_TEXT.refusedArg(flag))
  } else if (f.provider === 'acp') errors.push(acpReadable ? ACP_TEXT.commandRequired : ACP_TEXT.launchUnreadable)
  if (f.agui !== null) {
    const bad = aguiLaunchError(f.agui)
    if (bad !== null) errors.push(bad)
  } else if (f.provider === 'ag-ui') errors.push(aguiReadable ? AGUI_TEXT.endpointRequired : AGUI_TEXT.launchUnreadable)
  return errors
}
