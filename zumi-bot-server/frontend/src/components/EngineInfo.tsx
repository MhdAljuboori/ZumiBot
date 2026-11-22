import { useCallback, useRef, useState, type CSSProperties } from 'react'
import { useDismiss } from '../useDismiss'
import { useFitInViewport } from '../useFitInViewport'

/**
 * A small "i" beside the chat's agent (or a room's members): what its engine can't do, since those buttons are simply absent.
 * A real button, so a keyboard or a touch screen reaches it, and it opens the sentence (the title and aria-label carry it too).
 * Nothing renders when the engine lacks nothing. With a `label` the button shows that text instead of the "i" (the remote chip).
 */
export function EngineInfo({ text, label, testId = 'engine-info' }: { text: string | undefined; label?: string; testId?: string }) {
  const [menu, setMenu] = useState<CSSProperties | null>(null)
  const close = useCallback(() => setMenu(null), [])
  useDismiss(menu !== null, close)
  const ref = useRef<HTMLDivElement>(null)
  useFitInViewport(ref, menu)
  if (text === undefined) return null
  return (
    <>
      <button
        type="button"
        className={['picker set engine-info', label !== undefined && 'labelled', menu && 'open'].filter(Boolean).join(' ')}
        data-testid={testId}
        aria-label={label === undefined ? text : `${label}. ${text}`}
        aria-expanded={menu !== null}
        data-tip={text}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          // Opens upward: the pickers sit at the bottom of the window.
          setMenu(menu ? null : { left: r.left, bottom: window.innerHeight - r.top + 4 })
        }}
      >
        {label !== undefined ? (
          <span className="picker-text">{label}</span>
        ) : (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 7.25v3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="8" cy="5" r="0.9" fill="currentColor" />
          </svg>
        )}
      </button>
      {menu && (
        <div
          ref={ref}
          className="menu picker-menu engine-info-text"
          role="status"
          data-testid={`${testId}-text`}
          style={menu}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {text}
        </div>
      )}
    </>
  )
}
