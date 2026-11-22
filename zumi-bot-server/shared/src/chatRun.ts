import type { Engine } from './engine'

/**
 * A single chat's own permission mode (`--permission-mode`). Absent runs the server's (Auto). Never `auto` itself, so the
 * server's mode (the e2e's `manual`) stays the default, and never a mode that skips approvals (`bypassPermissions`, `dontAsk`).
 */
export const CHAT_MODES = ['manual', 'acceptEdits', 'plan'] as const
export type ChatMode = (typeof CHAT_MODES)[number]

/** The Claude CLI's `--effort` levels, lowest first. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]
/** A Claude chat with no effort of its own runs at this one. The chat never stores it, so absent and Medium read the same. */
export const DEFAULT_EFFORT: Effort = 'medium'

export const isChatMode = (v: unknown): v is ChatMode => typeof v === 'string' && (CHAT_MODES as readonly string[]).includes(v)
export const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)

/** The server-wide mode every turn runs in unless its chat has its own. */
export type ServerMode = 'auto' | 'manual'
/** The mode one `claude` process starts in. */
export type RunMode = ServerMode | ChatMode

/** Codex has only its two approval policies (codexParams.ts), so of the chat modes only Ask, the stricter one. */
export const modeFits = (engine: Engine, mode: ChatMode): boolean => engine === 'claude' || mode === 'manual'

/**
 * Effort is the Claude CLI's `--effort`. Codex keeps a turn's effort on its thread for the turns after it, so picking
 * Default again could not undo it: Codex chats have none.
 */
export const effortFits = (engine: Engine, _effort: Effort): boolean => engine === 'claude'

/** The chat's mode as a turn on this engine takes it; undefined runs the server's. One set while the agent ran on the other engine is ignored. */
export function engineChatMode(engine: Engine, chat: { permissionMode?: ChatMode }): ChatMode | undefined {
  const m = chat.permissionMode
  return m !== undefined && modeFits(engine, m) ? m : undefined
}

/** The chat's effort as a turn on this engine takes it: its own, else Medium on Claude; undefined (Codex) passes none. */
export function engineChatEffort(engine: Engine, chat: { effort?: Effort }): Effort | undefined {
  const e = chat.effort ?? DEFAULT_EFFORT
  return effortFits(engine, e) ? e : undefined
}

/** The mode a turn's process starts in: the chat's own, else the server's. */
export const runMode = (server: ServerMode, chat: ChatMode | undefined): RunMode => chat ?? server
