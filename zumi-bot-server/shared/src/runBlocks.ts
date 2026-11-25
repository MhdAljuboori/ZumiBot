/** The Run button on single-line shell blocks of an agent's reply (see docs/architecture/run-blocks.md). Pure rules and wire types. */
import { commandError } from './processes'

export const RUN_SHELL_LANGS = ['bash', 'sh', 'shell', 'zsh'] as const
/** What a Run result may hold of the output: its tail. */
export const RUN_OUTPUT_MAX = 16 * 1024

/** On a user item or queued task: this message is the agent's copy of a Run's result, not something the user typed. */
export interface RunMark {
  processId: string
}

export type RunEnd =
  | { kind: 'exit'; code: number }
  | { kind: 'signal'; signal: string }
  | { kind: 'stopped'; by: 'user' | 'lifetime' }

export const RUN_REFUSALS = {
  notBlock: 'That command is not a block of this message.',
  remote: "Run is not available for a remote agent's commands.",
  gone: 'That message is no longer in this chat.',
  asked: 'Run is not available in a chat another agent asked.'
}

/** Edit and Resend of a Run result's hidden message: the UI never offers them, and the server refuses them too. */
export const RUN_ITEM_FIXED = 'A Run result cannot be edited or sent again.'

/**
 * Whether the tray holds a task the user can see. Only those are held (`held`): the user cannot Send now or drop a Run
 * result's task, so a tray of those alone is never held and they go on by themselves.
 */
export const holdsVisibleTask = (tasks: readonly { run?: RunMark }[] | undefined): boolean => (tasks ?? []).some((t) => t.run === undefined)

const isShellLang = (lang: string): boolean => (RUN_SHELL_LANGS as readonly string[]).includes(lang.toLowerCase())

/** The block's command when it is one runnable line of a shell language, else null. */
export function runnableCommand(lang: string, text: string): string | null {
  if (!isShellLang(lang)) return null
  const command = text.endsWith('\n') ? text.slice(0, -1) : text
  if (command.includes('\n') || commandError(command)) return null
  return command
}

// What may stand in front of a fence line: quote marks, spaces and tabs, then one list marker (a blockquote, a list item).
const CONTAINER_RE = /^[> \t]*(?:(?:[-*+]|\d+[.)]) )?/
const OPEN_RE = /^(`{3,}|~{3,})[ \t]*([^\s]*)/
const CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/**
 * Whether the message holds a fenced shell block of exactly this one line. The server checks this before it runs
 * anything, so a client cannot run a command the agent never wrote. Body lines lose only the opener's own prefix: what
 * is left, a "- " or "> " or spaces included, is part of the line.
 */
export function messageHasRunBlock(text: string, command: string): boolean {
  let fence: string | null = null
  let shell = false
  let bodyPrefix = ''
  let body: string[] = []
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (fence !== null) {
      // A line outside the opener's quote or list item ends the block unclosed: nothing runs from it.
      if (!raw.startsWith(bodyPrefix)) fence = null
      else {
        const line = raw.slice(bodyPrefix.length)
        const close = CLOSE_RE.exec(line)
        if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
          if (shell && body.length === 1 && body[0] === command) return true
          fence = null
        } else body.push(line)
        continue
      }
    }
    const prefix = CONTAINER_RE.exec(raw)![0]
    const rest = raw.slice(prefix.length)
    const m = OPEN_RE.exec(rest)
    // A backtick fence's info string holds no backtick: "```x```" is inline code.
    if (!m || (m[1]![0] === '`' && rest.slice(m[1]!.length).includes('`'))) continue
    fence = m[1]!
    shell = isShellLang(m[2]!)
    // The list marker's width becomes spaces: its item's next lines are indented under it.
    bodyPrefix = prefix.replace(/(?:[-*+]|\d+[.)]) $/, (marker) => ' '.repeat(marker.length))
    body = []
  }
  return false
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function endLine(end: RunEnd): string {
  if (end.kind === 'exit') return `[exit code ${end.code}]`
  if (end.kind === 'signal') return `[ended by ${end.signal}]`
  return end.by === 'user' ? '[stopped by the user]' : '[stopped at its time limit]'
}

/**
 * The agent's copy of a Run, in the tags the CLI uses for its own `!` commands. Command and output are escaped so a line
 * of output cannot close a tag early; the end line says how it ended, since the stderr slot stays empty (one merged stream).
 */
export function runResultText(r: { command: string; output: string; cut: boolean; end: RunEnd; mention?: string }): string {
  const out = r.output.endsWith('\n') ? r.output.slice(0, -1) : r.output
  const body = `${r.cut ? '[…earlier output truncated…]\n' : ''}${out === '' ? '[No output]' : esc(out)}\n${esc(endLine(r.end))}`
  return `${r.mention ? `@${r.mention}\n` : ''}<bash-input>${esc(r.command)}</bash-input><bash-stdout>${body}</bash-stdout><bash-stderr></bash-stderr>`
}
