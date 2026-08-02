import { expect, test } from './fixtures'

// #128 item 1 — regression: switching from one OPEN note to ANOTHER must open the
// new note. #100 phase 1 added a canonical-slug effect (NotePage) that re-runs on
// every pathname change and rewrites /n/<id> → /n/<id>/<slug>. But mid-switch
// `note` still holds the PREVIOUS note while the next one loads (the skeleton
// replaces the old content, #68); without a `parsed.id === note.id` guard the
// effect computed the OLD note's slug and replace-navigated the URL back to it —
// so the target never opened, the reader and URL snapped back to where you were.
// Live repro (#128): Americium → click another note → URL stuck on Americium.

test('clicking another note in the tree opens it, never snapping back (#128 item 1)', async ({
  page,
}) => {
  await page.goto('/')
  const titanium = page.locator('[data-testid="tree-note"][data-id="fake-demo-titanium"]')
  const carbon = page.locator('[data-testid="tree-note"][data-id="fake-demo-carbon"]')
  await expect(titanium).toBeVisible()

  // Open A (Titanium): the URL settles on its canonical /n/<id>/<slug> (#100 phase 1).
  await titanium.click()
  await expect(page).toHaveURL(/\/n\/fake-demo-titanium\/titanium$/)
  await expect(page.getByRole('heading', { name: 'Titanium', level: 1 })).toBeVisible()

  // Click B (Carbon): both URL and content must become B. Before the fix the
  // canonical effect — still seeing note A — yanked the URL back to A here.
  await carbon.click()
  await expect(page).toHaveURL(/\/n\/fake-demo-carbon\/carbon$/)
  await expect(page.getByRole('heading', { name: 'Carbon', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Titanium', level: 1 })).toHaveCount(0)
  await expect(carbon).toHaveAttribute('aria-current', 'page')
  await expect(titanium).not.toHaveAttribute('aria-current', 'page')
})

// The same regression reached past tree clicks (#128): any restart where the URL
// already points at B while `note` still holds A — here following a [[wiki link]]
// in A's body to B. error-states covers the resolve-first path; this nails the
// note→note hop specifically as the canonical-effect victim.
test('following a [[wiki link]] to another note opens the target, not the source (#128 item 1)', async ({
  page,
}) => {
  await page.goto('/n/fake-demo-titanium')
  await expect(page.getByRole('heading', { name: 'Titanium', level: 1 })).toBeVisible()

  // Titanium's body links to [[Carbon]] (a real note). Following it lands on
  // Carbon — before the fix the stale-note canonical effect bounced back to A.
  await page.locator('.markdown a', { hasText: 'Carbon' }).click()
  await expect(page).toHaveURL(/\/n\/fake-demo-carbon\/carbon$/)
  await expect(page.getByRole('heading', { name: 'Carbon', level: 1 })).toBeVisible()
})
