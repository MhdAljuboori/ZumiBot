import { useEffect, useState } from 'react'
import type { Highlight } from './state/syntax'

let loaded: Highlight | null = null
let loading: Promise<Highlight> | null = null

function load(): Promise<Highlight> {
  loading ??= import('./syntaxEngine').then((m) => (loaded = m.highlightLines))
  // A failed chunk load (offline) may be retried by the next view that wants colours.
  loading.catch(() => {
    loading = null
  })
  return loading
}

/** The syntax highlighter once its chunk has loaded (null until then, and while `want` is false); rows draw plain meanwhile. */
export function useHighlighter(want: boolean): Highlight | null {
  const [hl, setHl] = useState<Highlight | null>(loaded)
  useEffect(() => {
    if (!want || hl) return
    let live = true
    load().then(
      (f) => {
        if (live) setHl(() => f)
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [want, hl])
  return want ? hl : null
}
