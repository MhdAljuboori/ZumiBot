// Pure helpers for the bot icon.
import { COLOR_OPTIONS, ICON_OPTIONS, LEGACY_ICONS, type BotShape } from '@zumibot/shared/frontmatter'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'

export const TILT_ANGLES = [-14, -9, -5, 0, 0, 5, 9, 14] as const
export const TILT_EVERY_MS = 650
export const TILT_CHANCE = 0.45

const isShape = (icon: string): icon is BotShape => (ICON_OPTIONS as readonly string[]).includes(icon)
// Own keys only: `constructor` or `__proto__` in a file must not read through to Object.prototype.
const isLegacy = (icon: string): boolean => Object.hasOwn(LEGACY_ICONS, icon)

/** The shape drawn for an agent's `icon:`: a shape, an old face's nearest shape, else the default. */
export function shapeOf(icon: string | null): BotShape {
  if (icon === null) return ICON_OPTIONS[0]
  if (isShape(icon)) return icon
  return isLegacy(icon) ? LEGACY_ICONS[icon] : ICON_OPTIONS[0]
}

/** An `icon:` the picker cannot show as one of its shapes (Zumi Bot's `zumi-z` included). */
export function isCustomIcon(icon: string | null): boolean {
  return icon !== null && !isShape(icon) && !isLegacy(icon)
}

export function shapeSelected(icon: string | null, shape: BotShape): boolean {
  return !isCustomIcon(icon) && shapeOf(icon) === shape
}

const isPaletteColor = (color: string | null): boolean => (COLOR_OPTIONS as readonly string[]).includes(color ?? '')

/** The CSS color for a palette color name, or null when the agent has none (or an unknown one). For fills: icons, dots. */
export function agentColor(color: string | null): string | null {
  return isPaletteColor(color) ? `var(--agent-${color})` : null
}

/** The same hue as text: several fills are too light to read on white, so names and mentions take this instead. */
export function agentInk(color: string | null): string | null {
  return isPaletteColor(color) ? `var(--agent-${color}-ink)` : null
}

export function agentIsWorking(
  agent: Pick<AgentSummary, 'name' | 'error'>,
  chats: ReadonlyArray<Pick<ChatMeta, 'id' | 'agentName' | 'inFlight' | 'group'>>,
  pendingByChat: Record<string, number>
): boolean {
  if (agent.error !== null) return false
  return chats.some(
    (c) => c.inFlight && !pendingByChat[c.id] && (c.group ? c.group.active.some((t) => t.agent === agent.name) : c.agentName === agent.name)
  )
}

export function nextTilt(current: number, random: () => number): number {
  if (random() >= TILT_CHANCE) return current
  return TILT_ANGLES[Math.floor(random() * TILT_ANGLES.length)]
}

export function bobTiming(random: () => number): { duration: string; delay: string } {
  const r1 = random()
  const r2 = random()
  return { duration: `${(0.9 + r1 * 0.6).toFixed(2)}s`, delay: `-${r2.toFixed(2)}s` }
}
