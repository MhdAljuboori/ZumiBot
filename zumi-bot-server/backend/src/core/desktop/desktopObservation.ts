// What the agent last saw of one running desktop, so an action can be checked against it and mapped to
// cua-driver: the current observation (the stamp an action must carry, and its `e<n>` -> cua token map),
// the windowId -> {pid, bounds} map and the launchable apps. The manager owns one per desktop.
import type { DesktopCommand, DesktopStamp } from '@zumibot/shared/desktop'
import { elementsOf, filterApps, filterWindows, MAX_WINDOWS, type DesktopApp, type PlanContext, type Rect } from './desktopTools'
import type { CuaResult } from './types'

type Observation = { id: string; generation: string; epoch: number; elements: Map<string, { cuaToken: string; frame: Rect }> }

export class DesktopObservations {
  private observation?: Observation
  private readonly windows = new Map<number, { pid: number; bounds: Rect }>()
  private apps: DesktopApp[] = []

  /** A new generation, a stop or a crash: nothing seen before applies, and cua's ids may be reused. */
  reset(): void {
    this.observation = undefined
    this.windows.clear()
    this.apps = []
  }

  /** The user had the desktop (or was asked to act): stamps are void and windows may have moved. */
  invalidate(): void {
    this.observation = undefined
    this.windows.clear()
  }

  /** Exactly the current observation, taken on this generation in this lease period. */
  isCurrent(stamp: DesktopStamp, generation: string | undefined, epoch: number): boolean {
    const o = this.observation
    return (
      !!o &&
      o.generation === generation &&
      o.epoch === epoch &&
      stamp.generation === o.generation &&
      stamp.epoch === o.epoch &&
      stamp.observationId === o.id
    )
  }

  /** A screenshot or window state replaces the observation; only a window state brings element ids. */
  observe(id: string, generation: string, epoch: number, structured: Record<string, unknown> | null, withElements: boolean): DesktopStamp {
    const elements = new Map(withElements ? elementsOf(structured).map((e) => [e.id, { cuaToken: e.token, frame: e.frame }] as const) : [])
    this.observation = { id, generation, epoch, elements }
    return { generation, epoch, observationId: id }
  }

  knowsWindow(windowId: number): boolean {
    return this.windows.has(windowId)
  }
  knowsApp(name: string): boolean {
    return this.apps.some((app) => app.name === name)
  }

  setWindows(structured: Record<string, unknown> | null): void {
    this.windows.clear()
    this.addWindows(structured)
  }
  private addWindows(structured: Record<string, unknown> | null): void {
    const windows = filterWindows(structured)
    // Launches only add; past the list's own cap start over, and unknown ids are looked up again.
    if (this.windows.size + windows.length > MAX_WINDOWS) this.windows.clear()
    for (const w of windows) this.windows.set(w.windowId, { pid: w.pid, bounds: w.bounds })
  }
  setApps(structured: Record<string, unknown> | null): void {
    this.apps = filterApps(structured)
  }

  /** Keep what a successful command's outputs tell about windows and apps. */
  learn(command: DesktopCommand, outputs: CuaResult[]): void {
    const last = outputs.at(-1)
    if (!last || last.isError) return
    if (command.op === 'windows') this.setWindows(last.structuredContent)
    else if (command.op === 'apps') this.setApps(last.structuredContent)
    // A launched app's windows can be focused without another desktop_windows.
    else if (command.op === 'launch') this.addWindows(last.structuredContent)
  }

  context(desktop: { width: number; height: number }): PlanContext {
    return { desktop, windows: this.windows, apps: this.apps, elements: this.observation?.elements ?? new Map() }
  }
}
