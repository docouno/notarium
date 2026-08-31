import type { Page, Route } from '@playwright/test'

import { expect, test, treeNote } from './fixtures'

const TITANIUM_PATH = '/n/fake-demo-titanium'
const SPA_LOAD_SIZE = '@spa-load-size'

const javaScriptKey = (url: string) => {
  const parsed = new URL(url)

  return `${parsed.pathname}${parsed.search}`
}

const isJavaScript = (url: URL) => url.pathname.endsWith('.js')

const observeJavaScript = (page: Page) => {
  const requested = new Set<string>()

  page.on('request', (request) => {
    const url = new URL(request.url())

    if (isJavaScript(url)) {
      requested.add(javaScriptKey(request.url()))
    }
  })

  return requested
}

const loadedJavaScript = async (page: Page): Promise<Set<string>> =>
  new Set(
    await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((entry) => new URL(entry.name))
        .filter((url) => url.pathname.endsWith('.js'))
        .map((url) => `${url.pathname}${url.search}`),
    ),
  )

const settleJavaScriptDemand = async (page: Page) => {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const response = await fetch('/api/health')

    if (!response.ok) {
      throw new Error(`UI settle request failed with ${response.status}`)
    }
  })
}

const holdExactJavaScript = async (page: Page, javaScript: ReadonlySet<string>) => {
  let open!: () => void
  let released = false
  const held = new Promise<void>((resolve) => {
    open = resolve
  })
  const requested = new Set<string>()

  await page.route(
    (url) => javaScript.has(javaScriptKey(url.href)),
    async (route) => {
      requested.add(javaScriptKey(route.request().url()))
      await held
      await route.continue()
    },
  )

  return {
    requested,
    release: () => {
      if (!released) {
        released = true
        open()
      }
    },
  }
}

type PendingJavaScript = {
  route: Route
  unblock: () => void
}

const gateNewJavaScript = async (page: Page, allowed: ReadonlySet<string>) => {
  let mode: 'hold' | 'pass' | 'abort' = 'hold'
  const intercepted = new Set<string>()
  const pending = new Set<PendingJavaScript>()

  await page.route(isJavaScript, async (route) => {
    const key = javaScriptKey(route.request().url())

    if (allowed.has(key) || mode === 'pass') {
      await route.continue()
      return
    }
    intercepted.add(key)

    if (mode === 'abort') {
      await route.abort()
      return
    }

    await new Promise<void>((unblock) => {
      pending.add({ route, unblock })
    })
  })

  const settle = async (next: 'pass' | 'abort') => {
    mode = next
    const batch = [...pending]
    pending.clear()

    await Promise.all(
      batch.map(async ({ route, unblock }) => {
        try {
          if (next === 'pass') {
            await route.continue()
          } else {
            await route.abort()
          }
        } finally {
          unblock()
        }
      }),
    )
  }

  return {
    blockedCount: () => pending.size,
    interceptedCount: () => intercepted.size,
    release: () => settle('pass'),
    abort: () => settle('abort'),
  }
}

const htmlAttribute = (tag: string, name: string) =>
  new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)?.[1]

const eagerJavaScriptFromHtml = async (page: Page) => {
  const response = await page.request.get('/')
  expect(response.ok()).toBe(true)
  const html = await response.text()
  const moduleScripts = [...html.matchAll(/<script\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => htmlAttribute(tag, 'type')?.toLowerCase() === 'module')
    .map((tag) => htmlAttribute(tag, 'src'))
    .filter((src): src is string => Boolean(src?.match(/\.js(?:\?|$)/)))
  const modulePreloads = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) =>
      htmlAttribute(tag, 'rel')?.toLowerCase().split(/\s+/).includes('modulepreload'),
    )
    .map((tag) => htmlAttribute(tag, 'href'))
    .filter((href): href is string => Boolean(href?.match(/\.js(?:\?|$)/)))

  expect(moduleScripts).toHaveLength(1)
  expect(modulePreloads).toHaveLength(2)

  const eager = new Set(
    [...moduleScripts, ...modulePreloads].map((asset) =>
      javaScriptKey(new URL(asset, response.url()).href),
    ),
  )

  expect(eager.size).toBe(3)
  return eager
}

const openFreshTitaniumRead = async (page: Page) => {
  await page.addInitScript(() => localStorage.setItem('bm-aside', '0'))
  const requested = observeJavaScript(page)

  await page.goto(TITANIUM_PATH)
  await expect(page.getByRole('heading', { name: 'Titanium', level: 1 })).toBeVisible()
  await expect(page.locator('.cm-content')).toHaveCount(0)
  await settleJavaScriptDemand(page)
  const settled = [...requested].sort()
  await settleJavaScriptDemand(page)
  expect([...requested].sort()).toEqual(settled)

  return requested
}

test(`${SPA_LOAD_SIZE} ordinary note read defers editor JavaScript until Edit and keeps the editor usable`, async ({
  page,
  browser,
  baseURL,
}) => {
  if (!baseURL) {
    throw new Error('baseURL is required')
  }

  await openFreshTitaniumRead(page)
  await page.evaluate(() => performance.clearResourceTimings())
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await settleJavaScriptDemand(page)
  const discoveredEditorJavaScript = await loadedJavaScript(page)

  expect(discoveredEditorJavaScript.size).toBeGreaterThan(0)

  const proofContext = await browser.newContext({ baseURL })
  await proofContext.addInitScript(() => {
    ;(window as unknown as { __NOTARIUM_TEST__: boolean }).__NOTARIUM_TEST__ = true
    localStorage.setItem('bm-aside', '0')
  })
  const proofPage = await proofContext.newPage()
  const gate = await holdExactJavaScript(proofPage, discoveredEditorJavaScript)

  try {
    await openFreshTitaniumRead(proofPage)
    expect(gate.requested.size).toBe(0)

    await proofPage.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(proofPage.getByTestId('editor-loading-skeleton')).toBeVisible()
    await expect
      .poll(() => [...gate.requested].sort())
      .toEqual([...discoveredEditorJavaScript].sort())

    gate.release()
    const editor = proofPage.locator('.cm-content')
    await expect(editor).toBeVisible()
    await editor.fill('# Titanium\n\nLazy editor is working.')
    await expect(editor).toContainText('Lazy editor is working.')
    await expect(proofPage.getByRole('button', { name: 'Save' })).toBeEnabled()
  } finally {
    gate.release()
    await proofContext.close()
  }
})

test(`${SPA_LOAD_SIZE} ordinary note read defers local graph JavaScript until a renderable Graph panel`, async ({
  page,
  browser,
  baseURL,
}) => {
  if (!baseURL) {
    throw new Error('baseURL is required')
  }

  await openFreshTitaniumRead(page)
  await page.evaluate(() => performance.clearResourceTimings())
  await page.getByRole('button', { name: 'Open panel' }).click()
  await page.waitForFunction(
    () => !!window.__graphTest?.nodes().some((node) => node.id === 'fake-demo-titanium'),
  )
  await settleJavaScriptDemand(page)
  const discoveredGraphJavaScript = await loadedJavaScript(page)

  expect(discoveredGraphJavaScript.size).toBeGreaterThan(0)

  const proofContext = await browser.newContext({ baseURL })
  await proofContext.addInitScript(() => {
    ;(window as unknown as { __NOTARIUM_TEST__: boolean }).__NOTARIUM_TEST__ = true
    localStorage.setItem('bm-aside', '0')
  })
  const proofPage = await proofContext.newPage()
  const gate = await holdExactJavaScript(proofPage, discoveredGraphJavaScript)

  try {
    await openFreshTitaniumRead(proofPage)
    expect(gate.requested.size).toBe(0)

    await proofPage.getByRole('button', { name: 'Open panel' }).click()
    await expect(proofPage.getByTestId('localgraph-skeleton')).toBeVisible()
    await expect
      .poll(() => [...gate.requested].sort())
      .toEqual([...discoveredGraphJavaScript].sort())

    gate.release()
    await proofPage.waitForFunction(
      () => !!window.__graphTest?.nodes().some((node) => node.id === 'fake-demo-titanium'),
    )
    await expect(proofPage.getByTestId('localgraph-skeleton')).toHaveCount(0)
  } finally {
    gate.release()
    await proofContext.close()
  }
})

test(`${SPA_LOAD_SIZE} persisted Meta tab does not load canvas before Graph becomes active`, async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('bm-aside', '1')
    localStorage.setItem(
      'bm-aside-groups',
      JSON.stringify([{ activeTab: 'meta', height: 260 }, { activeTab: 'links' }]),
    )
  })
  const readJavaScript = observeJavaScript(page)

  await page.goto(TITANIUM_PATH)
  await expect(page.getByRole('heading', { name: 'Titanium', level: 1 })).toBeVisible()
  await expect(page.getByTestId('meta-panel')).toBeVisible()
  await expect(page.getByTestId('localgraph-skeleton')).toHaveCount(0)
  const gate = await gateNewJavaScript(page, new Set(readJavaScript))

  await page.getByTestId('aside-tab-graph').click()
  await expect(page.getByTestId('localgraph-skeleton')).toBeVisible()
  await expect.poll(gate.blockedCount).toBeGreaterThan(0)
  expect(gate.interceptedCount()).toBeGreaterThan(0)

  await gate.release()
  await page.waitForFunction(
    () => !!window.__graphTest?.nodes().some((node) => node.id === 'fake-demo-titanium'),
  )
})

test(`${SPA_LOAD_SIZE} one-node local graph reaches EmptyState without requesting canvas JavaScript`, async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('bm-aside', '0'))
  const readJavaScript = observeJavaScript(page)

  await page.goto('/n/fake-demo-my-note')
  await expect(page.getByRole('heading', { name: 'My Note', level: 1 })).toBeVisible()
  const gate = await gateNewJavaScript(page, new Set(readJavaScript))

  await page.getByRole('button', { name: 'Open panel' }).click()
  await expect(page.getByTestId('localgraph-empty')).toBeVisible()
  expect(gate.blockedCount()).toBe(0)
  expect(gate.interceptedCount()).toBe(0)
})

test(`${SPA_LOAD_SIZE} an aborted ordinary EditorBody chunk reaches the existing page error boundary`, async ({
  page,
}) => {
  const readJavaScript = await openFreshTitaniumRead(page)
  const gate = await gateNewJavaScript(page, new Set(readJavaScript))

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByTestId('editor-loading-skeleton')).toBeVisible()
  await expect.poll(gate.blockedCount).toBeGreaterThan(0)
  await gate.abort()

  await expect(page.getByTestId('crash-state')).toBeVisible()
})

test(`${SPA_LOAD_SIZE} an aborted local ForceGraphCanvas chunk reaches the existing page error boundary`, async ({
  page,
}) => {
  const readJavaScript = await openFreshTitaniumRead(page)
  const gate = await gateNewJavaScript(page, new Set(readJavaScript))

  await page.getByRole('button', { name: 'Open panel' }).click()
  await expect(page.getByTestId('localgraph-skeleton')).toBeVisible()
  await expect.poll(gate.blockedCount).toBeGreaterThan(0)
  await gate.abort()

  await expect(page.getByTestId('crash-state')).toBeVisible()
})

type ColdRouteScenario = {
  name: string
  path: string
  verify: (page: Page) => Promise<void>
}

const coldRoutes: ColdRouteScenario[] = [
  {
    name: 'space home',
    path: '/',
    verify: async (page) => {
      await expect(page).toHaveURL(/\/s\/main$/)
      await expect(page.getByTestId('home-dashboard')).toBeVisible()
      await expect(treeNote(page, 'Titanium')).toBeVisible()
    },
  },
  {
    name: 'note',
    path: TITANIUM_PATH,
    verify: async (page) => {
      await expect(page.getByRole('heading', { name: 'Titanium', level: 1 })).toBeVisible()
    },
  },
  {
    name: 'Settings',
    path: '/settings/appearance',
    verify: async (page) => {
      await expect(page.getByTestId('settings-tab-appearance')).toHaveAttribute(
        'aria-current',
        'page',
      )
      await expect(page.getByTestId('reading-font-select')).toBeVisible()
    },
  },
  {
    name: 'Graph',
    path: '/s/main/graph',
    verify: async (page) => {
      await page.waitForFunction(() => !!window.__graphTest?.nodes().length)
      await expect(page.getByTestId('rail-graph')).toHaveAttribute('aria-current', 'page')
    },
  },
  {
    name: 'Agents',
    path: '/agents/abilities/roles',
    verify: async (page) => {
      await expect(page.getByTestId('agents-roles')).toBeVisible()
      await expect(page.getByTestId('rail-agents')).toHaveAttribute('aria-current', 'page')
    },
  },
]

for (const scenario of coldRoutes) {
  test(`${SPA_LOAD_SIZE} cold ${scenario.name} keeps AppShell visible while its route JavaScript is held`, async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('bm-aside', '0'))
    const eagerJavaScript = await eagerJavaScriptFromHtml(page)
    const spacesStarted = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/api/spaces',
    )
    const gate = await gateNewJavaScript(page, eagerJavaScript)

    await page.goto(scenario.path, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('route-loading-skeleton')).toBeVisible()
    await expect(page.getByTestId('rail-scroll')).toBeVisible()
    await spacesStarted
    await expect.poll(gate.blockedCount).toBeGreaterThan(0)
    expect(gate.interceptedCount()).toBeGreaterThan(0)

    await gate.release()
    await expect(page.getByTestId('route-loading-skeleton')).toHaveCount(0)
    await scenario.verify(page)
  })
}

test(`${SPA_LOAD_SIZE} remaining lazy base-fixture branches work by direct URL and internal navigation`, async ({
  page,
}) => {
  await page.goto('/s/main/trash')
  await expect(page.getByTestId('trash-page')).toBeVisible()

  await page.goto('/s/main/management/projects')
  await expect(page.getByRole('heading', { name: 'Projects', level: 3 })).toBeVisible()
  await expect(page.getByTestId('projects-list')).toBeVisible()

  await page.goto('/s/main/feed')
  await expect(page.getByTestId('feed-row').first()).toBeVisible()

  await page.goto('/s/main/files/demo')
  await expect(page.getByTestId('virtual-folder-page')).toBeVisible()

  await treeNote(page, 'Titanium').click()
  await expect(page.getByRole('heading', { name: 'Titanium', level: 1 })).toBeVisible()
  await page.getByTestId('rail-trash').click()
  await expect(page.getByTestId('trash-page')).toBeVisible()
  await page.getByTestId('rail-files').click()
  await expect(page.getByTestId('feed-row').first()).toBeVisible()

  await treeNote(page, 'Carbon').click()
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'demo', exact: true })
    .click()
  await expect(page.getByTestId('virtual-folder-page')).toBeVisible()

  const created = await page.request.post('/api/s/main/folders/page', {
    data: { folderPath: 'demo', content: '# demo\n\nOverview.' },
  })
  expect(created.status()).toBe(201)
  const { folderId } = (await created.json()) as { folderId: string }

  await page.goto(`/folder/${folderId}`)
  await expect(page).toHaveURL(/\/n\/.+\/demo$/)
  await expect(page.getByRole('heading', { name: 'demo', level: 1 })).toBeVisible()
})
