import { parseIsolation, type AgentIsolation, type IsolationLevel } from '@zumibot/shared/isolation'

// Agent Studio's Isolation section as plain data: the lists are edited as text, one entry per line.

export interface IsolationForm {
  level: IsolationLevel
  network: string
  write: string
  read: string
  webSearch: boolean
  autoBash: boolean
}

export const linesOf = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

export const formOf = (iso: AgentIsolation): IsolationForm => ({
  level: iso.level,
  network: iso.network.join('\n'),
  write: iso.write.join('\n'),
  read: iso.read.join('\n'),
  webSearch: iso.webSearch,
  autoBash: iso.autoBash
})

/** The value to save, or the first problem in words (the server checks it again). */
export function isolationOf(f: IsolationForm): { ok: true; isolation: AgentIsolation } | { ok: false; error: string } {
  try {
    return {
      ok: true,
      isolation: parseIsolation({
        level: f.level,
        network: linesOf(f.network),
        write: linesOf(f.write),
        read: linesOf(f.read),
        webSearch: f.webSearch,
        autoBash: f.autoBash
      })
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Not a valid setting' }
  }
}

export const sameForm = (a: IsolationForm, b: IsolationForm): boolean =>
  a.level === b.level &&
  a.webSearch === b.webSearch &&
  a.autoBash === b.autoBash &&
  linesOf(a.network).join('\n') === linesOf(b.network).join('\n') &&
  linesOf(a.write).join('\n') === linesOf(b.write).join('\n') &&
  linesOf(a.read).join('\n') === linesOf(b.read).join('\n')

/** What every sandboxed or contained run of this agent may reach, for the "What it gets" list. */
export function grantsOf(iso: AgentIsolation, toolchain: readonly string[]): { change: string[]; read: string[]; network: string } {
  if (iso.level === 'container') {
    return {
      change: [
        "The chat's folder (or its worktree)",
        "The chat's own temp folder",
        "The repo's git folder (not its hooks or config)",
        "This agent's memory and the folder's session logs",
        ...iso.write
      ],
      read: [
        "The image's own system and tools (not this machine's)",
        'Files you attach to a message',
        "A worktree's linked folders (node_modules)",
        ...iso.read
      ],
      network: iso.network.length === 0 ? 'No network' : iso.network.join(', ')
    }
  }
  return {
    change: [
      "The chat's folder (or its worktree)",
      "The chat's own temp folder",
      "The repo's git folder, so it can commit (not its hooks or config)",
      ...iso.write
    ],
    read: ['System folders (/usr, /etc, …), not your home folder', 'Files you attach to a message', ...toolchain, ...iso.read],
    network: iso.network.length === 0 ? 'No network' : iso.network.join(', ')
  }
}

/** Why a level cannot be chosen for this agent, or null. */
export function levelBlocked(
  level: IsolationLevel,
  o: { refused: string | null; sandbox: string | null; container: string | null; computerUse: boolean }
): string | null {
  if (level === 'off') return null
  if (o.refused) return o.refused
  if (level === 'sandbox') return o.sandbox
  if (o.computerUse) return 'Computer use is on for this agent; it drives your own desktop, which no container holds.'
  return o.container
}
