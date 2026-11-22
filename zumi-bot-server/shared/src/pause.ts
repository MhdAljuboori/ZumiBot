// Pause/Resume of a running reply (see the pause-resume design spec).

/** In the block text, so the server can count the calls the pause hook blocked in the CLI's output. */
export const PAUSE_MARKER = '(zumibot-pause)'
/** What the pause hook tells the agent for every tool call while paused; the agent then wraps up in a few lines. */
export const PAUSE_BLOCK_TEXT = `The user paused this task ${PAUSE_MARKER}. Do not start any tool or subagent. In a few lines, say where the task stands and what the next step is, then end your reply.`
/** The message Resume sends. */
export const RESUME_TEXT = 'Continue'
/** Blocked main-thread calls while nothing runs before the server ends the run itself (an agent that ignores the block). */
export const PAUSE_BLOCK_CAP = 3

/** pausing: the pause was asked and the reply is still wrapping up; paused: it ended and waits for Resume. */
export type PauseState = 'pausing' | 'paused'

const LOST_MAX = 20

/** The note a resumed agent reads when a stop killed subagents it had running; null when none were lost. */
export function lostNote(descriptions: readonly string[]): string | null {
  if (descriptions.length === 0) return null
  const lines = descriptions.slice(0, LOST_MAX).map((d) => `- ${d.trim() || '(no description)'}`)
  if (descriptions.length > LOST_MAX) lines.push(`- and ${descriptions.length - LOST_MAX} more`)
  return [
    'Your last reply was stopped while these subagents were running. They are not running now and their results are lost:',
    ...lines,
    'Run them again if you still need them.'
  ].join('\n')
}
