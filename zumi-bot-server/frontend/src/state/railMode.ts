export type RailMode = 'agents' | 'routines' | 'workflows'

const KEY = 'zumibot.railMode'

export function loadRailMode(): RailMode {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'routines' || v === 'workflows' ? v : 'agents'
  } catch {
    return 'agents'
  }
}

export function saveRailMode(m: RailMode): void {
  try {
    localStorage.setItem(KEY, m)
  } catch {
    // storage unavailable: the mode just isn't remembered
  }
}
