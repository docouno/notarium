import { expect, test } from './fixtures'

// #68.1 — a deep link must reveal + scroll + activate the note in the tree.
// Opening /n/<id> cold should expand the folder chain down to the note, scroll
// it into view, and mark it active, so the user can SEE where the note lives.
// Before the fix, the tree's scroll-into-view fired only on an activeId CHANGE,
// but a deep link sets activeId at mount while the row only appears later (after
// the tree skeleton and its lazy folder listing load) — so the scroll never
// caught up and a buried note opened with the tree parked at the top.

// A base big enough that the target row sits well below the fold, nested two
// folders deep so the reveal has real work to do. The top-level folders are
// auto-expanded on first load, which is what makes the rail actually scroll.
// The deep target lives in a MIDDLE folder (area-08), with many folders after
// it — so there is content below to scroll past, letting it reach the top (the
// very last row can't, the way VS Code's reveal can't lift the final item).
const DEEP_FIXTURE = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        ...Array.from({ length: 20 }, (_, f) =>
          Array.from({ length: 3 }, (_n, n) => ({
            title: `Note ${String(f + 1).padStart(2, '0')}-${n}`,
            filePath: `area-${String(f + 1).padStart(2, '0')}/note-${n}.md`,
            modifiedAt: '2026-06-08T00:00:00.000Z',
            createdAt: '2026-06-01T09:00:00.000Z',
            tags: [],
            content: `# Note ${f}-${n}`,
          })),
        ).flat(),
        // The deep target: nested two levels under a mid-list folder, so it
        // sits below the fold yet has folders area-09…area-20 beneath it.
        {
          title: 'Buried Treasure',
          filePath: 'area-08/projects/2020/buried.md',
          modifiedAt: '2026-06-09T00:00:00.000Z',
          createdAt: '2026-06-05T08:00:00.000Z',
          tags: [],
          content: '# Buried Treasure\n\nNested deep, mid-list, below the fold.',
        },
      ],
    },
  ],
}

// #161 — sync (refresh-tree) re-reveals the ACTIVE note. A deep link reveals on
// open, but once the note is already active the reveal effect won't re-fire on
// its own (browseFolder / noteOpen are unchanged) and the per-note scroll latch
// in VirtualTree, set on the first reveal, would skip a re-scroll for the same
// activeId. Sync must do both halves of VS Code's "reveal active file": expand
// the ancestor chain again AND re-arm the scroll. The two cases below cover each
// half independently (a regression in either would leave one test failing).

// Half 1 — EXPAND. After a manual "Collapse all" the note's folder chain closes,
// so its row leaves the tree entirely. Sync must re-open the chain so the row
// (and its active highlight) comes back — purely the openSet half.
test('sync re-expands a collapsed tree down to the active note (#161)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: DEEP_FIXTURE } })

  await page.goto('/n/fake-area-08-projects-2020-buried')

  const row = page.locator('[data-testid="tree-note"][data-id="fake-area-08-projects-2020-buried"]')
  await expect(row).toBeVisible() // deep-link reveal (the baseline below locks)

  // Collapse everything — the chain closes, so the row is no longer rendered at
  // all (not merely scrolled off): the note stays open in the reader, but the
  // tree no longer shows where it lives.
  await page.getByTestId('collapse-all').click()
  await expect(row).toHaveCount(0)

  // Sync re-expands the chain to the active note and re-activates its row.
  await page.getByTestId('refresh-tree').click()
  await expect(row).toBeVisible()
  await expect(row).toBeInViewport()
  await expect(row).toHaveAttribute('aria-current', 'page')
})

// Half 2 — SCROLL. With the chain already open, scroll the rail away so the
// note's row virtualizes out of view (the openSet is untouched — only the scroll
// moved). Sync must re-arm the per-note latch and bring it back; the openSet half
// does nothing here, so this isolates the scroll re-arm. Run on a SHORT viewport
// (#161 follow-up): the frosted panel head floats over the rail's top, and a
// short window makes it taller than the old fixed inset — so this also locks that
// the revealed note lands BELOW the glass, not tucked under it.
test('sync re-scrolls to the active note, clearing the glass head, after the rail was scrolled away (#161)', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1280, height: 512 })
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: DEEP_FIXTURE } })

  await page.goto('/n/fake-area-08-projects-2020-buried')

  const row = page.locator('[data-testid="tree-note"][data-id="fake-area-08-projects-2020-buried"]')
  await expect(row).toBeVisible()
  await expect(row).toBeInViewport() // deep-link scrolled it into view

  // Scroll the rail to the bottom — the mid-list note virtualizes out (it's far
  // above the overscan window), so its row unmounts. The chain stays expanded.
  await page.getByTestId('rail-scroll').evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
  await expect(row).toHaveCount(0)

  // Sync re-arms the scroll and brings the active note back into view — even
  // though its ancestors were already open (so only the latch reset, not a fresh
  // expand, can have moved the scroll).
  await page.getByTestId('refresh-tree').click()
  await expect(row).toBeVisible()
  await expect(row).toBeInViewport()
  await expect(row).toHaveAttribute('aria-current', 'page')

  // …and it sits BELOW the floating glass head, not hidden under it (#161): the
  // reveal inset must clear the measured head height, not a fixed guess.
  const rowBox = await row.boundingBox()
  const headBox = await page.getByTestId('panel-head').boundingBox()
  expect(rowBox).not.toBeNull()
  expect(headBox).not.toBeNull()
  expect(rowBox!.y).toBeGreaterThanOrEqual(headBox!.y + headBox!.height)
})

// The gate (#161): reveal-on-sync fires ONLY when a note is open on a doc
// surface. On a chrome surface (graph/settings/management) the rail retains
// `activeId` merely to return to Files — `noteOpen` is false — so sync must NOT
// yank the tree to the active note while you're reading the graph. This locks the
// load-bearing `noteOpen && lastNote.id === activeId` guard.
test('sync does NOT force-reveal the active note on a chrome page (#161 gate)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: DEEP_FIXTURE } })

  await page.goto('/n/fake-area-08-projects-2020-buried')
  const row = page.locator('[data-testid="tree-note"][data-id="fake-area-08-projects-2020-buried"]')
  await expect(row).toBeVisible() // revealed on the doc surface

  // Move to the graph — a chrome surface. activeId is retained (so "Files" can
  // return to the note), but the tree no longer treats it as the active doc.
  await page.getByTestId('rail-graph').click()
  await expect(page).toHaveURL(/\/graph$/)

  // Collapse the tree so the row is gone, then sync.
  await page.getByTestId('collapse-all').click()
  await expect(row).toHaveCount(0)

  // Sync refreshes the skeleton (the /tree reload), but the reveal is gated off
  // here. Awaiting the /tree response means refreshTree's continuation has run
  // (where a wrongful reveal WOULD expand the chain in the same commit as the
  // spinner clearing); the button re-enabling confirms that commit landed. The
  // row must still be gone — the gate held.
  // Match the skeleton reload EXACTLY (`…/tree`), not the per-folder listings
  // (`…/tree/children?…`) a non-empty openSet would also fire — so the await can't
  // resolve early on a child listing.
  const treeReload = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith('/tree') && r.request().method() === 'GET',
  )
  await page.getByTestId('refresh-tree').click()
  await treeReload
  await expect(page.getByTestId('refresh-tree')).toBeEnabled()
  await expect(row).toHaveCount(0)
})

test('deep-link reveals, scrolls to, and activates a deeply nested note', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: DEEP_FIXTURE } })

  await page.goto('/n/fake-area-08-projects-2020-buried')

  // The note itself opens in the reader.
  await expect(page.getByRole('heading', { name: 'Buried Treasure', level: 1 })).toBeVisible()

  // The tree revealed the chain down to it (the row only exists once its
  // ancestors are expanded AND it was scrolled into the virtual window),
  // scrolled it into view, and marked it the active note.
  const row = page.locator('[data-testid="tree-note"][data-id="fake-area-08-projects-2020-buried"]')
  await expect(row).toBeVisible()
  await expect(row).toBeInViewport()
  await expect(row).toHaveAttribute('aria-current', 'page')

  // …and it lands near the TOP (with a little context above it), not pinned to
  // the bottom edge the way 'auto' alignment used to slam a buried note (#68).
  const box = await row.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  expect(box!.y).toBeLessThan((viewport?.height ?? 720) * 0.5)
})

// The VS Code-parity nuance: the reveal aligns the note toward the top WHEN it
// can, but the very LAST row of the tree can't be lifted there (nothing below it
// to fill the viewport) — so it's revealed at the bottom. That's correct, not a
// regression; this locks it so a future change doesn't "fix" it into a forced,
// impossible top-scroll. `fake-area-20-note-2` is the terminal row of DEEP_FIXTURE.
test('deep-link to the tree’s LAST note still reveals + activates it (at the bottom)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: DEEP_FIXTURE } })

  await page.goto('/n/fake-area-20-note-2')

  await expect(page.getByRole('heading', { name: 'Note 20-2', level: 1 })).toBeVisible()

  const row = page.locator('[data-testid="tree-note"][data-id="fake-area-20-note-2"]')
  await expect(row).toBeVisible()
  await expect(row).toBeInViewport()
  await expect(row).toHaveAttribute('aria-current', 'page')

  // It sits LOW (terminal item can't reach the top) — and that's fine.
  const box = await row.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThan((viewport?.height ?? 720) * 0.5)
})
