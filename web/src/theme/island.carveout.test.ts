// Regression guard for the Bookings-island CSS carve-out.
//
// The island renders its OWN copies of .bk-section-title / .bk-filter-row /
// .bk-view-selector / #bookings-list INSIDE #bookings-react-root. The legacy
// booking.js markup renders the same classes/ids as DIRECT children of
// #bookings-tab. The carve-out must hide ONLY the legacy direct children and
// must NOT use the blunt `:not(#bookings-react-root)` catch-all (which also
// hid #day-details-modal and would hide any future direct child).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

// vitest runs with cwd = web/; read the stylesheet text straight from disk.
const css = readFileSync(resolve(process.cwd(), 'src/theme/island.css'), 'utf8')

// Collapse whitespace so assertions don't depend on formatting.
const flat = css.replace(/\s+/g, ' ')

describe('island.css bookings-tab carve-out', () => {
  it('does not use the blunt :not(#bookings-react-root) catch-all', () => {
    expect(flat).not.toContain(':not(#bookings-react-root)')
  })

  it('hides the legacy list and calendar as direct children of #bookings-tab', () => {
    expect(flat).toContain('#bookings-tab > #bookings-list')
    expect(flat).toContain('#bookings-tab > #bookings-calendar-view')
  })

  it('hides the three legacy toolbar/filter/view wrappers as direct children', () => {
    expect(flat).toContain('#bookings-tab > .bk-section-title')
    expect(flat).toContain('#bookings-tab > .bk-filter-row')
    expect(flat).toContain('#bookings-tab > .bk-view-selector')
  })
})
