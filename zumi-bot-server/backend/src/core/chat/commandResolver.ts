import { displayName } from '@zumibot/shared/frontmatter'
import { isCommandModel } from '@zumibot/shared/chatModel'
import { fillPrompt, leadingCommand, type AgentCommand, type CommandPick, type SentCommand } from '@zumibot/shared/commands'
import { codexPrompt, engineLeading, type CommandEngine } from '@zumibot/shared/engineCommands'
import { splitTodo } from '@zumibot/shared/todos'
import { isGroup } from '@zumibot/shared/types'
import type { ChatStore } from '../store/chatStore'

interface Deps {
  store: Pick<ChatStore, 'get' | 'loadItems'>
  commandsOf(agent: string): Promise<AgentCommand[]>
  /**
   * The agent's own engine rows in a folder (Claude Code commands, Codex skills); null when it has none or the probe failed.
   * `cachedOnly`: a Claude agent's list is read from the cache and never waited for (its text goes out as typed anyway); a Codex
   * agent's is still probed, since a hand-typed skill needs it.
   */
  engineCommandsOf(agent: string, folder: string, opts?: { cachedOnly?: boolean }): Promise<{ engine: CommandEngine; rows: { name: string }[] } | null>
}

/** Turns a leading `/name` into the agent's saved prompt; the server decides, never the composer. */
export class CommandResolver {
  constructor(private readonly d: Deps) {}

  async forSend(chatId: string, text: string, pick?: CommandPick): Promise<SentCommand | undefined> {
    const lead = leadingCommand(text)
    // An engine name may hold `:` or `.`, which an agent command's name never does.
    const eng = engineLeading(text)
    if (!lead && !eng) return undefined
    const meta = await this.d.store.get(chatId)
    if (!meta) return undefined
    const engineSent = (agent: string, name: string, engine: CommandEngine, args: string): SentCommand => ({
      agent,
      name,
      prompt: engine === 'codex' ? codexPrompt(name, args) : text,
      engine
    })
    const ep = pick?.engine ? pick : undefined
    if (ep && eng?.name === ep.name) {
      if (isGroup(meta)) throw new Error('Engine commands run only in a single chat')
      if (ep.agent !== meta.agentName) throw new Error(`${displayName(ep.agent)} is not in this chat`)
      // Claude: the CLI decides whether the name exists. Codex: the skill must still be there, or `$name` would go out as plain text.
      if (ep.engine === 'claude') return engineSent(ep.agent, ep.name, 'claude', eng.args)
      const found = await this.d.engineCommandsOf(ep.agent, meta.cwd)
      if (!(found?.engine === 'codex' && found.rows.some((r) => r.name === ep.name))) throw new Error(`Codex has no $${ep.name} skill any more`)
      return engineSent(ep.agent, ep.name, 'codex', eng.args)
    }
    // An engine pick whose name no longer leads the text is dropped, so it never steers the agent-command rules.
    const agentPick = ep ? undefined : pick
    const owners = isGroup(meta) ? meta.group.members : [meta.agentName]
    const find = async (agent: string): Promise<AgentCommand | undefined> => {
      if (!lead) return undefined
      // A broken agent file just has no commands; it must not fail the send.
      const list = await this.d.commandsOf(agent).catch(() => [] as AgentCommand[])
      return list.find((c) => c.name === lead.name)
    }
    const built = (agent: string, cmd: AgentCommand): SentCommand => ({
      agent,
      name: cmd.name,
      prompt: fillPrompt(cmd.prompt, lead?.args ?? ''),
      ...(cmd.todos ? { todos: true as const } : {}),
      ...(isCommandModel(cmd.model) ? { model: cmd.model } : {})
    })
    if (lead && agentPick && agentPick.name === lead.name) {
      if (!owners.includes(agentPick.agent)) throw new Error(`${displayName(agentPick.agent)} is not in this chat`)
      const cmd = await find(agentPick.agent)
      if (!cmd) throw new Error(`${displayName(agentPick.agent)} has no /${lead.name} command any more`)
      return built(agentPick.agent, cmd)
    }
    const hits: { agent: string; cmd: AgentCommand }[] = []
    for (const agent of owners) {
      const cmd = await find(agent)
      if (cmd) hits.push({ agent, cmd })
    }
    if (hits.length > 1) {
      const names = hits.map((h) => displayName(h.agent)).join(', ')
      throw new Error(`Several members have /${lead?.name} (${names}): pick one from the / menu`)
    }
    if (hits.length === 1) return built(hits[0].agent, hits[0].cmd)
    // Typed by hand and no agent command has the name: the agent's engine may (rooms get none).
    if (!eng || isGroup(meta)) return undefined
    const found = await this.d.engineCommandsOf(meta.agentName, meta.cwd, { cachedOnly: true })
    if (!found?.rows.some((r) => r.name === eng.name)) return undefined
    return engineSent(meta.agentName, eng.name, found.engine, eng.args)
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
    const { command } = old
    // An engine command's name may hold `:`, which the agent-command rule would not read.
    const leadName = command?.engine ? engineLeading(body)?.name : leadingCommand(body)?.name
    const pick: CommandPick | undefined =
      given ??
      (command && leadName === command.name
        ? { agent: command.agent, name: command.name, ...(command.engine ? { engine: command.engine } : {}) }
        : undefined)
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
