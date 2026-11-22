import type { CommandPick } from './commands'

export type Schedule =
  | { freq: 'once'; date: string; time: string }
  | { freq: 'hourly'; minute: number; days: number[] }
  | { freq: 'daily'; time: string; days: number[] }
  | { freq: 'weekly'; day: number; time: string }
  | { freq: 'monthly'; day: number | 'last'; time: string }
  | { freq: 'yearly'; month: number; day: number; time: string }
  | { freq: 'custom'; cron: string }

export interface WebhookCall {
  method: string
  query: Record<string, string>
  body: unknown
  receivedAt: number
}
// condition: plain words Jev checks each call against before a run starts; absent = every call runs.
export type RoutineTrigger =
  { kind: 'schedule'; schedule: Schedule } | { kind: 'manual' } | { kind: 'webhook'; sample: WebhookCall | null; condition?: string }
// title: each run's new chat or room is named this; absent = "<routine name> · <date>". section: the sidebar section (by
// id) each run's new room is placed at the top of; absent, or a section deleted since, leaves it outside every section.
export type RoutineTarget =
  | { kind: 'new-chat'; agent: string; cwd: string; title?: string }
  | { kind: 'new-group'; members: string[]; role: string; cwd: string; title?: string; section?: string }
  | { kind: 'chat'; chatId: string }
// limitPolicy: when the usage limit stops a run, wait for the reset and continue, or skip it.
// missedPolicy: a schedule run due while ZumiBot was off runs once late, or is skipped. Absent in routines saved before
// them: read through limitPolicyOf / missedPolicyOf.
export type LimitPolicy = 'wait' | 'skip'
export type MissedPolicy = 'run-once' | 'skip'
// sessionPolicy (an existing chat or room only): keep each agent's session from run to run, or start every run on new
// sessions seeded from the chat's recent messages, so a big idle context is not reloaded into the cache at each run.
export type SessionPolicy = 'continue' | 'fresh'
// command: the editor's `/` menu pick for the prompt's leading `/name`, so a room knows whose command it is. Kept only
// while the prompt still starts with that name; absent = resolved by name at run time, as a hand-typed one.
export interface Routine {
  id: string
  name: string
  enabled: boolean
  timeZone: string
  trigger: RoutineTrigger
  target: RoutineTarget
  prompt: string
  command?: CommandPick
  limitPolicy?: LimitPolicy
  missedPolicy?: MissedPolicy
  sessionPolicy?: SessionPolicy
  spendCap?: number // USD one run may spend (spendCaps.ts); absent = no cap
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
}
export const limitPolicyOf = (r: Pick<Routine, 'limitPolicy'> | null): LimitPolicy => r?.limitPolicy ?? 'wait'
export const missedPolicyOf = (r: Pick<Routine, 'missedPolicy'> | null): MissedPolicy => r?.missedPolicy ?? 'run-once'
export const sessionPolicyOf = (r: Pick<Routine, 'sessionPolicy'> | null): SessionPolicy => r?.sessionPolicy ?? 'continue'
// skipped: no work was done, for skipReason (absent: the webhook call did not meet the routine's condition, so no chat
// was made). limited: the usage limit stopped the run; it continues in its chat at resumeAt. paused: the user paused its
// turn; Resume's Continue carries it on, a message of the user's own ends it.
export type RunStatus = 'running' | 'waiting' | 'limited' | 'paused' | 'done' | 'failed' | 'skipped'
// cap: an agent the run would start was past its daily spend cap (capSkipText).
export type SkipReason = 'missed' | 'limit' | 'cap'
/** Jev's check of a webhook call: met null = Jev could not tell, and the run went ahead. p = Jev's probability of "met". */
export interface ConditionCheck {
  met: boolean | null
  p?: number
}
export interface RoutineRun {
  id: string
  routineId: string
  via: 'schedule' | 'manual' | 'webhook'
  status: RunStatus
  late: boolean
  chatId: string | null
  messageId: string | null
  error?: string
  missingFields?: string[]
  condition?: ConditionCheck
  skipReason?: SkipReason
  resumeAt?: number
  waits?: number // waits: how many times the limit stopped it so far
  resumes?: number // how many times Resume carried it on after the user paused it
  // Spend caps: what the run's turns cost (exact, from their results); capLimitUsd, a limit Resume raised past the cap;
  // capped, its cap paused it and nothing raised the limit since (so it is not paused twice for one crossing).
  costUsd?: number
  capLimitUsd?: number
  capped?: true
  startedAt: number
  endedAt?: number
}
/** What the client saves. id: the routine's id, a webhook draft's id, or null for a new routine. */
export type RoutineInput = Pick<Routine, 'name' | 'enabled' | 'timeZone' | 'trigger' | 'target' | 'prompt'> & {
  id: string | null
  limitPolicy: LimitPolicy
  missedPolicy: MissedPolicy
  sessionPolicy: SessionPolicy
  command: CommandPick | null
  spendCap?: number // absent = no cap
}
export interface RoutinesSnapshot {
  routines: Routine[]
  runs: Record<string, RoutineRun[]>
}
export const ROUTINE_RUNS_KEPT = 50
export const ROUTINE_SKIPPED_RUNS_KEPT = 10 // of those 50: a noisy webhook's skipped calls must not push out real runs
export const ROUTINE_MAX_ACTIVE_RUNS = 5
export const ROUTINE_MAX_LIMIT_WAITS = 5 // per run: a limit that keeps coming back fails the run instead of waiting forever
export const WEBHOOK_MAX_BYTES = 1_048_576
export const WEBHOOK_CALLS_PER_MIN = 60
export const ROUTINE_NAME_MAX = 100
export const ROUTINE_CHAT_TITLE_MAX = 100
/** A run's new chat or room when its target names no title: "Daily report · Nov 9", the date in the routine's zone. */
export const defaultRunTitle = (name: string, timeZone: string, now: number): string =>
  `${name} · ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(now)}`
export const ROUTINE_PROMPT_MAX = 20_000
export const SECRET_HEADER = 'x-zumibot-secret'
