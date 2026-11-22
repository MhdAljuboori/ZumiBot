import { isAsked } from './agentAsk'
import type { AgentSummary, ChatMeta } from './types'
import { CHAT_NOT_FOUND, CHAT_OF_WORKFLOW, CHAT_READ_ONLY } from './workflows'

// One rule for the server (at a step's start) and the editor (the note under the Chat picker), so their words never differ.

/** The graph check's words: the agent was fine when the run started, but a loop or a Retry may come after it went. */
export function agentProblem(name: string, agents: AgentSummary[], zumiBot: string): string | null {
  if (name === zumiBot) return 'Zumi Bot cannot be a workflow step'
  const agent = agents.find((a) => a.name === name)
  if (!agent) return `Agent "${name}" not found`
  return agent.error ? `Agent "${name}" has an error` : null
}

/** Why a Chat step cannot post into its chat (a deleted, read-only or workflow-made one, a single chat's missing agent). Null when it can. */
export function chatStepProblem(chat: ChatMeta | null, agents: AgentSummary[], zumiBot: string): string | null {
  if (!chat) return CHAT_NOT_FOUND
  if (isAsked(chat)) return CHAT_READ_ONLY
  if (chat.workflow || chat.workflowTest) return CHAT_OF_WORKFLOW
  // A room runs with the members it has left, as a routine's does.
  return chat.group ? null : agentProblem(chat.agentName, agents, zumiBot)
}
