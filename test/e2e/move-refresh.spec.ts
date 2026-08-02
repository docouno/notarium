import { type Page } from '@playwright/test'
import { expect, test } from './fixtures'

// #94 — a DnD move must refresh ONLY the folders it touches (source +
// destination + the tree skeleton), never every loaded folder. The old broad
// refresh refetched all ~95 loaded folders, saturating the browser's connection
// pool so the next /api/move queued behind the wave (pending up to ~5s) and a
// re-drop conflicted ("Move Failed"); overlapping waves also duplicated the
// moved row. This locks the narrow refresh + the no-duplicate invariant.

// Five sibling folders, each with notes, all auto-expanded on first load → five
// loaded folder listings. A move between two of them must leave the other three
// untouched.
const FIXTURE = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: ['f1', 'f2', 'f3', 'f4', 'f5'].flatMap((f) =>
        [1, 2, 3].map((n) => ({
          title: `${f}-note-${n}`,
          filePath: `${f}/${f}-note-${n}.md`,
          modifiedAt: '2026-06-08T00:00:00.000Z',
          createdAt: '2026-06-01T09:00:00.000Z',
          tags: [],
          content: `# ${f} ${n}`,
        })),
      ),
    },
  ],
}

// Dispatch a native HTML5 drag sequence (the only way to drive DnD — Playwright
// can't, see drag-and-drop.md §7): dragstart on the source anchor sets the
// module payload slot, then dragover/drop on the destination ROW (the wrapper
// div carrying the drop handlers — the anchor's parent). One shared DataTransfer
// across the sequence, as a real browser does.
const dragNoteOnto = async (page: Page, srcId: string, destId: string) => {
  await page.evaluate(
    (ids) => {
      const src = document.querySelector(
        `[data-testid="tree-note"][data-id="${ids.srcId}"]`,
      ) as HTMLElement
      const destAnchor = document.querySelector(
        `[data-testid="tree-note"][data-id="${ids.destId}"]`,
      ) as HTMLElement

      if (!src || !destAnchor) {
        throw new Error('drag endpoints not mounted')
      }
      const dest = destAnchor.parentElement as HTMLElement // the row div with the drop handlers
      const dt = new DataTransfer()
      const fire = (el: HTMLElement, type: string) =>
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      fire(src, 'dragstart')
      fire(dest, 'dragenter')
      fire(dest, 'dragover')
      fire(dest, 'drop')
      fire(src, 'dragend')
    },
    { srcId, destId },
  )
}

// Like dragNoteOnto, but the last `dragover` lands on a DECOY row while the
// `drop` lands on a different one — the fast-drag shape where the pointer has
// already moved on by the time the browser fires drop. The move must follow the
// DROP position (resolved at the section from the row under the pointer), not the
// stale hover. This is the structural invariant behind the fast-drop fix (#94):
// native drop timing itself can't be driven by Playwright (like the #68 item 7
// auto-scroll), so we lock the resolution model instead.
const dragNoteOverThenDropOn = async (
  page: Page,
  ids: { srcId: string; overId: string; dropId: string },
) => {
  await page.evaluate(({ srcId, overId, dropId }) => {
    const row = (id: string) =>
      (document.querySelector(`[data-testid="tree-note"][data-id="${id}"]`) as HTMLElement)
        ?.parentElement as HTMLElement
    const src = document.querySelector(
      `[data-testid="tree-note"][data-id="${srcId}"]`,
    ) as HTMLElement
    const over = row(overId)
    const drop = row(dropId)

    if (!src || !over || !drop) {
      throw new Error('drag endpoints not mounted')
    }
    const dt = new DataTransfer()
    const fire = (el: HTMLElement, type: string) =>
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    fire(src, 'dragstart')
    fire(over, 'dragover') // pointer was last seen here…
    fire(drop, 'drop') // …but released here
    fire(src, 'dragend')
  }, ids)
}

const idOf = (page: Page, title: string) =>
  page.locator(`[data-testid="tree-note"]`, { hasText: title }).first().getAttribute('data-id')

test('a move refreshes only the touched folders, and never duplicates the row (#94)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })

  // Record every folder-listing refetch with its folder (the `path` query).
  const childrenPaths: string[] = []
  page.on('request', (req) => {
    const url = req.url()
    const m = url.match(/\/tree\/children\?(.*)$/)

    if (m) {
      childrenPaths.push(new URLSearchParams(m[1]).get('path') ?? '')
    }
  })

  await page.goto('/s/main')

  // All five folders auto-expand and load their listings.
  await expect(page.locator('[data-testid="tree-note"]')).toHaveCount(15)
  const srcId = await idOf(page, 'f1-note-1')
  const destId = await idOf(page, 'f2-note-1')
  expect(srcId).toBeTruthy()
  expect(destId).toBeTruthy()

  // Everything before the move is setup; only post-move refetches are the test.
  const baseline = childrenPaths.length
  await dragNoteOnto(page, srcId!, destId!)

  // The moved row reappears (optimistic + authoritative refresh) and exactly
  // once — the duplicate bug showed it in BOTH the source and target folders.
  await expect(page.locator(`[data-testid="tree-note"][data-id="${srcId}"]`)).toHaveCount(1)
  // Still 15 rows total — nothing duplicated or lost.
  await expect(page.locator('[data-testid="tree-note"]')).toHaveCount(15)

  // Give the SSE `changed` coalesce window (1s) time to fire its own refetch, so
  // we also prove THAT path stays narrow.
  await page.waitForTimeout(1500)

  const touched = new Set(childrenPaths.slice(baseline))
  // Only the source and destination folders were refetched — the broad refresh
  // would have refetched f3/f4/f5 too (the regression this guards).
  expect([...touched].sort()).toEqual(['f1', 'f2'])
  expect(touched.has('f3')).toBe(false)
  expect(touched.has('f4')).toBe(false)
  expect(touched.has('f5')).toBe(false)
})

test('the drop target is the row released on, not the last one hovered (#94 fast-drop)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })

  const childrenPaths: string[] = []
  page.on('request', (req) => {
    const m = req.url().match(/\/tree\/children\?(.*)$/)

    if (m) {
      childrenPaths.push(new URLSearchParams(m[1]).get('path') ?? '')
    }
  })

  await page.goto('/s/main')
  await expect(page.locator('[data-testid="tree-note"]')).toHaveCount(15)

  const srcId = await idOf(page, 'f1-note-1')
  const overId = await idOf(page, 'f5-note-1') // last hovered (decoy)
  const dropId = await idOf(page, 'f3-note-1') // actually released here

  const baseline = childrenPaths.length
  await dragNoteOverThenDropOn(page, { srcId: srcId!, overId: overId!, dropId: dropId! })

  // The move landed in f3 (the drop row), proven by which folders refetched:
  // f1 (source) + f3 (destination) — NOT f5 (the stale hover).
  await expect(page.locator('[data-testid="tree-note"]')).toHaveCount(15)
  await page.waitForTimeout(1500)
  const touched = new Set(childrenPaths.slice(baseline))
  expect(touched.has('f3')).toBe(true)
  expect(touched.has('f1')).toBe(true)
  expect(touched.has('f5')).toBe(false)
})

// The drop folder a note's row currently declares ('' = root).
const folderOfRow = (page: Page, id: string) =>
  page.evaluate(
    (rowId) =>
      document
        .querySelector(`[data-testid="tree-note"][data-id="${rowId}"]`)
        ?.parentElement?.getAttribute('data-drop-folder'),
    id,
  )

test('re-throwing a note while its first move is still pending is not blocked (#94)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })

  // Make the FIRST /api/move hang ~1.2s (the slow-link case we keep hitting), so
  // the second drop lands while it's still in flight. An over-strict in-flight
  // guard would drop that second move; the per-note coalescing pipeline must
  // accept it, queue it behind the first, and converge.
  const moveBodies: string[] = []
  let first = true
  await page.route('**/api/move', async (route) => {
    moveBodies.push(route.request().postData() ?? '')
    if (first) {
      first = false
      await new Promise((r) => setTimeout(r, 1200))
    }
    await route.continue()
  })

  await page.goto('/s/main')
  await expect(page.locator('[data-testid="tree-note"]')).toHaveCount(15)

  const noteId = await idOf(page, 'f1-note-1')
  const toF2 = await idOf(page, 'f2-note-1')
  const toF3 = await idOf(page, 'f3-note-1')

  // Move 1: f1 → f2 (its /api/move will hang). The row relocates optimistically NOW.
  await dragNoteOnto(page, noteId!, toF2!)
  await expect.poll(() => folderOfRow(page, noteId!)).toBe('f2')

  // Move 2 while move 1 is still pending: f2 → f3. NOT blocked — the row moves on.
  await dragNoteOnto(page, noteId!, toF3!)
  await expect.poll(() => folderOfRow(page, noteId!)).toBe('f3')

  // Both moves fire (serialized), the second to f3 — the note converges in f3,
  // present exactly once.
  await expect.poll(() => moveBodies.length).toBeGreaterThanOrEqual(2)
  expect(moveBodies.some((b) => b.includes('f3/'))).toBe(true)
  await page.waitForTimeout(800)
  await expect(page.locator('[data-testid="tree-note"]')).toHaveCount(15)
  await expect.poll(() => folderOfRow(page, noteId!)).toBe('f3')
})

test('another client sees the move over SSE — converges without a reload (#94 multi-client)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })

  // Two clients on the same backend. The actor moves a note; the OBSERVER must
  // reflect it via the `changed` SSE event — which now carries the note's new
  // folder, so the observer refreshes BOTH the folder it left (from its own
  // cache) and the one it landed in (from the event). Without the enriched
  // event the observer only knew the stale folder and the note vanished from
  // its tree until a reload.
  const actor = page
  await actor.goto('/s/main')
  await expect(actor.locator('[data-testid="tree-note"]')).toHaveCount(15)

  const observer = await actor.context().newPage()
  await observer.goto('/s/main')
  await expect(observer.locator('[data-testid="tree-note"]')).toHaveCount(15)

  const noteId = await idOf(actor, 'f1-note-1')
  const toF2 = await idOf(actor, 'f2-note-1')
  // Both clients agree it starts in f1.
  expect(await folderOfRow(observer, noteId!)).toBe('f1')

  await dragNoteOnto(actor, noteId!, toF2!)

  // The observer converges to f2 purely from the SSE `changed` event (coalesced
  // ~1s) — no reload, no duplicate, still 15 rows.
  await expect.poll(() => folderOfRow(observer, noteId!), { timeout: 8000 }).toBe('f2')
  await expect(observer.locator('[data-testid="tree-note"]')).toHaveCount(15)
  await expect(observer.locator(`[data-testid="tree-note"][data-id="${noteId}"]`)).toHaveCount(1)

  await observer.close()
})
