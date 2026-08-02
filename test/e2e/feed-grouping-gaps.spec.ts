import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures'

// #68.6 — changing the Feed's grouping must not leave gaps between rows. The three
// virtualized layouts used to reset stale heights with `virtualizer.measure()`,
// which empties the whole size cache; but a ResizeObserver only re-fires for an
// element whose rendered size actually CHANGED, so every row that kept its height
// (the common case when toggling grouping) was stranded on the much larger
// estimate — ~95px of dead space under each. The fix keys the measurement cache by
// geometry (getItemKey), so unchanged rows keep their valid height and only the
// rows that actually changed (gained/lost a section header) re-measure.

// 9 notes across 3 distinct days → day grouping yields 3 sections. createdAt drives
// the default (Created) sort and its bucket histogram.
const DAYS = ['2026-06-08', '2026-06-07', '2026-06-06']
const GROUPED_FIXTURE = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: Array.from({ length: 9 }, (_, i) => {
        const day = DAYS[i % DAYS.length]
        return {
          title: `Note ${String(i + 1).padStart(2, '0')}`,
          filePath: `notes/note-${String(i + 1).padStart(2, '0')}.md`,
          modifiedAt: `${day}T00:00:00.000Z`,
          createdAt: `${day}T09:00:00.000Z`,
          tags: [],
          content: `# Note ${i + 1}\n\nShort body for note ${i + 1}.`,
        }
      }),
    },
  ],
}

// Each timeline row is absolutely positioned at translateY(start) and IS the element
// the virtualizer measures (a section header lives INSIDE the row, so it never breaks
// contiguity). "No gaps" ⇔ every row's start == the previous row's start + its measured
// height. A row stranded on the estimate shows up as a fat positive gap (~95px).
const maxRowGap = async (rows: Locator): Promise<number> =>
  rows.evaluateAll((els) => {
    const items = els
      .map((el) => {
        const m = /translateY\(([-\d.]+)px\)/.exec(el.style.transform || '')
        return { ty: m ? parseFloat(m[1]) : NaN, h: el.getBoundingClientRect().height }
      })
      .filter((r) => !Number.isNaN(r.ty))
      .sort((a, b) => a.ty - b.ty)
    let max = 0

    for (let i = 1; i < items.length; i++) {
      max = Math.max(max, Math.abs(items[i].ty - (items[i - 1].ty + items[i - 1].h)))
    }

    return max
  })

test('changing the Feed grouping leaves no gaps between timeline rows', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: GROUPED_FIXTURE } })
  // Tall enough that all 9 rows + 3 headers mount, so a stranded row can't hide below
  // the fold (and the header count is deterministic).
  await page.setViewportSize({ width: 1280, height: 1000 })

  await page.goto('/')
  await page.getByTestId('rail-files').click()
  await expect(page).toHaveURL(/\/feed$/)

  // Default view is the List timeline.
  const rows = page.locator('[data-testid="feed-row"]')
  await expect(rows.first()).toBeVisible()

  // group=off: rows are flush.
  await expect.poll(() => maxRowGap(rows)).toBeLessThan(2)

  // Switch to day grouping — the regime change that used to strand rows. Three day
  // headers appear and the rows must stay flush (no ~95px gaps).
  await page.getByRole('button', { name: 'Day', exact: true }).click()
  await expect(page.getByTestId('feed-group')).toHaveCount(3)
  await expect.poll(() => maxRowGap(rows)).toBeLessThan(2)

  // Repeated toggles must not accumulate stranded rows either.
  for (const g of ['Week', 'None', 'Day']) {
    await page.getByRole('button', { name: g, exact: true }).click()
    await expect.poll(() => maxRowGap(rows)).toBeLessThan(2)
  }
})

// #68.6 follow-up — a grouping change must not flash through an UNGROUPED state
// while the new histogram loads. useFeedState used to blank the buckets on every
// change, so the section headers vanished mid-fetch and reappeared relabelled
// ("Last week" → nothing → "Saturday/Friday/…"). The fix holds the current
// grouping's buckets until the new ones land, then swaps atomically — so the
// header count moves directly from the old grouping's to the new one's, never to
// zero.
test('changing grouping holds the current sections until the new histogram lands', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: GROUPED_FIXTURE } })
  await page.setViewportSize({ width: 1280, height: 1000 })

  // Delay the histogram so the swap window is observable and deterministic.
  await page.route(
    (url) => url.pathname.endsWith('/notes/buckets'),
    async (route) => {
      await new Promise((r) => setTimeout(r, 800))
      await route.continue()
    },
  )

  await page.goto('/')
  await page.getByTestId('rail-files').click()
  await expect(page).toHaveURL(/\/feed$/)

  // Group by day → 3 day sections (waits out the delayed histogram).
  await page.getByRole('button', { name: 'Day', exact: true }).click()
  await expect(page.getByTestId('feed-group')).toHaveCount(3)

  // Switch day → week: the new histogram is delayed. Mid-fetch the DAY sections
  // must still be on screen (held) — never blanked to ungrouped.
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await page.waitForTimeout(300) // well inside the 800ms delay
  await expect(page.getByTestId('feed-group')).toHaveCount(3) // day sections held, not 0

  // …then the week histogram lands and the sections swap atomically — 3 day
  // sections → 2 ISO weeks (Sat+Sun = wk23, Mon = wk24), never through zero.
  await expect(page.getByTestId('feed-group')).toHaveCount(2)
})
