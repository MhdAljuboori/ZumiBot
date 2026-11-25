import type { AuditEngine, AuditRecord, AuditRunKind } from '@zumibot/shared/audit'
import type { IsolationLevel } from '@zumibot/shared/isolation'
import type { RunEndEvent } from '../processes/processService'
import { redactInput, type Scrub } from './auditRedact'

/** The tool name of a Run button press in the audit log. */
export const RUN_AUDIT_TOOL = 'Run'

/**
 * The record of one Run, built when it ends. The command was already scrubbed with the author's vault values by the process
 * service; `redactInput` runs again so the audit never relies on that, and cuts it to the log's input cap.
 */
export function runAuditRecord(
  e: RunEndEvent,
  c: { engine: AuditEngine; isolation: IsolationLevel; mode: string; runKind: AuditRunKind; scrub: Scrub }
): Omit<AuditRecord, 'v' | 'id' | 'machine' | 'prev'> {
  const { input, inputCut } = redactInput(RUN_AUDIT_TOOL, { command: e.command, cwd: e.cwd }, c.scrub)
  return {
    ts: e.startedAt,
    durationMs: Math.max(0, e.endedAt - e.startedAt),
    chatId: e.chatId,
    itemId: e.messageId,
    turnId: null,
    agent: e.agent,
    subagent: null,
    parentToolUseId: null,
    engine: c.engine,
    runKind: c.runKind,
    mode: c.mode,
    isolation: c.isolation,
    tool: RUN_AUDIT_TOOL,
    input,
    inputCut,
    decision: { kind: 'runByUser' },
    outcome: e.outcome,
    error: e.error
  }
}
