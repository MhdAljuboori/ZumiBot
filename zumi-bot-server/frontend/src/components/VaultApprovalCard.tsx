import { useState } from 'react'
import type { ChatItem } from '@zumibot/shared/types'
import { api } from '../api'
import { errorMessage } from '../errors'
import { vaultCardView } from '../state/vaultApproval'

/** An agent's first use of a vault card on a site: Allow remembers the page and frame host, Deny remembers nothing. */
export function VaultApprovalCard({ item }: { item: Extract<ChatItem, { type: 'vault-approval' }> }) {
  const view = vaultCardView(item)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const answer = async (decision: 'allow' | 'deny'): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.vault.answer(item.request.chatId, item.request.id, decision)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className={`vault-approval${view.actionable ? ' pending' : ''}`}
      data-testid="vault-approval"
      data-status={item.request.status}
      data-request-id={item.request.id}
      aria-label={`Vault approval: ${view.what} on ${view.site}`}
    >
      <p>
        <strong>{view.agent}</strong> wants to use <strong>{view.what}</strong> on <strong>{view.site}</strong>
        {view.frame && <span className="vault-approval-frame"> · card form from {view.frame}</span>}
      </p>
      {view.actionable && (
        <div className="vault-approval-buttons">
          <button type="button" className="btn small primary" disabled={busy} onClick={() => void answer('allow')}>
            Allow
          </button>
          <button type="button" className="btn small ghost" disabled={busy} onClick={() => void answer('deny')}>
            Deny
          </button>
        </div>
      )}
      {/* In the page from the start, empty while the card waits, so the outcome is announced when it lands. */}
      <p className="vault-approval-outcome" data-testid="vault-approval-outcome" aria-live="polite">
        {view.outcome}
      </p>
      {error && (
        <p role="alert" className="browser-error">
          {error}
        </p>
      )}
    </section>
  )
}
