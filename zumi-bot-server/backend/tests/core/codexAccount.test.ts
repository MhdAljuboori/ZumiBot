import { describe, expect, it } from 'vitest'
import { CodexUsage, codexReadingsOnly, withCodexUsage } from '../../src/core/codex/codexAccount'
import type { ClaudeAccount } from '@zumibot/shared/types'
import type { RunEvent } from '../../src/core/chat/streamParser'

const reading = { session: { percent: 14, resetsAt: 1_000 }, weekly: { percent: 19, resetsAt: 2_000 } }
const claude: ClaudeAccount = {
  name: 'Mo',
  email: 'm@x.io',
  plan: 'Pro',
  usage: { session: { percent: 42, resetsAt: null }, weekly: null, updatedAt: 500 }
}

describe('CodexUsage', () => {
  it('has no reading until a Codex run reports one', () => {
    expect(new CodexUsage(() => 1).latest()).toBeNull()
  })

  it('keeps the newest reading with its time, in memory only', () => {
    let now = 10
    const u = new CodexUsage(() => now)
    u.record(reading)
    now = 20
    u.record({ session: { percent: 15, resetsAt: 1_000 }, weekly: null })
    expect(u.latest()).toEqual({ session: { percent: 15, resetsAt: 1_000 }, weekly: null, updatedAt: 20 })
  })
})

describe('withCodexUsage', () => {
  it('leaves the Claude account exactly as it was while there is no Codex reading', () => {
    expect(withCodexUsage(claude, null)).toEqual(claude)
    expect('codex' in withCodexUsage(claude, null)).toBe(false)
  })

  it('carries both, and never touches the Claude reading', () => {
    const u = new CodexUsage(() => 77)
    u.record(reading)
    const out = withCodexUsage(claude, u.latest())
    expect(out.usage).toEqual(claude.usage)
    expect(out.codex).toEqual({ ...reading, updatedAt: 77 })
  })
})

describe('codexReadingsOnly', () => {
  it('takes Codex readings for the popover and passes every other event on', () => {
    const u = new CodexUsage(() => 5)
    const seen: RunEvent[] = []
    const o = codexReadingsOnly({ onEvent: (e: RunEvent) => seen.push(e) }, u)
    o.onEvent({ kind: 'rateLimit', provider: 'codex', ...reading })
    o.onEvent({ kind: 'textDelta', text: 'hi' })
    expect(seen).toEqual([{ kind: 'textDelta', text: 'hi' }])
    expect(u.latest()).toEqual({ ...reading, updatedAt: 5 })
  })

  it('drops an untagged reading rather than store or forward it', () => {
    const u = new CodexUsage(() => 5)
    const seen: RunEvent[] = []
    codexReadingsOnly({ onEvent: (e: RunEvent) => seen.push(e) }, u).onEvent({ kind: 'rateLimit', ...reading })
    expect(seen).toEqual([])
    expect(u.latest()).toBeNull()
  })
})
