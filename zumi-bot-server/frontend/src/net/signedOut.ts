import { clearDrafts, sessionDrafts } from '../state/draftStore'

// What runs when the session is gone: callers register a last-moment save, then the page goes to /login.
let beforeLeave: () => void = () => {}

export function onBeforeSignedOut(fn: () => void): void {
  beforeLeave = fn
}

/** persist = the session expired (drafts survive the redirect); false = the user signed out, so nothing is kept for the next sign-in. */
export function redirectToLogin(
  assign: (url: string) => void = (url) => location.assign(url),
  persist = true,
  storage: Storage | null = sessionDrafts()
): void {
  if (persist) {
    try {
      beforeLeave()
    } catch {
      // saving drafts is best effort; the redirect must still happen
    }
  } else {
    clearDrafts(storage)
  }
  assign('/login')
}
