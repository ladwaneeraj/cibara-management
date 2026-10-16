import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { mockFetch, renderWith, signIn } from '@/test/utils'
import { ConfirmHost } from '@/components/layout/Overlays'
import { AdminPage } from './AdminPage'

const users = { success: true, users: [
  { userId: 'admin1', name: 'Asha Admin', role: 'admin', isActive: true, lastLoginAt: '2026-10-06 09:00:00' },
  { userId: 'desk', name: 'Desk One', role: 'housekeeping', isActive: true, lastLoginAt: null },
  { userId: 'old', name: 'Old Timer', role: 'manager', isActive: false, lastLoginAt: '2026-01-01 09:00:00' },
] }

describe('AdminPage', () => {
  beforeEach(() => signIn('admin'))

  it('lists users with role labels and states', async () => {
    mockFetch({ 'GET /api/v2/admin/users': users })
    renderWith(<AdminPage />)
    expect(await screen.findByText('Desk One')).toBeInTheDocument()
    expect(screen.getByText('Staff')).toBeInTheDocument()
    expect(screen.getByText('Deactivated')).toBeInTheDocument()
    expect(screen.getByText('Never signed in')).toBeInTheDocument()
    expect(screen.getByText('2 active users')).toBeInTheDocument()
  })

  it('force-logs out after confirmation', async () => {
    const { calls } = mockFetch({ 'GET /api/v2/admin/users': users, 'POST /api/v2/admin/users/desk/force-logout': { success: true } })
    renderWith(<><AdminPage /><ConfirmHost /></>)
    const row = (await screen.findByText('Desk One')).closest('li')!
    await userEvent.click(within(row).getByRole('button', { name: /Force logout/ }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Force logout' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/force-logout'))).toBe(true))
  })

  it('validates new user ids before enabling Create', async () => {
    mockFetch({ 'GET /api/v2/admin/users': users })
    renderWith(<AdminPage />)
    await userEvent.click(await screen.findByRole('button', { name: /New user/ }))
    const dialog = await screen.findByRole('dialog')
    const create = within(dialog).getByRole('button', { name: 'Create' })
    expect(create).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('User ID'), 'newbie')
    await userEvent.type(within(dialog).getByLabelText('Initial password'), 'secret1')
    expect(create).toBeEnabled()
  })
})
