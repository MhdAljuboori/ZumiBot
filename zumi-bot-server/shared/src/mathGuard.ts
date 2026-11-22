/** Just the mdast shape the guard reads, so shared needs no mdast types. */
export interface MathGuardNode {
  type: string
  value?: string
  children?: MathGuardNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

/** Pandoc's rule for single-$ math: no space inside either $, and no digit right after the closing one. */
function isProse(raw: string, next: string | undefined): boolean {
  if (raw.startsWith('$$')) return false
  const inner = raw.slice(1, -1)
  return /^\s/.test(inner) || /\s$/.test(inner) || (next !== undefined && /\d/.test(next))
}

/**
 * After math parsing: a `$…$` pair that reads like prices ("$5 and $10") goes back to text, in place. The chat's
 * Markdown and the export both run it, so a reply reads the same in each.
 */
export function guardInlineMath(node: MathGuardNode, source: string): void {
  const children = node.children
  if (!children) return
  children.forEach((child, i) => {
    if (child.type === 'inlineMath') {
      const start = child.position?.start.offset
      const end = child.position?.end.offset
      if (start === undefined || end === undefined) return
      const raw = source.slice(start, end)
      // Back to the text as written; markdown inside it stays unparsed, which prices never need.
      if (isProse(raw, source[end])) children[i] = { type: 'text', value: raw }
    } else if (child.children) {
      guardInlineMath(child, source)
    }
  })
}
