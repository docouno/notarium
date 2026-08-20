import { expect, test } from './fixtures'

// #245 — the merged Files + Feed section with the favorites lens (#42). The Feed
// has no own rail icon: feed / folder page / note are three faces of ONE "Files"
// section, and the tree LENS (files vs favorites) is orthogonal and mutually
// exclusive on the rail. This walks the seam the merge could break — the whole
// point of #245 — so the star and Files never light at once, favorites is a
// non-navigating lens, and it resets on a chrome surface (the #42 invariant, now
// keyed off an explicit surface signal instead of nav.type==='feed').
//
// Favorites are seeded through the live API (real-applier-only in the catalog, see
// docs/seeds.md), so this drives the same PUT the star button does.

const FIXTURE = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        {
          title: 'Finding',
          filePath: 'research/finding.md',
          modifiedAt: '2026-06-08T00:00:00.000Z',
          createdAt: '2026-06-01T09:00:00.000Z',
          tags: [],
          content: '# Finding\n\nA research note.',
        },
        {
          title: 'Proposal',
          filePath: 'drafts/proposal.md',
          modifiedAt: '2026-06-07T00:00:00.000Z',
          createdAt: '2026-06-02T09:00:00.000Z',
          tags: [],
          content: '# Proposal\n\nA draft.',
        },
        {
          title: 'Plan',
          filePath: 'Roadmap/plan.md',
          modifiedAt: '2026-06-06T00:00:00.000Z',
          createdAt: '2026-06-03T09:00:00.000Z',
          tags: [],
          content: '# Plan',
        },
        {
          title: 'Welcome',
          filePath: 'welcome.md',
          modifiedAt: '2026-06-09T00:00:00.000Z',
          createdAt: '2026-06-05T08:00:00.000Z',
          tags: [],
          content: '# Welcome',
        },
      ],
    },
  ],
  projects: [{ space: 'main', path: 'Roadmap', slug: 'roadmap', displayName: 'Roadmap' }],
}

// The fake derives a deterministic id from the path (welcome.md → fake-welcome).
const FINDING = 'fake-research-finding'

test('the favorites lens and the Files icon are mutually exclusive across the merged section', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  // Star a note (in research/) and the whole research/ folder — the same PUTs the
  // star button and the tree menu issue.
  await page.request.put(`${baseURL}/api/s/main/favorites`, { data: { kind: 'note', id: FINDING } })
  await page.request.put(`${baseURL}/api/s/main/favorites`, {
    data: { kind: 'folder', path: 'research' },
  })

  await page.goto('/s/main/feed')

  const files = page.getByTestId('rail-files')
  const star = page.getByTestId('rail-favorites')
  const scope = page.getByTestId('explorer-scope')

  // The feed is the section's default view → the FILES icon lights (no Feed icon).
  await expect(page.getByTestId('rail-feed')).toHaveCount(0)
  await expect(files).toHaveAttribute('aria-current', 'page')
  await expect(star).toHaveAttribute('aria-pressed', 'false')

  // Click the star → the tree LENS switches to favorites WITHOUT navigating (the
  // feed stays on screen), the star lights and the Files icon yields — never both.
  await star.click()
  await expect(page).toHaveURL(/\/s\/main\/feed$/) // no navigation — a lens, not a destination
  await expect(scope).toHaveAttribute('data-scope', 'favorites')
  await expect(star).toHaveAttribute('aria-pressed', 'true')
  await expect(files).not.toHaveAttribute('aria-current', 'page')
  // the tree is filtered: research/ (favorited) shows, drafts/ (not) doesn't
  await expect(page.locator('[data-testid="tree-folder"][data-path="research"]')).toBeVisible()
  await expect(page.locator('[data-testid="tree-folder"][data-path="drafts"]')).toHaveCount(0)

  // Open the favorited note → you STAY in favorites (the section doesn't switch on
  // its own), star still lit, Files still yielding (#42: "open a favorite → stay").
  await page.locator(`[data-testid="tree-note"][data-id="${FINDING}"]`).click()
  await expect(page).toHaveURL(new RegExp(`/n/${FINDING}`))
  await expect(scope).toHaveAttribute('data-scope', 'favorites')
  await expect(star).toHaveAttribute('aria-pressed', 'true')
  await expect(files).not.toHaveAttribute('aria-current', 'page')

  // Click Files → the merged section's default view (feed), the lens drops back to
  // the general files tree (sync exit), Files lights, the star goes dark.
  await files.click()
  await expect(page).toHaveURL(/\/s\/main\/feed$/)
  await expect(scope).toHaveAttribute('data-scope', 'files')
  await expect(files).toHaveAttribute('aria-current', 'page')
  await expect(star).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('[data-testid="tree-folder"][data-path="drafts"]')).toBeVisible()
})

test('leaving the section to a chrome surface resets a sticky favorites lens', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.request.put(`${baseURL}/api/s/main/favorites`, { data: { kind: 'note', id: FINDING } })
  await page.goto('/s/main/feed')

  const star = page.getByTestId('rail-favorites')
  const files = page.getByTestId('rail-files')
  const graph = page.getByTestId('rail-graph')
  const scope = page.getByTestId('explorer-scope')

  await star.click()
  await expect(scope).toHaveAttribute('data-scope', 'favorites')

  // Graph is a chrome surface — neither the star nor Files lights there, and the
  // sticky favorites lens resets so a note opened LATER reads as Files, not a
  // re-lit star (#42 invariant, feed no longer triggers this — it's in-section now).
  await graph.click()
  await expect(page).toHaveURL(/\/graph$/)
  await expect(graph).toHaveAttribute('aria-current', 'page')
  await expect(star).toHaveAttribute('aria-pressed', 'false')
  await expect(files).not.toHaveAttribute('aria-current', 'page')
  await expect(scope).toHaveAttribute('data-scope', 'files')
})

test('the favorites star stays DARK on the home dashboard, though the lens persists (#245)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.request.put(`${baseURL}/api/s/main/favorites`, { data: { kind: 'note', id: FINDING } })
  await page.goto('/s/main/feed')

  const star = page.getByTestId('rail-favorites')
  const files = page.getByTestId('rail-files')
  const scope = page.getByTestId('explorer-scope')

  await star.click()
  await expect(scope).toHaveAttribute('data-scope', 'favorites')
  await expect(star).toHaveAttribute('aria-pressed', 'true')

  // → the home dashboard (the logo owns home). The deliberate #245 contract change:
  // NEITHER file-tree icon lights here, even though the favorites lens is STILL the
  // persisted scope (pre-#245 the star lit on the dashboard). Home isn't a chrome
  // surface, so the lens is not reset — just unlit.
  await page.getByTestId('rail-home').click()
  await expect(page).toHaveURL(/\/s\/main$/)
  await expect(star).toHaveAttribute('aria-pressed', 'false')
  await expect(files).not.toHaveAttribute('aria-current', 'page')
  await expect(scope).toHaveAttribute('data-scope', 'favorites')
})

test('opening a NON-favorite note under the favorites lens keeps the star lit — the star tracks the LENS, not the open note (#42)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.request.put(`${baseURL}/api/s/main/favorites`, { data: { kind: 'note', id: FINDING } })
  await page.goto('/s/main/feed')

  const star = page.getByTestId('rail-favorites')
  const files = page.getByTestId('rail-files')
  const scope = page.getByTestId('explorer-scope')

  await star.click()
  await expect(scope).toHaveAttribute('data-scope', 'favorites')

  // Deep-link a NON-favorite note (drafts/proposal, not starred). scopeHidesFolder is
  // false for favorites, so the reader does NOT bounce the lens to Files: the star
  // stays lit and Files stays dark. A regression tying the star to whether the OPEN
  // note is favorited (rather than to the lens) would fail here.
  await page.goto('/n/fake-drafts-proposal')
  await expect(page).toHaveURL(/\/n\/fake-drafts-proposal/)
  await expect(scope).toHaveAttribute('data-scope', 'favorites')
  await expect(star).toHaveAttribute('aria-pressed', 'true')
  await expect(files).not.toHaveAttribute('aria-current', 'page')
})

test('picking a file lens OFF the section lands on the feed and lights it consistently (#245)', async ({
  page,
  baseURL,
}) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: FIXTURE } })
  await page.request.put(`${baseURL}/api/s/main/favorites`, { data: { kind: 'note', id: FINDING } })

  const files = page.getByTestId('rail-files')
  const star = page.getByTestId('rail-favorites')
  const scope = page.getByTestId('explorer-scope')
  const picker = () => scope.click()

  // The bug this guards: from a surface OUTSIDE the merged Files section, picking
  // Favorites dropped you on the DASHBOARD with the star lit, but picking
  // Files/Projects dropped you there with NOTHING lit — inconsistent. Now BOTH land
  // on the merged Files section (the feed) and light their icon the same way.
  //
  // The rail star is reachable from anywhere, so Agents still serves it. The FILE
  // lens picker is not: Agents owns its own dataset picker, so the file lenses are
  // asked from another off-section surface — the dashboard.

  // Favorites (via the rail star) from Agents → the feed, star lit, Files dark.
  await page.goto('/agents/context/personal')
  await star.click()
  await expect(page).toHaveURL(/\/s\/main\/feed$/)
  await expect(scope).toHaveAttribute('data-scope', 'favorites')
  await expect(star).toHaveAttribute('aria-pressed', 'true')
  await expect(files).not.toHaveAttribute('aria-current', 'page')

  // Projects (via the scope picker) off-section → the SAME feed, Files lit, star dark.
  await page.goto('/s/main')
  await picker()
  await page.getByRole('menuitemradio', { name: 'Projects' }).click()
  await expect(page).toHaveURL(/\/s\/main\/feed$/)
  await expect(scope).toHaveAttribute('data-scope', 'projects')
  await expect(files).toHaveAttribute('aria-current', 'page')
  await expect(star).toHaveAttribute('aria-pressed', 'false')

  // Files (via the scope picker) off-section → the feed, Files lit — identical shape.
  await page.goto('/s/main')
  await picker()
  await page.getByRole('menuitemradio', { name: 'Files' }).click()
  await expect(page).toHaveURL(/\/s\/main\/feed$/)
  await expect(scope).toHaveAttribute('data-scope', 'files')
  await expect(files).toHaveAttribute('aria-current', 'page')
  await expect(star).toHaveAttribute('aria-pressed', 'false')
})
