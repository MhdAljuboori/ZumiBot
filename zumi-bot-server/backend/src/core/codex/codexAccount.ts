import type { ClaudeAccount, ClaudeUsage } from '@zumibot/shared/types'
import type { RunEvent } from '../chat/streamParser'
import type { UsageReading } from '../claudeAccount'

/** Codex's plan limits as its last run here reported them. In memory only: nothing is stored or synced, a restart starts empty. */
export class CodexUsage {
  private seen: ClaudeUsage | null = null

  constructor(private readonly now: () => number) {}

  record(u: UsageReading): void {
    this.seen = { session: u.session, weekly: u.weekly, updatedAt: this.now() }
  }

  latest(): ClaudeUsage | null {
    return this.seen
  }
}

/** The account the popover reads: Claude's own, plus `codex` only once a Codex run reported one. */
export function withCodexUsage(account: ClaudeAccount, codex: ClaudeUsage | null): ClaudeAccount {
  return codex ? { ...account, codex } : account
}

/** A Codex run's `onEvent` that takes its plan readings for the popover and never hands them on to the chat. */
export function codexReadingsOnly<T extends { onEvent: (e: RunEvent) => void }>(o: T, into: CodexUsage): T {
  return {
    ...o,
    onEvent: (e: RunEvent) => {
      if (e.kind === 'rateLimit') {
        if (e.provider === 'codex') into.record(e)
      } else o.onEvent(e)
    }
  }
}
