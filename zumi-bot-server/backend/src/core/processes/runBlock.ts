import { isAsked } from '@zumibot/shared/agentAsk'
import { engineCaps, type Engine } from '@zumibot/shared/engine'
import type { ProcessInfo } from '@zumibot/shared/processes'
import { messageHasRunBlock, RUN_REFUSALS } from '@zumibot/shared/runBlocks'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'

export interface RunBlockDeps {
  meta(chatId: string): Promise<ChatMeta | null>
  items(chatId: string): Promise<ChatItem[]>
  engineOf(agent: string): Promise<Engine>
  run(chatId: string, agent: string, messageId: string, command: string): Promise<ProcessInfo>
}

/**
 * The user's Run of a block (`processes:run`). The server finds the message itself and checks the command is a block of that
 * stored assistant message, so a client cannot run what the agent never wrote; the author is the one the process belongs to.
 */
export async function runBlock(d: RunBlockDeps, chatId: string, messageId: string, command: string): Promise<ProcessInfo> {
  const meta = await d.meta(chatId)
  if (!meta) throw new Error(RUN_REFUSALS.gone)
  // An asked chat is read-only for the user (the UI shows no Run there): it answers the agent that asked.
  if (isAsked(meta)) throw new Error(RUN_REFUSALS.asked)
  const item = (await d.items(chatId)).find((i) => i.id === messageId)
  if (item?.type !== 'assistant') throw new Error(RUN_REFUSALS.gone)
  if (!messageHasRunBlock(item.text, command)) throw new Error(RUN_REFUSALS.notBlock)
  const agent = item.agent ?? meta.agentName
  // A remote agent's reply is text from another machine: its commands never run here.
  if (engineCaps(await d.engineOf(agent)).remote) throw new Error(RUN_REFUSALS.remote)
  return d.run(chatId, agent, messageId, command)
}
