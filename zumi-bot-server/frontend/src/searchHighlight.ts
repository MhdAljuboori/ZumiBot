import { matchRanges, parseQuery } from '@zumibot/shared/search'

/** The CSS highlight a search jump lights its message's words with (`::highlight(search-hit)` in styles/sidebar.css). */
const NAME = 'search-hit'

// The CSS Custom Highlight API marks text without touching the DOM React owns; a browser without it just shows no marks.
interface HighlightRegistry {
  set(name: string, h: unknown): void
  delete(name: string): void
}
const registry = (): HighlightRegistry | null => {
  const reg = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights
  return reg && typeof (globalThis as { Highlight?: unknown }).Highlight === 'function' ? reg : null
}

/** Lights the query's words in `root`'s text, as the server matched them (one text node at a time). */
export function highlightSearch(root: Element, query: string): void {
  const reg = registry()
  const q = parseQuery(query)
  if (!reg || !q) return
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const [start, end] of matchRanges(node.nodeValue ?? '', q)) {
      const r = document.createRange()
      r.setStart(node, start)
      r.setEnd(node, end)
      ranges.push(r)
    }
  }
  const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight
  if (ranges.length > 0) reg.set(NAME, new H(...ranges))
  else reg.delete(NAME)
}

export function clearSearchHighlight(): void {
  registry()?.delete(NAME)
}
