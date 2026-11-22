import { displayName } from '@zumibot/shared/frontmatter'
import { isCommandModel } from '@zumibot/shared/chatModel'
import { fillPrompt, leadingCommand, type AgentCommand, type CommandPick, type SentCommand } from '@zumibot/shared/commands'
import { splitTodo } from '@zumibot/shared/todos'
import { isGroup } from '@zumibot/shared/types'
import type { ChatStore } from '../store/chatStore'

interface Deps {
  store: Pick<ChatStore, 'get' | 'loadItems'>
  commandsOf(agent: string): Promise<AgentCommand[]>
}

/** Turns a leading `/name` into the agent's saved prompt; the server decides, never the composer. */
export class CommandResolver {
  constructor(private readonly d: Deps) {}

  async forSend(chatId: string, text: string, pick?: CommandPick): Promise<SentCommand | undefined> {
    const lead = leadingCommand(text)
    if (!lead) return undefined
    const meta = await this.d.store.get(chatId)
    if (!meta) return undefined
    const owners = isGroup(meta) ? meta.group.members : [meta.agentName]
    const find = async (agent: string): Promise<AgentCommand | undefined> => {
      // A broken agent file just has no commands; it must not fail the send.
      const list = await this.d.commandsOf(agent).catch(() => [] as AgentCommand[])
      return list.find((c) => c.name === lead.name)
    }
    const built = (agent: string, cmd: AgentCommand): SentCommand => ({
      agent,
      name: lead.name,
      prompt: fillPrompt(cmd.prompt, lead.args),
      ...(cmd.todos ? { todos: true as const } : {}),
      ...(isCommandModel(cmd.model) ? { model: cmd.model } : {})
    })
    if (pick && pick.name === lead.name) {
      if (!owners.includes(pick.agent)) throw new Error(`${displayName(pick.agent)} is not in this chat`)
      const cmd = await find(pick.agent)
      if (!cmd) throw new Error(`${displayName(pick.agent)} has no /${lead.name} command any more`)
      return built(pick.agent, cmd)
    }
    const hits: { agent: string; cmd: AgentCommand }[] = []
    for (const agent of owners) {
      const cmd = await find(agent)
      if (cmd) hits.push({ agent, cmd })
    }
    if (hits.length === 0) return undefined
    if (hits.length > 1) {
      const names = hits.map((h) => displayName(h.agent)).join(', ')
      throw new Error(`Several members have /${lead.name} (${names}): pick one from the / menu`)
    }
    return built(hits[0].agent, hits[0].cmd)
  }

  /**
   * A routine run's command. Only the saved prompt can name one: a webhook field filled in at the start must never turn
   * a caller's text into a command. A pick gone stale since the routine was saved (the member left, the command was
   * dropped) falls back to the name alone, as an edit's does, so only a real ambiguity fails the run.
   */
  async forRoutine(chatId: string, saved: string, text: string, pick?: CommandPick): Promise<SentCommand | undefined> {
    const name = leadingCommand(saved)?.name
    if (name === undefined || leadingCommand(text)?.name !== name) return undefined
    if (pick?.name !== name) return this.forSend(chatId, text)
    try {
      return await this.forSend(chatId, text, pick)
    } catch {
      return this.forSend(chatId, text)
    }
  }

  /** `given`: the pick the editor's menu made for this text (edit only); it wins over the old command's agent. */
  async forRerun(chatId: string, userId: string, text: string | null, given?: CommandPick): Promise<SentCommand | undefined> {
    const old = (await this.d.store.loadItems(chatId)).find((i) => i.type === 'user' && i.id === userId)
    if (!old || old.type !== 'user') return undefined // the queue reports a missing message
    if (text === null && !old.command) return undefined // a plain message stays plain, even if the agent has the command now
    // A leading /todo is the handler's to read; the command is whatever follows it.
    const body = splitTodo(text ?? old.text).rest
    const pick =
      given ??
      (old.command && leadingCommand(body)?.name === old.command.name ? { agent: old.command.agent, name: old.command.name } : undefined)
    try {
      return (await this.forSend(chatId, body, pick)) ?? (text === null ? old.command : undefined)
    } catch (err) {
      // Resend keeps what was sent before; an edit drops the stale pick so it can't trap the text, and a real ambiguity surfaces from the retry.
      // A pick the user just made is no stale one: its refusal (the agent left, lost the command) is shown as it is.
      if (text === null) return old.command
      if (!pick || given) throw err
      return this.forSend(chatId, body)
    }
  }
}
