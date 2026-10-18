import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useAuth } from '@/lib/auth'
import { App, AuthGate } from './App'

/** Restores the session via the shared auth store (refresh cookie → access JWT),
 *  then renders the page behind the permission gate. No bespoke session logic. */
export function Root({ queryClient }: { queryClient: QueryClient }) {
  const bootstrap = useAuth((s) => s.bootstrap)
  useEffect(() => { void bootstrap() }, [bootstrap])
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <App />
      </AuthGate>
    </QueryClientProvider>
  )
}
