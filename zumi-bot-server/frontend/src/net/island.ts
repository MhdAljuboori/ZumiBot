import { ISLAND_PATH, type IslandBridge } from '@zumibot/shared/island'

/**
 * The island page's bridge, read once at load: only the shell's island window has it, and only the page at /island may use
 * it, so the main window (which has no bridge) and a browser tab (which has neither) never run in island mode.
 */
export const islandBridge: IslandBridge | null =
  location.pathname === ISLAND_PATH ? ((window as unknown as { zumibotIsland?: IslandBridge }).zumibotIsland ?? null) : null
