/**
 * Runs in every frame before page scripts. Headless Chromium paints a native <select> popup
 * outside the page, so screencast frames never show it and viewer clicks land beneath it.
 * While one opens, it becomes a customizable select, whose picker renders inside the page;
 * the page's own appearance returns once the picker closes. Serialized: keep it self-contained.
 */
export function selectPickerScript(): void {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync('::picker(select){appearance:base-select}')
  const open = (event: Event) => {
    const el = event.composedPath()[0]
    if (!event.isTrusted || !(el instanceof HTMLSelectElement) || el.multiple || el.size > 1 || el.disabled) return
    // Viewer keys arrive without keypress, so only these open a native popup.
    if (event instanceof KeyboardEvent && event.key !== 'F4' && !(event.altKey && /^Arrow(Up|Down)$/.test(event.key))) return
    // Also skips a select that is already open: its saved appearance is still pending.
    if (getComputedStyle(el).appearance === 'base-select') return
    const root = el.getRootNode() as Document | ShadowRoot
    if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
    const value = el.style.getPropertyValue('appearance'),
      priority = el.style.getPropertyPriority('appearance')
    el.style.setProperty('appearance', 'base-select', 'important')
    // Changing appearance closes an open picker, so wait until it closes on its own.
    const restore = () => {
      if (el.matches(':open')) {
        setTimeout(restore, 100)
        return
      }
      if (value) el.style.setProperty('appearance', value, priority)
      else el.style.removeProperty('appearance')
      if (!el.getAttribute('style')) el.removeAttribute('style')
    }
    setTimeout(restore)
  }
  addEventListener('mousedown', open, true)
  addEventListener('keydown', open, true)
}
