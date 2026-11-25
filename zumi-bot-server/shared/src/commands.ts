import { isCommandModel, type CommandModel } from './chatModel'
import type { CommandEngine } from './engineCommands'
import { TODO_NAME } from './todos'

/** A saved prompt an agent offers as `/name` in the composer; stored in the agent file's frontmatter. */
export interface AgentCommand {
  name: string
  description: string
  prompt: string
  todos?: true // using it always builds the chat's to-do list, as if the message began with /todo
  model?: string // opus, sonnet or haiku: the model a chat it starts runs on (see chatModel.ts); kept as written for the editor
}

/** What the composer menu needs; the prompt stays on the server. */
export type CommandSummary = Pick<AgentCommand, 'name' | 'description' | 'todos'> & { model?: CommandModel }

/** What the composer sends: the server looks the prompt up itself. */
export interface CommandPick {
  agent: string
  name: string
  engine?: CommandEngine // set for a Claude command or Codex skill row; absent for an agent command
}

/** Stored on the user item; `prompt` is already filled, so later edits to the agent file never change history. */
export interface SentCommand {
  agent: string
  name: string
  prompt: string
  todos?: true
  model?: CommandModel
  engine?: CommandEngine
}

export const ARGUMENTS = '$ARGUMENTS'
export const COMMAND_PROMPT_MAX = 8000

// Same rule as agent names; kept here because frontmatter.ts imports this file.
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const LEADING = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/

/** Lossless enough for the editor to show bad rows: nothing is dropped, only stringified. */
export function parseCommands(v: unknown): AgentCommand[] {
  if (!Array.isArray(v)) return []
  return v.map((e) => {
    const o = e !== null && typeof e === 'object' ? (e as Record<string, unknown>) : {}
    // An object or list value would stringify to "[object Object]"; empty makes the row fail validation instead.
    const s = (k: string) => (o[k] === undefined || o[k] === null || typeof o[k] === 'object' ? '' : String(o[k]))
    const c: AgentCommand = { name: s('name'), description: s('description'), prompt: s('prompt') }
    if (o.todos === true) c.todos = true // only the boolean; "yes" or 1 stays off
    if (o.model !== undefined && o.model !== null) c.model = typeof o.model === 'object' ? '' : String(o.model)
    return c
  })
}

/** The first rule row `index` breaks, or null. */
export function commandIssue(list: readonly AgentCommand[], index: number): string | null {
  const c = list[index]
  if (!NAME.test(c.name)) return 'Name must be lowercase letters, digits and single hyphens'
  if (c.name === TODO_NAME) return `/${TODO_NAME} is built in`
  if (list.findIndex((o) => o.name === c.name) < index) return `Another command is already named /${c.name}`
  if (c.description.trim() === '') return 'Description is required'
  if (/[\r\n]/.test(c.description.trim())) return 'Description must be one line'
  if (c.prompt.trim() === '') return 'Prompt is required'
  if (c.prompt.length > COMMAND_PROMPT_MAX) return `Prompt is longer than ${COMMAND_PROMPT_MAX} characters`
  if (c.model !== undefined && !isCommandModel(c.model)) return 'Model must be opus, sonnet or haiku'
  return null
}

export function validCommands(list: readonly AgentCommand[]): AgentCommand[] {
  return list.filter((_, i) => commandIssue(list, i) === null)
}

/** Only at index 0 of the untrimmed text, so a pasted "/path" later in a message is never a command. */
export function leadingCommand(text: string): { name: string; args: string } | null {
  const m = LEADING.exec(text)
  return m ? { name: m[1], args: text.slice(m[0].length).trim() } : null
}

export function fillPrompt(prompt: string, args: string): string {
  const p = prompt.trimEnd() // a YAML `prompt: |` block keeps a trailing newline
  if (p.includes(ARGUMENTS)) return p.split(ARGUMENTS).join(args).trimEnd() // split/join: `replace` would read $& in the user's text
  return args === '' ? p : `${p}\n\n${args}`
}
