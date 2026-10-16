/**
 * Browser smoke test + screenshots against a running server.
 *
 *   cd backend && python -m tests.demo_server        # terminal 1 (fakes, no credentials)
 *   cd frontend && npm run build && npm run e2e       # terminal 2
 *
 * Signs in as admin, manager (mobile, dark) and staff, walks every screen,
 * opens a room, the check-in form and a bill, and fails on any page error.
 * Screenshots land in e2e/shots/. Needs: npx playwright install chromium
 */
import { chromium } from 'playwright'
const base = process.env.BASE_URL || 'http://localhost:8080'
const out = process.argv[2] || new URL('./shots', import.meta.url).pathname
await import('node:fs').then((fs) => fs.mkdirSync(out, { recursive: true }))
const browser = await chromium.launch()
const errors = []
async function session(user, pw, viewport, dark = false) {
  const ctx = await browser.newContext({ viewport, colorScheme: dark ? 'dark' : 'light' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`${user}: pageerror ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${user}: console ${m.text()}`) })
  await page.goto(base + '/')
  await page.waitForURL('**/app/login')
  await page.fill('#user-id', user)
  await page.fill('#password', pw)
  await page.click('button[type=submit]')
  await page.waitForURL(/\/app\/?$/)
  await page.waitForSelector('text=First floor', { timeout: 15000 })
  return { ctx, page }
}
const desk = { width: 1440, height: 900 }
{
  const ctx = await browser.newContext({ viewport: desk })
  const p = await ctx.newPage()
  await p.goto(base + '/app/login'); await p.waitForTimeout(500)
  await p.screenshot({ path: `${out}/01-login.png` })
  await ctx.close()
}
const { ctx, page } = await session('admin', 'admin123', desk)
await page.waitForTimeout(800)
await page.screenshot({ path: `${out}/02-dashboard.png`, fullPage: true })
await page.click('button[aria-label^="Room 223, occupied"]')
await page.waitForSelector('text=This stay'); await page.waitForTimeout(800)
await page.screenshot({ path: `${out}/03-occupied.png` })
await page.keyboard.press('Escape')
await page.click('button[aria-label^="Room 1, vacant"]')
await page.waitForSelector('text=Check in to room 1'); await page.fill('#ci-mobile', '9876543210'); await page.waitForTimeout(1200)
await page.screenshot({ path: `${out}/04-checkin.png` })
await page.keyboard.press('Escape')

// ── real flow: check a guest in, then out, then open the bill ──
const vacant = page.locator('button[aria-label$=", vacant"]').first()
const roomLabel = await vacant.getAttribute('aria-label')
const roomNo = roomLabel.match(/Room (\w+)/)[1]
await vacant.click()
await page.fill('#ci-mobile', '9000012345')
await page.fill('#ci-name', 'Smoke Test Guest')
await page.click(`text=Check in to room ${roomNo}`)
await page.waitForSelector('text=/Check-in successful/')
await page.waitForSelector(`button[aria-label^="Room ${roomNo}, occupied, Smoke Test Guest"]`, { timeout: 20000 })
await page.click(`button[aria-label^="Room ${roomNo}, occupied"]`)
await page.waitForSelector('text=This stay')
await page.click('role=button[name="Check out"]')
await page.click('role=button[name="Yes, check out"]')
await page.waitForSelector('text=/Open the bill/')
await page.click('role=button[name="Open bill"]')
await page.waitForURL(/\/app\/bills\?open=/)
await page.waitForSelector('iframe[title^="Invoice"]')
await page.keyboard.press('Escape')
await page.click('a[href="/app/bills"]')
await page.waitForSelector('text=GST collected'); await page.waitForTimeout(1000)
await page.screenshot({ path: `${out}/05-bills.png` })
await page.locator('table tbody tr').first().click()
await page.waitForSelector('iframe[title^="Invoice"]'); await page.waitForTimeout(1500)
await page.screenshot({ path: `${out}/06-bill.png` })
await page.keyboard.press('Escape')
await page.click('a[href="/app/finance"]')
await page.waitForSelector('text=Daily collections'); await page.waitForTimeout(1500)
await page.screenshot({ path: `${out}/07-reports.png`, fullPage: true })
await page.click('role=tab[name="GST (GSTR-1)"]'); await page.waitForSelector('text=Rate-wise summary'); await page.waitForTimeout(500)
await page.screenshot({ path: `${out}/08-gst.png` })
await page.click('role=tab[name="Settle later"]'); await page.waitForSelector('text=Vinod'); await page.waitForTimeout(300)
await page.screenshot({ path: `${out}/09-settle.png` })
await page.click('a[href="/app/guests"]'); await page.waitForSelector('text=Room 202'); await page.waitForTimeout(300)
await page.screenshot({ path: `${out}/10-guests.png` })
await page.click('a[href="/app/admin"]'); await page.waitForSelector('text=Mohan Manager'); await page.waitForTimeout(300)
await page.screenshot({ path: `${out}/11-admin.png` })
await page.click('role=tab[name="System health"]'); await page.waitForSelector('text=API performance'); await page.waitForTimeout(500)
await page.screenshot({ path: `${out}/12-health.png` })
await ctx.close()
// mobile, manager, dark
const m = await session('manager', 'manager123', { width: 390, height: 844 }, true)
await m.page.waitForTimeout(800)
await m.page.screenshot({ path: `${out}/13-mobile-dash.png` })
await m.page.click('button[aria-label^="Room 201, occupied"]'); await m.page.waitForSelector('text=This stay'); await m.page.waitForTimeout(600)
await m.page.screenshot({ path: `${out}/14-mobile-room.png` })
await m.ctx.close()
const s = await session('staff', 'staff123', { width: 390, height: 844 })
await s.page.waitForTimeout(500)
await s.page.screenshot({ path: `${out}/15-staff.png` })
await s.ctx.close()
await browser.close()
// 401 from the first silent refresh (no cookie yet) and blocked Firebase
// realtime hosts are expected in offline/demo mode.
const real = errors.filter((e) => !/401|ERR_TUNNEL|ERR_NAME|firestore|googleapis/i.test(e))
console.log(real.length ? 'FAIL\n' + real.join('\n') : `OK — screenshots in ${out}`)
process.exit(real.length ? 1 : 0)
