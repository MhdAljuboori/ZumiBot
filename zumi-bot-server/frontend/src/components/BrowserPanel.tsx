import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { browserKeyCode, type BrowserModifier } from '@zumibot/shared/browser'
import { displayName } from '@zumibot/shared/frontmatter'
import {
  BROWSER_INPUT_MAX,
  BROWSER_INPUT_PAD,
  BROWSER_LONG_PRESS_MS,
  browserImeKey,
  browserKeyText,
  browserPasteShortcut,
  browserPoint,
  browserScale,
  browserTyping,
  createBrowserTouch,
  nextClickCount,
  type BrowserClick,
  type BrowserTouchAction
} from '../state/browserView'
import { BrowserFiles } from './BrowserFiles'
import { SideBackButton } from './SidePanelMenu'
import { useBrowser } from '../useAgentBrowser'

/** `onBack` (the side panel over a chat) adds a way back to the panel's list; the browser stays open behind it. */
export function BrowserPanel({ inline = false, onBack }: { inline?: boolean; onBack?: () => void }) {
  const browser = useBrowser()
  const [url, setUrl] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // What the page input held after the last edit sent to the page.
  const typed = useRef(BROWSER_INPUT_PAD)
  /** Back to the padding, caret at the end. Only while no keyboard is up, or rarely: it restarts a phone keyboard. */
  const refill = (el: HTMLTextAreaElement): void => {
    if (el.value !== BROWSER_INPUT_PAD) el.value = BROWSER_INPUT_PAD
    el.setSelectionRange(BROWSER_INPUT_PAD.length, BROWSER_INPUT_PAD.length)
    typed.current = BROWSER_INPUT_PAD
  }
  const lastMove = useRef(0),
    lastWheel = useRef(0)
  const lastPoint = useRef<{ x: number; y: number } | null>(null)
  const held = useRef(new Map<string, { key: string; code: string; modifiers: BrowserModifier[] }>())
  const surfaceRef = useRef<HTMLDivElement>(null)
  const touch = useRef(createBrowserTouch())
  const longPress = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastClick = useRef<BrowserClick | null>(null),
    pressCount = useRef(1)
  const scroll = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null)
  const [pasting, setPasting] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const state = browser?.state,
    status = state?.status
  const tab = status?.tabs.find((t) => t.id === status.activeTabId)
  const resize = browser?.resize
  const open = !!state?.open,
    expanded = !!state?.expanded
  useEffect(() => {
    setUrl(tab?.url ?? '')
  }, [tab?.url])
  useEffect(() => {
    held.current.clear()
    touch.current.cancel()
    clearTimeout(longPress.current)
    scroll.current = null
    lastClick.current = null
    const el = inputRef.current
    // Rewriting a focused input restarts a phone keyboard, so it only starts counting from what is there.
    if (el && document.activeElement === el) typed.current = el.value
    else if (el) refill(el)
  }, [state?.epoch, state?.control])
  useEffect(() => {
    if (!state?.control) {
      setPasting(false)
      setPasteText('')
    }
  }, [state?.control])
  // The page is sized to this surface, so its pixels map 1:1 to the screen's. Expanding moves the panel to the body,
  // a new surface element, so it is observed again.
  const resizeRef = useRef(resize)
  resizeRef.current = resize
  useEffect(() => {
    const el = surfaceRef.current
    if (!open || !el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const report = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) resizeRef.current?.(r.width, r.height, window.devicePixelRatio || 1)
    }
    // Settle first: a drag of the panel's edge or a keyboard sliding in fires many sizes.
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(report, 150)
    })
    observer.observe(el)
    report()
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [open, expanded])
  useEffect(() => () => clearTimeout(longPress.current), [])
  if (!browser || !state?.open) return null
  const owned = state.control && status?.control === 'you'
  const ready = status?.state === 'ready' && !!status.activeTabId
  const label =
    state.controlPending || status?.control === 'pausing'
      ? 'Pausing agent…'
      : owned
        ? 'You have control'
        : status?.control === 'other'
          ? 'Controlled in another window'
          : 'View only'
  const key = (e: ReactKeyboardEvent<HTMLTextAreaElement>, down: boolean): void => {
    // Tab/Escape leave the surface; the desktop's server-switch shortcut remains an app action.
    if (e.key === 'Tab' || e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyS')) {
      if (e.key === 'Escape') {
        e.currentTarget.blur()
        e.stopPropagation()
      }
      return
    }
    e.stopPropagation()
    if (!owned) return
    // Let the client clipboard's paste event provide text; never send a remote paste shortcut.
    if (browserPasteShortcut(e.nativeEvent)) return
    const modifiers: BrowserModifier[] = []
    if (e.altKey) modifiers.push('Alt')
    if (e.ctrlKey) modifiers.push('Control')
    if (e.metaKey) modifiers.push('Meta')
    if (e.shiftKey) modifiers.push('Shift')
    if (browserImeKey(e.nativeEvent)) return
    const raw = { key: e.key, code: browserKeyCode(e.key, e.code), modifiers }
    browser.input({ type: down ? 'keyDown' : 'keyUp', ...raw })
    if (down) held.current.set(raw.code, raw)
    else held.current.delete(raw.code)
    // Printable keys go through textarea input, which also supports mobile keyboards and IME.
    if (browserKeyText(e.nativeEvent) === null) e.preventDefault()
  }
  const at = (x: number, y: number, el: HTMLElement) =>
    browser.size ? browserPoint(x, y, el.getBoundingClientRect(), browser.size.width, browser.size.height) : null
  const pointer = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }) => at(e.clientX, e.clientY, e.currentTarget)
  const button = (e: ReactPointerEvent) => (e.button === 2 ? ('right' as const) : e.button === 1 ? ('middle' as const) : ('left' as const))
  const flushScroll = (): void => {
    const s = scroll.current
    scroll.current = null
    lastWheel.current = performance.now()
    const clamp = (v: number) => Math.max(-10000, Math.min(10000, v))
    if (s && (s.dx || s.dy)) browser.input({ type: 'wheel', x: s.x, y: s.y, deltaX: clamp(s.dx), deltaY: clamp(s.dy) })
  }
  const touchActions = (el: HTMLElement, actions: BrowserTouchAction[]): void => {
    for (const a of actions) {
      const p = at(a.x, a.y, el) ?? (a.type === 'drag' || a.type === 'release' ? lastPoint.current : null)
      if (!p) continue
      if (a.type === 'click') {
        browser.input({ type: 'mouseMove', ...p })
        browser.input({ type: 'mouseDown', ...p, button: 'left', clickCount: a.count })
        browser.input({ type: 'mouseUp', ...p, button: 'left', clickCount: a.count })
      } else if (a.type === 'press') {
        lastPoint.current = p
        browser.input({ type: 'mouseMove', ...p })
        browser.input({ type: 'mouseDown', ...p, button: 'left' })
      } else if (a.type === 'drag') {
        const now = performance.now()
        if (now - lastMove.current >= 40) {
          lastMove.current = now
          lastPoint.current = p
          browser.input({ type: 'mouseMove', ...p })
        }
      } else if (a.type === 'release') browser.input({ type: 'mouseUp', ...p, button: 'left' })
      else if (a.type === 'scroll') {
        const k = browser.size ? browserScale(el.getBoundingClientRect(), browser.size.width, browser.size.height) : 1
        const s = scroll.current ?? { ...p, dx: 0, dy: 0 }
        s.dx += a.dx / k
        s.dy += a.dy / k
        scroll.current = s
        if (performance.now() - lastWheel.current >= 32) flushScroll()
      }
    }
  }
  const showKeyboard = (): void => {
    const el = inputRef.current
    if (el && document.activeElement !== el) el.focus()
  }
  const sendText = (text: string): void => {
    if (owned && text) browser.input({ type: 'text', text: text.slice(0, 16384) })
  }
  const paste = async (): Promise<void> => {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      /* Denied or unsupported: the box below takes a native paste. */
    }
    if (text) sendText(text)
    else setPasting(true)
  }
  const blank = tab?.url === 'about:blank'
  const panel = (
    <section
      className={`browser-panel${inline ? ' inline' : ''}${expanded ? ' expanded' : ''}`}
      aria-label={`${displayName(state.target?.agent ?? '')} browser`}
      data-testid="browser-panel"
    >
      <header className="browser-header">
        <span className="side-head-title">
          {onBack && <SideBackButton onBack={onBack} />}
          <span className="browser-title">
            Browser <span>· {displayName(state.target?.agent ?? '')}</span>
          </span>
        </span>
        <div className="browser-header-actions">
          <button
            className="icon-btn"
            type="button"
            aria-label={state.expanded ? 'Restore browser size' : 'Expand browser'}
            onClick={() => browser.expand(!state.expanded)}
          >
            {state.expanded ? '↙' : '↗'}
          </button>
          <button className="icon-btn" type="button" aria-label="Close browser" onClick={browser.close}>
            ✕
          </button>
        </div>
      </header>
      {status && status.tabs.length > 0 && (
        <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
          {status.tabs.map((t) => (
            <div className="browser-tab" key={t.id}>
              <button
                type="button"
                role="tab"
                aria-selected={t.id === status.activeTabId}
                disabled={!owned}
                data-tip={t.url}
                onClick={() => browser.navigate({ op: 'selectTab', tabId: t.id })}
              >
                {t.title || (t.url === 'about:blank' ? 'New tab' : t.url)}
              </button>
              {owned && status.tabs.length > 1 && (
                <button
                  type="button"
                  aria-label={`Close ${t.title || 'tab'}`}
                  onClick={() => browser.navigate({ op: 'closeTab', tabId: t.id })}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button
            className="icon-btn"
            type="button"
            aria-label="New tab"
            disabled={!owned}
            onClick={() => browser.navigate({ op: 'newTab' })}
          >
            +
          </button>
        </div>
      )}
      <form
        className="browser-navigation"
        onSubmit={(e) => {
          e.preventDefault()
          if (url.trim())
            browser.navigate({ op: 'navigate', url: /^https?:\/\/|^about:blank$/.test(url.trim()) ? url.trim() : `https://${url.trim()}` })
        }}
      >
        <button type="button" className="icon-btn" aria-label="Back" disabled={!owned} onClick={() => browser.navigate({ op: 'back' })}>
          ←
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Forward"
          disabled={!owned}
          onClick={() => browser.navigate({ op: 'forward' })}
        >
          →
        </button>
        <button type="button" className="icon-btn" aria-label="Reload" disabled={!owned} onClick={() => browser.navigate({ op: 'reload' })}>
          ↻
        </button>
        <input aria-label="Browser URL" value={url} placeholder="Enter a URL" readOnly={!owned} onChange={(e) => setUrl(e.target.value)} />
        <button type="submit" className="btn small" disabled={!owned}>
          Go
        </button>
      </form>
      <div className="browser-control">
        <label className="browser-switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="Take control"
            checked={!!owned || state.controlPending}
            disabled={!ready || status?.control === 'other' || state.controlPending}
            onChange={(e) => void browser.takeControl(e.target.checked)}
          />
          <span>Take control</span>
        </label>
        <span className="browser-control-actions">
          {/* A phone has no Ctrl+V and its long-press menu would cover the page, so paste is a button. */}
          <button type="button" className="btn small" disabled={!owned} onClick={() => void paste()}>
            Paste
          </button>
          <button
            type="button"
            className="btn small browser-keyboard"
            disabled={!owned}
            onClick={() => {
              inputRef.current?.blur()
              inputRef.current?.focus()
            }}
          >
            Keyboard
          </button>
          <span role="status" className={owned ? 'browser-owner active' : 'browser-owner'}>
            {label}
          </span>
        </span>
      </div>
      {pasting && owned && (
        <form
          className="browser-paste"
          onSubmit={(e) => {
            e.preventDefault()
            sendText(pasteText)
            setPasteText('')
            setPasting(false)
          }}
        >
          <input
            aria-label="Text for the page"
            value={pasteText}
            autoFocus
            placeholder="Paste or type text, then Send"
            onChange={(e) => setPasteText(e.target.value)}
          />
          <button type="submit" className="btn small" disabled={!pasteText}>
            Send
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setPasteText('')
              setPasting(false)
            }}
          >
            Cancel
          </button>
        </form>
      )}
      <BrowserFiles />
      {state.error && (
        <div className="browser-error" role="alert">
          {state.error}{' '}
          <button type="button" className="btn small" onClick={browser.retry}>
            Retry
          </button>
        </div>
      )}
      {!ready && !state.error && (
        <div className="browser-notice" role="status">
          {status?.state === 'queued'
            ? 'Waiting for browser capacity…'
            : status?.state === 'unavailable'
              ? 'Browser runtime unavailable. Check the server’s browser setup.'
              : status?.state === 'stopped' || status?.state === 'closing'
                ? 'Browser closed. Open it again to start a fresh view.'
                : 'Connecting to browser…'}
        </div>
      )}
      {blank && browser.reopenOrigin && (
        <div className="browser-reopen">
          Last site: <span>{browser.reopenOrigin}</span>
          <button
            type="button"
            className="btn small"
            disabled={!owned}
            onClick={() => browser.navigate({ op: 'navigate', url: browser.reopenOrigin! })}
          >
            Open last site
          </button>
        </div>
      )}
      <div className="browser-surface" data-testid="browser-surface" ref={surfaceRef}>
        <canvas ref={browser.canvasRef} aria-label="Live browser page" />
        {!browser.size && <div className="browser-empty">{ready ? 'Waiting for live page…' : 'No live page'}</div>}
        <textarea
          ref={inputRef}
          className="browser-input"
          aria-label="Browser page input"
          aria-description="Take control to interact. Tab leaves the page. Escape releases keyboard focus."
          readOnly={!owned}
          defaultValue={BROWSER_INPUT_PAD}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onKeyDown={(e) => key(e, true)}
          onKeyUp={(e) => key(e, false)}
          onFocus={(e) => {
            // Before the keyboard comes up, so no keyboard sees the field rewritten.
            refill(e.currentTarget)
          }}
          onInput={(e) => {
            // Every change, composing or not, goes to the page as it happens: a phone keyboard composes whole words,
            // and a tap on another field must not carry a half-typed word there.
            const el = e.currentTarget,
              value = el.value
            if (owned) for (const input of browserTyping(typed.current, value)) browser.input(input)
            typed.current = value
            if (value.length > BROWSER_INPUT_MAX && !(e.nativeEvent as InputEvent).isComposing) refill(el)
          }}
          onPaste={(e) => {
            e.preventDefault()
            const text = e.clipboardData.getData('text/plain')
            if (owned && text) browser.input({ type: 'text', text: text.slice(0, 16384) })
          }}
          onBlur={(e) => {
            for (const raw of held.current.values()) browser.input({ type: 'keyUp', ...raw })
            held.current.clear()
            refill(e.currentTarget)
          }}
          onPointerDown={(e) => {
            if (!owned) return
            e.preventDefault()
            if (e.pointerType === 'touch') {
              // A second finger is ignored; the focus (and phone keyboard) waits for a tap, so a scroll never opens it.
              if (!e.isPrimary) return
              const el = e.currentTarget
              touch.current.down(e.clientX, e.clientY)
              clearTimeout(longPress.current)
              longPress.current = setTimeout(() => touchActions(el, touch.current.longPress()), BROWSER_LONG_PRESS_MS)
              return
            }
            e.currentTarget.focus()
            const p = pointer(e)
            if (p) {
              const now = performance.now(),
                b = button(e),
                count = nextClickCount(lastClick.current, e.clientX, e.clientY, now, b)
              lastClick.current = { x: e.clientX, y: e.clientY, t: now, button: b, count }
              pressCount.current = count
              lastPoint.current = p
              e.currentTarget.setPointerCapture(e.pointerId)
              browser.input({ type: 'mouseDown', ...p, button: b, clickCount: count })
            }
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'touch') {
              if (!e.isPrimary || !owned) return
              clearTimeout(longPress.current)
              const actions = touch.current.up(e.clientX, e.clientY, performance.now())
              touchActions(e.currentTarget, actions)
              flushScroll()
              if (actions.some((a) => a.type === 'click')) showKeyboard()
              return
            }
            const p = pointer(e) ?? lastPoint.current
            if (p && owned) browser.input({ type: 'mouseUp', ...p, button: button(e), clickCount: pressCount.current })
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
          }}
          onPointerCancel={(e) => {
            if (e.pointerType === 'touch') {
              clearTimeout(longPress.current)
              if (owned) touchActions(e.currentTarget, touch.current.cancel())
              return
            }
            if (lastPoint.current && owned) browser.input({ type: 'mouseUp', ...lastPoint.current, button: 'left' })
          }}
          onPointerMove={(e) => {
            if (e.pointerType === 'touch') {
              if (!e.isPrimary || !owned) return
              const actions = touch.current.move(e.clientX, e.clientY)
              if (touch.current.mode !== 'pending') clearTimeout(longPress.current)
              touchActions(e.currentTarget, actions)
              return
            }
            const p = pointer(e),
              now = performance.now()
            if (p && owned && now - lastMove.current >= 40) {
              lastMove.current = now
              lastPoint.current = p
              browser.input({ type: 'mouseMove', ...p })
            }
          }}
          onWheel={(e) => {
            const p = pointer(e),
              now = performance.now()
            if (p && owned && now - lastWheel.current >= 40) {
              lastWheel.current = now
              e.stopPropagation()
              browser.input({
                type: 'wheel',
                ...p,
                deltaX: Math.max(-10000, Math.min(10000, e.deltaX)),
                deltaY: Math.max(-10000, Math.min(10000, e.deltaY))
              })
            }
          }}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
      <footer className="browser-footer">
        <span className={`browser-dot${ready ? ' live' : ''}`} />
        {ready ? 'Live browser' : (status?.state ?? 'Connecting')}
        <span>{owned ? 'Tab to leave page · Esc to unfocus' : 'Take control to use the page'}</span>
      </footer>
    </section>
  )
  // The thread's edge fade is a mask, and a mask clips and stacks even fixed descendants inside it: drawn in a handoff
  // card, the expanded panel would sit under the sidebar, chat head and composer with Restore out of reach.
  return expanded ? createPortal(panel, document.body) : panel
}
