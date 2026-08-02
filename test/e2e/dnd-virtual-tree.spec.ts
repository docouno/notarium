import { expect, test } from './fixtures'

// #68 item 7 — drag-and-drop collision in the VIRTUALIZED file tree when the rail
// auto-scrolls during a drag (scroll present, two folders open, dragging a note
// from the upper folder into the lower one drifted with a folder collision; the
// reverse was clean).
//
// Root cause: the virtualizer's row-height estimate (30px) did not match the real
// uniform row height (29px). Not-yet-measured rows therefore mounted 1px-per-row
// too low and snapped up once `measureElement` reported their real height. Summed
// across a virtual window that snap reaches a whole row. The browser auto-scrolls
// the rail during a native drag, so the snap yanked the row out from under the
// cursor and the drop landed on the wrong folder. It was asymmetric because
// auto-scrolling DOWN enters fresh, unmeasured rows (big snap) while scrolling UP
// re-enters already-measured rows (no snap).
//
// Native drag auto-scroll is an OS-level loop Playwright can't drive, so this
// locks the ROOT invariant instead: a buried row sits at exactly
// index × real-row-height — no cumulative estimate inflation, so rows never move
// after they mount and a drag's drop target stays under the cursor.

// A long, single-folder-per-area tree: enough rows to virtualize and scroll deep.
// Top-level folders auto-expand on first load (filling the count with rows — real
// notes or loading shimmers, both the same height), which is what makes the rail
// actually scroll.
const LONG_FIXTURE = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: Array.from({ length: 14 }, (_, f) =>
        Array.from({ length: 14 }, (_n, n) => ({
          title: `Note ${String(f + 1).padStart(2, '0')}-${String(n + 1).padStart(2, '0')}`,
          filePath: `area-${String(f + 1).padStart(2, '0')}/note-${String(n + 1).padStart(2, '0')}.md`,
          modifiedAt: '2026-06-08T00:00:00.000Z',
          createdAt: '2026-06-01T09:00:00.000Z',
          tags: [],
          content: `# Note ${f}-${n}`,
        })),
      ).flat(),
    },
  ],
}

test('virtualized tree rows sit at their real height — a drag never drifts (#68 item 7)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: LONG_FIXTURE } })
  await page.goto('/s/main')

  const scroll = page.getByTestId('rail-scroll')
  await expect(scroll).toBeVisible()
  // Wait until the tree is long enough to scroll well past the fold (folders
  // auto-expanded → the virtual list filled out).
  await expect
    .poll(() => scroll.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 10_000 })
    .toBeGreaterThan(3000)

  const result = await scroll.evaluate((sc) => {
    const box = sc.querySelector('[class*="tree-virtual"]') as HTMLElement
    const scTop = sc.getBoundingClientRect().top
    const raf = (n: number) =>
      new Promise<void>((r) => {
        let i = 0

        const tick = () => {
          i += 1
          if (i >= n) {
            r()
          } else {
            requestAnimationFrame(tick)
          }
        }
        requestAnimationFrame(tick)
      })
    return (async () => {
      sc.scrollTop = 0
      await raf(3)
      // The tree box sits below the rail's nav section; this offset converts a
      // row's content-space top into its position WITHIN the tree.
      const margin = box.getBoundingClientRect().top - scTop + sc.scrollTop
      // Jump deep so the top of the rendered window has a large index and the
      // rows above it are not-yet-measured (where a wrong estimate inflates).
      sc.scrollTop = Math.floor((sc.scrollHeight - sc.clientHeight) * 0.6)
      await raf(10)
      const snap = () =>
        [...sc.querySelectorAll('[data-index]')]
          .map((r) => {
            const rect = r.getBoundingClientRect()
            return { idx: Number(r.getAttribute('data-index')), top: rect.top, h: rect.height }
          })
          .sort((a, b) => a.idx - b.idx)
      const top = snap()[0]
      const startInTree = top.top - scTop + sc.scrollTop - margin
      // Scan several scroll positions AND browser zooms for any gap/overlap between
      // adjacent rows — the visible symptom of the bug (a folder name landing on the
      // file above). It only showed off 100% zoom (a "29px" row becomes fractional,
      // e.g. 31.9px at 110%), so test fractional zooms too. Rows render in flow, so
      // they abut at any zoom → structurally zero.
      let worstGap = 0

      for (const zoom of [1, 1.1, 1.25]) {
        document.documentElement.style.zoom = String(zoom)
        await raf(4)
        for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
          sc.scrollTop = Math.floor((sc.scrollHeight - sc.clientHeight) * frac)
          await raf(3)
          const rows = snap()

          for (let i = 0; i < rows.length - 1; i++) {
            if (rows[i + 1].idx === rows[i].idx + 1) {
              // normalise out the zoom scale so the threshold stays in CSS px
              worstGap = Math.max(
                worstGap,
                Math.abs(rows[i + 1].top - rows[i].top - rows[i].h) / zoom,
              )
            }
          }
        }
      }
      document.documentElement.style.zoom = '1'
      return { idx: top.idx, rowHeight: top.h, inflation: startInTree - top.idx * top.h, worstGap }
    })()
  })

  // Sanity: we genuinely scrolled deep (a large top index → many unmeasured rows
  // above, which is exactly where a wrong estimate would have inflated offsets).
  expect(result.idx).toBeGreaterThan(40)
  expect(result.rowHeight).toBeGreaterThan(0)
  // No gap or overlap between adjacent rows at any scroll position — rows tile.
  expect(result.worstGap).toBeLessThan(1)
  // The buried row sits at index × real-row-height. With the old too-tall estimate
  // this was off by ~1px per unmeasured row above (tens of px here) — far over a
  // whole row — which is what made the drag drift. Now it must be sub-row-tight.
  expect(Math.abs(result.inflation)).toBeLessThan(result.rowHeight)
})
