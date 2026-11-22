import { AGUI_TEXT } from '@zumibot/shared/agui'
import { engineCaps } from '@zumibot/shared/engine'
import {
  isDenied,
  type AuditDecision,
  type AuditEngine,
  type AuditHook,
  type AuditLink,
  type AuditOutcome,
  type AuditRecord,
  type AuditRunKind
} from '@zumibot/shared/audit'
import { sandboxBlocks, type IsolationLevel } from '@zumibot/shared/isolation'
import { PAUSE_MARKER } from '@zumibot/shared/pause'
import { CAP_BLOCK_TEXT } from '@zumibot/shared/spendCaps'
import type { RunEvent } from '../chat/streamParser'
import { AUDIT_GUARD_TEXT, VAULT_GUARD_TEXT } from '../vault/vaultGuard'
import { redactAnswer, redactError, redactInput, type Scrub } from './auditRedact'

export const SIDE_GUARD_TEXT = 'No tools in a side answer'

/** What one run is, fixed at its start. */
export interface AuditRun extends AuditLink {
  chatId: string
  engine: AuditEngine
  runKind: AuditRunKind
  mode: string
  turnId: string | null
  /** Side runs show nothing in the chat, so their records link to the chat only. */
  noItems?: true
  /** Absent = off. */
  isolation?: IsolationLevel
}

export interface AuditTapDeps {
  now(): number
  newId(): string
  machine: string
  /** Read per record: a room member renamed mid-turn signs the rest of its calls with the new name. */
  agent(): string
  /** Read per record: an attempt may change the run's vault grants. */
  scrub(): Scrub
  /** A vault fill's input as the chat row shows it (item and field names only). */
  fillRow?(input: unknown): unknown
  /** Takes a finished record; the writer adds the chain hash. Never throws back here. */
  write(record: Omit<AuditRecord, 'prev'>): void
}

interface Open {
  id: string
  tool: string
  input: unknown
  ts: number
  parent: string | null
  subagent: string | null
  decision: AuditDecision | null
  answer?: unknown
  asked: boolean // a permission request named this call
  result: { isError: boolean; content: string; at: number } | null
}

/** The hook a blocked call's text names, or null when it was not a hook's block. */
export function hookOf(text: string): AuditHook | null {
  if (text.includes(VAULT_GUARD_TEXT)) return 'vaultGuard'
  if (text.includes(AUDIT_GUARD_TEXT)) return 'auditGuard'
  if (text.includes(CAP_BLOCK_TEXT)) return 'spendCap'
  if (text.includes(PAUSE_MARKER)) return 'pause'
  if (text.includes(SIDE_GUARD_TEXT)) return 'sideGuard'
  if (/PreToolUse/.test(text) && /hook/i.test(text)) return 'other'
  return null
}

/**
 * Builds one record per tool call from a run's events. Pure apart from the deps: no file is touched here.
 *
 * A call is written once its result arrives, unless it failed with no decision yet: the CLI names the calls its own deny
 * rules refused only in the run's `result` (`permission_denials`), so such a call waits for that, or for the run's end.
 */
export class AuditTap {
  private open = new Map<string, Open>()
  private byRequest = new Map<string, string>() // permission request id -> tool use id
  private ended = false

  // The `remote` cap (AG-UI): the run's tools ran on its own server, outside this machine.
  private readonly remote: boolean

  constructor(
    private run: AuditRun,
    private d: AuditTapDeps
  ) {
    this.remote = engineCaps(run.engine).remote
  }

  private opened(id: string, tool: string, input: unknown, parent: string | null, subagent: string | null): Open {
    let o = this.open.get(id)
    if (!o) {
      o = { id, tool, input, ts: this.d.now(), parent, subagent, decision: null, asked: false, result: null }
      this.open.set(id, o)
    } else {
      // A permission request may come before its tool_use line; the stream's own copy wins for parent and subagent.
      if (parent !== null) o.parent = parent
      if (subagent !== null) o.subagent = subagent
    }
    return o
  }

  event(e: RunEvent): void {
    if (this.ended) return
    try {
      switch (e.kind) {
        case 'toolUse':
          this.opened(e.id, e.name, e.input, null, null)
          break
        case 'subToolUse':
          this.opened(e.id, e.name, e.input, e.parent, e.subagent)
          break
        case 'permissionRequest': {
          const id = e.toolUseId ?? `request:${e.requestId}`
          const o = this.opened(id, e.toolName, e.input, null, null)
          o.asked = true
          this.byRequest.set(e.requestId, id)
          break
        }
        case 'toolResult':
        case 'subToolResult': {
          const o = this.open.get(e.toolUseId)
          if (!o) break
          o.result = { isError: e.isError, content: e.content, at: this.d.now() }
          // A remote (AG-UI) agent's row: its own server ran it, or asked ZumiBot to (which runs none and says so in an error
          // only ZumiBot sets: a server's own results are never errors here). No CLI deny rule stands behind it, so nothing waits.
          if (this.remote) {
            if (o.decision === null)
              o.decision =
                e.isError && e.content === AGUI_TEXT.noTools ? { kind: 'deniedByZumiBot', why: 'remoteTools' } : { kind: 'ranRemotely' }
            this.flush(o)
            break
          }
          // The sandbox has the last word on a call it blocked, whoever allowed it (a label: the OS or the file guard enforced
          // it either way). Before the hook check: the file guard is a hook, but its block is the sandbox's.
          // A contained run's network blocks are added to the result by ZumiBot (containerRunner.withNetBlocks), error or not.
          const iso = this.run.isolation ?? 'off'
          const blocks =
            iso !== 'off' && (e.isError || iso === 'container') && (o.decision === null || !isDenied(o.decision))
              ? sandboxBlocks(e.content, { osErrors: e.isError })
              : []
          if (blocks.length > 0) o.decision = { kind: 'deniedBySandbox', target: blocks.map((b) => b.target).join(', ') }
          else if (o.decision === null && e.isError) {
            const hook = hookOf(e.content)
            if (hook) o.decision = { kind: 'deniedByHook', hook }
          }
          // A failed call with no decision may be a CLI deny rule's: kept until the run's result names its denials.
          if (o.decision === null && e.isError) break
          this.flush(o)
          break
        }
        case 'result': {
          const denied = new Set(e.denials.map((x) => x.toolUseId))
          for (const o of [...this.open.values()]) {
            if (!o.result) continue
            if (o.decision === null) o.decision = denied.has(o.id) ? { kind: 'deniedByRule' } : this.unasked()
            this.flush(o)
          }
          break
        }
        default:
          break
      }
    } catch (err) {
      console.error('audit event not recorded:', err instanceof Error ? err.name : 'error')
    }
  }

  /** The branch that answered a permission request says why, with the user's answer for a question or plan card. */
  decided(requestId: string, decision: AuditDecision, answer?: unknown): void {
    if (this.ended) return
    const id = this.byRequest.get(requestId)
    const o = id === undefined ? undefined : this.open.get(id)
    if (!o) return
    o.decision = decision
    if (answer !== undefined) o.answer = answer
    // A request with no tool_use id never gets a result line of its own: its answer ends it.
    if (o.id.startsWith('request:')) {
      o.result = { isError: isDenied(decision), content: '', at: this.d.now() }
      this.flush(o)
    }
  }

  /** The run is over: what is still open is written as interrupted (a stop) or as having no result. */
  end(stopped: boolean): void {
    if (this.ended) return
    for (const o of [...this.open.values()]) this.flush(o, stopped ? 'interrupted' : 'noResult')
    this.ended = true
  }

  /** A call no approval reached: the run's mode allowed it, or on a remote agent its own server ran it. */
  private unasked(): AuditDecision {
    return this.remote ? { kind: 'ranRemotely' } : { kind: 'allowedByMode' }
  }

  private flush(o: Open, unfinished?: AuditOutcome): void {
    this.open.delete(o.id)
    try {
      const decision: AuditDecision = o.decision ?? (o.asked ? { kind: 'unanswered' } : this.unasked())
      const scrub = this.d.scrub()
      const { input, inputCut } = redactInput(o.tool, o.input, scrub, this.d.fillRow)
      const outcome: AuditOutcome =
        o.result === null
          ? isDenied(decision)
            ? 'denied'
            : (unfinished ?? 'noResult')
          : isDenied(decision)
            ? 'denied'
            : o.result.isError
              ? 'error'
              : 'ok'
      const errorText = o.result && o.result.isError && o.result.content !== '' ? redactError(o.tool, o.result.content, scrub) : null
      const item = this.run.noItems ? null : (o.parent ?? (o.id.startsWith('request:') ? null : o.id))
      const record: Omit<AuditRecord, 'prev'> = {
        v: 1,
        id: this.d.newId(),
        ts: o.ts,
        durationMs: o.result ? Math.max(0, o.result.at - o.ts) : null,
        machine: this.d.machine,
        chatId: this.run.chatId,
        itemId: item,
        turnId: this.run.turnId,
        agent: this.d.agent(),
        subagent: o.subagent,
        parentToolUseId: o.parent,
        engine: this.run.engine,
        runKind: this.run.runKind,
        mode: this.run.mode,
        isolation: this.run.isolation ?? 'off',
        ...(this.run.routine ? { routine: this.run.routine } : {}),
        ...(this.run.workflow ? { workflow: this.run.workflow } : {}),
        tool: o.tool,
        input,
        inputCut,
        decision,
        ...(o.answer !== undefined ? { answer: redactAnswer(o.answer, scrub) } : {}),
        outcome,
        error: errorText
      }
      this.d.write(record)
    } catch (err) {
      console.error('audit record not built:', err instanceof Error ? err.name : 'error')
    }
  }
}
