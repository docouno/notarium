import type { Locator, Page } from '@playwright/test'
import { buildCaseWorld, caseToFixture, DEFAULT_NOW } from '../cases'
import { POSITION_SENTINEL } from '../cases/cases/longDocument'
import { expect, test } from './fixtures'

const FIXTURE = caseToFixture(buildCaseWorld('long-document', { now: DEFAULT_NOW }))
const SPACE = FIXTURE.spaces.find((space) => space.slug === 'reader-cases')!

const noteId = (title: string): string => {
  const id = SPACE.notes.find((note) => note.title === title)?.id

  if (!id) {
    throw new Error(`long-document fixture is missing note: ${title}`)
  }

  return id
}
const STRUCTURED_ID = noteId('Structured position witness')
const FLAT_ID = noteId('Flat position witness')
const READING_LIST_ID = noteId('Reading list')

const javaScriptKey = (url: string): string => {
  const parsed = new URL(url)

  return `${parsed.pathname}${parsed.search}`
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

test.beforeEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.setViewportSize({ width: 1280, height: 720 })
})

const readerSentinel = (page: Page, text: string): Locator =>
  page.locator('[data-document-position-root] p').filter({ hasText: text })

const positionInVisibleBand = async (locator: Locator) =>
  locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const chrome =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chrome-h')) || 0

    return { top: rect.top, bottom: rect.bottom, chrome, viewport: window.innerHeight }
  })

const expectInVisibleBand = async (locator: Locator) => {
  await expect(locator).toBeVisible()
  await expect
    .poll(async () => positionInVisibleBand(locator))
    .toMatchObject({ chrome: 52, viewport: 720 })
  const position = await positionInVisibleBand(locator)

  expect(position.top).toBeGreaterThanOrEqual(position.chrome - 2)
  expect(position.bottom).toBeLessThan(position.viewport - 28)
}

const scrollReaderTo = async (locator: Locator, immediateEdit = false) => {
  await expect(locator).toBeAttached()
  await locator.evaluate((element, editNow) => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="content-scroll"]')!
    const rect = element.getBoundingClientRect()
    const scrollerRect = scroller.getBoundingClientRect()
    const chrome =
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chrome-h')) || 0
    scroller.scrollTop += rect.top - (scrollerRect.top + chrome + 8)

    if (editNow) {
      // Same task as the scroll write: the maintained rAF snapshot is stale, so
      // only EditingProvider's synchronous pre-startEdit flush can observe this.
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'e',
          code: 'KeyE',
          bubbles: true,
          cancelable: true,
        }),
      )
    }
  }, immediateEdit)
}

const scrollEditorToLine = async (page: Page, text: string): Promise<Locator> => {
  const line = page.locator('.cm-line').filter({ hasText: text })

  for (let step = 0; step < 60; step++) {
    if ((await line.count()) > 0) {
      await line.evaluate((element) => {
        const scroller = document.querySelector<HTMLElement>('[data-testid="content-scroll"]')!
        const chrome =
          parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chrome-h')) || 0
        scroller.scrollTop +=
          element.getBoundingClientRect().top - (scroller.getBoundingClientRect().top + chrome + 8)
      })
      return line
    }
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const scroller = document.querySelector<HTMLElement>('[data-testid="content-scroll"]')!
          scroller.scrollTop += 500
          requestAnimationFrame(() => resolve())
        }),
    )
  }

  throw new Error(`editor line did not enter the rendered viewport: ${text}`)
}

const discoverEditorJavaScript = async (page: Page): Promise<Set<string>> => {
  await page.goto(`/n/${STRUCTURED_ID}`)
  await expect(readerSentinel(page, POSITION_SENTINEL.structuredThreeQuarters)).toBeAttached()
  await settleJavaScriptDemand(page)
  await page.evaluate(() => performance.clearResourceTimings())
  await page.getByRole('button', { name: 'Edit' }).click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await settleJavaScriptDemand(page)
  const editorJavaScript = await loadedJavaScript(page)

  expect(editorJavaScript.size).toBeGreaterThan(0)
  return editorJavaScript
}

const openEditorAt = async (
  page: Page,
  note: string,
  sentinel: string,
  mode: 'source' | 'wysiwym',
  immediateEdit = false,
  exactCaret = true,
) => {
  await page.addInitScript((editorMode) => {
    localStorage.setItem('bm-editor-mode', editorMode)
  }, mode)
  await page.goto(`/n/${note}`)
  const reader = readerSentinel(page, sentinel)
  await scrollReaderTo(reader, immediateEdit)

  if (!immediateEdit) {
    await page.getByRole('button', { name: 'Edit' }).click()
  }
  const editor = page.locator('.cm-content')
  await expect(editor).toBeVisible()
  const activeLine = page.locator('.cm-activeLine')
  const sentinelLine = page.locator('.cm-line').filter({ hasText: sentinel })

  if (exactCaret) {
    await expect(activeLine).toContainText(sentinel)
  } else {
    await expectInVisibleBand(sentinelLine)
    const lineDistance = await sentinelLine.evaluate((line) => {
      const active = document.querySelector('.cm-activeLine')!.getBoundingClientRect()
      const target = line.getBoundingClientRect()

      return Math.abs(active.top - target.top)
    })
    expect(lineDistance).toBeLessThan(50)
  }
  // Transfer deliberately runs after CodeMirror's own mount-time chrome frame.
  // Two layout frames settle that one-shot hand-off; this is frame readiness,
  // not a wall-clock sleep or a retry.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  await expect.poll(async () => (await positionInVisibleBand(activeLine)).top).toBeLessThan(150)
  await expectInVisibleBand(activeLine)

  return { editor, activeLine }
}

test('cold lazy editor aligns the transferred line after its chunk becomes measurable', async ({
  page,
  browser,
  baseURL,
}) => {
  if (!baseURL) {
    throw new Error('browser baseURL is required')
  }
  const editorJavaScript = await discoverEditorJavaScript(page)

  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } })
  await context.addInitScript(() => {
    const mutation = new MutationObserver(() => {
      if (!document.querySelector('.cm-content')) {
        return
      }
      mutation.disconnect()
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const scroller = document.querySelector<HTMLElement>('[data-testid="content-scroll"]')

          if (scroller) {
            scroller.scrollTop -= 400
            ;(
              window as typeof window & { __lateEditorViewportShift?: number }
            ).__lateEditorViewportShift = 1
          }
        })
      })
    })
    mutation.observe(document, { childList: true, subtree: true })
  })
  const proofPage = await context.newPage()
  const gate = await holdExactJavaScript(proofPage, editorJavaScript)

  try {
    await proofPage.goto(`/n/${STRUCTURED_ID}`)
    const sentinel = readerSentinel(proofPage, POSITION_SENTINEL.structuredThreeQuarters)
    await scrollReaderTo(sentinel)
    await proofPage.getByRole('button', { name: 'Edit' }).click()
    await expect(proofPage.getByTestId('editor-loading-skeleton')).toBeVisible()
    await expect.poll(() => gate.requested.size).toBe(editorJavaScript.size)

    gate.release()
    const activeLine = proofPage.locator('.cm-activeLine')
    await expect(activeLine).toContainText(POSITION_SENTINEL.structuredThreeQuarters)
    await expect
      .poll(() =>
        proofPage.evaluate(
          () =>
            (window as typeof window & { __lateEditorViewportShift?: number })
              .__lateEditorViewportShift ?? 0,
        ),
      )
      .toBe(1)
    await expect.poll(async () => (await positionInVisibleBand(activeLine)).top).toBeLessThan(150)
    await expectInVisibleBand(activeLine)
  } finally {
    gate.release()
    await context.close()
  }
})

for (const action of ['Escape', 'Control+s']) {
  test(`cold lazy editor ${action} restores the reader before its body resolves`, async ({
    page,
    browser,
    baseURL,
  }) => {
    if (!baseURL) {
      throw new Error('browser baseURL is required')
    }
    const editorJavaScript = await discoverEditorJavaScript(page)
    const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } })
    const proofPage = await context.newPage()
    const gate = await holdExactJavaScript(proofPage, editorJavaScript)
    const writes: string[] = []

    proofPage.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/note') {
        writes.push(request.url())
      }
    })

    try {
      await proofPage.goto(`/n/${STRUCTURED_ID}`)
      const sentinel = readerSentinel(proofPage, POSITION_SENTINEL.structuredThreeQuarters)
      await scrollReaderTo(sentinel)
      await proofPage.getByRole('button', { name: 'Edit' }).click()
      await expect(proofPage.getByTestId('editor-loading-skeleton')).toBeVisible()
      await expect.poll(() => gate.requested.size).toBe(editorJavaScript.size)

      await proofPage.keyboard.press(action)
      await expect(proofPage.locator('.cm-content')).toHaveCount(0)
      await expectInVisibleBand(sentinel)
      expect(writes).toHaveLength(0)
    } finally {
      gate.release()
      await context.close()
    }
  })
}

test('cold lazy failed dirty Save resumes the pending entry alignment', async ({
  page,
  browser,
  baseURL,
}) => {
  if (!baseURL) {
    throw new Error('browser baseURL is required')
  }
  const editorJavaScript = await discoverEditorJavaScript(page)
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } })
  await context.addInitScript(() => localStorage.setItem('bm-aside', '1'))
  const proofPage = await context.newPage()
  const gate = await holdExactJavaScript(proofPage, editorJavaScript)
  let saveAttempted = false

  await proofPage.route('**/api/note', async (route) => {
    if (!saveAttempted && route.request().method() === 'POST') {
      saveAttempted = true
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"held"}',
      })
      return
    }
    await route.continue()
  })

  try {
    await proofPage.goto(`/n/${STRUCTURED_ID}`)
    const sentinel = readerSentinel(proofPage, POSITION_SENTINEL.structuredThreeQuarters)
    await scrollReaderTo(sentinel)
    await proofPage.getByRole('button', { name: 'Edit' }).click()
    await expect(proofPage.getByTestId('editor-loading-skeleton')).toBeVisible()
    await expect.poll(() => gate.requested.size).toBe(editorJavaScript.size)
    await proofPage.getByLabel('Slug').fill('failed-save-slug')
    await proofPage.keyboard.press('Control+s')

    await expect.poll(() => saveAttempted).toBe(true)
    await expect(proofPage.getByTestId('editor-loading-skeleton')).toBeVisible()
    gate.release()
    const activeLine = proofPage.locator('.cm-activeLine')
    await expect(activeLine).toContainText(POSITION_SENTINEL.structuredThreeQuarters)
    await expectInVisibleBand(activeLine)
  } finally {
    gate.release()
    await context.close()
  }
})

for (const mode of ['source', 'wysiwym'] as const) {
  test(`structured reader → ${mode} uses the immediate pre-edit position and Cancel restores it`, async ({
    page,
  }) => {
    await openEditorAt(page, STRUCTURED_ID, POSITION_SENTINEL.structuredQuarter, mode, true)
    await page.keyboard.press('Escape')
    const restored = readerSentinel(page, POSITION_SENTINEL.structuredQuarter)
    await expectInVisibleBand(restored)
  })

  test(`${mode} viewport wins over a stale caret on clean Save`, async ({ page }) => {
    await openEditorAt(page, STRUCTURED_ID, POSITION_SENTINEL.structuredQuarter, mode)
    const before = await (await page.request.get(`/api/note?id=${STRUCTURED_ID}`)).json()
    const writes: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/note') {
        writes.push(request.url())
      }
    })

    const secondLine = await scrollEditorToLine(page, POSITION_SENTINEL.structuredThreeQuarters)
    await expectInVisibleBand(secondLine)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }),
    )
    await expectInVisibleBand(secondLine)
    // The caret remains at the quarter sentinel. Save must freeze visible-top B.
    await expect(page.locator('.cm-activeLine')).toContainText(POSITION_SENTINEL.structuredQuarter)
    await page.keyboard.press('Control+s')

    const restored = readerSentinel(page, POSITION_SENTINEL.structuredThreeQuarters)
    await expectInVisibleBand(restored)
    const after = await (await page.request.get(`/api/note?id=${STRUCTURED_ID}`)).json()
    expect(writes).toHaveLength(0)
    expect(after.content).toBe(before.content)
    expect(after.versionToken).toBe(before.versionToken)
  })
}

for (const sentinel of [POSITION_SENTINEL.flatFirst, POSITION_SENTINEL.flatSecond]) {
  test(`flat document fallback preserves ${sentinel}`, async ({ page }) => {
    await openEditorAt(page, FLAT_ID, sentinel, 'source', false, false)
    await page.keyboard.press('Escape')
    await expectInVisibleBand(readerSentinel(page, sentinel))
  })
}

test('dirty Save freezes visible-top and restores against the committed reader', async ({
  page,
}) => {
  await openEditorAt(page, STRUCTURED_ID, POSITION_SENTINEL.structuredQuarter, 'source')
  await page.keyboard.insertText('edited ')
  const secondLine = await scrollEditorToLine(page, POSITION_SENTINEL.structuredThreeQuarters)
  await expectInVisibleBand(secondLine)
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/note') {
      writes.push(request.url())
    }
  })
  await page.keyboard.press('Control+s')
  await expectInVisibleBand(readerSentinel(page, POSITION_SENTINEL.structuredThreeQuarters))
  expect(writes).toHaveLength(1)
})

test('a same-note canonical slug replacement keeps pending position intent', async ({ page }) => {
  await openEditorAt(page, STRUCTURED_ID, POSITION_SENTINEL.structuredQuarter, 'source')
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('End')
  await page.keyboard.insertText(' renamed')
  const secondLine = await scrollEditorToLine(page, POSITION_SENTINEL.structuredThreeQuarters)
  await expectInVisibleBand(secondLine)
  await page.keyboard.press('Control+s')
  await expect(page).toHaveURL(
    new RegExp(`/n/${STRUCTURED_ID}/structured-position-witness-renamed$`),
  )
  await expectInVisibleBand(readerSentinel(page, POSITION_SENTINEL.structuredThreeQuarters))
})

test('navigation to a different note clears position intent instead of scrolling the target', async ({
  page,
}) => {
  await openEditorAt(page, STRUCTURED_ID, POSITION_SENTINEL.structuredThreeQuarters, 'source')
  await page.getByTestId('tree-note').filter({ hasText: 'Flat position witness' }).click()

  await expect(page.getByRole('heading', { name: 'Flat position witness', level: 1 })).toBeVisible()
  await expect
    .poll(() =>
      page
        .getByTestId('content-scroll')
        .evaluate((scroller) => (scroller as HTMLElement).scrollTop),
    )
    .toBeLessThan(100)
})

test('a failed dirty Save keeps the aligned editor and resumes position capture', async ({
  page,
}) => {
  await openEditorAt(page, STRUCTURED_ID, POSITION_SENTINEL.structuredQuarter, 'source')
  await page.keyboard.insertText('edited ')
  let failed = false
  await page.route('**/api/note', async (route) => {
    if (!failed && route.request().method() === 'POST') {
      failed = true
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"held"}',
      })
      return
    }
    await route.continue()
  })
  await page.keyboard.press('Control+s')

  const activeLine = page.locator('.cm-activeLine')
  await expect(activeLine).toContainText(POSITION_SENTINEL.structuredQuarter)
  await expectInVisibleBand(activeLine)
  expect(failed).toBe(true)

  const secondLine = await scrollEditorToLine(page, POSITION_SENTINEL.structuredThreeQuarters)
  await expectInVisibleBand(secondLine)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Discard' }).click()
  await expectInVisibleBand(readerSentinel(page, POSITION_SENTINEL.structuredThreeQuarters))
})

test('typewriter owns final centering for the transferred sentinel', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('bm-editor-mode', 'source')
    localStorage.setItem('bm-typewriter', '1')
  })
  await page.goto(`/n/${STRUCTURED_ID}`)
  const reader = readerSentinel(page, POSITION_SENTINEL.structuredQuarter)
  await scrollReaderTo(reader)
  await page.getByRole('button', { name: 'Edit' }).click()
  const activeLine = page.locator('.cm-activeLine')
  await expect(activeLine).toContainText(POSITION_SENTINEL.structuredQuarter)
  await expect.poll(async () => (await positionInVisibleBand(activeLine)).top).toBeGreaterThan(250)
  const position = await positionInVisibleBand(activeLine)
  expect(position.bottom).toBeLessThan(480)
  await page.keyboard.press('Escape')
  await expectInVisibleBand(readerSentinel(page, POSITION_SENTINEL.structuredQuarter))
})

test('clean Save finishes a materialized folder page with zero writes', async ({ page }) => {
  const before = await (await page.request.get(`/api/note?id=${READING_LIST_ID}`)).json()
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/note') {
      writes.push(request.url())
    }
  })
  await page.goto(`/n/${READING_LIST_ID}`)
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.keyboard.press('Control+s')
  await expect(page.locator('.cm-content')).toHaveCount(0)
  const after = await (await page.request.get(`/api/note?id=${READING_LIST_ID}`)).json()

  expect(writes).toHaveLength(0)
  expect(after).toEqual(before)
})
