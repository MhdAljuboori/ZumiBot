import type { BrowserHandoff } from '@zumibot/shared/browser'
import type { AskIpcService } from '../asks/askIpc'
import type { TodoIpcService } from '../todos/todoIpc'
import { scrubText } from './scrub'

type ScrubOf = (agent: string) => ReadonlyMap<string, string>

/** The to-do bridge with every text an agent adds scrubbed with that agent's vault values before it is stored. */
export function scrubbedTodos(service: TodoIpcService, scrubOf: ScrubOf): TodoIpcService {
  return {
    agentList: (chatId, agent) => service.agentList(chatId, agent),
    agentAdd: (chatId, agent, turn, label, items) => {
      const scrub = scrubOf(agent)
      return service.agentAdd(
        chatId,
        agent,
        turn,
        label,
        items.map((i) => ({
          ...i,
          text: scrubText(i.text, scrub),
          ...(typeof i.group === 'string' ? { group: scrubText(i.group, scrub) } : {}),
          ...(typeof i.description === 'string' ? { description: scrubText(i.description, scrub) } : {})
        }))
      )
    },
    agentCheck: (chatId, agent, turn, ids, done) => service.agentCheck(chatId, agent, turn, ids, done),
    agentRemove: (chatId, agent, turn, ids) => service.agentRemove(chatId, agent, turn, ids),
    // A card's questions and review are the agent's text on a page the user reads, as an item's text is.
    agentAskUser: (chatId, agent, turn, questions) => {
      const scrub = scrubOf(agent)
      return service.agentAskUser(
        chatId,
        agent,
        turn,
        questions.map((q) => ({ text: scrubText(q.text, scrub), options: (q.options ?? []).map((o) => scrubText(o, scrub)) }))
      )
    },
    agentReview: (chatId, agent, turn, summary) => service.agentReview(chatId, agent, turn, scrubText(summary, scrubOf(agent))),
    agentComment: (chatId, agent, turn, id, text) => service.agentComment(chatId, agent, turn, id, scrubText(text, scrubOf(agent)))
  }
}

/** The ask bridge with each message and side question scrubbed with the owner agent's vault values: they become another chat's text. */
export function scrubbedAsks(service: AskIpcService, scrubOf: ScrubOf): AskIpcService {
  return {
    ask: (owner, call, signal) => service.ask(owner, { ...call, message: scrubText(call.message, scrubOf(owner.agent())) }, signal),
    sideAsk: (owner, call, signal) =>
      service.sideAsk(owner, { ...call, question: scrubText(call.question, scrubOf(owner.agent())) }, signal)
  }
}

type HandoffCreate<O, X extends unknown[], R> = (owner: O, onHandoff: (handoff: BrowserHandoff) => Promise<void>, ...rest: X) => Promise<R>

/**
 * Browser or desktop turns whose handoff cards get their reason scrubbed with the owner agent's vault values before they are
 * stored: the reason is the agent's text from `request_user_action`, over a bridge, never through the stream's scrub.
 */
export function scrubbedHandoffs<O, X extends unknown[], R, T extends { create: HandoffCreate<O, X, R> }>(
  turns: T & { create: HandoffCreate<O, X, R> },
  scrubOf: ScrubOf
): T {
  const create: HandoffCreate<O, X, R> = (owner, onHandoff, ...rest) =>
    turns.create(owner, (h) => onHandoff({ ...h, reason: scrubText(h.reason, scrubOf(h.agent)) }), ...rest)
  return { ...turns, create }
}
