import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/lib/api'

/** Same retry policy as the SPA: never retry a definitive client error. */
export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (n, e) => !(e instanceof ApiError && [400, 401, 403, 404, 422].includes(e.status)) && n < 2,
        refetchOnWindowFocus: false,
        staleTime: 60_000,
      },
    },
  })
}
