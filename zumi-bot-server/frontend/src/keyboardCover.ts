/** Less than this much of the page hidden is not a keyboard (rounding, a thin bar). */
const MIN_COVER = 80

export interface ViewportSize {
  /** The layout viewport's height (`window.innerHeight`). */
  innerHeight: number
  /** `window.visualViewport`: the part of the page on screen. */
  height: number
  offsetTop: number
  scale: number
}

/**
 * The part of the page left on screen when an on-screen keyboard covers its bottom instead of shrinking it, or null
 * when the page fits what is shown. Chrome on Android drawing edge to edge (`viewport-fit=cover`) ignores
 * `interactive-widget=resizes-content`: the page keeps the whole screen's height and the browser pans to the caret, so
 * the top bar and the composer's bottom leave the screen. Where the keyboard does shrink the page, both heights shrink
 * together and this is null. A pinch zoom also shows less than the page, so a zoomed view is left alone.
 */
export function keyboardCover(v: ViewportSize): { top: number; height: number } | null {
  if (Math.abs(v.scale - 1) > 0.01) return null
  if (v.innerHeight - v.height < MIN_COVER) return null
  return { top: Math.round(v.offsetTop), height: Math.round(v.height) }
}

type Win = Pick<Window, 'innerHeight'> & { visualViewport: (EventTarget & Omit<ViewportSize, 'innerHeight'>) | null }

/**
 * Keeps the app inside the part of the page left on screen while a keyboard covers the rest: `kb-cover` on the root
 * element with `--vv-top` and `--vv-height`, which styles/base.css turns into a fixed `#root` over that part. Updated on
 * every resize and pan of the visual viewport, in the same frame, so the app moves with a pan instead of after it.
 */
export function followKeyboardCover(win: Win = window, root: HTMLElement = document.documentElement): () => void {
  const vv = win.visualViewport
  if (!vv) return () => {}
  let shown: string | null = null
  const update = (): void => {
    const box = keyboardCover({ innerHeight: win.innerHeight, height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale })
    const key = box && `${box.top}/${box.height}`
    if (key === shown) return
    shown = key
    if (box) {
      root.style.setProperty('--vv-top', `${box.top}px`)
      root.style.setProperty('--vv-height', `${box.height}px`)
      root.classList.add('kb-cover')
    } else {
      root.classList.remove('kb-cover')
      root.style.removeProperty('--vv-top')
      root.style.removeProperty('--vv-height')
    }
  }
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  update()
  return () => {
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
  }
}
