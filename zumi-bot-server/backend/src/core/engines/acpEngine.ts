import type { EngineCaps } from '@zumibot/shared/engine'
import type { AcpRunOptions, AcpStart } from '../acp/acpRunner'
import type { EngineAdapter, RunHandle, TurnStart } from './engine'

/** An ACP run's own configuration: the agent file's arguments, its instructions, and the attempt's request tag. */
export type AcpTurnConfig = Pick<AcpRunOptions, 'args' | 'systemPrompt' | 'requestTag'>

/**
 * A `TurnStart` as ACP takes it. Stable v1 cannot resume or fork a session at a message, so `rewind` is off and a fork never
 * reaches here; one that does is a caller bug, refused before anything runs (the caller reseeds instead).
 */
export function acpStartOf(start: TurnStart): AcpStart {
  if (start.kind === 'new') return { kind: 'new' }
  if (start.kind === 'resume') return { kind: 'resume', sessionId: start.sessionId }
  throw new Error('ACP agents cannot fork a session at a point')
}

export interface AcpEngineDeps {
  caps(): EngineCaps
  /** `agent` names whose command to find: every ACP agent has its own. */
  locate(agent?: string): Promise<string | null>
  run(o: AcpRunOptions): RunHandle
}

export type AcpEngine = EngineAdapter<AcpTurnConfig>

/** The ACP engine: one agent process per attempt, speaking Agent Client Protocol v1 over stdio. */
export function acpEngine(d: AcpEngineDeps): AcpEngine {
  return {
    engine: 'acp',
    caps: () => d.caps(),
    locate: (agent) => d.locate(agent),
    start: (turn, config) => {
      // No compaction in ACP (`compact` is off); like a fork, a caller bug refused before anything runs.
      if (turn.action.kind === 'compact') throw new Error('ACP agents cannot compact a session')
      return d.run({
        bin: turn.bin,
        args: config.args,
        cwd: turn.cwd,
        env: turn.env ?? process.env,
        start: acpStartOf(turn.start),
        prompt: turn.action.prompt,
        systemPrompt: config.systemPrompt,
        requestTag: config.requestTag,
        onEvent: turn.onEvent
      })
    }
  }
}
