import { memoryLineText, type MemoryTouch } from '@zumibot/shared/memory'

/** The chat line under a reply that saved or updated memory; null when the item touched none. */
export function memoryLine(touch: MemoryTouch | undefined, roomAgent: string | null): string | null {
  if (!touch || touch.saved + touch.updated <= 0) return null
  return memoryLineText(touch, roomAgent)
}

/** A missing or broken agent has no Memory to open, so its line shows no View button. */
export function canViewMemory(agent: { builtIn: boolean; error: string | null; filePath: string }): boolean {
  return !agent.builtIn && agent.error === null && agent.filePath !== ''
}
