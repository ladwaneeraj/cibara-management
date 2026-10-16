import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import '@/lib/ui' // registers the duplicate-confirm hook with the API client
import { applyTheme, useUi } from '@/lib/ui'
import { installErrorMonitor } from '@/lib/errorMonitor'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { App, makeQueryClient } from './App'

// Forward window errors / unhandled rejections to /api/v2/client-errors → Sentry.
installErrorMonitor()

applyTheme(useUi.getState().theme)
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(useUi.getState().theme))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App queryClient={makeQueryClient()} />
    </ErrorBoundary>
  </StrictMode>,
)
