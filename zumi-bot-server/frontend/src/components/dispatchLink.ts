import { createContext } from 'react'

/** Lets an Agent row in the chat open its subagent in the Dispatched agents panel. */
export interface DispatchLink {
  state(toolId: string): 'running' | 'ended' | null
  open(toolId: string): void
}

export const DispatchLinkContext = createContext<DispatchLink>({ state: () => null, open: () => {} })
