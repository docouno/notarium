import { buildCaseWorld, caseToFixture, DEFAULT_NOW } from '../cases'
import { expect, test } from './fixtures'

const WORLD = caseToFixture(buildCaseWorld('views', { now: DEFAULT_NOW }))

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: WORLD } })
})

test.afterEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`)
})

test('board uses workspace geometry, adaptive columns and optimistic DnD without chrome noise', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1800, height: 1000 })
  const manifestGate = deferred()
  let holdManifest = true

  await page.route('**/api/note/views?*', async (route) => {
    if (holdManifest) {
      holdManifest = false
      await manifestGate.promise
    }
    await route.continue()
  })
  const navigation = page.goto('/n/vboard000001')
  const loadingBoard = page.getByTestId('board-loading-skeleton')

  await expect(loadingBoard).toBeVisible()
  await expect(loadingBoard.locator('[data-testid="board-column-skeleton"]')).toHaveCount(4)
  const skeletonGeometry = await loadingBoard
    .locator('[data-testid="board-column-skeleton"]')
    .first()
    .evaluate((card) => {
      const title = card.children[0]!.firstElementChild as HTMLElement
      const fields = card.children[1] as HTMLElement
      const chip = fields.firstElementChild as HTMLElement
      const style = getComputedStyle(card)

      return {
        padding: style.padding,
        borderWidth: style.borderTopWidth,
        radius: style.borderRadius,
        titleHeight: title.getBoundingClientRect().height,
        fieldsMargin: getComputedStyle(fields).marginTop,
        chipHeight: chip.getBoundingClientRect().height,
      }
    })

  manifestGate.resolve()
  await navigation

  const workspace = page.locator('[data-view-presentation="workspace"]')

  await expect(workspace).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Later reader' })).toHaveAttribute(
    'aria-selected',
    'false',
  )
  await expect(page.getByText('This column is ready for a task.')).toHaveCount(0)
  await expect(page.getByText('Move to', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Show source', { exact: true })).toHaveCount(0)
  await expect(page.locator('[title="Open panel"], [title="Collapse panel"]')).toHaveCount(0)
  await expect(page.getByTestId('aside-groups')).toHaveCount(0)
  await expect(page.locator('[aria-label^="Reorder "]')).toHaveCount(0)
  await expect(
    page.locator('[data-note-id="vtask0000001"] [aria-label="risk: High"]'),
  ).toBeVisible()

  const geometry = await workspace.evaluate((article) => {
    const boardScroller = article.querySelector<HTMLElement>('[data-testid="board-scroller"]')!
    const columns = [...article.querySelectorAll<HTMLElement>('[data-group]')]
    const oneCardBody = columns
      .find((column) => column.getAttribute('aria-label')?.startsWith('Doing,'))!
      .querySelector<HTMLElement>('[data-testid="board-column-cards"]')!
    const activeTab = article.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!
    const tabList = activeTab.parentElement!
    const firstColumn = columns[0]!
    const firstColumnHead = firstColumn.firstElementChild as HTMLElement

    return {
      articleBottom: article.getBoundingClientRect().bottom,
      boardBottom: boardScroller.getBoundingClientRect().bottom,
      boardWidth: boardScroller.clientWidth,
      boardScrollWidth: boardScroller.scrollWidth,
      columnWidths: columns.slice(0, 3).map((column) => column.getBoundingClientRect().width),
      oneCardClientHeight: oneCardBody.clientHeight,
      oneCardScrollHeight: oneCardBody.scrollHeight,
      scrollbarHeight: getComputedStyle(boardScroller, '::-webkit-scrollbar').height,
      scrollbarThumb: getComputedStyle(boardScroller, '::-webkit-scrollbar-thumb').backgroundColor,
      activeIndicator: getComputedStyle(activeTab, '::after').height,
      tabOverflowY: getComputedStyle(tabList).overflowY,
      tabClientHeight: tabList.clientHeight,
      tabScrollHeight: tabList.scrollHeight,
      columnBackground: getComputedStyle(firstColumn).backgroundColor,
      columnSideBorder: getComputedStyle(firstColumn).borderLeftWidth,
      columnColorBorder: getComputedStyle(firstColumnHead).borderTopWidth,
      columnToneCount: firstColumn.querySelectorAll('[class*="column-tone"]').length,
    }
  })

  expect(geometry.articleBottom).toBe(1000)
  expect(geometry.boardBottom).toBe(1000)
  expect(geometry.boardScrollWidth).toBeGreaterThan(geometry.boardWidth)
  expect(geometry.columnWidths).toEqual([256, 256, 256])
  expect(geometry.oneCardScrollHeight).toBe(geometry.oneCardClientHeight)
  expect(geometry.scrollbarHeight).toBe('11px')
  expect(geometry.scrollbarThumb).not.toContain('/ 0)')
  expect(geometry.activeIndicator).toBe('2px')
  expect(geometry.tabOverflowY).toBe('hidden')
  expect(geometry.tabScrollHeight).toBe(geometry.tabClientHeight)
  expect(geometry.columnBackground).toBe('rgba(0, 0, 0, 0)')
  expect(geometry.columnSideBorder).toBe('0px')
  expect(geometry.columnColorBorder).toBe('3px')
  expect(geometry.columnToneCount).toBe(0)

  const title = page.getByRole('link', { name: 'Alpha task' })

  await title.hover()
  const titleStyle = await title.evaluate((element) => ({
    decoration: getComputedStyle(element).textDecorationLine,
    borderBottomWidth: getComputedStyle(element).borderBottomWidth,
    color: getComputedStyle(element).color,
    width: element.getBoundingClientRect().width,
    cardWidth: element.closest('[data-note-id]')!.getBoundingClientRect().width,
    draggable: element.getAttribute('draggable'),
    cardPadding: getComputedStyle(element.closest('[data-note-id]')!).padding,
    cardBorderWidth: getComputedStyle(element.closest('[data-note-id]')!).borderTopWidth,
    cardRadius: getComputedStyle(element.closest('[data-note-id]')!).borderRadius,
    titleHeight: element.getBoundingClientRect().height,
    fieldsMargin: getComputedStyle(
      element.closest('[data-note-id]')!.querySelector('[aria-label="owner: Ann"]')!.parentElement!,
    ).marginTop,
    chipHeight: element
      .closest('[data-note-id]')!
      .querySelector('[aria-label="owner: Ann"]')!
      .getBoundingClientRect().height,
    accentColor: getComputedStyle(
      document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!,
      '::after',
    ).backgroundColor,
  }))

  expect(titleStyle.decoration).toBe('underline')
  expect(titleStyle.borderBottomWidth).toBe('0px')
  expect(titleStyle.color).not.toBe(titleStyle.accentColor)
  expect(titleStyle.width).toBeLessThan(titleStyle.cardWidth)
  expect(titleStyle.draggable).toBe('false')
  expect(titleStyle.cardPadding).toBe(skeletonGeometry.padding)
  expect(titleStyle.cardBorderWidth).toBe(skeletonGeometry.borderWidth)
  expect(titleStyle.cardRadius).toBe(skeletonGeometry.radius)
  expect(titleStyle.titleHeight).toBeCloseTo(skeletonGeometry.titleHeight, 1)
  expect(titleStyle.fieldsMargin).toBe(skeletonGeometry.fieldsMargin)
  expect(titleStyle.chipHeight).toBeCloseTo(skeletonGeometry.chipHeight, 1)

  const gate = deferred()
  let moveRequests = 0

  await page.route('**/api/note/board-move', async (route) => {
    moveRequests++
    await gate.promise
    await route.continue()
  })
  const noOpPlacementCounts = await page.evaluate(async () => {
    const probe = async (id: string) => {
      const card = document.querySelector<HTMLElement>(`[data-note-id="${id}"]`)!
      const transfer = new DataTransfer()

      card.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      )
      card.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      )
      await new Promise((resolve) => setTimeout(resolve, 30))
      const during = document.querySelectorAll('[data-testid="insertion-placeholder"]').length

      card.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      )
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }))
      await new Promise((resolve) => setTimeout(resolve, 30))
      return {
        during,
        after: document.querySelectorAll('[data-testid="insertion-placeholder"]').length,
      }
    }

    return [await probe('vtask0000001'), await probe('vtask0000002')]
  })

  expect(noOpPlacementCounts).toEqual([
    { during: 0, after: 0 },
    { during: 0, after: 0 },
  ])
  expect(moveRequests).toBe(0)

  const placementStyle = await page.evaluate(async () => {
    const source = document.querySelector<HTMLElement>('[data-note-id="vtask0000001"]')!
    const target = document.querySelector<HTMLElement>('[data-note-id="vtask0000002"]')!
    const transfer = new DataTransfer()
    const rect = target.getBoundingClientRect()

    source.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    )
    target.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: rect.left + rect.width / 2,
        clientY: rect.bottom - 2,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    const placeholder = document.querySelector<HTMLElement>(
      '[data-testid="insertion-placeholder"]',
    )!
    const neutralSwatch = document.createElement('span')

    neutralSwatch.style.color = 'var(--border-strong)'
    document.body.append(neutralSwatch)
    const neutralBorder = getComputedStyle(neutralSwatch).color

    neutralSwatch.remove()
    const style = getComputedStyle(placeholder)
    const result = {
      count: document.querySelectorAll('[data-testid="insertion-placeholder"]').length,
      height: placeholder.getBoundingClientRect().height,
      cardHeight: source.getBoundingClientRect().height,
      borderStyle: style.borderTopStyle,
      borderColor: style.borderTopColor,
      boxShadow: style.boxShadow,
      neutralBorder,
    }

    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    return {
      ...result,
      after: document.querySelectorAll('[data-testid="insertion-placeholder"]').length,
    }
  })

  expect(placementStyle.count).toBe(1)
  expect(placementStyle.height).toBeCloseTo(placementStyle.cardHeight, 1)
  expect(placementStyle.borderStyle).toBe('solid')
  expect(placementStyle.borderColor).toBe('rgba(0, 0, 0, 0)')
  expect(placementStyle.boxShadow).toContain(placementStyle.neutralBorder)
  expect(placementStyle.after).toBe(0)

  const doingBefore = page.getByRole('region', { name: 'Doing, 1 cards' })

  await title.dragTo(doingBefore.getByTestId('board-column-cards'))
  await expect(page.getByRole('region', { name: 'Backlog, 1 cards' })).toBeVisible()
  const doingAfter = page.getByRole('region', { name: 'Doing, 2 cards' })
  await expect(doingAfter.locator('[data-note-id="vtask0000001"]')).toBeVisible()
  await expect(page.getByTestId('board-column-skeleton')).toHaveCount(0)

  gate.resolve()
  await expect(page.getByText('Card moved to Doing.')).toBeAttached()
  await expect(page.getByTestId('board-column-skeleton')).toHaveCount(0)

  await page.goto('/n/vboard000002')
  const adaptive = await page.getByTestId('board-scroller').evaluate((boardScroller) => ({
    width: boardScroller.clientWidth,
    scrollWidth: boardScroller.scrollWidth,
    columns: [...boardScroller.querySelectorAll<HTMLElement>('[data-group]')].map(
      (column) => column.getBoundingClientRect().width,
    ),
  }))

  expect(adaptive.scrollWidth).toBe(adaptive.width)
  expect(adaptive.columns).toEqual([483, 483, 483])

  await page.goto('/s/views-lab/feed')
  await expect(page.getByText('View unavailable', { exact: true })).toHaveCount(0)
  const staleMarkerCard = page.getByTestId('feed-item').filter({ hasText: 'Stale marker' })

  await expect(staleMarkerCard).toContainText('Ordinary prose.')
  await staleMarkerCard.click()
  await expect(page.getByText('Ordinary prose.', { exact: true })).toBeVisible()
  await expect(page.getByText(/View marker/)).toHaveCount(0)
})

test('writer moves a focused card by keyboard without a resting control', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 })
  await page.goto('/n/vboard000002')

  const source = page.locator('[data-note-id="vtask0000001"]')
  const destination = page.locator('[data-group]').nth(1)

  await expect(source).toBeVisible()
  await expect(destination).toHaveAttribute('aria-label', /ops/i)
  await expect(source).toHaveAttribute('tabindex', '0')
  await expect(source).toHaveAttribute('aria-keyshortcuts', /Space.*ArrowRight.*Escape/)
  await expect(source.locator('button, svg, [aria-label^="Reorder "]')).toHaveCount(0)
  await expect(page.getByText('Move to', { exact: true })).toHaveCount(0)

  const moveGate = deferred()

  await page.route('**/api/note/board-move', async (route) => {
    await moveGate.promise
    await route.continue()
  })
  await source.focus()
  await page.keyboard.press('Space')
  await expect(page.getByText(/Use arrow keys to choose a column and position/)).toBeAttached()
  const scroller = page.getByTestId('board-scroller')
  const scrollBefore = await scroller.evaluate((element) => element.scrollLeft)

  await page.keyboard.press('ArrowRight')
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(scrollBefore)
  await expect(destination.locator('[data-note-id="vtask0000004"]')).toBeVisible()
  await page.keyboard.press('ArrowDown')

  const placement = destination.getByTestId('insertion-placeholder')

  await expect(placement).toBeVisible()
  await expect(page.getByTestId('insertion-placeholder')).toHaveCount(1)
  const placementTone = await placement.evaluate((element) => {
    const swatch = document.createElement('span')

    swatch.style.color = 'var(--border-strong)'
    document.body.append(swatch)
    const neutral = getComputedStyle(swatch).color

    swatch.remove()
    const style = getComputedStyle(element)

    return { border: style.borderTopColor, shadow: style.boxShadow, neutral }
  })

  expect(placementTone.border).toBe('rgba(0, 0, 0, 0)')
  expect(placementTone.shadow).toContain(placementTone.neutral)

  await page.keyboard.press('Space')
  const optimistic = destination.locator('[data-note-id="vtask0000001"]')

  await expect(optimistic).toBeVisible()
  await expect(optimistic).toBeFocused()
  await expect(page.getByTestId('insertion-placeholder')).toHaveCount(0)
  moveGate.resolve()
  await expect(page.getByText(/Card moved to ops\./i)).toBeAttached()

  await page.route('**/api/note/views?*', async (route) => {
    const response = await route.fetch()
    const json = (await response.json()) as { views?: Array<{ capabilities?: unknown }> }

    for (const view of json.views ?? []) {
      delete view.capabilities
    }
    await route.fulfill({ response, json })
  })
  await page.reload()
  const readOnlyCard = page.locator('[data-note-id="vtask0000001"]')

  await expect(readOnlyCard).toBeVisible()
  await expect(readOnlyCard).not.toHaveAttribute('tabindex', '0')
  await expect(readOnlyCard).not.toHaveAttribute('aria-keyshortcuts', /Space/)
  await expect(readOnlyCard).toHaveAttribute('draggable', 'false')
  await readOnlyCard.evaluate((element) =>
    element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })),
  )
  await expect(page.getByTestId('insertion-placeholder')).toHaveCount(0)
})

test('lazy editor Preview gives workspace view blocks their reader geometry', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 })
  await page.goto('/n/vboard000001')
  await expect(page.getByTestId('board-scroller')).toBeVisible()

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.cm-content')

  await expect(editor).toBeVisible()
  await expect(page.getByTestId('board-scroller')).toHaveCount(0)
  await page.getByRole('button', { name: 'Preview', exact: true }).click()

  const preview = page.getByTestId('editor-preview')

  await expect(preview).toBeVisible()
  await expect(preview.getByTestId('board-scroller')).toBeVisible()
  await expect(preview.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('editor-body-column')).toHaveAttribute(
    'data-view-presentation',
    'workspace',
  )
  const geometry = await preview.evaluate((root) => {
    const board = root.querySelector<HTMLElement>('[data-testid="board-scroller"]')!

    return {
      width: root.getBoundingClientRect().width,
      boardBottom: board.getBoundingClientRect().bottom,
      overflow: getComputedStyle(root).overflow,
    }
  })

  expect(geometry.width).toBeGreaterThan(1200)
  expect(geometry.boardBottom).toBeCloseTo(1000, 0)
  expect(geometry.overflow).toBe('hidden')

  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(editor).toBeFocused()
})
