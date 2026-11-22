import type { Root } from 'mdast'
import { guardInlineMath, type MathGuardNode } from '@zumibot/shared/mathGuard'

/** Remark plugin, after remark-math: a `$…$` pair that reads like prices ("$5 and $10") goes back to text. */
export function remarkMathGuard() {
  return (tree: Root, file: { value: unknown }): void => guardInlineMath(tree as unknown as MathGuardNode, String(file.value))
}
