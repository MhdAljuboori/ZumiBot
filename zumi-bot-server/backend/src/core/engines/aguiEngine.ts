import { randomUUID } from 'node:crypto'
import type { EngineCaps } from '@zumibot/shared/engine'
import type { AguiRunOptions } from '../agui/aguiRunner'
import type { EngineAdapter, RunHandle, TurnStart } from './engine'

/**
 * An AG-UI run's own configuration: where and how to call, the history to send, the thread file, the attempt's request tag.
 * The prompt is not here: it is the last of `messages`.
 */
export type AguiTurnConfig = Pick<AguiRunOptions, 'endpoint' | 'headers' | 'authKey' | 'messages' | 'thread' | 'onThread' | 'requestTag'>

/** What the adapter hands `run`: everything but this machine's own settings (the dev hook, a test's lookup), which `run` adds. */
export type AguiRunRequest = Omit<AguiRunOptions, 'allowLocal' | 'lookup' | 'limits'>

/**
 * The thread a `TurnStart` runs on: a new one mints its id, a resumed one is the stored thread. A rewind is a new thread with
 * the visible history (a reseed), so `rewind` is off and a fork never reaches here; one that does is a caller bug.
 */
export function aguiStartOf(start: TurnStart, mint: () => string = randomUUID): string {
  if (start.kind === 'new') return mint()
  if (start.kind === 'resume') return start.sessionId
  throw new Error('AG-UI agents cannot fork a thread at a point')
}

export interface AguiEngineDeps {
  caps(): EngineCaps
  /** The agent's endpoint, or null when it would not run. */
  locate(agent?: string): Promise<string | null>
  run(o: AguiRunRequest): RunHandle
}

export type AguiEngine = EngineAdapter<AguiTurnConfig>

/** The AG-UI engine: a remote agent over HTTPS + SSE, one run per attempt plus one per interrupt round. */
export function aguiEngine(d: AguiEngineDeps): AguiEngine {
  return {
    engine: 'ag-ui',
    caps: () => d.caps(),
    locate: (agent) => d.locate(agent),
    // The turn's folder, env and prompt stay on this machine: a remote agent gets only what `config` names.
    start: (turn, config) => {
      // No compaction in AG-UI (`compact` is off); like a fork, a caller bug refused before anything runs.
      if (turn.action.kind === 'compact') throw new Error('AG-UI agents cannot compact a thread')
      return d.run({
        endpoint: config.endpoint,
        headers: config.headers,
        authKey: config.authKey,
        threadId: aguiStartOf(turn.start),
        messages: config.messages,
        thread: config.thread,
        onThread: config.onThread,
        requestTag: config.requestTag,
        onEvent: turn.onEvent
      })
    }
  }
}
