import { createElement, type ComponentProps } from 'react'
import type { Components, Options } from 'react-markdown'

/**
 * Item text from an agent is one line: links, emphasis and code stay, and everything else (headings, lists, quotes,
 * tables, raw html) is unwrapped to its text. Images become their alt text, so nothing loads from a remote address.
 * The allow-list is the safety rule; links keep react-markdown's own URL sanitising.
 */
export const INLINE_ELEMENTS = ['p', 'a', 'em', 'strong', 'del', 'code', 'img']

/** The pieces `Markdown`'s inline mode and the tests share (the caller adds its own link component). */
export const inlineMarkdownProps: Pick<Options, 'allowedElements' | 'unwrapDisallowed' | 'components'> = {
  allowedElements: INLINE_ELEMENTS,
  unwrapDisallowed: true,
  components: {
    // The text is one line, so a paragraph is only a wrapper: a span keeps it in the row.
    p: ({ node: _node, ...props }: ComponentProps<'p'> & { node?: unknown }) => createElement('span', props),
    img: ({ alt }: { alt?: string }) => alt ?? null
  } as Components
}
