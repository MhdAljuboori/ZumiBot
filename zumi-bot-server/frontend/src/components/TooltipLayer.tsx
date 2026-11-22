import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { describes, placeTip, repeats, showDelay, tipNeeded } from '../state/tooltip'

const TIP_ID = 'app-tip'

type Shown = { el: Element; text: string }

/**
 * Puts the bubble beside its target. Measured at the window's corner first, so the space left of its last spot cannot
 * narrow it into more lines.
 */
function place(b: HTMLElement, target: DOMRect): void {
  b.style.left = '0px'
  b.style.top = '0px'
  const p = placeTip(
    { left: target.left, top: target.top, width: target.width, height: target.height },
    { width: b.offsetWidth, height: b.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight }
  )
  b.style.left = `${p.left}px`
  b.style.top = `${p.top}px`
  b.dataset.side = p.side
}

const moved = (a: DOMRect | null, b: DOMRect): boolean =>
  a === null || a.left !== b.left || a.top !== b.top || a.width !== b.width || a.height !== b.height

/** The element's text is cut off (an ellipsis or a line clamp), on itself or on the span inside that holds it. */
function truncated(el: Element): boolean {
  for (const n of [el, ...el.querySelectorAll('*')]) {
    if (!(n instanceof HTMLElement)) continue
    if (n.scrollWidth > n.clientWidth || n.scrollHeight > n.clientHeight) return true
  }
  return false
}

/**
 * A `title` someone else's markup still sets (React Flow's zoom buttons, a markdown link's title) becomes a `data-tip`
 * before the browser's own popup can show. A frame's title is its accessible name, not a tip.
 */
function adoptTitle(el: Element): void {
  const t = el.getAttribute('title')
  if (t === null || el instanceof HTMLIFrameElement) return
  if (!el.hasAttribute('data-tip')) el.setAttribute('data-tip', t)
  el.removeAttribute('title')
}

/** The innermost element under `from` whose tip has something to say, if any. */
function tipTarget(from: EventTarget | null): Shown | null {
  let el = from instanceof Element ? from.closest('[data-tip], [title]') : null
  while (el !== null) {
    adoptTitle(el)
    const text = el.getAttribute('data-tip')
    if (text !== null) {
      const parts = [el, ...el.querySelectorAll('*')].map((n) => n.textContent ?? '')
      const repeated = repeats(text, parts)
      // Measured only for a tip that repeats the text: it forces a layout of everything inside.
      if (tipNeeded(text, repeated, repeated && truncated(el))) return { el, text }
    }
    el = el.parentElement?.closest('[data-tip], [title]') ?? null
  }
  return null
}

/**
 * The app's one tooltip: any element with `data-tip` shows it on hover (mouse and pen) or keyboard focus. Native `title`
 * is never used (a test checks), since the browser's own popup takes no theme, font or width.
 */
export function TooltipLayer(): ReactNode {
  const [shown, setShown] = useState<Shown | null>(null)
  const bubble = useRef<HTMLDivElement>(null)
  // The target's box the bubble was last placed for: a frame where it has not moved skips the measuring.
  const placedAt = useRef<DOMRect | null>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let frame = 0
    // The element the pointer or focus is on, shown or waiting; a press keeps it here so its tip stays away until it is left.
    let candidate: Element | null = null
    let current: Shown | null = null
    let lastHiddenAt: number | null = null
    // Focus shows a tip only while the keyboard drives: a tap or click into a field, or a dialog focusing its first
    // control after a click, is not a keyboard visit.
    let byKeyboard = false
    let described: { el: Element; prior: string | null } | null = null

    const undescribe = (): void => {
      if (described === null) return
      if (described.prior === null) described.el.removeAttribute('aria-describedby')
      else described.el.setAttribute('aria-describedby', described.prior)
      described = null
    }

    const describe = (s: Shown): void => {
      undescribe()
      if (!describes(s.text, s.el.getAttribute('aria-label') ?? s.el.textContent ?? '')) return
      const prior = s.el.getAttribute('aria-describedby')
      s.el.setAttribute('aria-describedby', prior === null ? TIP_ID : `${prior} ${TIP_ID}`)
      described = { el: s.el, prior }
    }

    const hide = (keepCandidate = false): void => {
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      if (!keepCandidate) candidate = null
      if (current === null) return
      current = null
      lastHiddenAt = Date.now()
      undescribe()
      setShown(null)
    }

    // While a tip shows it follows its target: a text change (Copy → Copied) or a move updates it, and a target that
    // left the page or the screen takes the tip with it.
    const follow = (): void => {
      if (current === null) return
      const { el } = current
      const text = el.getAttribute('data-tip')
      const r = el.getBoundingClientRect()
      if (!el.isConnected || text === null || text.trim() === '' || (r.width === 0 && r.height === 0)) {
        hide()
        return
      }
      if (text !== current.text) {
        current = { el, text }
        describe(current)
        setShown(current) // the layout effect places it again
      } else if (bubble.current !== null && moved(placedAt.current, r)) {
        placedAt.current = r
        place(bubble.current, r)
      }
      frame = requestAnimationFrame(follow)
    }

    const show = (s: Shown): void => {
      current = s
      describe(s)
      setShown(s)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(follow)
    }

    const aim = (s: Shown | null): void => {
      if (s?.el === candidate) return
      clearTimeout(timer)
      if (s === null) {
        hide()
        return
      }
      const delay = showDelay(Date.now(), current !== null, lastHiddenAt)
      if (current !== null) hide(true)
      candidate = s.el
      if (delay === 0) show(s)
      else timer = setTimeout(() => show(s), delay)
    }

    const onOver = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return
      aim(tipTarget(e.target))
    }
    const onOut = (e: PointerEvent): void => {
      if (e.relatedTarget === null) hide()
    }
    const onDown = (e: PointerEvent): void => {
      byKeyboard = false
      hide(e.pointerType !== 'touch')
    }
    const onFocusIn = (e: FocusEvent): void => {
      const el = e.target
      if (!byKeyboard || !(el instanceof Element) || !el.matches(':focus-visible')) return
      aim(tipTarget(el))
    }
    const onFocusOut = (e: FocusEvent): void => {
      if (e.target instanceof Node && candidate !== null && e.target.contains(candidate)) hide()
    }
    const onKey = (e: KeyboardEvent): void => {
      byKeyboard = true
      if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') hide()
    }
    // Only a scroll that moves the tip's target: a streaming reply scrolling the thread leaves a toolbar's tip alone.
    const onScroll = (e: Event): void => {
      const t = e.target
      if (current !== null && (t === document || (t instanceof Node && t.contains(current.el)))) hide()
    }
    const onBlur = (): void => hide()

    const opts = { capture: true, passive: true }
    document.addEventListener('pointerover', onOver, opts)
    document.addEventListener('pointerout', onOut, opts)
    document.addEventListener('pointerdown', onDown, opts)
    document.addEventListener('focusin', onFocusIn, opts)
    document.addEventListener('focusout', onFocusOut, opts)
    document.addEventListener('keydown', onKey, opts)
    document.addEventListener('scroll', onScroll, opts)
    window.addEventListener('resize', onBlur)
    window.addEventListener('blur', onBlur)
    return () => {
      hide()
      document.removeEventListener('pointerover', onOver, opts)
      document.removeEventListener('pointerout', onOut, opts)
      document.removeEventListener('pointerdown', onDown, opts)
      document.removeEventListener('focusin', onFocusIn, opts)
      document.removeEventListener('focusout', onFocusOut, opts)
      document.removeEventListener('keydown', onKey, opts)
      document.removeEventListener('scroll', onScroll, opts)
      window.removeEventListener('resize', onBlur)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useLayoutEffect(() => {
    if (bubble.current === null || shown === null) return
    const r = shown.el.getBoundingClientRect()
    placedAt.current = r
    place(bubble.current, r)
  }, [shown])

  if (shown === null) return null
  return createPortal(
    <div ref={bubble} id={TIP_ID} className="app-tip" role="tooltip" data-testid="app-tip">
      {shown.text}
    </div>,
    document.body
  )
}
