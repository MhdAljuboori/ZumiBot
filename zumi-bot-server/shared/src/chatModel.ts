import { assertNever, type Engine } from './engine'

/** The models a command may name, cheapest first. */
export const COMMAND_MODELS = ['haiku', 'sonnet', 'opus'] as const
export type CommandModel = (typeof COMMAND_MODELS)[number]

export const isCommandModel = (v: unknown): v is CommandModel => typeof v === 'string' && (COMMAND_MODELS as readonly string[]).includes(v)

const rank = (m: string | null | undefined): number => (isCommandModel(m) ? COMMAND_MODELS.indexOf(m) : -1)

/**
 * The model a single chat's turn runs on. The prompt cache belongs to one model, so a running session never moves to a
 * cheaper one (it would write the whole context again): a command's model applies when it starts the session, and later
 * only a stronger one switches up. A model the user picked by hand (`byHand`) wins over every command's.
 * `run` undefined runs the agent's own model; `save` sets the chat's model (null clears it).
 */
export function turnModel(o: { chatModel?: string; byHand?: boolean; agentModel: string | null; picked?: CommandModel; fresh: boolean }): {
  run?: string
  save?: string | null
} {
  const keep = o.chatModel !== undefined ? { run: o.chatModel } : {}
  if (!o.picked || (o.byHand && o.chatModel !== undefined)) return keep
  const to = (m: CommandModel) => (m === o.agentModel ? { save: null } : { run: m, save: m })
  if (o.fresh) return to(o.picked)
  const current = o.chatModel ?? o.agentModel
  return rank(current) >= 0 && rank(o.picked) > rank(current) ? to(o.picked) : keep
}

/** A model name as Codex's `model/list` gives one: no spaces or quotes, so it stays a plain JSON-RPC value. */
const CODEX_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/

/**
 * Whether a model picked by hand is one a chat on this engine can run: Claude's three, or a Codex name that is none of them.
 * An ACP agent's models are its own config options, which ZumiBot does not set (no `models` cap), so none; nor a remote agent's.
 */
export function modelFits(engine: Engine, model: string): boolean {
  switch (engine) {
    case 'claude':
      return isCommandModel(model)
    case 'codex':
      return CODEX_MODEL.test(model) && !isCommandModel(model)
    case 'acp':
      return false
    case 'ag-ui':
      return false // a remote agent's model is its server's
    default:
      return assertNever(engine)
  }
}

/**
 * The chat's stored model as a turn on this engine takes it; undefined runs the agent's own. Codex has no command models, so
 * it takes only a pick by hand. A pick made while the agent ran on the other engine is ignored, never handed to the wrong CLI.
 */
export function engineChatModel(engine: Engine, chat: { model?: string; modelByHand?: true }): string | undefined {
  const m = chat.model
  if (m === undefined || !modelFits(engine, m)) return undefined
  return engine === 'claude' || chat.modelByHand ? m : undefined
}
