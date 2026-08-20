import { test as base, expect, type Locator, type Page } from '@playwright/test'

// Shared E2E fixture. The fake backend is a single in-memory process shared by
// the whole run, so before each test we re-seed it (POST /api/__test/reset) to
// start from the canonical fixture — and arm the graph test-hook before the app
// loads. Specs import { test, expect } from here instead of @playwright/test.
//
// (The run is serial — see playwright.config workers:1 — so resets never race.)
export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    await page.request.post(`${baseURL}/api/__test/reset`)
    await page.addInitScript(() => {
      ;(window as unknown as { __NOTARIUM_TEST__: boolean }).__NOTARIUM_TEST__ = true
    })
    await use(page)
  },
})

export const treeNote = (page: Page, name: string | RegExp) =>
  page.getByTestId('rail-scroll').getByRole('link', { name })

export const waitForAppReady = async (page: Page) => {
  await expect(page.getByTestId('rail-scroll')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible()
}

export const openSpotlight = async (page: Page) => {
  await waitForAppReady(page)
  await page.locator('body').click()
  await page.keyboard.press('Control+P')
  const input = page.getByTestId('spotlight-input')
  await expect(input).toBeFocused()
  return input
}

export { expect }
export type { Locator, Page }
