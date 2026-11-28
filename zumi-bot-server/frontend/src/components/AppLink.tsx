import { useContext, type ReactNode } from 'react'
import { appLinkClick } from '../state/appLink'
import { AppLinkContext } from './Markdown'

/**
 * A link to one of the app's own pages (a sub-workflow's run, its parent's): a plain click moves in the app as Back
 * does, through popstate, so the unsaved-changes guard sees it; a modified click keeps the browser's own. Where links
 * open elsewhere (the island, a popout: AppLinkContext) every click goes there, since this page's address never moves.
 */
export function AppLink({ href, className, testId, children }: { href: string; className?: string; testId?: string; children: ReactNode }) {
  const openApp = useContext(AppLinkContext)
  return (
    <a
      href={href}
      className={className}
      data-testid={testId}
      onClick={(e) => {
        const action = appLinkClick(e, href, window.location.pathname + window.location.search + window.location.hash, openApp)
        if (action === 'browser') return
        e.preventDefault()
        if (action === 'context') return openApp?.(href)
        if (action === 'same') return
        history.pushState(null, '', href)
        window.dispatchEvent(new PopStateEvent('popstate'))
      }}
    >
      {children}
    </a>
  )
}
