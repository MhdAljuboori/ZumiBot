import { createContext } from 'react'
import type { ProcessInfo } from '@zumibot/shared/processes'

/** Lets a shell block in an agent's reply run its command and open the run's log in the Processes panel. */
export interface RunLink {
  /** The shown chat's processes, where each block finds its latest run; null until they load. */
  list: ProcessInfo[] | null
  /** Rejects with the server's sentence when the run is refused. */
  run(chatId: string, messageId: string, command: string): Promise<void>
  open(chatId: string, processId: string): void
}

/** null: no Run buttons (the island popup, which has no Processes panel to show a run in). */
export const RunLinkContext = createContext<RunLink | null>(null)

/** The finished reply a block sits in, set around that reply's text only: cards and the streaming bubble get no Run. */
export const RunBlockScope = createContext<{ chatId: string; messageId: string } | null>(null)
