// Pure drafts and checks for the three forms of Settings › Claude Code (a server, a hook, a skill), shared with Agent Studio's
// own-servers and own-hooks cards. Every field is a string, as typed; a builder turns a draft into what the RPC takes. The
// checks mirror what the server refuses, so a form never sends what would only come back as an error.
import {
  EXT_TEXT,
  isReservedServerName,
  isServerName,
  type HookFile,
  type HookInput,
  type HookPosition,
  type LoadoutHook,
  type McpScope,
  type McpServerInput,
  type McpServerView,
  type SkillView
} from '@zumibot/shared/extensions'
import { NAME_PATTERN } from '@zumibot/shared/frontmatter'

/** Field name to message; an absent key is a field with nothing wrong. */
export type FormErrors = Partial<Record<string, string>>

export const hasErrors = (e: FormErrors): boolean => Object.values(e).some((m) => m !== undefined)

const isDirty = <T>(draft: T, opened: T): boolean => JSON.stringify(draft) !== JSON.stringify(opened)

// An own property, so a `__proto__` name stays a name instead of setting the prototype.
function setOwn<T>(o: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true })
}

// ---- MCP server ----

export type Transport = 'stdio' | 'http' | 'sse'

/** One env or header row. `stored`: the server holds a value for this name that the page never gets, so blank means keep it. */
export interface ValueRow {
  name: string
  value: string
  stored: boolean
}

export interface ServerDraft {
  name: string
  /** Where it is saved; null in the agent file mode, which has no scope. */
  scope: McpScope | null
  transport: Transport
  command: string
  argsText: string
  /** An argument the one-per-line box would change (empty, padded, or with a line break): saving is refused, never altered. */
  argsLossy: boolean
  url: string
  env: ValueRow[]
  headers: ValueRow[]
}

export function emptyServerDraft(scope: McpScope | null): ServerDraft {
  return { name: '', scope, transport: 'stdio', command: '', argsText: '', argsLossy: false, url: '', env: [], headers: [] }
}

const blankRow = (): ValueRow => ({ name: '', value: '', stored: false })
export const newValueRow = blankRow

const rowsOf = (map: Record<string, string> | undefined, hidden: readonly string[]): ValueRow[] =>
  Object.entries(map ?? {}).map(([name, value]) =>
    hidden.includes(name) ? { name, value: '', stored: true } : { name, value, stored: false }
  )

const argLossy = (a: string): boolean => a === '' || a.trim() !== a || /[\r\n]/.test(a)

/** The form for a stored server: a hidden value is a stored blank row, any other value is shown (the agent file mode). */
export function serverDraftOf(v: McpServerView): ServerDraft {
  const { def } = v
  const args = def.args ?? []
  return {
    name: v.name,
    scope: v.scope,
    transport: def.type ?? (def.url !== undefined && def.command === undefined ? 'http' : 'stdio'),
    command: def.command ?? '',
    argsText: args.join('\n'),
    argsLossy: args.some(argLossy),
    url: def.url ?? '',
    env: rowsOf(def.env, v.hidden.env),
    headers: rowsOf(def.headers, v.hidden.headers)
  }
}

/** The Arguments box was edited: what is in it now is what the user means, so the "cannot show it" refusal ends. */
export const withArgsText = (d: ServerDraft, argsText: string): ServerDraft => ({ ...d, argsText, argsLossy: false })

/** From Vault only in the agent file mode: a `${vault:…}` reference elsewhere would never be rewritten into an env name. */
export const showVaultPicker = (
  scopes: readonly McpScope[] | null,
  vaultKeys: ReadonlyArray<{ env: string; name: string }> | undefined
): boolean => scopes === null && vaultKeys !== undefined && vaultKeys.length > 0

const valuesOf = (rows: readonly ValueRow[]): Record<string, string | null> | undefined => {
  const out: Record<string, string | null> = {}
  for (const r of rows) {
    const name = r.name.trim()
    if (name === '' && r.value === '') continue
    setOwn(out, name, r.stored && r.value === '' ? null : r.value)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** What a save sends: only the picked transport's fields, so a command and a url never go together. */
export function serverInputOf(d: ServerDraft): McpServerInput {
  if (d.transport !== 'stdio') {
    const headers = valuesOf(d.headers)
    return { type: d.transport, url: d.url.trim(), ...(headers ? { headers } : {}) }
  }
  const args = d.argsText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const env = valuesOf(d.env)
  return { type: 'stdio', command: d.command.trim(), ...(args.length > 0 ? { args } : {}), ...(env ? { env } : {}) }
}

const TEXT_MAX = 10_000
const ROWS_MAX = 200
const ROW_NAME_MAX = 200

function rowsError(rows: readonly ValueRow[]): string | undefined {
  if (rows.length > ROWS_MAX) return `At most ${ROWS_MAX} rows.`
  const seen = new Set<string>()
  for (const r of rows) {
    const name = r.name.trim()
    if (name === '' && r.value === '') continue
    if (name === '') return 'Give every value a name.'
    if (/[=\r\n\0]/.test(name)) return 'A name cannot contain "=" or a line break.'
    if (name.length > ROW_NAME_MAX) return `A name can be at most ${ROW_NAME_MAX} characters.`
    if (r.value.length > TEXT_MAX) return `A value can be at most ${TEXT_MAX} characters.`
    if (seen.has(name)) return `"${name}" is listed twice.`
    seen.add(name)
  }
  return undefined
}

/**
 * What is wrong with the form. `scopes` are the places it offers (the Settings page's three), or null for the agent file mode,
 * which has none. A reserved name is refused whenever it is written, an edit in place included, as the server does.
 */
export function serverErrors(d: ServerDraft, scopes: readonly McpScope[] | null): FormErrors {
  const e: FormErrors = {}
  const name = d.name.trim()
  if (name === '') e.name = 'Give the server a name.'
  else if (!isServerName(name)) e.name = EXT_TEXT.badName
  else if (isReservedServerName(name)) e.name = EXT_TEXT.reservedName
  if (scopes !== null && (d.scope === null || !scopes.includes(d.scope))) e.scope = 'Pick where to save the server.'
  if (d.transport === 'stdio') {
    if (d.command.trim() === '') e.command = 'Enter the command that starts the server.'
    else if (d.command.length > TEXT_MAX) e.command = `The command can be at most ${TEXT_MAX} characters.`
    if (d.argsLossy)
      e.args =
        'An argument is empty, padded with spaces or has a line break, which this form cannot show, so it cannot save over it. Change it with claude mcp.'
    else if (d.argsText.split('\n').length > ROWS_MAX) e.args = `At most ${ROWS_MAX} arguments.`
    const env = rowsError(d.env)
    if (env) e.env = env
  } else {
    if (d.url.trim() === '') e.url = 'Enter the server URL.'
    else if (d.url.length > TEXT_MAX) e.url = `The URL can be at most ${TEXT_MAX} characters.`
    const headers = rowsError(d.headers)
    if (headers) e.headers = headers
  }
  return e
}

export const isServerDirty = (draft: ServerDraft, opened: ServerDraft): boolean => isDirty(draft, opened)

/** What a From Vault pick writes into a value: the run rewrites it to an env name, so the value never sits in the file. */
export const vaultReference = (env: string): string => '${vault:' + env + '}'

/** A From Vault pick: an empty value becomes the reference, a value with a typed prefix (`Bearer `) gets it added after; never twice. */
export function withVaultReference(value: string, env: string): string {
  const ref = vaultReference(env)
  return value.includes(ref) ? value : value + ref
}

/** A value typed into an agent file's server that holds no Vault reference: the file keeps it as plain text, and the form says so. */
export const isPlainValue = (value: string): boolean => value.trim() !== '' && !/\$\{vault:[A-Za-z_][A-Za-z0-9_]*\}/.test(value)

// ---- hook ----

/** The events the CLI runs hooks for, offered as suggestions; any event name is accepted. */
export const HOOK_EVENTS: readonly string[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'SessionStart',
  'SessionEnd',
  'PermissionRequest'
]

export interface HookDraft {
  file: HookFile
  event: string
  matcher: string
  command: string
  /** As typed; empty means the CLI's own default. */
  timeoutText: string
  /** Where the hook sits in its file when editing it, null for an add. */
  at: HookPosition | null
  /** The file's stamp for an edit; an add needs none. */
  stamp: string | null
}

export const emptyHookDraft = (file: HookFile): HookDraft => ({
  file,
  event: '',
  matcher: '',
  command: '',
  timeoutText: '',
  at: null,
  stamp: null
})

/** What a hook form opens on: a loadout row, or an agent's own hook shaped like one. */
export type HookSeed = Pick<LoadoutHook, 'event' | 'matcher' | 'command' | 'timeout' | 'at' | 'stamp'>

export function hookDraftOf(h: HookSeed, file: HookFile): HookDraft {
  return {
    file,
    event: h.event,
    matcher: h.matcher,
    command: h.command,
    timeoutText: h.timeout === null ? '' : String(h.timeout),
    at: h.at ? { ...h.at } : null,
    stamp: h.stamp
  }
}

const timeoutOf = (text: string): number | undefined => {
  const t = text.trim()
  return t === '' ? undefined : Number(t)
}

export function hookInputOf(d: HookDraft): HookInput {
  const timeout = timeoutOf(d.timeoutText)
  return {
    event: d.event.trim(),
    matcher: d.matcher,
    command: d.command.trim(),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(d.at ? { at: d.at } : {})
  }
}

// The server's own rule: letters and digits, which also keeps `__proto__` out of the hooks block.
const EVENT_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/

export function hookErrors(d: HookDraft): FormErrors {
  const e: FormErrors = {}
  const event = d.event.trim()
  if (event === '') e.event = 'Enter the event, like PreToolUse.'
  else if (!EVENT_PATTERN.test(event)) e.event = 'An event is letters and digits only, like PreToolUse.'
  if (d.command.trim() === '') e.command = 'Enter the command to run.'
  else if (d.command.length > 20_000) e.command = 'The command can be at most 20000 characters.'
  if (d.matcher.length > 1000) e.matcher = 'The matcher can be at most 1000 characters.'
  const timeout = timeoutOf(d.timeoutText)
  if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0))
    e.timeout = 'The timeout is a number of seconds above 0, or empty.'
  return e
}

export const isHookDirty = (draft: HookDraft, opened: HookDraft): boolean => isDirty(draft, opened)

// ---- skill ----

export interface SkillDraft {
  scope: 'user' | 'project'
  name: string
  description: string
  body: string
  /** The stamp of the skill as read; null for a new one. */
  stamp: string | null
  /** The files in the skill's folder, shown read-only; they are kept as they are. */
  files: string[]
}

export const emptySkillDraft = (scope: 'user' | 'project'): SkillDraft => ({
  scope,
  name: '',
  description: '',
  body: '',
  stamp: null,
  files: []
})

export const skillDraftOf = (v: SkillView): SkillDraft => ({
  scope: v.scope,
  name: v.name,
  description: v.description,
  body: v.body,
  stamp: v.stamp,
  files: [...v.files]
})

export function skillInputOf(d: SkillDraft): { name: string; description: string; body: string; stamp?: string } {
  return {
    name: d.name,
    description: d.description.trim(),
    body: d.body.replace(/\r\n/g, '\n'),
    ...(d.stamp !== null ? { stamp: d.stamp } : {})
  }
}

const DESCRIPTION_MAX = 5_000
const BODY_MAX = 500_000

/** A stored skill's name is read-only, so only a new one is checked (an odd stored name must not block editing its body). */
export function skillErrors(d: SkillDraft): FormErrors {
  const e: FormErrors = {}
  if (d.stamp === null) {
    if (d.name === '') e.name = 'Give the skill a name.'
    else if (d.name.length > 100 || !NAME_PATTERN.test(d.name)) e.name = EXT_TEXT.badSkillName
    else if (d.name === 'synced') e.name = 'That name is reserved.'
  }
  if (d.description.trim() === '') e.description = 'Describe when Claude should use the skill.'
  else if (d.description.length > DESCRIPTION_MAX) e.description = `The description can be at most ${DESCRIPTION_MAX} characters.`
  if (d.body.length > BODY_MAX) e.body = `The instructions can be at most ${BODY_MAX} characters.`
  return e
}

export const isSkillDirty = (draft: SkillDraft, opened: SkillDraft): boolean => isDirty(draft, opened)
