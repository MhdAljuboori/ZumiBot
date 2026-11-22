import { useState } from 'react'
import type { ChatItem } from '@zumibot/shared/types'
import { useBrowser } from '../useAgentBrowser'
import { useDesktop } from '../useAgentDesktop'
import { errorMessage } from '../errors'
import { BrowserPanel } from './BrowserPanel'
import { DesktopPanel } from './DesktopPanel'
const labels = {
  pending: 'Action required',
  done: 'Done — agent can continue',
  cancelled: 'Cancelled',
  expired: 'Request expired',
  interrupted: 'Request interrupted'
}
/** A handoff card: the agent asks the user to act in its browser, or on its desktop (`surface: 'desktop'`). */
export function BrowserActionCard({ item }: { item: Extract<ChatItem, { type: 'browser-action' }> }) {
  const onDesktop = item.surface === 'desktop'
  const browser = useBrowser(),
    desktop = useDesktop(),
    handoff = item.handoff
  const view = onDesktop ? desktop : browser
  const name = onDesktop ? 'Desktop' : 'Browser'
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const pending = handoff.status === 'pending'
  const target = { agent: item.agent, chatId: handoff.chatId, ...(pending ? { requestId: handoff.id } : {}) }
  const expanded = pending && view?.state.open && view.state.target?.requestId === handoff.id
  // I'm done and Cancel go over the socket's answer request: they need no open view.
  const answer = async (decision: 'done' | 'cancel'): Promise<void> => {
    if (!view || !pending || busy) return
    setBusy(true)
    setError(null)
    try {
      await view.answer(target, decision)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className={`browser-action${pending ? ' pending' : ''}`}
      data-testid="browser-action"
      data-surface={onDesktop ? 'desktop' : 'browser'}
    >
      <div className="browser-action-heading">
        <span aria-hidden="true">{onDesktop ? '▣' : '◎'}</span>
        <strong>{labels[handoff.status]}</strong>
        <span className="browser-action-site">{onDesktop ? 'Desktop' : handoff.site}</span>
      </div>
      <p>{handoff.reason}</p>
      {handoff.status === 'expired' && <p className="browser-action-hint">Ask the agent to request help again.</p>}
      {handoff.status === 'interrupted' && (
        <p className="browser-action-hint">The request ended when the session stopped. Ask the agent to continue.</p>
      )}
      <div className="browser-action-buttons">
        <button
          type="button"
          className="btn small"
          disabled={!view || busy}
          onClick={() => (expanded ? view!.close() : view!.open(target))}
        >
          {expanded ? `Close ${name}` : `Open ${name}`}
        </button>
        {pending && (
          <>
            <button type="button" className="btn small primary" disabled={busy || !view} onClick={() => void answer('done')}>
              I’m done
            </button>
            <button type="button" className="btn small ghost" disabled={busy || !view} onClick={() => void answer('cancel')}>
              Cancel
            </button>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="browser-error">
          {error}
        </p>
      )}
      {expanded && (onDesktop ? <DesktopPanel inline /> : <BrowserPanel inline />)}
    </section>
  )
}
