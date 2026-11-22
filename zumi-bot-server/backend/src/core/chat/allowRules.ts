import { prefixOfRule } from '@zumibot/shared/allowRules'
import type { RunMode } from '@zumibot/shared/chatRun'

/**
 * The `--settings` piece that gives a turn the Bash allow rules the user granted (this chat's first, then the agent's).
 * Never in Plan: a plan stays read-only. A rule that is not exactly `Bash(<prefix>:*)` is dropped, since this file decides
 * what a turn may run. buildArgs merges the piece into the run's one --settings.
 */
export function allowSettingsArgs(chatRules: readonly string[] | undefined, agentRules: readonly string[], mode: RunMode): string[] {
  if (mode === 'plan') return []
  const allow = [...new Set([...(chatRules ?? []), ...agentRules])].filter((r) => prefixOfRule(r) !== null)
  return allow.length ? ['--settings', JSON.stringify({ permissions: { allow } })] : []
}
