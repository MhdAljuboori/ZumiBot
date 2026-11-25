// Pure rules of the Run button on shell blocks (see docs/architecture/run-blocks.md).
import type { Element } from 'hast'
import type { ProcessInfo } from '@zumibot/shared/processes'
import { runnableCommand } from '@zumibot/shared/runBlocks'
import type { ChatItem, QueuedTask } from '@zumibot/shared/types'
import { visibleText } from '@zumibot/shared/visibleText'

/** The one-line shell command of a markdown code block (a hast `<pre>`), or null for any other block. */
export function runnableOfPre(pre: Element | undefined): string | null {
  const code = pre?.children[0]
  if (code?.type !== 'element' || code.tagName !== 'code') return null
  const classes = code.properties.className
  if (!Array.isArray(classes)) return null
  // The language keeps its case here; runnableCommand compares it case-insensitively.
  const lang = classes.map(String).find((c) => c.startsWith('language-'))
  if (lang === undefined) return null
  return runnableCommand(lang.slice('language-'.length), code.children.map((c) => (c.type === 'text' ? c.value : '')).join(''))
}

/** The newest Run of this command from this message: the status the block shows. Agent processes (`run: null`) never count. */
export function latestRun(list: readonly ProcessInfo[] | null, messageId: string, command: string): ProcessInfo | null {
  let best: ProcessInfo | null = null
  for (const p of list ?? []) {
    if (p.run?.messageId !== messageId || p.command !== command) continue
    if (best === null || p.startedAt > best.startedAt) best = p
  }
  return best
}

/** A command with characters the text hides (bidi marks, zero-width) is confirmed before it runs, since the user cannot read it as it is. */
export const needsRunConfirm = (command: string): boolean => visibleText(command) !== command

/** The agent's hidden copy of a Run's result: never drawn, resent or recalled as something the user typed. */
export const isRunItem = (i: ChatItem): boolean => i.type === 'user' && i.run !== undefined

export const withoutRunItems = (items: readonly ChatItem[]): ChatItem[] => items.filter((i) => !isRunItem(i))

export const visibleTasks = (tasks: readonly QueuedTask[] | undefined): QueuedTask[] => (tasks ?? []).filter((t) => t.run === undefined)
