import { ACP_ASK_MODE } from '@zumibot/shared/acp'

// ZumiBot's ACP chats ask before acting, so every session is put in the agent's asking mode before its prompt, when the agent
// offers one under that id. See docs/architecture/protocol-engines.md (Modes).

/** The request that puts a session in `ACP_ASK_MODE`: a mode config option when one offers it, else `modes`. */
export type AskSwitch =
  | { method: 'session/set_mode'; params: { modeId: string } }
  | { method: 'session/set_config_option'; params: { configId: string; value: string } }

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

// A select option's values, flat or in groups.
function optionValues(options: unknown): string[] {
  const out: string[] = []
  for (const o of list(options)) {
    const opt = obj(o)
    if (typeof opt?.value === 'string') out.push(opt.value)
    else
      for (const g of list(opt?.options)) {
        const v = obj(g)?.value
        if (typeof v === 'string') out.push(v)
      }
  }
  return out
}

/**
 * How to put the session a start answered (`res`, the answer of session/new, resume or load) in `ACP_ASK_MODE`, given every
 * mode it reports now (`current`); null when each of those is that mode already, or no control still off it offers it.
 */
export function askSwitch(res: unknown, current: readonly string[]): AskSwitch | null {
  if (current.length > 0 && current.every((m) => m === ACP_ASK_MODE)) return null
  const r = obj(res)
  // Config options come first: the spec has a client that reads them use them, and the mode methods are to be removed. Agents
  // mirror `modes` in a mode option (the Claude adapter does), one control, so only the one still off the asking mode is switched.
  for (const c of list(r?.configOptions)) {
    const opt = obj(c)
    if (opt?.category !== 'mode' || typeof opt.id !== 'string' || opt.id === '' || opt.currentValue === ACP_ASK_MODE) continue
    if (optionValues(opt.options).includes(ACP_ASK_MODE))
      return { method: 'session/set_config_option', params: { configId: opt.id, value: ACP_ASK_MODE } }
  }
  const modes = obj(r?.modes)
  if (modes?.currentModeId !== ACP_ASK_MODE && list(modes?.availableModes).some((m) => obj(m)?.id === ACP_ASK_MODE)) {
    return { method: 'session/set_mode', params: { modeId: ACP_ASK_MODE } }
  }
  return null
}

/**
 * Whether the switch's answer leaves the session in `ACP_ASK_MODE` as far as it says: set_config_option answers with every
 * option's state, so the option it set must read that mode; set_mode answers nothing to check.
 */
export function askHeld(ask: AskSwitch, answer: unknown): boolean {
  if (ask.method !== 'session/set_config_option') return true
  const opt = list(obj(answer)?.configOptions)
    .map(obj)
    .find((o) => o?.id === ask.params.configId)
  return typeof opt?.currentValue !== 'string' || opt.currentValue === ACP_ASK_MODE
}
