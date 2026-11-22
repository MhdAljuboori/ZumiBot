import { COMMAND_MODELS, engineChatModel, isCommandModel, turnModel, type CommandModel } from '@zumibot/shared/chatModel'
import { leadingCommand } from '@zumibot/shared/commands'
import { assertNever, engineCaps, engineOfAgent, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import { splitTodo } from '@zumibot/shared/todos'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'

const label = (m: string): string => m.charAt(0).toUpperCase() + m.slice(1)

/** The Agent Studio select for a command's model: '' is no key (the agent's model); a bad value from the file stays visible. */
export function commandModelOptions(current: string | undefined): [string, string][] {
  const out: [string, string][] = [['', "Agent's model"], ...[...COMMAND_MODELS].reverse().map((m): [string, string] => [m, label(m)])]
  if (current !== undefined && current !== '' && !isCommandModel(current)) out.push([current, `${current} (not valid)`])
  return out
}

/** What decides a single chat's next model: its stored model, whether the user picked it, and whether the next turn starts a session. */
export interface ModelSource {
  model?: string
  modelByHand?: true
  fresh: boolean
}

/** The server's own `fresh` (ChatService.turnModelOf): no session yet, or a reseed. */
export const chatModelSource = (chat: ChatMeta): ModelSource => ({
  ...(chat.model !== undefined ? { model: chat.model } : {}),
  ...(chat.modelByHand ? { modelByHand: true as const } : {}),
  fresh: chat.sessionId === null || (chat.next !== undefined && 'seed' in chat.next)
})

/** The new-chat screen: nothing ran yet, and a pick made there is the chat's hand pick once it exists. */
export const newChatModelSource = (pick: string | undefined): ModelSource =>
  pick ? { model: pick, modelByHand: true, fresh: true } : { fresh: true }

export interface ModelPicker {
  /** The button: the model the next message runs on, with the typed command when that command is what moves it. */
  label: string
  title: string
  /** The menu's checked option, from the chat as stored (not the typed command); null = Default. */
  current: string | null
  options: { model: string | null; label: string }[]
  /** A pick that changes the model makes a running conversation write its whole context again once. */
  reloads: boolean
}

/**
 * The model picker of a single chat or the new-chat screen, for the text typed now. Previews run the shared rule the
 * server runs (`turnModel`, `engineChatModel`), so the button always names the model the message will run on. A Codex
 * agent offers Codex's own models (`codexModels`, from `model/list`) and previews no command. Null with no agent.
 */
export function modelPicker(
  src: ModelSource,
  agent: AgentSummary | undefined,
  text: string,
  codexModels?: readonly string[],
  caps: (e: Engine) => EngineCaps = engineCaps
): ModelPicker | null {
  if (!agent) return null
  const engine = engineOfAgent(agent)
  // The picker is the models cap's: an engine without it (ACP: its model is its own config option) shows none.
  if (!caps(engine).models) return null
  switch (engine) {
    case 'codex':
      return codexPicker(src, agent, codexModels ?? [])
    case 'claude':
      break // Claude's picker below
    case 'acp':
      return null // never reached while its `models` cap is off (above)
    case 'ag-ui':
      return null // a remote agent's model is its server's, whatever a cap says
    default:
      return assertNever(engine)
  }
  const agentModel = agent.model ?? null
  const own = agentModel && agentModel !== 'inherit' ? `Default (${nameOf(agentModel)})` : 'Default'
  const shown = (m: string | undefined) => (m === undefined ? own : nameOf(m))
  // A Codex pick left from when the agent ran on Codex is no Claude model: the server runs as if the chat had none.
  const chatModel = engineChatModel('claude', src)
  const byHand = chatModel !== undefined && src.modelByHand === true
  const runOf = (picked?: CommandModel) => turnModel({ chatModel, byHand, agentModel, picked, fresh: src.fresh }).run
  const base = runOf()
  const cmd = typedCommand(agent, text)
  const run = cmd ? runOf(cmd.model) : base
  const moved = cmd !== null && run !== base
  return {
    label: moved ? `${shown(run)} · /${cmd.name}` : shown(base),
    title: moved
      ? `/${cmd.name} runs this message on ${shown(run)}.${src.fresh ? '' : ' The conversation reloads once.'}`
      : cmd && cmd.model !== (base ?? agentModel)
        ? byHand
          ? `/${cmd.name}'s ${nameOf(cmd.model)} is skipped: you picked ${shown(base)} for this chat.`
          : `/${cmd.name}'s ${nameOf(cmd.model)} is skipped: a running conversation only moves to a stronger model.`
        : byHand
          ? "Picked by hand: commands' models are skipped. Default goes back to the agent's model and its commands."
          : chatModel !== undefined
            ? "Set by a command. Default puts the chat back on the agent's model."
            : "The agent's model in Agent Studio. A command that names a model can change it.",
    current: chatModel ?? null,
    options: [{ model: null, label: own }, ...[...COMMAND_MODELS].reverse().map((m) => ({ model: m, label: label(m) }))],
    reloads: !src.fresh
  }
}

const nameOf = (m: string): string => (isCommandModel(m) ? label(m) : m)

/** A Codex agent's picker: its file's model as Codex names it, Codex's own list, and no command previews (Codex runs none). */
function codexPicker(src: ModelSource, agent: AgentSummary, models: readonly string[]): ModelPicker {
  // As the server's codexModel reads the file: blank or `inherit` (any case) sends no model, so Codex picks its own.
  const file = agent.model?.trim()
  const own = file && file.toLowerCase() !== 'inherit' ? `Default (${file})` : 'Default'
  const picked = engineChatModel('codex', src)
  // A pick stays in the menu, checked, before `model/list` answers or after it stops listing that model.
  const list = picked !== undefined && !models.includes(picked) ? [picked, ...models] : models
  return {
    label: picked ?? own,
    title:
      picked !== undefined
        ? "Picked by hand. Default goes back to the agent's model."
        : "The agent's model in Agent Studio. Codex agents run no command models.",
    current: picked ?? null,
    options: [{ model: null, label: own }, ...list.map((m) => ({ model: m, label: m }))],
    reloads: !src.fresh
  }
}

/** The agent's command leading the text (after a `/todo`), when it names a model: the server resolves the same one. */
function typedCommand(agent: AgentSummary, text: string): { name: string; model: CommandModel } | null {
  const lead = leadingCommand(splitTodo(text).rest)
  const cmd = lead ? agent.commands?.find((c) => c.name === lead.name) : undefined
  return cmd?.model ? { name: cmd.name, model: cmd.model } : null
}
