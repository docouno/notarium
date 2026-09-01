import type { Page } from '@playwright/test'
import { expect, test } from '../e2e/fixtures'
import { visualScreenshot } from './screenshot'

const addCredential = async (page: Page) => {
  const response = await page.request.post('/api/providers/credentials', {
    data: {
      name: 'OpenRouter key',
      kind: 'bearer',
      secret: 'visual-secret-value',
      origin: 'https://openrouter.ai',
      injection: { header: '', prefix: 'Bearer ' },
      rpm: 60,
      tpm: 100000,
    },
  })
  expect(response.ok()).toBe(true)
}

const addResource = async (page: Page) => {
  const response = await page.request.post('/api/providers/resources', {
    data: {
      name: 'Primary model',
      wire: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [
        { name: 'openai/gpt-5', capabilities: ['completion'] },
        { name: 'text-embedding-3-small', capabilities: ['embedding'] },
      ],
      defaultModel: 'openai/gpt-5',
    },
  })
  expect(response.ok()).toBe(true)
}

for (const theme of ['dark', 'light'] as const) {
  test(`populated provider resource form — ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript((value) => localStorage.setItem('bm-theme', value), theme)
    await addResource(page)
    await page.goto('/settings/providers')
    await page.getByRole('button', { name: 'Edit Primary model' }).click()
    await expect(page.getByTestId('provider-disclosure')).toBeVisible()
    await visualScreenshot(page, `provider-resource-form-${theme}`)
  })

  test(`populated provider resource form narrow — ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript((value) => localStorage.setItem('bm-theme', value), theme)
    await addResource(page)
    await page.goto('/settings/providers')
    await page.getByRole('button', { name: 'Edit Primary model' }).click()
    await expect(page.getByTestId('provider-models')).toBeVisible()
    await visualScreenshot(page, `provider-resource-form-narrow-${theme}`)
  })

  test(`provider credential setup form — ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript((value) => localStorage.setItem('bm-theme', value), theme)
    await page.goto('/settings/credentials')
    await page.getByTestId('credential-new').click()
    await expect(page.getByTestId('credential-advanced-content')).toHaveCount(0)
    await visualScreenshot(page, `provider-credential-form-${theme}`)
  })

  test(`provider credential inventory — ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript((value) => localStorage.setItem('bm-theme', value), theme)
    await addCredential(page)
    await page.goto('/settings/credentials')
    await expect(page.getByTestId('credential-list')).toBeVisible()
    await visualScreenshot(page, `provider-credentials-table-${theme}`)
  })

  test(`provider resource inventory — ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript((value) => localStorage.setItem('bm-theme', value), theme)
    await addResource(page)
    await page.goto('/settings/providers')
    await expect(page.getByTestId('provider-list')).toBeVisible()
    await visualScreenshot(page, `provider-resources-table-${theme}`)
  })

  test(`provider resource task disclosures — ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript((value) => localStorage.setItem('bm-theme', value), theme)
    await addResource(page)
    await page.goto('/settings/providers')
    await page.getByRole('button', { name: 'Edit Primary model' }).click()
    await expect(page.getByTestId('provider-advanced-content')).toHaveCount(0)
    await expect(page.getByTestId('provider-checks')).toBeVisible()
    await expect(page.getByTestId('provider-sharing')).toBeVisible()
    await page.getByTestId('provider-checks-toggle').click()
    await page.getByRole('textbox', { name: 'Model 1 name' }).fill('dirty-openai/gpt-5')
    await expect(page.getByText('Save changes first to Validate or Share.')).toBeVisible()
    await visualScreenshot(page, `provider-resource-tasks-${theme}`)
  })
}
