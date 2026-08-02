import { Component, type ReactNode } from 'react'
import { Button } from '../Button'
import { IconBrain } from '../Icons'
import { StateView } from '../StateView'

// The crash net (#65). A render error anywhere below would otherwise blank the
// screen (React unmounts the whole tree); this catches it and shows a styled,
// reloadable state — the client-side equivalent of a 500. Used twice:
//   - outermost in main.tsx, so even a provider-stack crash has a face;
//   - around the routed <Outlet/> in AppShell, so a single page's crash keeps
//     the sidebar/chrome alive (pass resetKey={location.pathname} there — a
//     navigation then clears the error and re-renders the new page).
//
// A class is mandatory here: getDerivedStateFromError / componentDidCatch have
// no hook equivalent.

type ErrorBoundaryProps = {
  children: ReactNode
  /** When this value changes, the boundary forgets the error and re-renders its
   *  children — wire it to the route so navigating away from a crashed page
   *  recovers without a full reload. */
  resetKey?: unknown
  /** Custom fallback; receives the caught error and a reset callback. Defaults
   *  to a StateView with Reload / Go home. */
  fallback?: (error: Error, reset: () => void) => ReactNode
}

type ErrorBoundaryState = { error: Error | null }

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  // No componentDidCatch logging: the SPA keeps console clean (eslint no-console
  // — errors surface as state, not logs), and React already prints the caught
  // error + component stack to the console in dev. A real error-reporting sink
  // would hook in here when one lands.

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    const { error } = this.state

    if (!error) {
      return this.props.children
    }
    if (this.props.fallback) {
      return this.props.fallback(error, this.reset)
    }

    return (
      <StateView
        tone="error"
        code="Crash"
        icon={<IconBrain size={32} />}
        title="That wasn’t supposed to happen"
        description="An unexpected error broke this view. Reloading usually clears it — your notes are safe on the server. If it keeps happening, give it a moment and try again."
        testId="crash-state"
        actions={
          <>
            <Button variant="primary" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                window.location.href = '/'
              }}
            >
              Go home
            </Button>
          </>
        }
      />
    )
  }
}
