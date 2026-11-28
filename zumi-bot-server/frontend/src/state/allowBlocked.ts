import {
  cdTarget,
  checkFolder,
  checkPrefix,
  commandParts,
  coveredBy,
  folderCoveredBy,
  gitCForms,
  isGitPart,
  isSafePart,
  PROGRAM_MESSAGE,
  PROGRAM_REASON,
  programError,
  suggestPrefix
} from '@zumibot/shared/allowRules'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'

type ToolItem = Extract<ChatItem, { type: 'tool' }>

/** The agent a row belongs to: a room's rows carry it, a single chat's is the chat's. */
export const rowAgent = (item: ToolItem, chat: ChatMeta): string => item.agent ?? chat.agentName

/** The Bash command of a tool row, or null when its input holds none. */
export function commandOf(item: ToolItem): string | null {
  const input = item.input
  if (typeof input !== 'object' || input === null) return null
  const c = (input as { command?: unknown }).command
  return typeof c === 'string' ? c : null
}

/** Whether a refused row could ever be allowed: a classifier-refused Bash call with a command, in a chat a user can talk
 *  to (not Zumi Bot's, not a workflow's), its turn ended. A user's Deny or a rule's block never qualifies (`blockedBy`). */
function allowable(item: ToolItem, chat: ChatMeta): boolean {
  const agent = rowAgent(item, chat)
  return (
    item.name === 'Bash' &&
    item.blockedBy === 'classifier' &&
    commandOf(item) !== null &&
    item.turn === undefined &&
    agent !== '' &&
    agent !== 'zumi-bot' &&
    chat.workflow === undefined &&
    chat.workflowTest === undefined
  )
}

/** Whether a row can be allowed right now: allowable, not yet allowed, and the chat idle. */
export function canAllowBlocked(item: ToolItem, chat: ChatMeta, running: boolean): boolean {
  return !running && item.allowedAs === undefined && allowable(item, chat)
}

export type AllowCardState = 'hidden' | 'collapsed' | 'pending' | 'running' | 'done'

/**
 * What the Allow card of a refused row shows. `done`: allowed already. `hidden`: it can never be allowed. `running`: the
 * chat is running, so the card is there but cannot be used yet. Otherwise `pending` in the latest turn, `collapsed` (one
 * line that expands) for an older refusal, which the user probably handled another way.
 */
export function allowCardState(item: ToolItem, chat: ChatMeta, running: boolean, latest: boolean): AllowCardState {
  if (item.allowedAs !== undefined) return 'done'
  if (!allowable(item, chat)) return 'hidden'
  if (running) return 'running'
  return latest ? 'pending' : 'collapsed'
}

/** The tool row is in the chat's latest turn: no user message comes after it. False when the row is not in `items`. */
export function inLatestTurn(items: readonly ChatItem[], toolId: string): boolean {
  const at = items.findIndex((i) => i.type === 'tool' && i.id === toolId)
  return at >= 0 && !items.slice(at + 1).some((i) => i.type === 'user')
}

export interface SheetRow {
  part: string
  prefix: string
  /** A `cd` into this folder, outside the chat's own: the CLI asks about it before any Bash rule, so it gets a Read rule
   *  instead of a prefix. null for every other part. */
  folder: string | null
  ticked: boolean
  /** The part is a git command after a `cd` into a folder row, shown in its `git -C <folder> …` form: no rule lets git run after
   *  such a cd, so the rule and the agent's retry use that form. */
  gitC: boolean
  /** The held rule that already allows this part, or null. */
  heldBy: string | null
  /** Why no rule can start with this part's program (a shell or wrapper), or null. Such a row has no prefix and is never ticked. */
  refused: string | null
}

const insideFolder = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(folder.endsWith('/') ? folder : folder + '/')

/** One row per part of the refused command. Read-only helpers start unticked; a held part is ticked and fixed. A `cd` into a
 *  folder outside `cwd` (the chat's folder) is a folder row, ticked: a Bash rule cannot let it through. A git part after such a
 *  cd is shown as `git -C <folder> …` (`gitCForms`), since git after the cd is asked whatever is allowed. */
export function sheetRows(command: string, held: readonly string[], cwd?: string): SheetRow[] {
  const forms = gitCForms(command)
  let afterFolder = false // the latest cd is a folder row the card offers
  return commandParts(command).map((raw, i) => {
    const folder = cdTarget(raw)
    if (/^cd(\s|$)/.test(raw)) afterFolder = false
    if (folder !== null && !(cwd && insideFolder(folder, cwd))) {
      // The server also refuses the home folder, which the page does not know.
      const refused = checkFolder(folder, command)
      if (refused !== null) return { part: raw, prefix: '', folder, gitC: false, ticked: false, heldBy: null, refused }
      afterFolder = true
      return { part: raw, prefix: '', folder, gitC: false, ticked: true, heldBy: folderCoveredBy(folder, held), refused: null }
    }
    const form = afterFolder ? forms[i] : null
    const part = form?.part ?? raw
    const gitC = form !== null
    // `timeout 30 git …` is not offered as `git …`: whether the CLI matches the wrapped command is unverified.
    const refused = programError(part)
    if (refused !== null) return { part, prefix: '', folder: null, gitC, ticked: false, heldBy: null, refused }
    const heldBy = coveredBy(part, held)
    return { part, prefix: suggestPrefix(part), folder: null, gitC, ticked: heldBy !== null || !isSafePart(part), heldBy, refused: null }
  })
}

/** The folders a click would send: each ticked, not yet held folder row's, without repeats. */
export function chosenFolders(rows: readonly SheetRow[]): string[] {
  const out: string[] = []
  for (const r of rows) if (r.folder && r.ticked && r.heldBy === null && r.refused === null && !out.includes(r.folder)) out.push(r.folder)
  return out
}

/** The folder of a folder row that a later part runs git in, or null. The CLI asks about `cd <folder> && git …` whatever
 *  is allowed (it could pick up the folder's hooks), so no rule helps there; `git -C <folder>` does not trip it. When the git
 *  rows are in their git -C form (`gitC`), the card's rules are for that form and the agent is told to use it. */
export function gitAfterFolder(rows: readonly SheetRow[]): string | null {
  const at = rows.findIndex((r) => r.folder)
  return at >= 0 && rows.slice(at + 1).some((r) => isGitPart(r.part)) ? rows[at].folder : null
}

/** Every row that would be allowed is already held: the CLI refused anyway, so a new rule cannot help. */
export const allHeld = (rows: readonly SheetRow[]): boolean =>
  rows.some((r) => r.ticked) && rows.every((r) => !r.ticked || r.heldBy !== null)

/** The parts the card cannot allow (a shell, interpreter or wrapper, or a folder it does not offer), each once, with why.
 *  No rule covers such a part, so the CLI hands the whole command to the classifier however many other parts are held: when
 *  allHeld, these are what blocked it, not the held rules. A program's reason drops "Allow a narrower command": there is
 *  nothing to allow here. */
export function unallowableParts(rows: readonly SheetRow[]): { part: string; reason: string }[] {
  const out: { part: string; reason: string }[] = []
  for (const r of rows) {
    if (r.refused === null || out.some((b) => b.part === r.part)) continue
    out.push({ part: r.part, reason: r.refused === PROGRAM_MESSAGE ? PROGRAM_REASON : r.refused })
  }
  return out
}

/**
 * What a click would send: each ticked, not yet held row's prefix, trimmed (checkPrefix refuses spaces at the ends) and
 * without repeats, plus the problem with each row's prefix (null when fine or not going to be sent).
 */
export function chosenPrefixes(rows: readonly SheetRow[], command: string): { prefixes: string[]; errors: (string | null)[] } {
  const prefixes: string[] = []
  const errors = rows.map((r) => {
    if (!r.ticked || r.heldBy !== null || r.folder) return null
    const p = r.prefix.trim()
    const bad = checkPrefix(p, command)
    if (bad === null && !prefixes.includes(p)) prefixes.push(p)
    return bad
  })
  return { prefixes, errors }
}
