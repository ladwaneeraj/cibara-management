import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { mockFetch, renderWith, signIn } from '@/test/utils'
import { GuestRequestsPage } from './GuestRequestsPage'

describe('GuestRequestsPage', () => {
  it('lists open requests and marks them done', async () => {
    signIn('housekeeping')
    const { calls } = mockFetch({
      'GET /api/v2/guest-requests': { success: true, requests: [{ id: 'r1', room: '202', guestName: 'Priya', kind: 'extra_items', team: 'housekeeping', note: 'Blanket', status: 'open', createdAtMs: Date.now() - 60000 }] },
      'POST /api/v2/guest-requests/r1/done': { success: true },
    })
    renderWith(<GuestRequestsPage />)
    expect(await screen.findByText('Room 202')).toBeInTheDocument()
    expect(screen.getByText('Blanket')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Portal settings/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Done/ }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v2/guest-requests/r1/done')).toBe(true))
  })

  it('shows history summary', async () => {
    signIn('admin')
    mockFetch({
      'GET /api/v2/guest-requests': { success: true, requests: [] },
      'GET /api/v2/guest-requests/history': { success: true, requests: [], feedback: [{ room: '201', rating: 5, comment: 'Great', createdAtMs: 1 }],
        summary: { total: 4, done: 3, cancelled: 1, avgResponseSec: 120, avgCompletionSec: 900, avgRating: 4.5 } },
    })
    renderWith(<GuestRequestsPage />)
    expect(await screen.findByText('All caught up')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(await screen.findByText('4.5 ★')).toBeInTheDocument()
    expect(screen.getByText('15m')).toBeInTheDocument()
    expect(screen.getByText(/Great/)).toBeInTheDocument()
  })
})
