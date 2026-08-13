import { buildCaseWorld } from '../cases/build'
import { caseToFixture } from '../cases/toFixture'
import { expect, type Page, test } from './fixtures'

// #247 — the Trash top chrome and footer are scroll-aware glass (#185): the material
// (frost, fill, lit edge) is interpolated from a `--glass-lift` CSS var that
// useScrollGlass writes per scroll frame. Two invariants this pins:
//
//  1. The footer — mounted the instant a row is picked — shows its frost on the FIRST
//     frame when content still sits under it, not flat-then-fade. Root cause of the bug:
//     the footer's useScrollGlass ran while its bar was unmounted, so the eased lift was
//     written to nothing; on mount `current` already equalled its target, so no rAF ran
//     and `--glass-lift` was never set on the element (CSS fell back to 0 = flat) until
//     the next scroll. The hook now SNAPS and WRITES the lift on (re)mount.
//  2. The top chrome carries NO hard divider at rest: its separation is the scroll-lifted
//     glass edge only, so at the very top (glass idle) the header is clean.

// A long deleted-notes list straight from the shared catalog (`make seed CASE=trash-long`)
// — two dozen tombstoned rows, enough to overflow the viewport so the list scrolls and the
// footer floats over content. Reusing the case keeps the e2e and manual-QA worlds identical.
const LONG_TRASH = caseToFixture(
  buildCaseWorld('trash-long', { now: '2026-07-01T12:00:00.000Z', scale: 1 }),
)

// A short viewport so the ~24-row trash reliably overflows (content stays under the footer).
test.use({ viewport: { width: 1280, height: 640 } })

const trashScroll = (page: Page) => page.getByTestId('trash-page')
const setScrollTop = (page: Page, top: number) =>
  trashScroll(page).evaluate((el: HTMLElement, t: number) => el.scrollTo({ top: t }), top)
const glassLift = (page: Page, testid: string) =>
  page
    .getByTestId(testid)
    .evaluate(
      (el: HTMLElement) => parseFloat(getComputedStyle(el).getPropertyValue('--glass-lift')) || 0,
    )
// The top chrome bar carries the lift var but has no testid — read it by its (hashed) class.
const topChromeLift = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[class*="topChrome"]')
    return el ? parseFloat(getComputedStyle(el).getPropertyValue('--glass-lift')) || 0 : NaN
  })

test.beforeEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: LONG_TRASH } })
})
test.afterEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`)
})

test('footer frosts on the first frame when content is under it, flat only at the end (#247)', async ({
  page,
}) => {
  await page.goto('/s/main/trash')
  await expect(page.getByTestId('trash-row').first()).toBeVisible()
  await setScrollTop(page, 0) // plenty of content sits below the footer once it appears

  // Pick the first row → the pre-measured footer becomes visible over content. Its glass
  // must already be full; it must not pause flat until another scroll event arrives.
  await page.getByTestId('trash-row-check').first().check({ force: true })
  await expect(page.getByTestId('trash-footer')).toBeVisible()
  expect(await glassLift(page, 'trash-footer')).toBeGreaterThan(0.9)

  // Scroll to the very end: nothing remains under the footer, so it goes flat.
  await setScrollTop(page, 10_000)
  await expect.poll(() => glassLift(page, 'trash-footer')).toBeLessThan(0.1)

  // Flat glass is safe only when the final row visibly clears the floating action bar.
  // Keep a full content gap there; otherwise the transparent footer reads as if it were
  // laid directly over the row even though the scroll position is technically at rest.
  const bottomGap = async () => {
    const last = await page.getByTestId('trash-row').last().boundingBox()
    const footer = await page.getByTestId('trash-footer').boundingBox()

    return last && footer ? footer.y - (last.y + last.height) : -1
  }
  await expect.poll(bottomGap).toBeGreaterThanOrEqual(23)
})

test('footer space is reserved before selection, so showing it does not jump the scroll', async ({
  page,
}) => {
  await page.goto('/s/main/trash')
  const scroll = trashScroll(page)
  await expect(page.getByTestId('trash-row').first()).toBeVisible()
  await setScrollTop(page, 10_000)

  const metrics = () =>
    scroll.evaluate((element) => {
      const list = element.querySelector<HTMLElement>('[data-testid="trash-list"]')

      return {
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
        listTop: list!.getBoundingClientRect().top,
      }
    })
  const before = await metrics()

  await page.getByTestId('trash-row-check').last().check({ force: true })
  await expect(page.getByTestId('trash-footer')).toBeVisible()
  const after = await metrics()

  expect(after.scrollHeight).toBe(before.scrollHeight)
  expect(after.scrollTop).toBe(before.scrollTop)
  // Compare the stable virtual-list coordinate, not the last mounted row: the
  // virtualizer may swap its overscan window one frame after scrollTo without any
  // user-visible movement, so "last DOM row" is not a stable content anchor.
  expect(after.listTop).toBe(before.listTop)
})

// Alpha of a computed colour — handles `color(srgb r g b / a)`, `rgb(a)`, `transparent`.
const alphaOf = (c: string): number => {
  const fn = c.match(/\/\s*([\d.]+)\s*\)/)

  if (fn) {
    return parseFloat(fn[1])
  }
  const rgba = c.match(/rgba?\([^)]*?,\s*([\d.]+)\s*\)/)

  if (rgba) {
    return parseFloat(rgba[1])
  }

  return /transparent/.test(c) ? 0 : 1
}
// The toolbar band's top border-top colour (walk up from the select-all checkbox to the
// outermost `.toolbar` ancestor — class names are hashed by CSS modules).
const toolbarBorderColor = (page: Page) =>
  page.getByTestId('trash-select-all').evaluate((cb: HTMLElement) => {
    const has = (el: Element | null) =>
      !!el && String(el.className).toLowerCase().includes('toolbar')
    let band: Element | null = cb

    while (band && !has(band)) {
      band = band.parentElement
    }
    while (band && has(band.parentElement)) {
      band = band.parentElement
    }

    return band ? getComputedStyle(band).borderTopColor : 'no-band'
  })

test('top-chrome divider rides the scroll glass: gone at rest, present on scroll (#247)', async ({
  page,
}) => {
  await page.goto('/s/main/trash')
  await expect(page.getByTestId('trash-row').first()).toBeVisible()
  await setScrollTop(page, 0)

  // At the very top the chrome's glass is idle (lift ~0), so the toolbar's top divider is
  // transparent — no hard hairline splitting the clean band.
  expect(await topChromeLift(page)).toBeLessThan(0.1)
  expect(alphaOf(await toolbarBorderColor(page))).toBeLessThan(0.1)

  // Scrolling lifts the glass in; the divider returns to a solid border in step with it —
  // separating header from list exactly as before, just no longer a rest-state noise.
  await setScrollTop(page, 10_000)
  await expect.poll(() => topChromeLift(page)).toBeGreaterThan(0.9)
  expect(alphaOf(await toolbarBorderColor(page))).toBeGreaterThan(0.5)
})
