import { expect, test } from './fixtures'

test('provider tabs and direct routes disappear with the host capability', async ({ page }) => {
  await page.goto('/settings/credentials')
  await expect(page).toHaveURL(/\/settings\/appearance$/)
  await expect(page.getByTestId('provider-credentials')).toHaveCount(0)
  await expect(page.getByTestId('settings-tab-credentials')).toHaveCount(0)
  await expect(page.getByTestId('settings-tab-providers')).toHaveCount(0)

  await page.goto('/settings/providers')
  await expect(page).toHaveURL(/\/settings\/appearance$/)
  await expect(page.getByTestId('provider-resources')).toHaveCount(0)

  await page.goto('/s/main/management/providers')
  await expect(page).not.toHaveURL(/\/management\/providers$/)
  await expect(page.getByTestId('provider-attachments')).toHaveCount(0)
})
