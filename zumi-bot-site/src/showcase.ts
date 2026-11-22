// The page's demo cast and the small rules its live scenes follow. Pure, so tests/showcase.test.ts can check them.
import type { BotShape } from '@zumibot/shared/frontmatter'

export type SceneId =
  | 'hero'
  | 'chat'
  | 'studio'
  | 'room'
  | 'control'
  | 'auto'
  | 'machine'
  | 'work'
  | 'voice'
  | 'everywhere'
  | 'release'
  | 'download'
  | 'server'
export const SCENES: readonly SceneId[] = [
  'hero',
  'chat',
  'studio',
  'room',
  'control',
  'auto',
  'machine',
  'work',
  'voice',
  'everywhere',
  'release',
  'download',
  'server'
]

export const AGENT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'] as const
export type AgentColor = (typeof AGENT_COLORS)[number]
/** A working icon's tilt rhythm (styles.css tilt-a/b/c), so neighbours never sway in step. */
export type Tilt = 'a' | 'b' | 'c'

export interface DemoAgent {
  name: string
  shape: BotShape
  color: AgentColor
  tilt: Tilt
}

// Demo agents only: the page never shows a real agent, chat or folder.
export const AGENTS = {
  planner: { name: 'Planner', shape: 'layers', color: 'blue', tilt: 'a' },
  coder: { name: 'Coder', shape: 'lightning', color: 'green', tilt: 'b' },
  reviewer: { name: 'Reviewer', shape: 'magnifier', color: 'purple', tilt: 'c' },
  ops: { name: 'Ops', shape: 'gear', color: 'orange', tilt: 'a' },
  wordsmith: { name: 'Wordsmith', shape: 'chat', color: 'pink', tilt: 'b' },
  clerk: { name: 'Inbox Clerk', shape: 'folder', color: 'yellow', tilt: 'c' }
} as const satisfies Record<string, DemoAgent>
export type AgentId = keyof typeof AGENTS

/** The four in the header and the room, left to right. */
export const CAST = ['planner', 'coder', 'reviewer', 'ops'] as const satisfies readonly AgentId[]
export type CastId = (typeof CAST)[number]

const SCENE_AGENT: Partial<Record<SceneId, CastId>> = {
  hero: 'coder',
  chat: 'coder',
  studio: 'planner',
  room: 'planner',
  control: 'reviewer',
  auto: 'ops',
  machine: 'ops',
  work: 'reviewer',
  voice: 'ops',
  download: 'ops',
  server: 'ops'
}
const DOING: Partial<Record<SceneId, string>> = {
  hero: 'fixing tests',
  chat: 'explaining',
  studio: 'trying on shapes',
  room: 'moderating',
  control: 'waiting on you',
  auto: 'running a workflow',
  machine: 'at the desktop',
  work: 'reviewing',
  voice: 'listening',
  download: 'packing installers',
  server: 'setting up a server'
}

export type Look = -1 | 0 | 1

export interface CastState {
  label: string
  working: CastId | null
  /** Where each cast member's eyes point: at the one working, or ahead when it is them or nobody. */
  look: Record<CastId, Look>
}

/** The header cast while `active` is the scene in the middle of the screen. */
export function castState(active: SceneId): CastState {
  const working = SCENE_AGENT[active] ?? null
  const at = working === null ? -1 : CAST.indexOf(working)
  const look = {} as Record<CastId, Look>
  CAST.forEach((id, i) => {
    look[id] = at < 0 || i === at ? 0 : at > i ? 1 : -1
  })
  return { label: working === null ? 'All idle' : `${AGENTS[working].name} is ${DOING[active]}`, working, look }
}

const BASE_QUEUE: readonly CastId[] = ['coder', 'reviewer', 'ops']

/** Who the room's moderator lines up next: a mentioned agent jumps to the front. */
export function roomQueue(mention: CastId | null): CastId[] {
  if (mention === null) return [...BASE_QUEUE]
  return [mention, ...BASE_QUEUE.filter((id) => id !== mention)]
}

export const ROOM_ASKS: Record<CastId, string> = {
  planner: 'can you re-split this for Friday?',
  coder: 'is /v1/export behind a flag?',
  reviewer: 'does the index change need a backfill?',
  ops: 'when is the deploy window?'
}

/** The app's own permission mode names (frontend state/runPickers.ts). */
export const MODES = [
  { id: 'plan', label: 'Plan mode' },
  { id: 'edits', label: 'Accept edits' },
  { id: 'ask', label: 'Ask permissions' }
] as const
export type ModeId = (typeof MODES)[number]['id']

/** "Lightning", "Magnifier": a shape's name as the picker shows it. */
export function shapeLabel(shape: string): string {
  return shape.charAt(0).toUpperCase() + shape.slice(1)
}

/** The voice scene's waveform: fixed heights and delays, so it looks the same on every load. */
export function waveBars(count: number): { h: number; delay: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    h: Math.round(14 + 34 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23))),
    delay: Number(((i * 0.13) % 1.1).toFixed(2))
  }))
}

/** "Nov 18, 2026", or '' for a missing or broken date. UTC, so the day never shifts with the reader's zone. */
export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (iso === '' || Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
}
