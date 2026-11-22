import { describe, expect, it } from 'vitest'
import { auditRowOf, auditSummary, decisionLabel, isDenied, matchesAudit, parseAuditFilter, type AuditRecord } from '../src/audit'

const rec = (o: Partial<AuditRecord> = {}): AuditRecord => ({
  v: 1,
  id: 'i',
  ts: 100,
  durationMs: 1,
  machine: 'm',
  chatId: 'c',
  itemId: null,
  turnId: null,
  agent: 'dev',
  subagent: null,
  parentToolUseId: null,
  engine: 'claude',
  runKind: 'chat',
  mode: 'auto',
  isolation: 'off',
  tool: 'Bash',
  input: { command: 'npm test' },
  inputCut: null,
  decision: { kind: 'allowedByMode' },
  outcome: 'ok',
  error: null,
  prev: '',
  ...o
})

describe('audit filter', () => {
  it('keeps known fields, drops empty and unknown ones, refuses bad values', () => {
    expect(parseAuditFilter(undefined)).toEqual({})
    expect(parseAuditFilter({ agent: 'dev', tool: '', decision: 'deniedByUser', outcome: 'ok', from: 1, to: 2, q: 'x', other: 1 })).toEqual(
      { agent: 'dev', decision: 'deniedByUser', outcome: 'ok', from: 1, to: 2, q: 'x' }
    )
    expect(() => parseAuditFilter('x')).toThrow(/object/)
    expect(() => parseAuditFilter({ decision: 'nope' })).toThrow(/decision/)
    expect(() => parseAuditFilter({ outcome: 'nope' })).toThrow(/outcome/)
    expect(() => parseAuditFilter({ from: -1 })).toThrow(/from/)
    expect(() => parseAuditFilter({ to: Infinity })).toThrow(/to/)
    expect(() => parseAuditFilter({ agent: 3 })).toThrow(/agent/)
  })

  it('matches every field; the search looks at the tool and the input, case-insensitively', () => {
    const r = rec()
    expect(matchesAudit(r, {})).toBe(true)
    expect(matchesAudit(r, { agent: 'other' })).toBe(false)
    expect(matchesAudit(r, { decision: 'deniedByUser' })).toBe(false)
    expect(matchesAudit(r, { from: 101 })).toBe(false)
    expect(matchesAudit(r, { to: 99 })).toBe(false)
    expect(matchesAudit(r, { q: 'NPM' })).toBe(true)
    expect(matchesAudit(r, { q: 'bash' })).toBe(true)
    expect(matchesAudit(r, { q: 'yarn' })).toBe(false)
  })
})

describe('audit rows and words', () => {
  it('a row summarises the input by its command, path or url, else its JSON, on one short line', () => {
    expect(auditSummary('Bash', { command: 'ls\n  -la' })).toBe('ls -la')
    expect(auditSummary('Read', { file_path: '/a/b' })).toBe('/a/b')
    expect(auditSummary('X', { n: 1 })).toBe('{"n":1}')
    expect(auditSummary('Bash', { command: 'x'.repeat(500) }).length).toBe(200)
    expect(auditRowOf(rec(), 'f:3')).toMatchObject({ id: 'i', at: 'f:3', summary: 'npm test' })
  })

  it('labels decisions and tells denied ones apart', () => {
    expect(decisionLabel({ kind: 'approvedByUser', scope: 'agent' })).toBe('Approved by you always for this agent')
    expect(decisionLabel({ kind: 'deniedByHook', hook: 'vaultGuard' })).toBe('Denied by the vault guard')
    expect(isDenied({ kind: 'deniedByRule' })).toBe(true)
    expect(isDenied({ kind: 'unanswered' })).toBe(true)
    expect(isDenied({ kind: 'allowedByMode' })).toBe(false)
  })
})
