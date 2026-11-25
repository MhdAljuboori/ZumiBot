import { describe, expect, it } from 'vitest'
import type { AuditRecord } from '@zumibot/shared/audit'
import { AuditService } from '../../../src/core/audit/auditService'
import { RUN_AUDIT_TOOL, runAuditRecord } from '../../../src/core/audit/runAudit'
import type { RunEndEvent } from '../../../src/core/processes/processService'

const ev = (o: Partial<RunEndEvent> = {}): RunEndEvent => ({
  chatId: 'c1',
  id: 'p1',
  messageId: 'm1',
  command: 'npm test',
  cwd: '/work',
  agent: 'dev',
  startedAt: 1000,
  endedAt: 3500,
  end: { kind: 'exit', code: 0 } as RunEndEvent['end'],
  outcome: 'ok',
  error: null,
  output: '',
  cut: false,
  ...o
})
const ctx = { engine: 'claude', isolation: 'off', mode: 'auto', runKind: 'chat', scrub: new Map<string, string>() } as const

describe('run audit record', () => {
  it('maps a run end to a record', () => {
    expect(RUN_AUDIT_TOOL).toBe('Run')
    expect(runAuditRecord(ev({ outcome: 'error', error: 'exit 2' }), { ...ctx, runKind: 'room', mode: 'manual', isolation: 'sandbox' })).toEqual({
      ts: 1000,
      durationMs: 2500,
      chatId: 'c1',
      itemId: 'm1',
      turnId: null,
      agent: 'dev',
      subagent: null,
      parentToolUseId: null,
      engine: 'claude',
      runKind: 'room',
      mode: 'manual',
      isolation: 'sandbox',
      tool: 'Run',
      input: { command: 'npm test', cwd: '/work' },
      inputCut: null,
      decision: { kind: 'runByUser' },
      outcome: 'error',
      error: 'exit 2'
    })
  })

  it('redacts a vault value in the command', () => {
    const r = runAuditRecord(ev({ command: 'curl -H s3cr3tvalue x' }), { ...ctx, scrub: new Map([['s3cr3tvalue', '[vault: K]']]) })
    expect(JSON.stringify(r)).not.toContain('s3cr3tvalue')
    expect(r.input).toEqual({ command: 'curl -H [vault: K] x', cwd: '/work' })
  })

  it('never lets a negative duration through', () => {
    expect(runAuditRecord(ev({ startedAt: 5000, endedAt: 4000 }), ctx).durationMs).toBe(0)
  })
})

describe('AuditService.record', () => {
  it('fills v, id and machine and writes once', async () => {
    const out: Omit<AuditRecord, 'prev'>[] = []
    const svc = new AuditService({ machine: 'm1', now: () => 1, newId: () => 'id1', write: (r) => out.push(r) })
    await svc.record(runAuditRecord(ev(), ctx))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ v: 1, id: 'id1', machine: 'm1', tool: 'Run', decision: { kind: 'runByUser' } })
  })
})
