export const CONNECTION_GRACE_MS = 1500

/** Bar text, or null to hide it. Before the first open it waits out a short grace so a normal load never flashes. */
export function connectionBarLabel(connection: 'connected' | 'reconnecting', everConnected: boolean, graceElapsed: boolean): string | null {
  if (connection === 'connected') return null
  if (everConnected) return 'Reconnecting…'
  return graceElapsed ? 'Connecting…' : null
}
