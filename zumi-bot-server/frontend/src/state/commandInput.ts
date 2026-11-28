// Pure helpers for the `/` command menu of the composer and the message editor.
import { leadingCommand, type CommandPick, type CommandSummary } from '@zumibot/shared/commands'
import { commandTokens } from '@zumibot/shared/commentCommands'
import { engineLeading, type CommandEngine, type EngineCommand, type EngineCommands } from '@zumibot/shared/engineCommands'
import { findMentions } from '@zumibot/shared/mentions'
import type { AgentSummary } from '@zumibot/shared/types'
import { BTW_DESCRIPTION, BTW_NAME } from '@zumibot/shared/btw'
import { RUN_WORKFLOW_DESCRIPTION, RUN_WORKFLOW_NAME, afterWorkflowName, runWorkflowRest } from '@zumibot/shared/runWorkflow'
import { splitTodo, TODO_NAME } from '@zumibot/shared/todos'
import { LATER_DESCRIPTION, LATER_NAME } from '@zumibot/shared/later'

export interface AgentCommandOption {
  agent: AgentSummary
  command: CommandSummary
}

/** A row of the agent engine's own list: a Claude Code command or a Codex skill. */
export interface EngineCommandOption {
  engine: CommandEngine
  command: EngineCommand
}

export type CommandOption = AgentCommandOption | EngineCommandOption | { builtin: 'btw' | 'todo' | 'run-workflow' | 'later'; description: string }

export const TODO_DESCRIPTION = "Put this reply's action items on the chat's to-do list"

// A leading `/todo` and the whitespace after it: the only place the menu opens again, for the command it goes with.
const AFTER_TODO = new RegExp(`^/${TODO_NAME}\\s+(?=/)`)
// A leading `/run-workflow` and whitespace, then what was typed of the workflow's name (and past it, which matches nothing).
const WORKFLOW_QUERY = new RegExp(`^/${RUN_WORKFLOW_NAME}[ \\t]+(.*)$`)
// Wider than agent command names: engine rows have uppercase, `:` (plugin namespaces), `.` and `_`.
const SLASH_QUERY = new RegExp(`^(/${TODO_NAME}\\s+)?/([A-Za-z0-9_:.-]*)$`)

/**
 * The query after a leading `/` (or after a leading `/todo `, `afterTodo`), or null. `before` is the caret block's text
 * before the caret; only the message's first block counts, so a pasted "/path" further down never opens the menu.
 */
export function slashQuery(before: string, firstBlock: boolean): { query: string; afterTodo: boolean } | null {
  if (!firstBlock) return null
  const m = SLASH_QUERY.exec(before)
  return m ? { query: m[2], afterTodo: m[1] !== undefined } : null
}

/** What follows `/run-workflow ` before the caret (the Workflows list's query), or null until the space after the command. */
export function workflowQuery(before: string): string | null {
  const m = WORKFLOW_QUERY.exec(before)
  return m ? m[1] : null
}

/** The same for a plain text box (the message editor): the caret is a bare caret right after a leading `/name`. */
export function textSlashQuery(text: string, selectionStart: number, selectionEnd: number): { query: string; afterTodo: boolean } | null {
  return selectionStart === selectionEnd ? slashQuery(text.slice(0, selectionStart), true) : null
}

/** `text` with the `/query` before the caret replaced by `/name ` (what the rest of the text was stays, and so does a leading `/todo `), and where the caret goes. */
export function insertCommandName(text: string, caret: number, name: string): { text: string; caret: number } {
  const before = text.slice(0, caret)
  const lead = (AFTER_TODO.exec(before)?.[0] ?? '') + `/${name} `
  return { text: lead + text.slice(caret), caret: lead.length }
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '')

/**
 * Per agent (in the given order, broken ones skipped): name prefixes in file order, then description word prefixes. The
 * engine's own rows (`opts.engine`) follow the agents' by the same rule.
 */
export function filterCommands(
  query: string,
  agents: readonly AgentSummary[],
  opts: { afterTodo?: boolean; btw?: boolean; todo?: boolean; runWorkflow?: boolean; later?: boolean; engine?: EngineCommands | null } = {}
): CommandOption[] {
  const q = query.toLowerCase()
  // Built-ins only at the top level: after `/todo ` the menu is for the command the to-do list goes with.
  const builtins: CommandOption[] = opts.afterTodo
    ? []
    : [
        ...(opts.btw !== false && BTW_NAME.startsWith(q) ? [{ builtin: 'btw' as const, description: BTW_DESCRIPTION }] : []),
        ...(opts.todo !== false && TODO_NAME.startsWith(q) ? [{ builtin: 'todo' as const, description: TODO_DESCRIPTION }] : []),
        ...(opts.runWorkflow !== false && RUN_WORKFLOW_NAME.startsWith(q)
          ? [{ builtin: 'run-workflow' as const, description: RUN_WORKFLOW_DESCRIPTION }]
          : []),
        ...(opts.later !== false && LATER_NAME.startsWith(q) ? [{ builtin: 'later' as const, description: LATER_DESCRIPTION }] : [])
      ]
  const options = agents.flatMap((agent) => {
    if (agent.error !== null) return []
    // A command that makes to-dos is /todo's kin: hidden with it, since the server refuses both for an agent without the tools.
    const commands = (agent.commands ?? []).filter(
      (c) =>
        c.name !== BTW_NAME &&
        c.name !== TODO_NAME &&
        c.name !== RUN_WORKFLOW_NAME &&
        c.name !== LATER_NAME &&
        !(opts.todo === false && c.todos === true)
    )
    const byName = commands.filter((c) => c.name.startsWith(q))
    const byWord = commands.filter((c) => !byName.includes(c) && words(c.description).some((w) => w.startsWith(q)))
    return [...byName, ...byWord].map((command) => ({ agent, command }))
  })
  const list = opts.engine
  const engineRows = (kind: 'skill' | 'command'): EngineCommandOption[] => {
    if (!list) return []
    const rows = list.commands.filter((c) => c.kind === kind)
    const byName = rows.filter((c) => c.name.toLowerCase().startsWith(q))
    const byWord = rows.filter((c) => !byName.includes(c) && words(c.description).some((w) => w.startsWith(q)))
    return [...byName, ...byWord].map((command) => ({ engine: list.engine, command }))
  }
  // The order the user reads them in: the agent's own commands, ZumiBot's, then the engine's skills and its other commands.
  return [...options, ...builtins, ...engineRows('skill'), ...engineRows('command')]
}

export const WORKFLOW_MENU_MAX = 8

/** The Workflows list of `/run-workflow `: names starting with the query first, then names with a word starting with it (it may span words). */
export function filterWorkflowNames<T extends { name: string }>(query: string, ws: readonly T[]): T[] {
  const q = query.toLowerCase()
  const named = ws.filter((w) => w.name.trim() !== '')
  const byName = named.filter((w) => w.name.toLowerCase().startsWith(q))
  const byWord = named.filter((w) => {
    if (byName.includes(w)) return false
    const name = w.name.toLowerCase()
    return Array.from(name.matchAll(/(?<![\p{L}\p{N}])[\p{L}\p{N}]/gu)).some((m) => name.startsWith(q, m.index))
  })
  return [...byName, ...byWord].slice(0, WORKFLOW_MENU_MAX)
}

/** A workflow picked from the Workflows list: its id goes with the send, so a duplicate or longer name cannot win. */
export interface WorkflowPick {
  id: string
  name: string
}

/** The pick holds only while the text still starts with `/run-workflow <its name>` (then whitespace or the end). */
export function keepWorkflowPick(text: string, pick: WorkflowPick | null): WorkflowPick | null {
  if (pick === null) return null
  const rest = runWorkflowRest(text)
  return rest !== null && afterWorkflowName(rest, pick.name) !== null ? pick : null
}

/**
 * The Workflows list's query (`before` is the text before the caret, `text` the whole draft): closed while a pick holds,
 * so Enter after "Report" sends instead of picking "Report weekly", which the query still matches.
 */
export function workflowMenuQuery(before: string, text: string, pick: WorkflowPick | null): string | null {
  return keepWorkflowPick(text, pick) === null ? workflowQuery(before) : null
}

/** The menu's sections in a room: one per agent, in the order the options come. */
export function groupOptions(options: readonly CommandOption[]): { agent: AgentSummary; options: AgentCommandOption[] }[] {
  const groups: { agent: AgentSummary; options: AgentCommandOption[] }[] = []
  for (const o of options) {
    if ('builtin' in o || 'engine' in o) continue
    const last = groups.at(-1)
    if (last && last.agent.name === o.agent.name) last.options.push(o)
    else groups.push({ agent: o.agent, options: [o] })
  }
  return groups
}

/**
 * The pick holds only while the text still starts with its `/name`; editing the name drops it. Given `agents` (whose
 * commands the menu lists now), it also needs its agent there, loadable and still offering the command: an agent
 * switched away on the new-chat screen, or a member who left, would make the server refuse the send. An engine pick
 * (a Claude command or Codex skill) reads its name with the wider engine rule, needs its agent among `agents` and, given `engine`, needs that list
 * (same engine) to still hold the name; the agent's own commands play no part in it.
 */
export function keepPick(
  text: string,
  pick: CommandPick | null,
  agents?: readonly AgentSummary[],
  engine?: EngineCommands | null
): CommandPick | null {
  if (pick?.engine !== undefined) {
    if (engineLeading(splitTodo(text).rest)?.name !== pick.name) return null
    // The new-chat screen may have switched agent since the pick: the row was that agent's.
    if (agents !== undefined && !agents.some((x) => x.name === pick.agent)) return null
    return !engine || (engine.engine === pick.engine && engine.commands.some((c) => c.name === pick.name)) ? pick : null
  }
  if (pick === null || leadingCommand(splitTodo(text).rest)?.name !== pick.name) return null
  const owned = (a: AgentSummary): boolean =>
    a.name === pick.agent && a.error === null && (a.commands ?? []).some((c) => c.name === pick.name)
  return agents === undefined || agents.some(owned) ? pick : null
}

/** The `/word` being typed right before the caret in a comment box: anywhere, after the start or whitespace. */
export function commentSlashQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?<!\S)\/([a-z0-9-]*)$/.exec(text.slice(0, caret))
  return m ? { start: m.index, query: m[1]! } : null
}

/** Replaces the typed `/query` with `/name ` and puts the caret after the space. */
export function insertCommentCommand(text: string, q: { start: number }, caret: number, name: string): { text: string; caret: number } {
  const inserted = `/${name} `
  return { text: text.slice(0, q.start) + inserted + text.slice(caret), caret: q.start + inserted.length }
}

/**
 * A comment box's `/` list: the commands of every agent the comment mentions, in the order they are mentioned. Built-ins
 * have no meaning on a card, so only agents' own commands show.
 */
export function commentCommandOptions(query: string, text: string, members: readonly AgentSummary[]): AgentCommandOption[] {
  const mentioned = findMentions(
    text,
    members.map((m) => m.name)
  ).flatMap((n) => members.filter((m) => m.name === n))
  return filterCommands(query, mentioned, { btw: false, runWorkflow: false, later: false }).filter((o): o is AgentCommandOption => !('builtin' in o) && !('engine' in o))
}

/** A `/name` in a comment that runs: its range in the text and the agent it is tinted for (null: several own it). */
export interface CommentCommandMark {
  start: number
  end: number
  agent: AgentSummary | null
}

/**
 * The `/name`s a comment runs, as the server reads them (`commentCommands`): each one some mentioned agent owns. One
 * owner tints it in that agent's color; several (each runs its own) leave it marked but untinted. Any other `/word` is text.
 */
export function commentCommandMarks(text: string, members: readonly AgentSummary[]): CommentCommandMark[] {
  const mentioned = findMentions(
    text,
    members.map((m) => m.name)
  ).flatMap((n) => members.filter((m) => m.name === n && m.error === null))
  return commandTokens(text).flatMap((t) => {
    const owners = mentioned.filter((a) => (a.commands ?? []).some((c) => c.name === t.name))
    return owners.length === 0 ? [] : [{ start: t.start, end: t.end, agent: owners.length === 1 ? owners[0]! : null }]
  })
}

/** A posted comment's commands for its Markdown: each `/name` that runs, to its one owner's name ('' when several own it). */
export function commentCommandMap(text: string, members: readonly AgentSummary[]): Map<string, string> {
  return new Map(commentCommandMarks(text, members).map((m) => [text.slice(m.start + 1, m.end), m.agent?.name ?? '']))
}
