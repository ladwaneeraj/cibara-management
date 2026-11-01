import { test, expect } from '@playwright/test'

// Smoke against a running server (demo_server seeds admin/admin123). If the
// server requires sign-in, these steps log in first; adjust selectors to your
// login page if it differs. This is a manual smoke, not a CI gate.
async function ensureSignedIn(page: import('@playwright/test').Page) {
  await page.goto('/legacy')
  const userField = page.locator('#login-user, input[name="userId"], #userId')
  if (await userField.first().isVisible().catch(() => false)) {
    await userField.first().fill(process.env.E2E_USER || 'admin')
    await page.locator('#login-pass, input[type="password"]').first().fill(process.env.E2E_PASS || 'admin123')
    await page.getByRole('button', { name: /sign in|log ?in/i }).first().click()
    await page.waitForLoadState('networkidle')
  }
}

test('Bookings island renders and switches views', async ({ page }) => {
  await ensureSignedIn(page)
  await page.goto('/legacy')
  await page.locator('.nav-item[data-tab="bookings"]').click()

  const root = page.locator('#bookings-react-root')
  await expect(root).toContainText('Room Bookings')

  await page.getByRole('button', { name: /^Calendar$/ }).click()
  await page.getByRole('button', { name: /^Timeline$/ }).click()
  await page.getByRole('button', { name: /^List$/ }).click()

  // New Booking opens the island modal.
  await page.getByRole('button', { name: /New Booking/ }).click()
  await expect(page.getByRole('dialog', { name: /New booking/i })).toBeVisible()
})
