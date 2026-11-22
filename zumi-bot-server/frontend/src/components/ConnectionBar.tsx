export const OFFLINE_REASON = 'Reconnecting…'

/** Shown while the socket is down; sending is disabled until it is back. */
export function ConnectionBar({ label = OFFLINE_REASON }: { label?: string }) {
  return (
    <div className="connection-bar" role="status">
      <span className="connection-dot" aria-hidden="true" />
      {label}
    </div>
  )
}
