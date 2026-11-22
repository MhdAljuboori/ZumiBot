// Bash's own timeout is 2 min (max 10). With background tasks off, a build longer than that had no way through but a
// background process, whose start always asks: one-shot builds and test runs showed up as process cards. A value the
// server's own env already sets wins.
export const BASH_TIMEOUTS: Record<string, string> = { BASH_DEFAULT_TIMEOUT_MS: '600000', BASH_MAX_TIMEOUT_MS: '1800000' }

// Background tasks (async subagents, run_in_background, Monitor) keep the CLI alive past its result and start turns of
// their own that stdin, closed at the result, cannot answer: the chat stayed running after the reply.
export function claudeRunEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...BASH_TIMEOUTS, ...env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }
}
