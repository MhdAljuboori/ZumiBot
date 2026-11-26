import type { Engine, EngineCaps } from '@zumibot/shared/engine'
import type { UserContent } from '../chat/controlProtocol'
import type { ResultEvent, RunEvent } from '../chat/streamParser'

/**
 * Where a turn's session comes from, in words both engines have: a new one, the chat's own resumed, or that one forked at a
 * recorded point, which keeps the old session as it was (Claude's `--resume-session-at` + `--fork-session`, Codex's
 * `thread/fork`). Each adapter translates it; nothing outside them spells either CLI's form.
 */
export type TurnStart =
  | { kind: 'new' }
  | { kind: 'resume'; sessionId: string }
  /**
   * `at` is the point's own stamp: a Claude entry uuid, a Codex turn id (see docs/architecture/edit-resend-fork.md).
   * `drops` is the prompt uuid of the turn the fork discards, when it is known: the engine validates the cut against it and
   * refuses one that would discard anything else, instead of cutting on trust. Codex has no form of it.
   */
  | { kind: 'fork'; sessionId: string; at: string; drops?: string }

/**
 * The one rule for reading a stored start point: a session with a point is forked, one without is resumed, and no session is a
 * fresh one. Both the main run and a side run read it here, so neither can drift into resuming a point it meant to fork.
 */
export function turnStart(sessionId: string | null, at?: string, drops?: string): TurnStart {
  if (sessionId === null) return { kind: 'new' }
  if (at === undefined) return { kind: 'resume', sessionId }
  return { kind: 'fork', sessionId, at, ...(drops !== undefined ? { drops } : {}) }
}

/**
 * What the run does on that session. `prompt` is the turn's input; a compaction carries one too, because Claude compacts by
 * sending `/compact` while Codex has its own request and drops it (the typed note has nowhere to go there).
 */
export type TurnAction =
  { kind: 'turn'; prompt: UserContent; promptUuid?: string } | { kind: 'compact'; prompt: UserContent; promptUuid?: string }

/** Everything a turn needs that does not depend on the engine. The engine-specific part is each adapter's own `config`. */
export type RunOptionsWrap = (s: { bin: string; args: string[]; env: NodeJS.ProcessEnv }) => {
  bin: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export interface EngineTurn {
  bin: string
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Claude only: a contained run's spawn (RunOptions.wrap). No other engine has the `isolation` cap, so none is ever contained. */
  wrap?: RunOptionsWrap
  start: TurnStart
  action: TurnAction
  onEvent(e: RunEvent): void
}

/**
 * One engine behind one interface: start a turn (new, resumed, or forked at a point), compact, and say what the engine can do.
 * `send` and `stop` live on the handle the start returns, so a caller drives any engine's run the same way.
 *
 * `Config` is what only that engine takes — a Claude run's argv parts, a Codex run's thread and hooks. Keeping it per adapter is
 * deliberate: the lifecycle is shared, the configuration is not, and pretending otherwise would hide which is which.
 */
export interface EngineAdapter<Config> {
  readonly engine: Engine
  /** What this engine supports. Read through the caller's own `caps`, so a probe that turns a flag off reaches the adapter too. */
  caps(): EngineCaps
  /**
   * The CLI this engine spawns, or null when it is not installed on this machine. `agent` is for an engine whose command is
   * per agent (ACP); one binary for every agent (Claude, Codex) ignores it.
   */
  locate(agent?: string): Promise<string | null>
  start(turn: EngineTurn, config: Config): RunHandle
}

/**
 * One CLI attempt. `done` settles when the process is gone (or never started); `send` answers a request the run is waiting on
 * and says whether it went; `stop` ends the run (an interrupt where the engine has one, then its kill ladder).
 */
export interface RunHandle {
  stop(): void
  send(message: object): boolean
  /**
   * Claude's CLI run only: a user message into the running turn (a mid-turn steer), taken in at the agent's next step and
   * echoed back as `userReplay` under `uuid`. False when it can no longer go in. Absent: this engine takes none.
   */
  steer?(content: UserContent, uuid: string): boolean
  done: Promise<RunOutcome>
}

/** How one attempt ended. Shared by both engines; the two engine-reported flags say so on themselves. */
export interface RunOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stderr: string
  spawnError: string | null
  result: ResultEvent | null
  stopped: boolean
  /** Codex and ACP: the session to resume is gone (or the agent cannot resume one), so the caller reseeds. Claude never sets it. */
  missingSession?: true
  /**
   * ACP only, beside `missingSession`: the agent resumes no session at all (neither `session/resume` nor `session/load`), so
   * every turn reseeds as a matter of course, with no notice. Claude and Codex never set it.
   */
  noResume?: true
  /** Codex only: codex would not run the run's hooks (it skips an untrusted one silently), so no thread was started. */
  hooksUntrusted?: true
}
