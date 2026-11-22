// The dynamic island: the contract between the desktop shell's strip/popup windows and the pages they load.

export const ISLAND_PATH = '/island'
export const ISLAND_AGENTS_MAX = 10

export interface IslandRect {
  x: number
  y: number
  width: number
  height: number
}
/**
 * Window coordinates, CSS px: where the strip's hit area and the popup sit inside the island window. `track` is the column
 * the strip slides in; only shells whose window never moves send it, and only then does the page slide the strip itself.
 */
export interface IslandLayout {
  strip: IslandRect
  popup: IslandRect | null
  track?: IslandRect
}

/** A live view the main window should open beside the chat. */
export type IslandLive =
  | { kind: 'desktop'; agent: string; point: { x: number; y: number } | null }
  | { kind: 'handoff'; surface: 'desktop' | 'browser'; target: { agent: string; chatId: string; requestId: string } }

export interface IslandOpenTarget {
  chatId: string | null
  live: IslandLive | null
}
export interface IslandSettings {
  agents: string[]
  startAtLogin: boolean
  /** The global shortcut that starts or stops a voice conversation; null is off. Absent from shells that predate it. */
  voiceHotkey?: string | null
  /** Only in the result of `set`: false when the shortcut could not be registered (another app holds it), and the old one stays. */
  ok?: boolean
}

/** What the island page gets; the shell exposes it only to the island window. */
export interface IslandBridge {
  ready(): void
  agents(): Promise<string[]>
  onAgents(cb: (a: string[]) => void): () => void
  setShape(icons: number, open: boolean): void
  onLayout(cb: (l: IslandLayout) => void): () => void
  /**
   * A drag of the strip. With a `track` in the layout the page slides the strip itself, sends no moves and gives the
   * strip's final top (window coordinates) with the end; without one (an older shell) it sends moves and the shell moves
   * the window. Only older shells read `screenY`: newer ones follow the X pointer, since mid-drag screenY can be off.
   */
  drag(phase: 'start' | 'move' | 'end', screenY: number, top?: number): void
  openMain(t: IslandOpenTarget): void
  openAttachment(url: string, name: string): Promise<boolean>
  /** The desk shortcut was pressed: true starts a voice conversation, false stops the one that runs. Absent from older shells. */
  onVoice?(cb: (on: boolean) => void): () => void
  /** The voice conversation is over (it finished, was stopped or was closed); the shell drops a voice-only island. */
  voiceEnded?(): void
}

/** What Settings gets, as an optional member of `DesktopBridge`. */
export interface IslandSettingsBridge {
  get(): Promise<IslandSettings>
  set(patch: Partial<IslandSettings>): Promise<IslandSettings>
  renameAgent(from: string, to: string): void
}

const HOTKEY_MAX = 40
const HOTKEY_MODS = ['Ctrl', 'Alt', 'Shift', 'Super']
const HOTKEY_KEY = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|SPACE)$/

/**
 * An Electron accelerator from a short allow-list, in one form (modifiers in the order Ctrl, Alt, Shift, Super, then the
 * key), or null: at least one modifier and exactly one key (A-Z, 0-9, F1-F12 or Space). It reaches the main process from
 * the page and the file, and is handed to the window manager, so nothing outside the grammar passes.
 */
export function cleanHotkey(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > HOTKEY_MAX) return null
  const parts = v.split('+')
  const mods = new Set<string>()
  let key: string | null = null
  for (const raw of parts) {
    const mod = HOTKEY_MODS.find((m) => m.toLowerCase() === raw.toLowerCase())
    if (mod) {
      if (mods.has(mod)) return null
      mods.add(mod)
    } else if (key === null && HOTKEY_KEY.test(raw.toUpperCase())) key = raw.toUpperCase() === 'SPACE' ? 'Space' : raw.toUpperCase()
    else return null
  }
  if (mods.size === 0 || key === null) return null
  return [...HOTKEY_MODS.filter((m) => mods.has(m)), key].join('+')
}

const NAME_MAX = 100
const ID_MAX = 200
const CONTROL = /[\u0000-\u001f\u007f]/

/** Page and prefs input reach the shell's main process, so both sides clean it the same way. */
export function cleanAgentList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const a of v) {
    if (typeof a !== 'string' || a.length < 1 || a.length > NAME_MAX || CONTROL.test(a) || out.includes(a)) continue
    out.push(a)
    if (out.length === ISLAND_AGENTS_MAX) break
  }
  return out
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (o: Record<string, unknown>, keys: string[]): boolean => {
  const own = Object.keys(o)
  return own.length === keys.length && keys.every((k) => k in o)
}
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= ID_MAX

function parsePoint(v: unknown): { x: number; y: number } | null | undefined {
  if (v === null) return null
  if (!isObject(v) || !exactKeys(v, ['x', 'y'])) return undefined
  const { x, y } = v
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y) ? { x, y } : undefined
}

function parseLive(v: unknown): IslandLive | undefined {
  if (!isObject(v)) return undefined
  if (v.kind === 'desktop') {
    if (!exactKeys(v, ['kind', 'agent', 'point']) || !text(v.agent)) return undefined
    const point = parsePoint(v.point)
    return point === undefined ? undefined : { kind: 'desktop', agent: v.agent, point }
  }
  if (v.kind === 'handoff') {
    if (!exactKeys(v, ['kind', 'surface', 'target']) || (v.surface !== 'desktop' && v.surface !== 'browser') || !isObject(v.target))
      return undefined
    const t = v.target
    if (!exactKeys(t, ['agent', 'chatId', 'requestId']) || !text(t.agent) || !text(t.chatId) || !text(t.requestId)) return undefined
    return { kind: 'handoff', surface: v.surface, target: { agent: t.agent, chatId: t.chatId, requestId: t.requestId } }
  }
  return undefined
}

export function parseIslandOpenTarget(v: unknown): IslandOpenTarget | null {
  if (!isObject(v) || !exactKeys(v, ['chatId', 'live'])) return null
  if (v.chatId !== null && !text(v.chatId)) return null
  if (v.live === null) return { chatId: v.chatId, live: null }
  const live = parseLive(v.live)
  return live ? { chatId: v.chatId, live } : null
}
