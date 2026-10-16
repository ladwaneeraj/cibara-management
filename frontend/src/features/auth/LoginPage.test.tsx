import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAuth } from '@/lib/auth'
import { json, mockFetch, renderWith } from '@/test/utils'
import { LoginPage } from './LoginPage'

const session = { access_token: 'a', expires_in: 900, permissions: ['*'], firebase_custom_token: null,
  user: { userId: 'neeraj', name: 'Neeraj', role: 'admin', roleLabel: 'Admin', authUid: 'u' } }

function setup() {
  return renderWith(<Routes><Route path="/login" element={<LoginPage />} /><Route path="/" element={<div>HOME</div>} /></Routes>, { route: '/login' })
}

describe('LoginPage', () => {
  beforeEach(() => useAuth.setState({ status: 'anonymous', user: null, token: null, permissions: new Set(), notice: null }))

  it('validates empty fields without calling the server', async () => {
    const { fn } = mockFetch({})
    setup()
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(screen.getByRole('alert')).toHaveTextContent('Please enter your User ID and password.')
    expect(fn).not.toHaveBeenCalled()
  })

  it('shows the server message on bad credentials and clears the password', async () => {
    mockFetch({ 'POST /api/v2/auth/login': json({ success: false, message: 'Incorrect User ID or password.' }, 401) })
    setup()
    await userEvent.type(screen.getByLabelText('User ID'), 'neeraj')
    await userEvent.type(screen.getByLabelText('Password'), 'wrongpass')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect User ID or password.')
    expect(screen.getByLabelText('Password')).toHaveValue('')
  })

  it('signs in and navigates home', async () => {
    const { calls } = mockFetch({ 'POST /api/v2/auth/login': session })
    setup()
    await userEvent.type(screen.getByLabelText('User ID'), '  Neeraj ')
    await userEvent.type(screen.getByLabelText('Password'), 'secret123')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(screen.getByText('HOME')).toBeInTheDocument())
    expect(calls[0].body).toEqual({ user_id: 'Neeraj', password: 'secret123' })
    expect(useAuth.getState().token).toBe('a')
    expect(useAuth.getState().can('anything')).toBe(true)
  })

  it('toggles password visibility', async () => {
    mockFetch({})
    setup()
    const pw = screen.getByLabelText('Password')
    expect(pw).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', { name: /show password/i }))
    expect(pw).toHaveAttribute('type', 'text')
  })
})
