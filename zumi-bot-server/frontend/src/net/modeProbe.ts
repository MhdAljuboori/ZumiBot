import type { ConnectionStatus, ServerMode } from '@zumibot/shared/types'

/**
 * Reads the server mode once the socket is up. A call dropped with the socket is rejected,
 * so it is retried on each connect until one answers.
 */
export function watchMode(
  onStatus: (cb: (s: ConnectionStatus) => void) => () => void,
  getMode: () => Promise<ServerMode>,
  set: (mode: ServerMode) => void
): () => void {
  let live = true
  let done = false
  let asking = false
  const off = onStatus((s) => {
    if (s !== 'connected' || done || asking) return
    asking = true
    getMode().then(
      (mode) => {
        done = true
        asking = false
        if (live) set(mode)
      },
      () => {
        asking = false
      }
    )
  })
  return () => {
    live = false
    off()
  }
}
