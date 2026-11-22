import type { EngineCaps } from '@zumibot/shared/engine'
import { buildArgs, type RunOptions } from '../chat/claudeRunner'
import type { EngineAdapter, RunHandle, TurnStart } from './engine'

/** `buildArgs`' own options, so this adapter cannot drift from the flags it builds. */
type ClaudeArgs = Parameters<typeof buildArgs>[0]

/** A Claude run's own configuration: every `buildArgs` field but the session, which `EngineTurn.start` carries. */
export type ClaudeTurnConfig = Omit<ClaudeArgs, 'resumeSessionId' | 'resumeAt' | 'resumeDrops'>

/**
 * A `TurnStart` as the Claude CLI takes it. A fork adds `resumeAt`, which `buildArgs` turns into the hidden
 * `--resume-session-at <uuid> --fork-session` pair, and `resumeDrops` for `--resume-drops-turn`; those three flag names appear
 * nowhere else. `drops` is only carried when the caller has it and the binary takes the flag, which `dropsTurnProbe.ts` asks.
 */
export const claudeResume = (start: TurnStart): Pick<ClaudeArgs, 'resumeSessionId' | 'resumeAt' | 'resumeDrops'> =>
  start.kind === 'new'
    ? { resumeSessionId: null }
    : start.kind === 'resume'
      ? { resumeSessionId: start.sessionId }
      : { resumeSessionId: start.sessionId, resumeAt: start.at, ...(start.drops !== undefined ? { resumeDrops: start.drops } : {}) }

export interface ClaudeEngineDeps {
  caps(): EngineCaps
  locate(): Promise<string | null>
  run(o: RunOptions): RunHandle
}

/**
 * The Claude engine: one `claude` per turn. A compaction is a turn like any other — the CLI compacts on the prompt it is sent
 * (`/compact`), so both actions spawn the same way.
 */
export function claudeEngine(d: ClaudeEngineDeps): EngineAdapter<ClaudeTurnConfig> {
  return {
    engine: 'claude',
    caps: () => d.caps(),
    locate: () => d.locate(),
    start: (turn, config) =>
      d.run({
        bin: turn.bin,
        args: buildArgs({ ...config, ...claudeResume(turn.start) }),
        cwd: turn.cwd,
        stdin: turn.action.prompt,
        ...(turn.action.promptUuid !== undefined ? { stdinUuid: turn.action.promptUuid } : {}),
        ...(turn.env ? { env: turn.env } : {}),
        ...(turn.wrap ? { wrap: turn.wrap } : {}),
        onEvent: turn.onEvent
      })
  }
}
