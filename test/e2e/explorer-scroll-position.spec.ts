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
const DEEP_TREE = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        ...Array.from({ length: 10 }, (_, f) =>
          Array.from({ length: 5 }, (_n, n) => ({
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

// A short viewport so the buried note reliably falls outside it once we scroll to
// the top — the condition under which the old bug force-scrolled it back.
test.use({ viewport: { width: 1280, height: 520 } })

test('expanding a folder above the open note does NOT move the scroll (#242)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: DEEP_TREE } })
  await page.goto(`/n/${BURIED}`)

  const buried = page.locator(`[data-testid="tree-note"][data-id="${BURIED}"]`)
  await expect(buried).toBeVisible() // deep-link revealed it at the bottom

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
  await page.goto(`/n/${BURIED}`)
  const buried = page.locator(`[data-testid="tree-note"][data-id="${BURIED}"]`)
  await expect(buried).toBeVisible()

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
  await page.goto(`/n/${BURIED}`)
  await expect(page.locator(`[data-testid="tree-note"][data-id="${BURIED}"]`)).toBeVisible()

  // area-01's listing lazy-loads on view (#64) — force it in so collapsing area-01
  // later removes a KNOWN 5 rows, not 0 skeleton rows. Scroll it into view and wait
  // for its last note; the loaded rows stay counted after we scroll away.
  await setScrollTop(page, 0)
  await expect(
    page.locator('[data-testid="tree-note"][data-id="fake-area-01-note-5"]'),
  ).toBeVisible()

  const ROW_H = 29
  const measured = await railScroll(page).evaluate(async (sc: HTMLElement, rowH: number) => {
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    // The anchor the component pins is the row crossing the GLASS LINE (the top of the
    // unobscured list, `scrollTop + headH`) — NOT y>=0. Measure it from the floating
    // panel head so we match the component's own reference, then position so that row
    // is area-02's header: that puts ALL of area-01 above the anchor line (collapsing
    // it is a pure above-anchor reflow) while area-01 stays mounted (overscan) for the
    // raw click, and the anchor (area-02) survives the collapse.
    const head = document.querySelector('[data-testid="panel-head"]')
    const glassLine =
      sc.getBoundingClientRect().top + (head ? head.getBoundingClientRect().height : 0)
    const rowAtGlass = () =>
      [...sc.querySelectorAll('[data-testid="tree-folder"],[data-testid="tree-note"]')].find(
        (el) => {
          const r = el.getBoundingClientRect()
          return r.top <= glassLine + 1 && r.bottom > glassLine + 1
        },
      )
    let atGlass = null

    for (let st = rowH; st <= 1000; st += 12) {
      sc.scrollTop = st
      await raf()
      await sleep(30)
      const el = rowAtGlass()

      if (
        el &&
        el.getAttribute('data-path') === 'area-02' &&
        sc.querySelector('[data-testid="tree-folder"][data-path="area-01"]')
      ) {
        atGlass = 'area-02'
        break
      }
    }
    const area01 = sc.querySelector('[data-testid="tree-folder"][data-path="area-01"]')
    const area02 = sc.querySelector('[data-testid="tree-folder"][data-path="area-02"]')
    const before = {
      scrollTop: sc.scrollTop,
      atGlass,
      area01Mounted: !!area01,
      area01Y: area01 ? Math.round(area01.getBoundingClientRect().top) : null,
      area02Y: area02 ? Math.round(area02.getBoundingClientRect().top) : null,
    }

    if (!atGlass || !area01) {
      return { before, scrollTopAfter: sc.scrollTop, area02YAfter: null }
    }
    // Raw DOM click (NOT Playwright .click(), which would auto-scroll it into view).
    area01.querySelector<HTMLElement>('button')?.click()
    for (let i = 0; i < 8; i++) {
      await raf()
    }
    await sleep(150)
    const area02Now = sc.querySelector('[data-testid="tree-folder"][data-path="area-02"]')
    return {
      before,
      scrollTopAfter: sc.scrollTop,
      area02YAfter: area02Now ? Math.round(area02Now.getBoundingClientRect().top) : null,
    }
  }, ROW_H)

  // Preconditions: area-02 is the row on the glass line, area-01 is mounted AND scrolled
  // entirely above the anchor line (its header off the top).
  expect(measured.before.atGlass).toBe('area-02')
  expect(measured.before.area01Mounted).toBe(true)
  expect(measured.before.area01Y!).toBeLessThan(measured.before.area02Y!)
  // The payload: 5 notes removed above the anchor → scrollTop drops by EXACTLY one block…
  expect(measured.before.scrollTop - measured.scrollTopAfter).toBe(5 * ROW_H)
  // …and the anchor row (area-02) the user was looking at did NOT move on screen. Both
  // fail flat if the anchoring branch is deleted (scrollTop stays, area-02 jumps up
  // ~145px) or its offset math drifts.
  expect(measured.area02YAfter).toBe(measured.before.area02Y)
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
  await page.goto(`/n/${BURIED}`)
  await expect(page.locator(`[data-testid="tree-note"][data-id="${BURIED}"]`)).toBeVisible()

  const r = await railScroll(page).evaluate(async (sc: HTMLElement) => {
    const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))
    // A mid position: the folders here are loaded and there are notes mounted just BELOW
    // the fold (react-virtual overscan) — off-screen but clickable.
    sc.scrollTop = 260
    await raf()
    await sleep(250)
    const bottom = sc.getBoundingClientRect().bottom
    const target = [...sc.querySelectorAll('[data-testid="tree-note"]')]
      .map((el) => ({ id: el.getAttribute('data-id'), top: el.getBoundingClientRect().top }))
      .filter((n) => n.top > bottom) // strictly below the visible band
      .sort((a, b) => a.top - b.top)[0]

    if (!target) {
      return { found: false }
    }
    const beforeScroll = sc.scrollTop
    // Raw DOM click — opens the note without Playwright's actionability auto-scroll.
    sc.querySelector<HTMLElement>(`[data-testid="tree-note"][data-id="${target.id}"]`)?.click()
    let box = null

    for (let i = 0; i < 40; i++) {
      await raf()
      await sleep(50)
      const el = sc.querySelector(`[data-testid="tree-note"][data-id="${target.id}"]`)
      box = el ? el.getBoundingClientRect() : null
      if (
        box &&
        box.top >= 0 &&
        box.bottom <= sc.getBoundingClientRect().bottom &&
        el?.getAttribute('aria-current') === 'page'
      ) {
        break
      }
    }
    const vh = sc.getBoundingClientRect().bottom
    return {
      found: true,
      id: target.id,
      beforeScroll,
      afterScroll: sc.scrollTop,
      inViewport: !!box && box.top >= 0 && box.bottom <= vh,
    }
  })

  expect(r.found).toBe(true)
  expect(r.afterScroll).not.toBe(r.beforeScroll) // the reveal actually scrolled (re-arm fired)
  expect(r.inViewport).toBe(true) // the off-screen note was brought into view
  await expect(page.locator(`[data-testid="tree-note"][data-id="${r.id}"]`)).toHaveAttribute(
    'aria-current',
    'page',
  )
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

  // Collapse then expand a folder BELOW the active note (area-05). This never moved
  // the scroll even before the fix (a below reflow leaves activeIndex untouched) —
  // lock it so a future change can't regress the symmetric half.
  await folderTwisty(page, 'area-05').click()
  await folderTwisty(page, 'area-05').click()
  await expect(
    page.locator('[data-testid="tree-note"][data-id="fake-area-05-note-1"]'),
  ).toBeVisible()
  await expect.poll(() => scrollTopOf(page)).toBe(0)
  await expect(active).toBeInViewport()
})
