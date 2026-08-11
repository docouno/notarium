import { expect, type Page, test } from './fixtures'

// #242 — expanding or collapsing a folder ABOVE the open note must NOT move the
// scroll. The tree navigates to the active row ONLY on a real reveal (opening a
// note, or reveal-on-sync #161), never on an incidental reflow. Before the fix the
// "keep active row in view" effect re-fired on every `activeIndex`/`totalSize`
// change, so a folder toggled above the open note yanked the scroll back down to
// it — losing the user's place. For manual QA of the SAME class of tree on a real
// stand, `make seed CASE=explorer-scroll` (a similar deep tree — not this exact
// fixture; these tests post their own inline DEEP_TREE below).

// A deep tree: ten foldable folders (area-01…area-10, five notes each) with the
// target note buried in a bottom folder below them all. Enough rows to virtualize
// and scroll well past the fold, with many folders ABOVE the open note to toggle.
const AREA_COUNT = 10
const NOTES_PER_AREA = 5
const ROWS_PER_AREA = NOTES_PER_AREA + 1

const DEEP_TREE = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        ...Array.from({ length: AREA_COUNT }, (_, f) =>
          Array.from({ length: NOTES_PER_AREA }, (_n, n) => ({
            title: `Note ${String(f + 1).padStart(2, '0')}-${n + 1}`,
            filePath: `area-${String(f + 1).padStart(2, '0')}/note-${n + 1}.md`,
            modifiedAt: '2026-06-08T00:00:00.000Z',
            createdAt: '2026-06-01T09:00:00.000Z',
            tags: [],
            content: `# Note ${f + 1}-${n + 1}`,
          })),
        ).flat(),
        // The buried target: in a bottom folder that sorts AFTER every area-NN, so
        // it's the last row — open it and every foldable folder sits above it.
        {
          title: 'Buried Note',
          filePath: 'zz-bottom/buried.md',
          modifiedAt: '2026-06-09T00:00:00.000Z',
          createdAt: '2026-06-05T08:00:00.000Z',
          tags: [],
          content: '# Buried Note\n\nThe deepest, last row.',
        },
      ],
    },
  ],
}

const BURIED = 'fake-zz-bottom-buried'
const folderRowIndex = (area: number) => (area - 1) * ROWS_PER_AREA
const railScroll = (page: Page) => page.getByTestId('rail-scroll')
const scrollTopOf = (page: Page) => railScroll(page).evaluate((el: HTMLElement) => el.scrollTop)
const setScrollTop = (page: Page, top: number) =>
  railScroll(page).evaluate((el: HTMLElement, t: number) => {
    el.scrollTo({ top: t })
  }, top)
// The chevron is the folder row's first button ("Toggle folder"); clicking it
// toggles without the folder-page navigation a name click can carry.
const folderTwisty = (page: Page, path: string) =>
  page.locator(`[data-testid="tree-folder"][data-path="${path}"] button`).first()

// Arm before navigation. This bounds transport only; callers keep the DOM and
// scroll assertions that prove React reconciliation and reveal.
const folderListingFinished = (page: Page, path: string): Promise<void> =>
  page
    .waitForResponse((response) => {
      const url = new URL(response.url())

      return (
        response.request().method() === 'GET' &&
        response.ok() &&
        url.pathname.endsWith('/tree/children') &&
        url.searchParams.get('path') === path
      )
    })
    .then(async (response) => {
      const error = await response.finished()

      if (error) {
        throw error
      }
    })

// The list geometry the component itself works in: the virtualizer's `scrollMargin`
// (the list's offset inside the scroll pane) and the floating head that overlays the
// pane's top edge. Both are read from the DOM the same way the component derives
// them, so a computed scrollTop lands on exactly the row we mean.
const listGeometry = (page: Page) =>
  railScroll(page).evaluate((sc: HTMLElement) => {
    const box = sc.querySelector('[role="tree"]')!
    const head = document.querySelector('[data-testid="panel-head"]')!
    const row = box.querySelector<HTMLElement>('[data-index]')

    if (!row) {
      throw new Error('Explorer geometry requires a mounted virtual row')
    }

    return {
      margin: box.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop,
      headH: head.getBoundingClientRect().height,
      clientHeight: sc.clientHeight,
      rowH: row.getBoundingClientRect().height,
    }
  })

// Visibility alone is vacuous when the whole tree fits. These cases require both
// the active row in view and positive rail movement.
const expectRevealSettledAtBottom = async (page: Page, listingFinished: Promise<void>) => {
  await listingFinished
  const buried = page.locator(`[data-testid="tree-note"][data-id="${BURIED}"]`)

  await expect(buried).toBeVisible()
  await expect(buried).toBeInViewport()
  await expect.poll(() => scrollTopOf(page)).toBeGreaterThan(0)
}

// A short viewport so the buried note reliably falls outside it once we scroll to
// the top — the condition under which the old bug force-scrolled it back.
test.use({ viewport: { width: 1280, height: 520 } })

test('a deep link expands the top level even when the tree skeleton lands last', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: DEEP_TREE } })

  // A response event precedes body parsing and React commit. Hold the skeleton until
  // the reader title proves the note-side state has rendered.
  const readerTitle = page.getByRole('heading', { name: 'Buried Note', level: 1 })
  await page.route('**/api/s/*/tree', async (route) => {
    await readerTitle.waitFor({ state: 'visible' })
    await route.continue()
  })

  const listingFinished = folderListingFinished(page, 'zz-bottom')
  await page.goto(`/n/${BURIED}`)
  await listingFinished

  // Settle reveal, then return to the top before reading virtualized folder rows.
  const buried = page.locator(`[data-testid="tree-note"][data-id="${BURIED}"]`)
  await expect(buried).toBeVisible() // true in BOTH worlds
  await setScrollTop(page, 0)

  // Both roots must be expanded in the deliberately inverted arrival order.
  for (const path of ['area-01', 'area-02']) {
    await expect(page.locator(`[data-testid="tree-folder"][data-path="${path}"]`)).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  }
})

test('expanding a folder above the open note does NOT move the scroll (#242)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: DEEP_TREE } })
  const listingFinished = folderListingFinished(page, 'zz-bottom')
  await page.goto(`/n/${BURIED}`)

  const buried = page.locator(`[data-testid="tree-note"][data-id="${BURIED}"]`)
  await expectRevealSettledAtBottom(page, listingFinished) // deep-link revealed it at the bottom

  // Scroll to the top: the buried note virtualizes out (it's far below the fold).
  await setScrollTop(page, 0)
  await expect(buried).toHaveCount(0)

  // A collapsed folder ABOVE the open note to expand. Collapsing it first must
  // ALSO not move the scroll (it's the same reflow-under-a-stable-note invariant).
  await folderTwisty(page, 'area-02').click()
  await expect.poll(() => scrollTopOf(page)).toBe(0)
  // Pin a reference row that sits ABOVE the folder we'll expand — its on-screen
  // position must survive the reflow (the content the user is looking at stays put).
  const refRow = page.locator('[data-testid="tree-folder"][data-path="area-01"]')
  const refBefore = await refRow.boundingBox()

  // THE ACTION: expand area-02. Before the fix this jumped the scroll ~1000px down
  // to the buried note; now the scroll — and the visible content — stay put.
  await folderTwisty(page, 'area-02').click()
  await expect(
    page.locator('[data-testid="tree-note"][data-id="fake-area-02-note-1"]'),
  ).toBeVisible()

  await expect.poll(() => scrollTopOf(page)).toBe(0)
  await expect(buried).toHaveCount(0) // the open note was NOT force-revealed
  const refAfter = await refRow.boundingBox()
  expect(refAfter!.y).toBeCloseTo(refBefore!.y, 0) // reference row didn't move
})

test('collapsing a folder above the open note does NOT move the scroll (#242)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: DEEP_TREE } })
  const listingFinished = folderListingFinished(page, 'zz-bottom')
  await page.goto(`/n/${BURIED}`)
  const buried = page.locator(`[data-testid="tree-note"][data-id="${BURIED}"]`)
  await expectRevealSettledAtBottom(page, listingFinished)

  // Scroll to the top: the buried note virtualizes out, the top folders show.
  await setScrollTop(page, 0)
  await expect(buried).toHaveCount(0)
  // area-01 sits above area-02 and stays put — the reference the user is looking at.
  const refRow = page.locator('[data-testid="tree-folder"][data-path="area-01"]')
  const refBefore = await refRow.boundingBox()

  // Collapse area-02 (a folder ABOVE the open note, whose notes we are NOT scrolled
  // into): its notes fold away below its own header. Before the fix this dropped
  // the open note's index and force-scrolled ~1000px down to it; now nothing moves.
  await folderTwisty(page, 'area-02').click()
  await expect(
    page.locator('[data-testid="tree-note"][data-id="fake-area-02-note-1"]'),
  ).toHaveCount(0)

  await expect.poll(() => scrollTopOf(page)).toBe(0)
  await expect(buried).toHaveCount(0) // the open note was NOT force-revealed
  const refAfter = await refRow.boundingBox()
  expect(refAfter!.y).toBeCloseTo(refBefore!.y, 0) // reference row didn't move
})

test('anchoring: a reflow ABOVE the viewport shifts scrollTop to hold the visible content (#242 (b))', async ({
  page,
  baseURL,
}) => {
  // The (b) scroll-anchoring half: when rows are removed/inserted ABOVE the viewport
  // (a folder collapsed/expanded off the top of the fold, a lazy listing landing),
  // the virtualizer keeps scrollTop numerically fixed, so the content the user is
  // looking at would shove. Anchoring re-pins the top visible row by adjusting
  // scrollTop by exactly the reflowed block height. This test drives that path (the
  // four tests above sit at scrollTop 0, where the re-pin is a no-op).
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: DEEP_TREE } })
  const listingFinished = folderListingFinished(page, 'zz-bottom')
  await page.goto(`/n/${BURIED}`)
  await expectRevealSettledAtBottom(page, listingFinished)

  // area-01's listing lazy-loads on view (#64) — force it in so collapsing area-01
  // later removes a KNOWN 5 rows, not 0 skeleton rows. Scroll it into view and wait
  // for its last note; the loaded rows stay counted after we scroll away.
  await setScrollTop(page, 0)
  const area01LastNote = page.locator('[data-testid="tree-note"][data-id="fake-area-01-note-5"]')
  await expect(area01LastNote).toBeVisible()

  // The anchor the component pins is the row crossing the GLASS LINE (the top of the
  // UNOBSCURED list, `scrollTop + headH`) — not y >= 0. Put area-02's header there:
  // that leaves ALL of area-01 above the anchor line, so collapsing it is a pure
  // above-anchor reflow, while area-01 stays mounted (overscan) for the raw click and
  // the anchor itself survives the collapse. The position is COMPUTED from the same
  // geometry the component uses — row height is pinned in CSS and every row exists
  // from the first paint — so there is nothing to hunt for. Aim at the row's MIDDLE:
  // the component floors the glass line into a row index, and a half-row of slack
  // makes that floor immune to sub-pixel rounding of the scrollTop we set.
  const { margin, headH, rowH } = await listGeometry(page)
  const anchorTop = Math.round(margin + folderRowIndex(2) * rowH + rowH / 2 - headH)
  await setScrollTop(page, anchorTop)

  const area01Row = page.locator('[data-testid="tree-folder"][data-path="area-01"]')
  const area02Row = page.locator('[data-testid="tree-folder"][data-path="area-02"]')
  // Preconditions, as observable conditions rather than a settling delay: the rail is
  // parked where we put it, area-01 is still mounted, and it sits entirely above the
  // anchor row.
  await expect.poll(() => scrollTopOf(page)).toBe(anchorTop)
  await expect(area01Row).toBeAttached()
  const before = {
    scrollTop: anchorTop,
    area01Y: (await area01Row.boundingBox())!.y,
    area02Y: (await area02Row.boundingBox())!.y,
  }
  expect(before.area01Y).toBeLessThan(before.area02Y)

  // THE ACTION, as a raw DOM click — Playwright's .click() would auto-scroll area-01
  // into view and measure the test driver instead of the reflow.
  await area01Row.evaluate((el: HTMLElement) => el.querySelector('button')?.click())
  // The reflow is DONE when area-01's notes are gone from the tree — an observable
  // condition, not a timer.
  await expect(area01LastNote).toHaveCount(0)

  // The payload: 5 notes removed above the anchor → scrollTop drops by EXACTLY one
  // block…
  await expect.poll(() => scrollTopOf(page)).toBe(before.scrollTop - NOTES_PER_AREA * rowH)
  // …and the anchor row (area-02) the user was looking at did NOT move on screen. Both
  // fail flat if the anchoring branch is deleted (scrollTop stays, area-02 jumps up
  // ~145px) or its offset math drifts.
  expect((await area02Row.boundingBox())!.y).toBeCloseTo(before.area02Y, 0)
  await expect(page.locator(`[data-testid="tree-note"][data-id="${BURIED}"]`)).toHaveCount(0)
})

test('reveal-on-open scrolls an OFF-SCREEN newly-opened note into view (latch re-arm, regression)', async ({
  page,
  baseURL,
}) => {
  // The reveal must re-arm when the OPEN note changes (revealSettledRef true→false on a
  // fresh token) and actually scroll a note that is NOT already visible into view — the
  // core of the latch. So the click target must start OFF-SCREEN, and be clicked raw
  // (Playwright's .click() would auto-scroll it into view and mask a broken re-arm).
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: DEEP_TREE } })
  const listingFinished = folderListingFinished(page, 'zz-bottom')
  await page.goto(`/n/${BURIED}`)
  await expectRevealSettledAtBottom(page, listingFinished)

  // Park mid-tree — plenty of rows above and below, and the rows just past the fold
  // are mounted by overscan: off-screen, yet clickable without Playwright scrolling
  // them into view first.
  const { margin, headH, clientHeight, rowH } = await listGeometry(page)
  const midTop = Math.round(margin + folderRowIndex(4) * rowH - headH)
  await setScrollTop(page, midTop)
  await expect.poll(() => scrollTopOf(page)).toBe(midTop)

  // The first row strictly below the visible band. Each fixture block starts with
  // a folder header; step over it, because this scenario needs a note to open.
  const firstBelow = Math.floor((midTop + clientHeight - margin) / rowH) + 1
  const targetIndex = firstBelow % ROWS_PER_AREA === 0 ? firstBelow + 1 : firstBelow
  const targetId = `fake-area-${String(Math.floor(targetIndex / ROWS_PER_AREA) + 1).padStart(2, '0')}-note-${targetIndex % ROWS_PER_AREA}`
  const target = page.locator(`[data-testid="tree-note"][data-id="${targetId}"]`)

  const railBottom = await railScroll(page).evaluate(
    (sc: HTMLElement) => sc.getBoundingClientRect().bottom,
  )
  await expect(target).toBeAttached() // mounted by overscan…
  expect((await target.boundingBox())!.y).toBeGreaterThan(railBottom) // …but off-screen

  // Raw DOM click — opens the note without Playwright's actionability auto-scroll.
  await target.evaluate((el: HTMLElement) => el.click())

  await expect(target).toHaveAttribute('aria-current', 'page')
  await expect.poll(() => scrollTopOf(page)).not.toBe(midTop) // the reveal really scrolled
  // …and it brought the off-screen row fully into the visible band.
  const box = (await target.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(railBottom)
})

test('a dropped listing is retried twice, then reveal completes', async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: DEEP_TREE } })

  const reconciliationMarker = 'retry-reconciliation-marker'
  let treeResponses = 0
  await page.route(
    (url) => url.pathname.endsWith('/tree'),
    async (route) => {
      const response = await route.fetch()
      const tree = await response.json()

      treeResponses += 1
      tree.folders.push({
        path: reconciliationMarker,
        name: reconciliationMarker,
        count: treeResponses === 1 ? 0 : 1,
        direct: treeResponses === 1 ? 0 : 1,
      })
      await route.fulfill({ response, json: tree })
    },
  )
  let reconciliationReady!: () => void
  const reconciliationApplied = new Promise<void>((resolve) => {
    reconciliationReady = resolve
  })
  await page.route(
    (url) =>
      url.pathname.endsWith('/tree/children') &&
      url.searchParams.get('path') === reconciliationMarker,
    async (route) => {
      await route.fulfill({ json: { folders: [], notes: [], total: 0 } })
      reconciliationReady()
    },
  )
  let attempts = 0
  await page.route(
    (url) =>
      url.pathname.endsWith('/tree/children') && url.searchParams.get('path') === 'zz-bottom',
    async (route) => {
      attempts += 1
      if (attempts === 1) {
        // The marker listing can start only after the second tree response has
        // committed and Sidebar's passive lazy-listing effect has run.
        await reconciliationApplied
      }

      return attempts <= 2 ? route.abort() : route.continue()
    },
  )

  await page.goto(`/n/${BURIED}`)

  const buried = page.locator(`[data-testid="tree-note"][data-id="${BURIED}"]`)
  await expect(buried).toBeVisible()
  await expect(buried).toBeInViewport()
  await expect(buried).toHaveAttribute('aria-current', 'page')
  expect(attempts).toBe(3)
})

test('expanding a folder BELOW the open note does NOT move the scroll (symmetry lock)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: DEEP_TREE } })
  await page.goto('/n/fake-area-01-note-1')

  const active = page.locator('[data-testid="tree-note"][data-id="fake-area-01-note-1"]')
  await expect(active).toBeVisible()
  await setScrollTop(page, 0) // active note near the top, in view
  // The bottom folder being unmounted proves the tree grew past the fold; this
  // active note sits near the top, so reveal movement cannot prove that premise.
  await expect(page.locator('[data-testid="tree-folder"][data-path="zz-bottom"]')).toHaveCount(0)

  // Collapse then expand the nearest folder BELOW the active note. Wait for its
  // listing first: otherwise lazy listings above a farther target can push that
  // target outside the viewport between setup and click, and Playwright's click
  // actionability will scroll to it — measuring the test driver, not the reflow.
  const belowNote = page.locator('[data-testid="tree-note"][data-id="fake-area-02-note-1"]')
  await expect(belowNote).toBeVisible()
  const belowFolder = folderTwisty(page, 'area-02')
  await expect(belowFolder).toBeInViewport()

  // This never moved the scroll even before the fix (a below reflow leaves
  // activeIndex untouched) — lock it so a future change can't regress the
  // symmetric half.
  await belowFolder.click()
  await belowFolder.click()
  await expect(belowNote).toBeVisible()
  await expect.poll(() => scrollTopOf(page)).toBe(0)
  await expect(active).toBeInViewport()
})
