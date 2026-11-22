import { sandboxBlockLine, sandboxBlocks, type SandboxBlock } from '@zumibot/shared/isolation'

// The chat's line for a call the sandbox refused (governance.md 2.3, "Showing a block"). Only texts the sandbox alone writes are
// read here; "Read-only file system" is left out, since the chat cannot tell a sandboxed run from an Off one.

interface ToolLike {
  type: string
  isError?: boolean
  result?: string | null
}

const blocksOf = (t: ToolLike): SandboxBlock[] =>
  t.type === 'tool' && t.isError && typeof t.result === 'string' ? sandboxBlocks(t.result) : []

export const sandboxRowLine = (t: ToolLike): string | null => sandboxBlockLine(blocksOf(t))

/** One line for a folded run of calls: every target the sandbox refused in it, once each. */
export function sandboxRunLine(tools: readonly ToolLike[]): string | null {
  const all: SandboxBlock[] = []
  for (const b of tools.flatMap(blocksOf)) if (!all.some((x) => x.target === b.target)) all.push(b)
  return sandboxBlockLine(all)
}
