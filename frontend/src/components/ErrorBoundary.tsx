import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '@/lib/errorMonitor';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Catches render-time errors anywhere below it, reports them to
 * /api/v2/client-errors (→ Sentry), and shows a minimal recoverable fallback
 * instead of a blank white screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const stack = `${error?.stack || ''}\n${info?.componentStack || ''}`;
    reportError('react', error?.message || 'React render error', stack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          style={{ padding: '2rem', textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}
        >
          <h2>Something went wrong.</h2>
          <p>The error has been reported. Please reload the page.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
