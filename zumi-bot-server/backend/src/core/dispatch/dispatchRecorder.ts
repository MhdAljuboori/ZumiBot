import {
  DISPATCH_LONG_MAX,
  DISPATCH_STEPS_MAX,
  DISPATCH_TEXT_MAX,
  DISPATCH_TOOLS,
  HANDBACK_TOOL,
  capInput,
  capSteps,
  capText,
  handbackMessage,
  type DispatchEntry,
  type DispatchStatus,
  type DispatchStep
} from '@zumibot/shared/dispatch'
import type { RunEvent } from '../chat/streamParser'
import { vaultRowResult } from '../vault/vaultTools'

export interface RecorderOptions {
  turn: string
  member?: string
  now: () => number
  onChange: () => void
  /** Browser, desktop and vault tools are stored the way chat items store them: their results never hold page, screen or vault text. */
  privateTool: (name: string) => 'browser' | 'desktop' | 'vault' | null
}

type ToolStep = Extract<DispatchStep, { kind: 'tool' }>
type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

/** The report a finished subagent handed back: the text parts of its result's `content`. */
function reportOf(detail: unknown): string | null {
  if (!isObj(detail)) return null
  const c = detail.content
  if (typeof c === 'string') return c || null
  if (!Array.isArray(c)) return null
  const text = c.flatMap((p) => (isObj(p) && p.type === 'text' && typeof p.text === 'string' ? [p.text] : [])).join('\n')
  return text || null
}

const FAILED = new Set(['failed', 'killed', 'error', 'cancelled', 'canceled', 'stopped'])

/**
 * One turn's dispatched agents, built from the stream as it comes. Each Agent/Task call, the agent's own or a subagent's,
 * opens an entry keyed by its tool use id, so every subagent line finds its entry by `parent_tool_use_id` at any depth.
 */
export class DispatchRecorder {
  private readonly map = new Map<string, DispatchEntry>()
  private readonly tasks = new Map<string, string>() // task id -> dispatch tool use id (task_updated names only the task)
  private member: string | undefined

  constructor(private readonly o: RecorderOptions) {
    this.member = o.member
  }

  has(id: string): boolean {
    return this.map.has(id)
  }

  entries(): DispatchEntry[] {
    return [...this.map.values()].map((e) => ({ ...e, usage: { ...e.usage }, steps: [...e.steps] }))
  }

  rename(from: string, to: string): void {
    if (this.member !== from) return
    this.member = to
    for (const e of this.map.values()) if (e.member === from) e.member = to
    this.o.onChange()
  }

  event(e: RunEvent): void {
    switch (e.kind) {
      case 'toolUse':
        if (DISPATCH_TOOLS.has(e.name)) this.open(e.id, null, e.input)
        break
      case 'toolResult':
        this.finish(e.toolUseId, e.isError, e.detail)
        break
      case 'subToolUse': {
        const parent = this.map.get(e.parent)
        if (!parent) break
        if (DISPATCH_TOOLS.has(e.name)) {
          this.append(parent, { kind: 'agent', id: e.id, ts: this.o.now() })
          this.open(e.id, e.parent, e.input)
          break
        }
        // Read from the raw input: a step's input is capped at 20 000 characters of JSON, a report at 50 000.
        const handback = e.name === HANDBACK_TOOL ? handbackMessage(e.input) : null
        if (handback !== null) {
          parent.report = capText(handback, DISPATCH_LONG_MAX)
          this.touch(parent)
          break
        }
        const priv = this.o.privateTool(e.name)
        this.append(parent, {
          kind: 'tool',
          id: e.id,
          name: e.name,
          input: priv === 'browser' ? {} : capInput(e.input),
          result: null,
          isError: false,
          ts: this.o.now()
        })
        break
      }
      case 'subToolResult': {
        if (this.map.has(e.toolUseId)) {
          this.finish(e.toolUseId, e.isError, e.detail)
          break
        }
        const parent = this.map.get(e.parent)
        const step = parent?.steps.find((s): s is ToolStep => s.kind === 'tool' && s.id === e.toolUseId)
        if (!parent || !step) break
        const priv = this.o.privateTool(step.name)
        step.result =
          priv === 'browser'
            ? e.isError
              ? 'Browser command failed.'
              : 'Browser command completed.'
            : priv === 'desktop'
              ? e.isError
                ? 'Desktop command failed.'
                : 'Desktop command completed.'
              : // The names only, as the chat's own row keeps them.
                priv === 'vault'
                ? vaultRowResult(e.content, e.isError)
                : capText(e.content, DISPATCH_TEXT_MAX)
        step.isError = e.isError
        step.doneTs = this.o.now()
        this.touch(parent)
        break
      }
      case 'subText': {
        const parent = this.map.get(e.parent)
        if (parent) this.append(parent, { kind: 'text', text: capText(e.text, DISPATCH_TEXT_MAX), ts: this.o.now() })
        break
      }
      case 'taskStarted': {
        const entry = this.map.get(e.toolUseId)
        if (!entry) break
        if (e.restart) {
          entry.status = 'running'
          entry.report = null
          entry.now = null
          entry.usage = { tokens: null, toolUses: null, durationMs: null }
          entry.startedAt = this.o.now()
          entry.endedAt = null
        }
        this.tasks.set(e.taskId, e.toolUseId)
        if (!entry.prompt && e.prompt) entry.prompt = capText(e.prompt, DISPATCH_LONG_MAX)
        if (entry.subagentType === null && e.subagentType) entry.subagentType = e.subagentType
        if (!entry.description && e.description) entry.description = e.description
        this.touch(entry)
        break
      }
      case 'taskProgress': {
        const entry = this.map.get(e.toolUseId)
        if (!entry || entry.status !== 'running') break
        if (e.description !== null) entry.now = e.description
        entry.usage = {
          tokens: e.tokens ?? entry.usage.tokens,
          toolUses: e.toolUses ?? entry.usage.toolUses,
          durationMs: e.durationMs ?? entry.usage.durationMs
        }
        this.touch(entry)
        break
      }
      case 'taskUpdated': {
        const id = this.tasks.get(e.taskId)
        const entry = id === undefined ? undefined : this.map.get(id)
        if (!entry || entry.status !== 'running' || e.status === null) break
        // A cut-off one (a Codex subagent it interrupted) ends as a turn's end ends what it cut off; only the Codex mapper sets it.
        const status: DispatchStatus | null = e.cut
          ? 'interrupted'
          : e.status === 'completed'
            ? 'done'
            : FAILED.has(e.status)
              ? 'failed'
              : null
        if (status) this.close(entry, status, e.endTime)
        break
      }
    }
  }

  /** The turn ended: whatever still runs was cut off with it. */
  end(reason: 'stopped' | 'interrupted'): void {
    for (const entry of this.map.values()) if (entry.status === 'running') this.close(entry, reason, null)
  }

  private open(id: string, parent: string | null, input: unknown): void {
    if (this.map.has(id)) return
    const i = isObj(input) ? input : {}
    const t = this.o.now()
    this.map.set(id, {
      id,
      parent,
      turn: this.o.turn,
      ...(this.member === undefined ? {} : { member: this.member }),
      description: str(i.description) ?? '',
      subagentType: str(i.subagent_type),
      prompt: capText(str(i.prompt) ?? '', DISPATCH_LONG_MAX),
      status: 'running',
      now: null,
      usage: { tokens: null, toolUses: null, durationMs: null },
      steps: [],
      report: null,
      startedAt: t,
      endedAt: null,
      updatedAt: t
    })
    this.o.onChange()
  }

  /** The dispatch's own tool result: its outcome, totals and report. One already ended keeps its outcome. */
  private finish(id: string, isError: boolean, detail: unknown): void {
    const entry = this.map.get(id)
    if (!entry) return
    if (isObj(detail)) {
      entry.usage = {
        tokens: num(detail.totalTokens) ?? entry.usage.tokens,
        toolUses: num(detail.totalToolUseCount) ?? entry.usage.toolUses,
        durationMs: num(detail.totalDurationMs) ?? entry.usage.durationMs
      }
    }
    const report = reportOf(detail)
    if (report !== null && entry.report === null) entry.report = capText(report, DISPATCH_LONG_MAX)
    if (entry.status === 'running') this.close(entry, isError ? 'failed' : 'done', null)
    else this.touch(entry)
  }

  private close(entry: DispatchEntry, status: DispatchStatus, at: number | null): void {
    entry.status = status
    entry.now = null
    entry.endedAt = at ?? this.o.now()
    this.touch(entry)
  }

  private append(entry: DispatchEntry, step: DispatchStep): void {
    entry.steps.push(step)
    if (entry.steps.length > DISPATCH_STEPS_MAX + 1) entry.steps = capSteps(entry.steps)
    this.touch(entry)
  }

  private touch(entry: DispatchEntry): void {
    entry.updatedAt = this.o.now()
    this.o.onChange()
  }
}
