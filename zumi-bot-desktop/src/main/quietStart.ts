// A login start may find the server not ready or the session gone: retry quietly for a while, then show the window.
export const QUIET_RETRY_MS = 10_000
export const QUIET_WINDOW_MS = 120_000

export function quietStep(now: number, startedAt: number): 'retry' | 'show' {
  return now - startedAt + QUIET_RETRY_MS <= QUIET_WINDOW_MS ? 'retry' : 'show'
}

/** The sign-in page needs the user, so a quiet start shows the window when it lands there. */
export function isLoginUrl(url: string, origin: string): boolean {
  try {
    const u = new URL(url)
    return u.origin === new URL(origin).origin && (u.pathname === '/login' || u.pathname.startsWith('/login/'))
  } catch {
    return false
  }
}
