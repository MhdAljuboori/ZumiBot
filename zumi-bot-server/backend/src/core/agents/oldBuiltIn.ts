import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import type { ChatMeta } from '@zumibot/shared/types'
import type { Routine } from '@zumibot/shared/routines'

/** The built-in agent's first name. */
export const OLD_BUILT_IN_NAME = 'bot-father-agent'
/** Every name the built-in agent had before it became Zumi Bot, oldest first: it was Claude Bot until 0.1.0. */
export const OLD_BUILT_IN_NAMES = [OLD_BUILT_IN_NAME, 'claude-bot'] as const

export interface OldBuiltInDeps {
  agentsDir: string
  chats(): Promise<readonly ChatMeta[]>
  /** Agents that hold remembered approvals. */
  approvals(): readonly string[]
  routines(): Promise<readonly Routine[]>
  /** The same rename the agents-folder watcher runs: chats, approvals, sidebar, settings, routines... */
  rename(from: string, to: string): Promise<void>
  trash(path: string): Promise<void>
}

const namedInChat = (c: ChatMeta, n: string): boolean =>
  c.agentName === n ||
  (c.group?.members.includes(n) ?? false) ||
  c.asked?.by === n ||
  (c.asked?.chain.includes(n) ?? false) ||
  (c.tasks?.some((t) => t.command?.agent === n) ?? false)

const namedInRoutine = (r: Routine, n: string): boolean =>
  r.target.kind === 'new-chat' ? r.target.agent === n : r.target.kind === 'new-group' && r.target.members.includes(n)

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/**
 * Moves everything of the old built-in agent to Zumi Bot, then trashes its file. Runs at every start, because a sync
 * with a machine still on an older version brings the old file and chats back. The full rename reads every chat, so it
 * runs only when the old file or a chat, approval or routine still names the old agent. The rename goes first: when it
 * fails the old file stays, and the next start tries again. Returns whether it moved anything.
 */
export async function migrateOldBuiltIn(d: OldBuiltInDeps, old: string = OLD_BUILT_IN_NAME): Promise<boolean> {
  const file = join(d.agentsDir, `${old}.md`)
  const present = await exists(file)
  const named =
    present ||
    d.approvals().includes(old) ||
    (await d.chats()).some((c) => namedInChat(c, old)) ||
    (await d.routines()).some((r) => namedInRoutine(r, old))
  if (!named) return false
  await d.rename(old, ZUMI_BOT_NAME)
  if (present) await d.trash(file)
  return true
}
