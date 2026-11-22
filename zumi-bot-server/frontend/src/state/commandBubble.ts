// Pure helpers for how a sent command message is drawn.
import type { AgentSummary } from '@zumibot/shared/types'
import { splitTodo, TODO_NAME } from '@zumibot/shared/todos'

/** The text still begins with `/name` as a whole word, so the chip can stand in for it. */
export function startsWithCommand(text: string, name: string): boolean {
  const lead = `/${name}`
  return text.startsWith(lead) && (text.length === lead.length || /\s/.test(text[lead.length]))
}

/**
 * The names of the chips that stand in for the text's leading `/todo` and then `/name`, in order. A chip stands in only
 * for what is really there: a flagged command sets `todo` without the user typing `/todo`, so it gets no `/todo` chip.
 */
export function leadChips(text: string, command: string | null, todo: boolean): string[] {
  const chips: string[] = []
  let rest = text
  if (todo && startsWithCommand(text, TODO_NAME)) {
    chips.push(TODO_NAME)
    rest = splitTodo(text).rest
  }
  if (command !== null && startsWithCommand(rest, command)) chips.push(command)
  return chips
}

/** The chip goes grey when the agent is gone or broken, or no longer offers the command; the stored prompt still opens. */
export function chipBroken(agent: AgentSummary | undefined, name: string): boolean {
  return !agent || agent.error !== null || !(agent.commands ?? []).some((c) => c.name === name)
}

/** `set` with `id` added, or taken out when it is there: which sent commands show their full prompt. */
export function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set)
  if (!next.delete(id)) next.add(id)
  return next
}
