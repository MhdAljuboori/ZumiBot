import { useCallback, useEffect, useRef, useState } from 'react'
import type { UsageSummary } from '@zumibot/shared/usageReport'
import { api } from '../api'
import { chipTotalLabel, costLabel, formatTokens, formatUsd } from '../state/usageReport'
import { useConnected } from '../useConnected'
import { useDismiss } from '../useDismiss'
import { useFitInViewport } from '../useFitInViewport'

const zone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The chat's running cost in the pickers row; opens a breakdown. Hidden until the chat has any recorded usage. */
export function CostChip({
  chatId,
  room = false,
  onOpenUsage
}: {
  chatId: string
  /** A room also lists each agent's share. */ room?: boolean
  onOpenUsage: () => void
}) {
  const [sum, setSum] = useState<UsageSummary | null>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const close = useCallback(() => setPos(null), [])
  useDismiss(pos !== null, close)
  const popRef = useRef<HTMLDivElement>(null)
  useFitInViewport(popRef, pos)

  // Another chat starts from nothing; a reconnect asks again over the shown total.
  useEffect(() => setSum(null), [chatId])
  const connected = useConnected()
  useEffect(() => {
    if (!connected) return
    let live = true
    let seq = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (): void => {
      const mine = ++seq // a slow older answer must not overwrite a newer one
      api.usage.query({ from: null, to: null, agent: null, chatId, timeZone: zone() }).then(
        (s) => {
          if (live && mine === seq) setSum(s)
        },
        () => {}
      )
    }
    load()
    // Recording a reply can fire in bursts; one refetch after they settle.
    const off = api.usage.onChanged((id) => {
      if (id !== null && id !== chatId) return
      clearTimeout(timer)
      timer = setTimeout(load, 500)
    })
    return () => {
      live = false
      clearTimeout(timer)
      off()
    }
  }, [chatId, connected])

  if (sum === null || sum.byModel.length === 0) return null
  const t = sum.tokens
  const boxes: [string, number][] = [
    ['Input', t.input],
    ['Output', t.output],
    ['Cache read', t.cacheRead],
    ['Cache write', t.cacheWrite]
  ]
  return (
    <>
      <button
        type="button"
        className={pos ? 'picker set cost-chip open' : 'picker set cost-chip'}
        data-testid="cost-chip"
        aria-haspopup="dialog"
        aria-expanded={pos !== null}
        data-tip="Cost of this chat (API estimate)"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (pos) return close()
          const r = e.currentTarget.getBoundingClientRect()
          setPos({ left: r.left, bottom: window.innerHeight - r.top + 4 })
        }}
      >
        <span className="picker-text">{chipTotalLabel(sum)}</span>
      </button>
      {pos && (
        <div
          ref={popRef}
          className="menu cost-pop"
          role="dialog"
          aria-label="Chat cost"
          data-testid="cost-pop"
          style={{ left: pos.left, bottom: pos.bottom }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="cost-pop-label">This chat</div>
          <div className="cost-pop-total">{chipTotalLabel(sum)}</div>
          <div className="cost-pop-sub">
            {sum.userMessages} {sum.userMessages === 1 ? 'message' : 'messages'}
            {sum.estimatedUsd > 0 && ` · ${formatUsd(sum.estimatedUsd)} estimated`} · API estimate · USD
          </div>
          <div className="cost-pop-grid">
            {boxes.map(([label, n]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{formatTokens(n)}</strong>
              </div>
            ))}
          </div>
          <table className="cost-pop-rows">
            <tbody>
              {sum.byModel.map((r) => (
                <tr key={r.key}>
                  <td>
                    {r.label}
                    {r.estimated && <span className="usg-tag">est.</span>}
                    {r.unpriced && <span className="usg-tag">unpriced</span>}
                  </td>
                  <td>{costLabel(r.costUsd, r.unpriced)}</td>
                </tr>
              ))}
              {room && sum.byAgent.length > 0 && (
                <tr className="cost-pop-head">
                  <td colSpan={2}>By agent</td>
                </tr>
              )}
              {room &&
                sum.byAgent.map((r) => (
                  <tr key={'a' + r.key}>
                    <td>
                      {r.label}
                      {r.estimated && <span className="usg-tag">est.</span>}
                      {r.unpriced && <span className="usg-tag">unpriced</span>}
                    </td>
                    <td>{costLabel(r.costUsd, r.unpriced)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <button
            type="button"
            className="cost-pop-link"
            data-testid="cost-open-usage"
            onClick={() => {
              close()
              onOpenUsage()
            }}
          >
            Open in Usage →
          </button>
        </div>
      )}
    </>
  )
}
