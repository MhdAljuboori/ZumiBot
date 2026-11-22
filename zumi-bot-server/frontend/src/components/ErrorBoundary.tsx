import { Component, type ErrorInfo, type ReactNode } from 'react'

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Keeps a render error in one part of the page. Without a boundary React unmounts the whole tree, and a chat whose
 * stored items trip the error blanks the app again on every launch (a PWA reopens on the same chat).
 */
class Boundary extends Component<{ children: ReactNode; fallback: (error: unknown) => ReactNode; label: string }, { error: unknown }> {
  state: { error: unknown } = { error: null }
  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error: error ?? new Error('Unknown error') }
  }
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`${this.props.label} failed to render`, error, info.componentStack)
  }
  render(): ReactNode {
    return this.state.error !== null ? this.props.fallback(this.state.error) : this.props.children
  }
}

/** One chat item: the rest of the chat still shows, with a note where the item would be. */
export function ItemBoundary({ children }: { children: ReactNode }) {
  return (
    <Boundary
      label="Chat item"
      fallback={(e) => (
        <div className="item-error" role="alert" data-testid="item-error">
          This message could not be shown: {describe(e)}
        </div>
      )}
    >
      {children}
    </Boundary>
  )
}

/** The whole app: the error and a way out instead of a blank page. */
export function AppBoundary({ children }: { children: ReactNode }) {
  return (
    <Boundary
      label="App"
      fallback={(e) => (
        <div className="app-error" role="alert" data-testid="app-error">
          <h1>Something went wrong</h1>
          <p>{describe(e)}</p>
          {e instanceof Error && e.stack && <pre>{e.stack}</pre>}
          <div className="app-error-actions">
            {/* Home leaves the chat whose items broke the page, so the rest of the app works again. */}
            <button type="button" className="btn primary" onClick={() => location.assign('/')}>
              Go home
            </button>
            <button type="button" className="btn" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      )}
    >
      {children}
    </Boundary>
  )
}
