import type { Page, PageAssertionsToHaveScreenshotOptions } from '@playwright/test'

import { expect, test } from '../e2e/fixtures'

// Runtime annotations make the declared cell namespace visible in Playwright's JSON
// report even when both screenshots pass. Attachments alone only expose failed cells,
// so they cannot detect a cross-spec/project name collision before one render wins.
export const visualScreenshot = async (
  page: Page,
  name: string,
  options?: PageAssertionsToHaveScreenshotOptions,
) => {
  test.info().annotations.push({ type: 'visual-cell', description: name })
  await expect(page).toHaveScreenshot(`${name}.png`, options)
}
