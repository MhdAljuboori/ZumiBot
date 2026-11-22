import type { BrowserVault } from '../browser/browserManager'
import type { VaultApprovals } from './vaultApprovals'
import type { VaultStore } from './vaultStore'

/**
 * What the browser manager reads of the vault for a fill. An approval asks under the browser owner's turn id: ChatService
 * registered the card callback under the id it gave the browser turn. One card per browser at a time; a second is told so
 * (`pending`), and a turn with no card callback gets `unavailable`, rather than either being read as the user's Deny.
 */
export function browserVaultOf(
  vault: Pick<VaultStore, 'get' | 'status' | 'addApproval' | 'secrets'>,
  approvals: Pick<VaultApprovals, 'request'>
): BrowserVault {
  return {
    item: (id) => vault.get(id),
    status: () => vault.status(),
    addApproval: (id, site, frameSite) => vault.addApproval(id, site, frameSite),
    approve: ({ owner, ...o }, signal) =>
      approvals.request({ ...o, chatId: owner.chatId, turnId: owner.turnId, profileId: owner.profileId }, signal),
    secrets: () => vault.secrets()
  }
}
