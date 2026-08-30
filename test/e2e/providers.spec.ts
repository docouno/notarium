import type { APIRequestContext } from '@playwright/test'
import { expect, test } from './fixtures'

const createCredential = async (request: APIRequestContext) => {
  const response = await request.post('/api/providers/credentials', {
    data: {
      name: 'OpenRouter key',
      kind: 'bearer',
      secret: 'browser-proof-secret-value',
      origin: 'https://provider.example',
      injection: { header: '', prefix: 'Bearer ' },
    },
  })
  expect(response.ok()).toBe(true)
  return (await response.json()).credential as { id: string }
}

const createResource = async (
  request: APIRequestContext,
  input: { name: string; credentialId: string | null; baseUrl?: string },
) => {
  const response = await request.post('/api/providers/resources', {
    data: {
      name: input.name,
      wire: 'openai-compatible',
      baseUrl: input.baseUrl ?? 'https://provider.example/v1',
      purposes: ['chat'],
      models: [
        {
          name: `<img src=x onerror=alert(1)> ${'very-long-model-name-'.repeat(8)}`,
          dimensions: null,
          status: 'available',
        },
      ],
      defaultModel: null,
      credentialId: input.credentialId,
      headers: { 'X-Tenant-Internal': 'header-secret-value' },
    },
  })
  expect(response.ok()).toBe(true)
  return (await response.json()).resource as { id: string }
}

const mainSpaceId = async (request: APIRequestContext): Promise<string> => {
  const response = await request.get('/api/spaces')
  const body = await response.json()
  return body.spaces.find((space: { slug: string }) => space.slug === 'main').id
}

test('credentials stay write-only and a refused delete explains every reference', async ({
  page,
}) => {
  const credential = await createCredential(page.request)
  await createResource(page.request, { name: 'Primary', credentialId: credential.id })
  await createResource(page.request, {
    name: 'Secondary',
    credentialId: credential.id,
    baseUrl: 'https://provider.example/v2',
  })
  const providerReads: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname

    if (request.method() === 'GET' && path.startsWith('/api/providers/')) {
      providerReads.push(path)
    }
  })

  await page.goto('/settings/credentials')
  await expect(page.getByTestId('settings-tab-credentials')).toBeVisible()
  await expect(page.getByTestId('credential-list')).toContainText('OpenRouter key')
  await expect(page.locator('body')).not.toContainText('browser-proof-secret-value')
  await page.getByRole('button', { name: 'Edit OpenRouter key' }).click()
  await expect(page.getByTestId('credential-list')).toBeVisible()
  await expect(page.getByTestId('credential-advanced-content')).toHaveCount(0)
  await expect(page.getByTestId('credential-references')).toHaveCount(0)
  await expect(page.getByTestId('credential-advanced-toggle')).toContainText('default header')
  await expect(page.getByTestId('credential-usage-toggle')).toContainText('2 provider resources')
  await expect(page.getByTestId('credential-secret')).toHaveValue('')
  expect(
    providerReads.filter((path) => /^\/api\/providers\/credentials\/[^/]+$/u.test(path)),
  ).toHaveLength(1)
  expect(
    providerReads.filter((path) => /^\/api\/providers\/resources\/[^/]+$/u.test(path)),
  ).toHaveLength(0)
  expect(providerReads.filter((path) => path === '/api/providers/resources')).toHaveLength(0)
  await page.getByTestId('credential-usage-toggle').click()
  await expect(page.getByTestId('credential-references')).toContainText('Primary')
  await expect(page.getByTestId('credential-references')).toContainText('Secondary')
  await page.getByRole('button', { name: 'Retarget resources…' }).click()
  await expect(page.getByTestId('credential-retarget-form')).toBeVisible()
  expect(providerReads.filter((path) => path === '/api/providers/resources')).toHaveLength(1)
  expect(
    providerReads.filter((path) => /^\/api\/providers\/resources\/[^/]+$/u.test(path)),
  ).toHaveLength(0)
  await page.getByTestId('credential-retarget-form').getByRole('button', { name: 'Cancel' }).click()
  await page.getByTestId('credential-name').fill('OpenRouter key renamed')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('credential-edit-form')).toHaveCount(0)
  await expect(page.getByTestId('credential-list')).toContainText('OpenRouter key renamed')
  await page.getByRole('button', { name: 'Delete OpenRouter key renamed' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('credential-edit-form')).toBeVisible()
  await expect(page.getByTestId('credential-references')).toContainText('Primary')
  await expect(page.getByTestId('credential-references')).toContainText('Secondary')
  await expect(page.locator('body')).not.toContainText('browser-proof-secret-value')
})

test('resource save closes the editor and returns to the refreshed table', async ({ page }) => {
  await createResource(page.request, { name: 'Editable provider', credentialId: null })
  await page.goto('/settings/providers')
  await expect(page.getByTestId('provider-list')).toBeVisible()
  await page.getByRole('button', { name: 'Edit Editable provider' }).click()
  await expect(page.getByTestId('provider-list')).toBeVisible()
  await expect(page.getByTestId('provider-advanced-content')).toHaveCount(0)
  await expect(page.getByTestId('provider-statuses')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Ask for consent' })).toHaveCount(0)
  await expect(page.getByTestId('provider-advanced-toggle')).toContainText('1 custom header')
  await page.getByTestId('provider-advanced-toggle').click()
  await expect(page.getByTestId('provider-private-opt-in')).toBeVisible()
  await page.getByTestId('provider-name').fill('Provider renamed')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('provider-edit-form')).toHaveCount(0)
  await expect(page.getByTestId('provider-list')).toContainText('Provider renamed')
  await page.getByRole('button', { name: 'Edit Provider renamed' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('provider-edit-form')).toHaveCount(0)
  await page.getByRole('button', { name: 'Delete Provider renamed' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('provider-row')).toHaveCount(0)
  await expect(page.getByText('No model providers yet')).toBeVisible()
})

test('resource disclosure precedes save and a Space owner accepts a literal safe diff', async ({
  page,
}) => {
  let validateCalls = 0
  await page.route('**/api/providers/resources/*/validate', async (route) => {
    validateCalls++
    await route.continue()
  })
  await page.goto('/settings/providers')
  await page.getByTestId('provider-new').click()
  await expect(page.getByTestId('provider-advanced-content')).toHaveCount(0)
  await expect(page.getByTestId('provider-checks')).toHaveCount(0)
  await expect(page.getByTestId('provider-sharing')).toHaveCount(0)
  await expect(page.getByTestId('provider-disclosure')).toContainText('https://openrouter.ai')
  expect(validateCalls).toBe(0)

  const resource = await createResource(page.request, {
    name: 'Shared model',
    credentialId: null,
  })
  const spaceId = await mainSpaceId(page.request)
  const offered = await page.request.post('/api/providers/attachments', {
    data: { resourceId: resource.id, targetKind: 'space', targetId: spaceId },
  })
  expect(offered.ok()).toBe(true)

  await page.goto('/s/main/management/providers')
  const card = page.getByTestId('provider-attachment')
  await expect(card).not.toContainText('https://provider.example/v1')
  await expect(card).not.toContainText('x-tenant-internal')
  await expect(card).not.toContainText('header-secret-value')
  await expect(card).not.toContainText('browser-proof-secret-value')
  await card.getByTestId('provider-attachment-review').click()
  let detail = page.getByTestId('provider-attachment-detail')
  await expect(detail).toContainText('https://provider.example/v1')
  await expect(detail).toContainText('x-tenant-internal')
  await expect(detail).not.toContainText('header-secret-value')
  await expect(detail).not.toContainText('browser-proof-secret-value')
  await expect(card.locator('img')).toHaveCount(0)
  await expect(detail).toContainText('<img src=x onerror=alert(1)>')
  await detail.getByTestId('provider-attachment-accept').click()
  await expect(card).toContainText('active')

  const patched = await page.request.patch(`/api/providers/resources/${resource.id}`, {
    data: { baseUrl: 'https://provider.example/v2' },
  })
  expect(patched.ok()).toBe(true)
  await page.reload()
  await card.getByTestId('provider-attachment-review').click()
  detail = page.getByTestId('provider-attachment-detail')
  await expect(detail.getByTestId('provider-disclosure-diff')).toContainText(
    'https://provider.example/v1',
  )
  await expect(detail.getByTestId('provider-disclosure-diff')).toContainText(
    'https://provider.example/v2',
  )
  await detail.getByTestId('provider-attachment-accept').click()
  await expect(card).toContainText('active')
})

test('Review disclosure stays anchored and focused on a 100-row consent page', async ({ page }) => {
  test.slow()
  const spaceId = await mainSpaceId(page.request)

  for (let index = 0; index < 100; index += 1) {
    const resource = await createResource(page.request, {
      name: `Consent resource ${String(index).padStart(3, '0')}`,
      credentialId: null,
      baseUrl: `https://provider-${index}.example/v1`,
    })
    const offered = await page.request.post('/api/providers/attachments', {
      data: { resourceId: resource.id, targetKind: 'space', targetId: spaceId },
    })
    expect(offered.ok()).toBe(true)
  }

  await page.goto('/s/main/management/providers')
  const cards = page.getByTestId('provider-attachment')
  await expect(cards).toHaveCount(100)
  await cards.first().getByTestId('provider-attachment-review').click()
  const detail = page.getByTestId('provider-attachment-detail')

  await expect(detail).toBeInViewport()
  await expect(detail).toBeFocused()
  await expect(detail.getByTestId('provider-attachment-accept')).toBeVisible()
  expect(
    await detail.evaluate((element) => element.previousElementSibling?.getAttribute('data-testid')),
  ).toBe('provider-attachment')
  await detail.getByTestId('provider-attachment-accept').click()
  await expect(cards.first()).toContainText('active')
})
