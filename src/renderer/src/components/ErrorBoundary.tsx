import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * The last thing between a render-time throw and a blank window.
 *
 * React unmounts the entire tree when a render throws and nothing catches it.
 * For most apps that is a bad session; for Hue it is the worst possible failure
 * mode, because it happens silently, at the moment the user is looking at the
 * screen for an answer, and there is no way back short of restarting the app —
 * by which time the interview has moved on.
 *
 * So this deliberately does not try to be clever. It shows what broke, and it
 * offers the one recovery that costs nothing: re-mount the tree. The session's
 * audio and the LLM connection live in the pipeline and the main process, not in
 * the React tree, so a re-mount is cheap and a stuck screen becomes a two-second
 * blip rather than the end of the session.
 */
interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  /** Bumped on retry to force a fresh subtree rather than reusing broken state. */
  attempt: number
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Goes to the renderer console, which is where a crash report would be read
    // from. Deliberately not sent anywhere: session content is on screen here.
    console.error('renderer crashed:', error, info.componentStack)
  }

  private retry = (): void => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return <div key={this.state.attempt}>{this.props.children}</div>

    return (
      <div className="crash-shield">
        <h2>Hue hit an error</h2>
        <p>
          The session is still running in the background — reloading the screen usually brings it
          back.
        </p>
        <pre>{error.message}</pre>
        <button onClick={this.retry}>Reload the screen</button>
      </div>
    )
  }
}
