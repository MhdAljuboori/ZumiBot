import dockerfile from 'highlight.js/lib/languages/dockerfile'
import { common, createLowlight } from 'lowlight'
import { hastLines, type Tok } from './state/syntax'

// Loaded only through useHighlighter's dynamic import, so its grammars stay out of the main bundle.
// lowlight returns a tree, never HTML: rows are drawn as React text, so nothing in a file can become markup.
const lowlight = createLowlight(common)
lowlight.register({ dockerfile })

export function highlightLines(lang: string, text: string): Tok[][] | null {
  if (!lowlight.registered(lang)) return null
  try {
    return hastLines(lowlight.highlight(lang, text))
  } catch {
    return null // a grammar that throws on odd input: the rows stay plain
  }
}
