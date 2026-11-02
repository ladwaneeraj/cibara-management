// Regression guard for the Bookings-island CSS carve-out.
//
// The island renders its OWN copies of .bk-section-title / .bk-filter-row /
// .bk-view-selector / #bookings-list INSIDE #bookings-react-root. The legacy
// booking.js markup renders the same classes/ids as DIRECT children of
// #bookings-tab. The carve-out must hide ONLY the legacy direct children and
// must NOT use the blunt `:not(#bookings-react-root)` catch-all (which also
// hid #day-details-modal and would hide any future direct child).
// Read the stylesheet from disk: vitest's `css: false` makes a `?raw` import
// return empty, so we go through node's fs. The island tsconfig is browser-only
// (no @types/node), so the builtin import is type-suppressed on this one line;
// it resolves fine at runtime under vitest/node.
// @ts-expect-error node builtin, available at runtime under vitest
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// vitest runs with cwd = web/; a relative path resolves against it.
const css: string = readFileSync('src/theme/island.css', 'utf8')

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
