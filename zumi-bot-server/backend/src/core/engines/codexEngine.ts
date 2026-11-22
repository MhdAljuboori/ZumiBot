import type { EngineCaps } from '@zumibot/shared/engine'
import type { CodexAction, CodexRunOptions, CodexStart } from '../codex/codexRunner'
import type { EngineAdapter, RunHandle, TurnAction, TurnStart } from './engine'

/**
 * A Codex run's own configuration: every `runCodex` option but the lifecycle ones `EngineTurn` carries, plus `ephemeral`, which
 * belongs to the fork (a side run's fork writes no rollout and leaves its source as it was, probe check 8). Claude says the same
 * thing with `--no-session-persistence` in its args, so neither form belongs in the shared `TurnStart`.
 */
export type CodexTurnConfig = Omit<CodexRunOptions, 'bin' | 'cwd' | 'env' | 'start' | 'action' | 'onEvent'> & { ephemeral?: true }

/** A `TurnStart` as codex takes it: `thread/start`, `thread/resume`, or `thread/fork` at the stamped turn (kept, inclusive). */
export const codexStartOf = (start: TurnStart, o?: { ephemeral?: true }): CodexStart =>
  start.kind === 'new'
    ? { kind: 'new' }
    : start.kind === 'resume'
      ? { kind: 'resume', threadId: start.sessionId }
      : { kind: 'fork', threadId: start.sessionId, lastTurnId: start.at, ...(o?.ephemeral ? { ephemeral: true as const } : {}) }

/**
 * A compaction is its own codex request (`thread/compact/start`), so the action's prompt is dropped: a note has nowhere to go.
 * `promptUuid` is dropped too: Codex names its own turns, and a fork is validated by `lastTurnId` alone.
 */
export const codexActionOf = (action: TurnAction): CodexAction =>
  action.kind === 'compact' ? { kind: 'compact' } : { kind: 'turn', prompt: action.prompt }

export interface CodexEngineDeps {
  caps(): EngineCaps
  locate(): Promise<string | null>
  run(o: CodexRunOptions): RunHandle
  definitionOf(agent: string): Promise<{ body: string; model: string | null } | null>
}

/** The Codex adapter, with the one thing only it needs: the agent file itself, since Codex has no `--agent`. */
export type CodexEngine = EngineAdapter<CodexTurnConfig> & {
  /** The agent file's body and `model:`, read per attempt, so an Agent Studio edit applies from the next one. */
  definitionOf(agent: string): Promise<{ body: string; model: string | null } | null>
}

/** The Codex engine: one `codex app-server` per attempt. */
export function codexEngine(d: CodexEngineDeps): CodexEngine {
  return {
    engine: 'codex',
    caps: () => d.caps(),
    locate: () => d.locate(),
    definitionOf: (agent) => d.definitionOf(agent),
    start: (turn, config) => {
      const { ephemeral, ...rest } = config
      return d.run({
        bin: turn.bin,
        cwd: turn.cwd,
        ...(turn.env ? { env: turn.env } : {}),
        start: codexStartOf(turn.start, ephemeral ? { ephemeral } : undefined),
        action: codexActionOf(turn.action),
        ...rest,
        onEvent: turn.onEvent
      })
    }
  }
}
