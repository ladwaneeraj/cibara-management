import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './analytics.css'
import { applyTheme, useUi } from '@/lib/ui'
import { installErrorMonitor } from '@/lib/errorMonitor'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { makeQueryClient } from './queryClient'
import { Root } from './Root'

// Forward window errors / unhandled rejections to /api/v2/client-errors → Sentry.
installErrorMonitor()

applyTheme(useUi.getState().theme)
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(useUi.getState().theme))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Root queryClient={makeQueryClient()} />
    </ErrorBoundary>
  </StrictMode>,
)
