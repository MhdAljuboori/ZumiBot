import { chatEngine } from '@zumibot/shared/engine'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'

/**
 * Whether Claude-only machinery (a /btw side base, a keep-warm ping) must stay off this chat: its agent is on another engine
 * (Codex) now, or its session came from one (the agent may have moved back, and no Claude session exists to resume).
 */
export function isCodexChat(meta: Pick<ChatMeta, 'agentName' | 'group' | 'sessionEngine'>, agents: readonly AgentSummary[]): boolean {
  return meta.sessionEngine !== undefined || chatEngine(meta, agents) !== 'claude'
}
