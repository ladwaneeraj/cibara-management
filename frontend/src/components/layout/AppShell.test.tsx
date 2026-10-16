import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { mockFetch, renderWith, signIn } from '@/test/utils'
import { AppShell } from './AppShell'

function navLabels() {
  const nav = screen.getAllByRole('navigation', { name: 'Main' })[0]
  return within(nav).getAllByRole('link').map((a) => a.textContent?.trim())
}

describe('AppShell navigation by role', () => {
  it('admin sees everything', () => {
    mockFetch({}); signIn('admin')
    renderWith(<AppShell />)
    expect(navLabels()).toEqual(['Rooms', 'Guest requests', 'Bills', 'Reports', 'Admin', 'More modules', 'Classic screens'])
  })
  it('manager sees no admin and "Finance"', () => {
    mockFetch({}); signIn('manager')
    renderWith(<AppShell />)
    expect(navLabels()).toEqual(['Rooms', 'Guest requests', 'Bills', 'Finance', 'More modules', 'Classic screens'])
  })
  it('staff sees rooms and guest requests only', () => {
    mockFetch({}); signIn('housekeeping')
    renderWith(<AppShell />)
    expect(navLabels()).toEqual(['Rooms', 'Guest requests', 'Classic screens'])
  })
})
