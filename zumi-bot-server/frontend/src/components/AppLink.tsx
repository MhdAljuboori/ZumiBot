import type { ReactNode } from 'react'
import { plainClick } from '../state/appLink'

/**
 * A link to one of the app's own pages (a sub-workflow's run, its parent's): a plain click moves in the app as Back
 * does, through popstate, so the unsaved-changes guard sees it; a modified click keeps the browser's own.
 */
export function AppLink({ href, className, testId, children }: { href: string; className?: string; testId?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className={className}
      data-testid={testId}
      onClick={(e) => {
        if (!plainClick(e)) return
        e.preventDefault()
        if (href === window.location.pathname + window.location.search + window.location.hash) return
        history.pushState(null, '', href)
        window.dispatchEvent(new PopStateEvent('popstate'))
      }}
    >
      {children}
    </a>
  )
}
