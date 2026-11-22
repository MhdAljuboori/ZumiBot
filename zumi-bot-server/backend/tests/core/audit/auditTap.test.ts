import { describe, expect, it } from 'vitest'
import type { AuditRecord } from '@zumibot/shared/audit'
import { AGUI_TEXT, AGUI_TOOL } from '@zumibot/shared/agui'
import { PAUSE_BLOCK_TEXT } from '@zumibot/shared/pause'
import { CAP_BLOCK_TEXT } from '@zumibot/shared/spendCaps'
import { AuditTap, hookOf, SIDE_GUARD_TEXT, type AuditRun } from '../../../src/core/audit/auditTap'
import { VAULT_GUARD_TEXT } from '../../../src/core/vault/vaultGuard'
import type { RunEvent } from '../../../src/core/chat/streamParser'

const result = (denials: string[] = []): RunEvent => ({
  kind: 'result',
  subtype: 'success',
  isError: false,
  numTurns: 1,
  sessionId: 's',
  denials: denials.map((toolUseId) => ({ toolUseId, toolName: 'X' })),
  windows: {},
  uuid: null,
  cost: null
})

function tapOf(run: Partial<AuditRun> = {}, agent = 'helper') {
  const out: Omit<AuditRecord, 'prev'>[] = []
  let t = 1000
  let id = 0
  const tap = new AuditTap(
    { chatId: 'c1', engine: 'claude', runKind: 'chat', mode: 'auto', turnId: 'u1', ...run },
    {
      now: () => (t += 10),
      newId: () => `r${++id}`,
      machine: 'm1',
      agent: () => agent,
      scrub: () => new Map([['s3cr3tvalue', '[vault: K]']]),
      write: (r) => out.push(r)
    }
  )
  return { tap, out }
}

describe('audit tap', () => {
  it('a call with no request is allowed by mode, written at its result with its duration', () => {
    const { tap, out } = tapOf()
    tap.event({ kind: 'toolUse', id: 't1', name: 'Bash', input: { command: 'echo s3cr3tvalue' } })
    tap.event({ kind: 'toolResult', toolUseId: 't1', content: 'ok', isError: false })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      tool: 'Bash',
      input: { command: 'echo [vault: K]' },
      decision: { kind: 'allowedByMode' },
      outcome: 'ok',
      durationMs: 10,
      itemId: 't1',
      turnId: 'u1',
      agent: 'helper',
      machine: 'm1',
      isolation: 'off'
    })
  })

  it('a request decided by a branch carries that decision', () => {
    const { tap, out } = tapOf()
    tap.event({ kind: 'toolUse', id: 't1', name: 'Edit', input: {} })
    tap.event({ kind: 'permissionRequest', requestId: 'q1', toolName: 'Edit', input: {}, description: null, reason: null, toolUseId: 't1' })
    tap.decided('q1', { kind: 'allowedByChatRule' })
    tap.event({ kind: 'toolResult', toolUseId: 't1', content: 'done', isError: false })
    expect(out[0].decision).toEqual({ kind: 'allowedByChatRule' })
  })

  it('a failed call with no decision waits for the result: a listed denial is a rule, else allowed by mode', () => {
    const { tap, out } = tapOf()
    tap.event({ kind: 'toolUse', id: 'a', name: 'Read', input: {} })
    tap.event({ kind: 'toolResult', toolUseId: 'a', content: 'denied', isError: true })
    tap.event({ kind: 'toolUse', id: 'b', name: 'Bash', input: {} })
    tap.event({ kind: 'toolResult', toolUseId: 'b', content: 'exit 1', isError: true })
    expect(out).toHaveLength(0)
    tap.event(result(['a']))
    expect(out.map((r) => [r.tool, r.decision.kind, r.outcome])).toEqual([
      ['Read', 'deniedByRule', 'denied'],
      ['Bash', 'allowedByMode', 'error']
    ])
  })

  it('names the hook that blocked a call by its text', () => {
    expect(hookOf(`PreToolUse:Bash hook error: ${VAULT_GUARD_TEXT}`)).toBe('vaultGuard')
    expect(hookOf(PAUSE_BLOCK_TEXT)).toBe('pause')
    expect(hookOf(CAP_BLOCK_TEXT)).toBe('spendCap')
    expect(hookOf(SIDE_GUARD_TEXT)).toBe('sideGuard')
    expect(hookOf('PreToolUse:Bash hook error: nope')).toBe('other')
    expect(hookOf('command failed')).toBeNull()
    const { tap, out } = tapOf()
    tap.event({ kind: 'toolUse', id: 'b', name: 'Blocked', input: {} })
    tap.event({ kind: 'toolResult', toolUseId: 'b', content: VAULT_GUARD_TEXT, isError: true })
    expect(out[0]).toMatchObject({ decision: { kind: 'deniedByHook', hook: 'vaultGuard' }, outcome: 'denied', error: VAULT_GUARD_TEXT })
  })

  it('a question card keeps its answers; a plan sent back keeps the feedback', () => {
    const { tap, out } = tapOf()
    tap.event({ kind: 'toolUse', id: 'q', name: 'AskUserQuestion', input: { questions: [] } })
    tap.event({
      kind: 'permissionRequest',
      requestId: 'r',
      toolName: 'AskUserQuestion',
      input: {},
      description: null,
      reason: null,
      toolUseId: 'q'
    })
    tap.decided('r', { kind: 'approvedByUser', scope: 'once' }, { answers: { 'Which?': 's3cr3tvalue' } })
    tap.event({ kind: 'toolResult', toolUseId: 'q', content: 'answered', isError: false })
    expect(out[0].answer).toEqual({ answers: { 'Which?': '[vault: K]' } })
  })

  it('subagent calls link to their Agent row and name the subagent', () => {
    const { tap, out } = tapOf()
    tap.event({ kind: 'subToolUse', parent: 'agentRow', id: 's1', name: 'Grep', input: { pattern: 'x' }, subagent: 'explorer' })
    tap.event({ kind: 'subToolResult', parent: 'agentRow', toolUseId: 's1', content: 'hit', isError: false })
    expect(out[0]).toMatchObject({ subagent: 'explorer', parentToolUseId: 'agentRow', itemId: 'agentRow' })
  })

  it('at the end, open calls are interrupted (stop) or have no result; an open card is unanswered', () => {
    const { tap, out } = tapOf()
    tap.event({ kind: 'toolUse', id: 'a', name: 'Bash', input: {} })
    tap.event({ kind: 'toolUse', id: 'b', name: 'Bash', input: {} })
    tap.event({ kind: 'permissionRequest', requestId: 'r', toolName: 'Bash', input: {}, description: null, reason: null, toolUseId: 'b' })
    tap.end(true)
    expect(out.map((r) => [r.decision.kind, r.outcome])).toEqual([
      ['allowedByMode', 'interrupted'],
      ['unanswered', 'denied']
    ])
    tap.event({ kind: 'toolUse', id: 'c', name: 'Bash', input: {} })
    tap.end(false)
    expect(out).toHaveLength(2)
  })

  it('a request without a tool use id is written when it is answered; side runs link to no item', () => {
    const { tap, out } = tapOf({ runKind: 'side', noItems: true })
    tap.event({
      kind: 'permissionRequest',
      requestId: 'r',
      toolName: 'Bash',
      input: { command: 'ls' },
      description: null,
      reason: null,
      toolUseId: null
    })
    tap.decided('r', { kind: 'deniedByZumiBot', why: 'sideGuard' })
    expect(out[0]).toMatchObject({
      tool: 'Bash',
      decision: { kind: 'deniedByZumiBot', why: 'sideGuard' },
      outcome: 'denied',
      itemId: null,
      runKind: 'side'
    })
  })

  it('carries the workflow and routine links of its run', () => {
    const { tap, out } = tapOf({ runKind: 'workflow', workflow: { id: 'w', runId: 'wr', stepId: 'st' } })
    tap.event({ kind: 'toolUse', id: 'a', name: 'Bash', input: {} })
    tap.event({ kind: 'toolResult', toolUseId: 'a', content: '', isError: false })
    expect(out[0].workflow).toEqual({ id: 'w', runId: 'wr', stepId: 'st' })
  })

  it('a sandboxed run marks what the sandbox blocked, whoever allowed the call; an Off run never does', () => {
    const net =
      'Exit code 56\n<sandbox_violations>\ndeny network-outbound api.github.com:443 (host is not on the allow list)\n</sandbox_violations>'
    const { tap, out } = tapOf({ isolation: 'sandbox' })
    tap.event({ kind: 'toolUse', id: 't1', name: 'Bash', input: { command: 'curl https://api.github.com' } })
    tap.event({ kind: 'toolResult', toolUseId: 't1', content: net, isError: true })
    tap.event({ kind: 'toolUse', id: 't2', name: 'Bash', input: { command: 'echo y > ~/.nvm/x' } })
    tap.event({ kind: 'permissionRequest', requestId: 'q2', toolName: 'Bash', input: {}, description: null, reason: null, toolUseId: 't2' })
    tap.decided('q2', { kind: 'approvedByUser', scope: 'once' })
    tap.event({ kind: 'toolResult', toolUseId: 't2', content: '/bin/bash: /home/u/.nvm/x: Read-only file system', isError: true })
    expect(out.map((r) => [r.decision, r.outcome, r.isolation])).toEqual([
      [{ kind: 'deniedBySandbox', target: 'api.github.com' }, 'denied', 'sandbox'],
      [{ kind: 'deniedBySandbox', target: '/home/u/.nvm/x' }, 'denied', 'sandbox']
    ])
    const off = tapOf()
    off.tap.event({ kind: 'toolUse', id: 't1', name: 'Bash', input: {} })
    off.tap.event({ kind: 'toolResult', toolUseId: 't1', content: '/proc/x: Read-only file system', isError: true })
    off.tap.event(result())
    expect(off.out[0].decision).toEqual({ kind: 'allowedByMode' })
  })

  it("an ACP agent's calls are written like Claude's, under its engine", () => {
    const { tap, out } = tapOf({ engine: 'acp' })
    tap.event({ kind: 'toolUse', id: 't1', name: 'Bash', input: { command: 'ls' } })
    tap.event({
      kind: 'permissionRequest',
      requestId: 'q1',
      toolName: 'Bash',
      input: { command: 'ls' },
      description: null,
      reason: null,
      toolUseId: 't1'
    })
    tap.decided('q1', { kind: 'approvedByUser', scope: 'once' })
    tap.event({ kind: 'toolResult', toolUseId: 't1', content: 'a', isError: false })
    expect(out[0]).toMatchObject({ engine: 'acp', decision: { kind: 'approvedByUser', scope: 'once' }, outcome: 'ok' })
  })

  it("a remote agent's rows ran on its server; a call it asked ZumiBot to run is refused; a question card keeps its answer", () => {
    const { tap, out } = tapOf({ engine: 'ag-ui' })
    tap.event({ kind: 'toolUse', id: 'r1', name: AGUI_TOOL, input: { name: 'search', args: '{}' } })
    tap.event({ kind: 'toolResult', toolUseId: 'r1', content: 'found', isError: false })
    tap.event({ kind: 'toolUse', id: 'r2', name: AGUI_TOOL, input: { name: 'local_tool', args: '{}' } })
    tap.event({ kind: 'toolResult', toolUseId: 'r2', content: AGUI_TEXT.noTools, isError: true })
    tap.event({ kind: 'toolUse', id: 'r3', name: AGUI_TOOL, input: { name: 'slow', args: '{}' } })
    tap.event({ kind: 'toolResult', toolUseId: 'r3', content: AGUI_TEXT.toolUnfinished, isError: true })
    tap.event({
      kind: 'permissionRequest',
      requestId: 'q1',
      toolName: 'AskUserQuestion',
      input: {},
      description: null,
      reason: null,
      toolUseId: null
    })
    tap.decided('q1', { kind: 'approvedByUser', scope: 'once' }, { answers: { a: 'b' } })
    tap.event({ kind: 'toolUse', id: 'r4', name: AGUI_TOOL, input: { name: 'open', args: '{}' } })
    tap.end(true)
    expect(out.map((r) => [r.engine, r.decision.kind, r.outcome])).toEqual([
      ['ag-ui', 'ranRemotely', 'ok'],
      ['ag-ui', 'deniedByZumiBot', 'denied'],
      ['ag-ui', 'ranRemotely', 'error'],
      ['ag-ui', 'approvedByUser', 'ok'],
      ['ag-ui', 'ranRemotely', 'interrupted']
    ])
    expect(out[1].decision).toEqual({ kind: 'deniedByZumiBot', why: 'remoteTools' })
  })
})
