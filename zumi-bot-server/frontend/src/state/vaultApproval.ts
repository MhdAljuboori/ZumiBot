import type { ChatItem } from '@zumibot/shared/types'
import { mentionLabel } from './agentNames'

type Card = Extract<ChatItem, { type: 'vault-approval' }>

const OUTCOME = { denied: 'Denied', interrupted: 'Interrupted' } as const

/** What a vault approval card says: who wants which item on which site, and, once answered, how it ended. */
export function vaultCardView(item: Card): {
  agent: string
  what: string
  site: string
  frame: string | null
  actionable: boolean
  outcome: string | null
} {
  const r = item.request
  return {
    agent: mentionLabel(item.agent),
    what: `${r.itemName} (${r.label})`,
    site: r.site,
    // Only a card form from another host needs saying: the user should see it is not the page itself.
    frame: r.frameSite !== r.site ? r.frameSite : null,
    actionable: r.status === 'pending',
    outcome: r.status === 'pending' ? null : r.status === 'allowed' ? `Allowed — remembered for ${r.site}` : OUTCOME[r.status]
  }
}

/** How many vault cards wait for the user; they count as waiting like an approval card. */
export const vaultPending = (items: readonly ChatItem[]): number =>
  items.filter((i) => i.type === 'vault-approval' && i.request.status === 'pending').length
