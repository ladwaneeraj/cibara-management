import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import '@/lib/ui' // registers the duplicate-confirm hook with the API client
import { applyTheme, useUi } from '@/lib/ui'
import { App, makeQueryClient } from './App'

applyTheme(useUi.getState().theme)
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(useUi.getState().theme))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App queryClient={makeQueryClient()} />
  </StrictMode>,
)
