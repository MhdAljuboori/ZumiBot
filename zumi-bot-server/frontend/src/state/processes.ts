import { displayName } from '@zumibot/shared/frontmatter'
import { spanText, type ProcessInfo, type ProcessLogRead, type ProcessWake } from '@zumibot/shared/processes'

// Pure view rules of the Processes panel, its log view and the chat header's mark (docs/architecture/processes.md).

// Green is for a live process only, as in Dispatched agents: a green dot on a process that exited fine reads as still running.
export type ProcessTone = 'running' | 'bad' | 'muted'

export interface ProcessRow {
  id: string
  name: string
  command: string
  /** "Running", "Exited (code 1)", "Stopped by you", "Lost at restart"… */
  state: string
  tone: ProcessTone
  by: string
  /** "up 5m" while it runs, "3m ago" once it ended. */
  time: string
  running: boolean
}

/** The state in the panel's words: shorter than the agent's (`stateText`), and "you" for the user. */
export function stateLabel(p: Pick<ProcessInfo, 'state' | 'exitCode' | 'signal' | 'stoppedBy' | 'note'>): {
  text: string
  tone: ProcessTone
} {
  switch (p.state) {
    case 'running':
      return { text: 'Running', tone: 'running' }
    case 'exited':
      return p.exitCode === 0
        ? { text: 'Exited (code 0)', tone: 'muted' }
        : { text: p.exitCode !== null ? `Exited (code ${p.exitCode})` : `Ended by ${p.signal ?? 'a signal'}`, tone: 'bad' }
    case 'stopped': {
      const by =
        p.stoppedBy === 'user'
          ? 'Stopped by you'
          : p.stoppedBy === 'agent'
            ? 'Stopped by the agent'
            : p.stoppedBy === 'archive'
              ? 'Stopped at archive'
              : p.stoppedBy === 'lifetime'
                ? 'Stopped at its time limit'
                : p.stoppedBy === 'shutdown'
                  ? 'Stopped with the server'
                  : 'Stopped'
      return { text: by, tone: 'muted' }
    }
    case 'lost':
      return { text: p.note === 'ended at start' ? 'Lost at restart (ended)' : 'Lost at restart', tone: 'muted' }
    case 'failed':
      return { text: p.note ? `Failed to start (${p.note})` : 'Failed to start', tone: 'bad' }
  }
}

/** The panel's rows: running first, then ended newest first (the server's order, kept even if a push reorders). */
export function processRows(list: readonly ProcessInfo[], now: number): ProcessRow[] {
  return [...list]
    .sort(
      (a, b) => Number(b.state === 'running') - Number(a.state === 'running') || (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)
    )
    .map((p) => {
      const s = stateLabel(p)
      const running = p.state === 'running'
      return {
        id: p.id,
        name: p.name,
        command: p.command,
        state: s.text,
        tone: s.tone,
        by: displayName(p.startedBy),
        running,
        time: running ? `up ${spanText(now - p.startedAt)}` : p.endedAt !== null ? `${spanText(now - p.endedAt)} ago` : ''
      }
    })
}

/** Beside Open Processes: "N running" while any runs, else how many there are; nothing for none. */
export function processesBadge(list: readonly ProcessInfo[]): { text: string; live: boolean } | null {
  const running = list.filter((p) => p.state === 'running').length
  if (running > 0) return { text: `${running} running`, live: true }
  return list.length > 0 ? { text: String(list.length), live: false } : null
}

/** The chat header's mark: only while something runs. A live process is not a running reply, so nothing else shows it. */
export function processMark(running: number): { count: string; label: string } | null {
  if (running <= 0) return null
  return { count: running > 1 ? String(running) : '', label: running === 1 ? '1 process running' : `${running} processes running` }
}

/** The app's running counts per chat: the first fetch, then each `processes:changed`, which carries the chat's new count. */
export function countsAfter(counts: Readonly<Record<string, number>>, e: { chatId: string; running: number }): Record<string, number> {
  if ((counts[e.chatId] ?? 0) === e.running) return counts as Record<string, number>
  const next = { ...counts }
  if (e.running > 0) next[e.chatId] = e.running
  else delete next[e.chatId]
  return next
}

/**
 * What a process's notify rule does, in a line: when it wakes the agent and how much of it is used. null without a rule.
 * Its `note` (why the last event woke nobody) is shown on its own, as a warning.
 */
export function wakeLabel(w: ProcessWake | null): string | null {
  if (w === null) return null
  const when =
    w.on === 'exit' ? 'when it exits' : w.on === 'fail' ? 'if it fails' : `on lines with ${w.patterns.map((p) => `"${p}"`).join(', ')}`
  const used = w.fired >= w.times ? ' · used' : w.times > 1 ? ` · ${w.fired} of ${w.times} used` : ''
  return `Wakes the agent ${when}${used}`
}

/** Which buttons a process's log view offers. Restart also for a running one (it ends it first); Forget only once it ended. */
export function processActions(
  p: Pick<ProcessInfo, 'state'> | undefined,
  archived: boolean
): { stop: boolean; restart: boolean; forget: boolean } {
  if (!p) return { stop: false, restart: false, forget: false }
  const running = p.state === 'running'
  return { stop: running, restart: !archived, forget: !running }
}

// ---- the live log ----

/** What the log view holds: the text of bytes [from, to) of the process's output, and how much before `from` is gone. */
export interface LogView {
  id: string
  from: number
  to: number
  text: string
  /** Bytes before `from` the server no longer keeps. */
  dropped: number
  /** The view itself let its oldest lines go (LOG_VIEW_MAX). */
  trimmed: boolean
}

/** How much text the view keeps: the newest part, so a chatty process cannot grow the page without end. */
export const LOG_VIEW_MAX = 512 * 1024

/**
 * A read joined onto what the view holds. A read that starts where the view ends is appended; anything else (the first read, a
 * read that left a gap, or one from another process) replaces it. Past LOG_VIEW_MAX the oldest lines go.
 */
export function joinLog(view: LogView | null, id: string, read: Pick<ProcessLogRead, 'text' | 'from' | 'to' | 'dropped'>): LogView {
  let next: LogView =
    view !== null && view.id === id && read.from === view.to && read.dropped === 0
      ? { ...view, to: read.to, text: view.text + read.text }
      : { id, from: read.from, to: read.to, text: read.text, dropped: read.dropped, trimmed: false }
  if (next.text.length > LOG_VIEW_MAX) {
    const cut = next.text.length - LOG_VIEW_MAX
    // Whole lines only, so the first line shown is never half of one.
    const nl = next.text.indexOf('\n', cut)
    const at = nl < 0 ? cut : nl + 1
    next = { ...next, text: next.text.slice(at), trimmed: true }
  }
  return next
}

/** Whether the view should read again: the process produced bytes past what the view holds. */
export const logBehind = (view: LogView | null, out: number): boolean => view === null || out > view.to
