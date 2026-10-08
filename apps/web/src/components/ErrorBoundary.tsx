import { Component, type ReactNode } from 'react'

/**
 * If something on screen fails to draw, show what went wrong (and a way out)
 * instead of a blank app. `inline` is for a part of the screen, such as the
 * search results: the rest of the app keeps working, and changing `resetKey`
 * (the next search) tries again.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; inline?: boolean; resetKey?: unknown }, { error: Error | null; key: unknown }> {
  state = { error: null as Error | null, key: this.props.resetKey }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { error: Error | null; key: unknown }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('ReconNotes: something failed to draw', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.inline)
      return (
        <div className="empty-hint error-inline">
          Couldn’t show this: {error.message}{' '}
          <button className="text" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      )
    return (
      <div className="app-error">
        <h2>Something went wrong</h2>
        <p>Your notes are safe – this is only the screen. Reloading usually fixes it.</p>
        <pre>{error.message}</pre>
        <div className="app-error-actions">
          <button className="primary" onClick={() => location.reload()}>
            Reload
          </button>
          <button onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </div>
    )
  }
}
