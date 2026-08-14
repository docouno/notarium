import { type Page } from '@playwright/test'
import { expect, test, treeNote } from './fixtures'

// #111 — runtime access CHANGES must reflect without a reload, both ways:
//  • LOST: losing the active space (membership revoked, or archive/delete) → an
//    explicit takeover, not silent breakage. We simulate a revoke by stripping
//    the space from the live session and 404-ing its scoped routes — the wire a
//    revoked principal sees (docs/auth.md). The detector re-checks the session
//    (the authority) and takes the app over with a switch to a live space.
//  • GAINED: being granted a space → it appears in the switcher live, via the
//    server's named `access` SSE nudge (driven here by a real admin grant from a
//    second request context, end-to-end against the fake's real buildApp).
//  • READ-ONLY: a reader's chrome hides every create/edit/delete affordance —
//    they used to show, then the server rejected the save (the misleading bug).
//
// The SSE-drop trigger for LOST (the proactive path) is verified live against the
// real server, where a revoke genuinely tears the socket — interception can't
// kill an already-open EventSource. Here LOST drives the other real trigger: a
// 403/404 on the active space's scoped route (the api-layer probe).

const AUTH_WORLD = {
  now: '2026-06-10T12:00:00.000Z',
  spaces: [
    {
      slug: 'main',
      displayName: 'Main',
      notes: [
        {
          title: 'Main Note',
          filePath: 'demo/Main Note.md',
          modifiedAt: '2026-06-08T00:00:00.000Z',
          createdAt: '2026-06-01T09:00:00.000Z',
          tags: [],
          content: '# Main Note\n\nlives in main',
        },
      ],
    },
    {
      slug: 'work',
      displayName: 'Work',
      notes: [
        {
          title: 'Work Note',
          filePath: 'projects/Work Note.md',
          modifiedAt: '2026-06-09T00:00:00.000Z',
          createdAt: '2026-06-02T09:00:00.000Z',
          tags: [],
          content: '# Work Note\n\nlives in work',
        },
      ],
    },
  ],
  // A marked project in `main` — so the projects management tab has an Unmark
  // action that a leaking client would expose to a non-writer (#121).
  projects: [{ space: 'main', path: 'demo' }],
  auth: {
    users: [
      { username: 'root', password: 'root-password-1', admin: true },
      { username: 'bob', password: 'bob-password-01' },
      { username: 'ron', password: 'ron-password-01' },
      // a host-admin who is only a READER of `main` — the #121 subject.
      { username: 'adron', password: 'adron-password-1', admin: true },
      // a user with NO membership — added to `main` at runtime by the live
      // members-list test (someone appearing while another viewer watches).
      { username: 'eve', password: 'eve-password-01' },
    ],
    members: [
      { space: 'main', username: 'root', role: 'owner' },
      { space: 'work', username: 'root', role: 'owner' },
      // bob starts in `main` only — the grant test adds `work` at runtime.
      { space: 'main', username: 'bob', role: 'writer' },
      // ron is a READER of `main` — the read-only gating subject.
      { space: 'main', username: 'ron', role: 'reader' },
      // adron is a host-admin but only a READER of `main`: admin must NOT unlock
      // project (space:write) actions — the server's admin override is for
      // management/recovery (need:'owner'), never space:write (#121).
      { space: 'main', username: 'adron', role: 'reader' },
    ],
  },
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`, { data: { fixture: AUTH_WORLD } })
})

test.afterEach(async ({ page, baseURL }) => {
  await page.request.post(`${baseURL}/api/__test/reset`)
})

const login = async (page: Page, username: string, password: string) => {
  await page.getByTestId('auth-username').fill(username)
  await page.getByTestId('auth-password').fill(password)
  await page.getByTestId('auth-submit').click()
}

/** Simulate "access to `main` revoked mid-session": the session no longer grants
 *  it, and its scoped routes answer 404 (anti-enumeration #16) — without touching
 *  `work`, so the switch target stays reachable. */
const revokeMain = async (page: Page) => {
  await page.route('**/api/auth/session', async (route) => {
    const res = await route.fetch()
    const json = (await res.json()) as { me?: { spaces?: { slug: string }[] } }

    if (json.me?.spaces) {
      json.me.spaces = json.me.spaces.filter((s) => s.slug !== 'main')
    }
    await route.fulfill({ response: res, json })
  })
  await page.route('**/api/s/main/**', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'not found' }),
    }),
  )
}

test('a revoked active space shows the takeover, not a silently broken shell', async ({ page }) => {
  await page.goto('/')
  await login(page, 'root', 'root-password-1')
  await expect(treeNote(page, 'Main Note')).toBeVisible() // happily working in `main`

  await revokeMain(page)

  // A space-scoped fetch on the active space (the graph) now 404s → the detector
  // re-checks the session, finds `main` gone, and takes over.
  await page.getByTestId('rail-graph').click()

  const takeover = page.getByTestId('space-access-lost')
  await expect(takeover).toBeVisible()
  // The dead space's chrome is gone — not a half-broken shell behind a banner.
  await expect(treeNote(page, 'Main Note')).not.toBeVisible()
  // The switch lands on a space that still works (personal first, else the first
  // other readable — here `work`).
  await expect(page.getByRole('button', { name: 'Switch to Work' })).toBeVisible()
})

test('switching from the takeover lands in a working space', async ({ page }) => {
  await page.goto('/')
  await login(page, 'root', 'root-password-1')
  await expect(treeNote(page, 'Main Note')).toBeVisible()

  await revokeMain(page)
  await page.getByTestId('rail-graph').click()
  await expect(page.getByTestId('space-access-lost')).toBeVisible()

  await page.getByRole('button', { name: 'Switch to Work' }).click()

  await expect(page).toHaveURL(/\/s\/work$/)
  await expect(page.getByTestId('space-access-lost')).not.toBeVisible()
  await expect(treeNote(page, 'Work Note')).toBeVisible() // the new space is live
})

test('a newly granted space appears in the switcher live, no reload (#111 grant-side)', async ({
  page,
  request,
  baseURL,
}) => {
  await page.goto('/')
  await login(page, 'bob', 'bob-password-01')
  await expect(treeNote(page, 'Main Note')).toBeVisible() // bob works in `main` only

  // Open the switcher: `work` isn't offered (bob has no grant on it yet). Leave it
  // OPEN — the menu recomputes from `spaces`, so a live grant updates it in place.
  await page.getByTestId('space-switcher').click()
  await expect(page.getByText('Work', { exact: true })).toHaveCount(0)

  // A separate admin session grants bob `work`. The server nudges bob's live SSE
  // stream with a named `access` event → the client refetches its grants.
  await request.post(`${baseURL}/api/auth/login`, {
    data: { username: 'root', password: 'root-password-1' },
  })
  const granted = await request.put(`${baseURL}/api/s/work/members/bob`, {
    data: { role: 'writer' },
  })
  expect(granted.ok()).toBeTruthy()

  // …and `work` appears in the still-open switcher — no reload, no reopen.
  await expect(page.getByText('Work', { exact: true })).toBeVisible()
})

test('the members list badge tracks a live role change, no reload (#111 grant-side)', async ({
  page,
  request,
  baseURL,
}) => {
  await page.goto('/')
  await login(page, 'bob', 'bob-password-01')
  await expect(treeNote(page, 'Main Note')).toBeVisible() // session settled, bob is in `main`
  await page.goto('/s/main/management/members')
  const bobRow = page.getByTestId('members-list').getByRole('listitem').filter({ hasText: '@bob' })
  await expect(bobRow).toContainText('Writer') // bob is a writer of `main`

  // A separate admin session demotes bob → reader. The `access` nudge refreshes
  // bob's session; the open list must re-fetch so its badge doesn't lag the chrome
  // (the chrome already reacts via canWrite — the list used to read once on open).
  await request.post(`${baseURL}/api/auth/login`, {
    data: { username: 'root', password: 'root-password-1' },
  })
  const demoted = await request.put(`${baseURL}/api/s/main/members/bob`, {
    data: { role: 'reader' },
  })
  expect(demoted.ok()).toBeTruthy()

  await expect(bobRow).toContainText('Reader') // the badge tracked it — no reload
})

// A change to SOMEONE ELSE must reflect live for a bystander viewer — this is the
// space-level `members` broadcast, distinct from the addressed `access` nudge.
// Three shapes (remove / role-change / add) so a partial revert of
// `notifyMembersOf` in either putMember or removeMember can't slip through.
test('the members list reflects another member removed live, no reload (#121-follow-up)', async ({
  page,
  request,
  baseURL,
}) => {
  await page.goto('/')
  await login(page, 'bob', 'bob-password-01')
  await expect(treeNote(page, 'Main Note')).toBeVisible()
  await page.goto('/s/main/management/members')
  const ronRow = page.getByTestId('members-list').getByRole('listitem').filter({ hasText: '@ron' })
  await expect(ronRow).toHaveCount(1) // ron is a member bob can see

  // A separate admin session removes ron — bob's grants are untouched.
  await request.post(`${baseURL}/api/auth/login`, {
    data: { username: 'root', password: 'root-password-1' },
  })
  const removed = await request.delete(`${baseURL}/api/s/main/members/ron`)
  expect(removed.ok()).toBeTruthy()

  await expect(ronRow).toHaveCount(0) // dropped live — no reload
})

test("the members list reflects another member's role change live (#121-follow-up)", async ({
  page,
  request,
  baseURL,
}) => {
  await page.goto('/')
  await login(page, 'bob', 'bob-password-01')
  await expect(treeNote(page, 'Main Note')).toBeVisible()
  await page.goto('/s/main/management/members')
  const ronRow = page.getByTestId('members-list').getByRole('listitem').filter({ hasText: '@ron' })
  await expect(ronRow).toContainText('Reader') // ron starts a reader of `main`

  // A separate admin promotes ron reader→writer — bob (a bystander) sees the badge
  // flip via the `members` broadcast, not his own `access` nudge.
  await request.post(`${baseURL}/api/auth/login`, {
    data: { username: 'root', password: 'root-password-1' },
  })
  const promoted = await request.put(`${baseURL}/api/s/main/members/ron`, {
    data: { role: 'writer' },
  })
  expect(promoted.ok()).toBeTruthy()

  await expect(ronRow).toContainText('Writer') // re-roled live — no reload
})

test('the members list reflects a newly added member live (#121-follow-up)', async ({
  page,
  request,
  baseURL,
}) => {
  await page.goto('/')
  await login(page, 'bob', 'bob-password-01')
  await expect(treeNote(page, 'Main Note')).toBeVisible()
  await page.goto('/s/main/management/members')
  const list = page.getByTestId('members-list')
  const eveRow = list.getByRole('listitem').filter({ hasText: '@eve' })
  await expect(eveRow).toHaveCount(0) // eve isn't a member yet

  // A separate admin adds eve to `main` — she appears in bob's open list live.
  await request.post(`${baseURL}/api/auth/login`, {
    data: { username: 'root', password: 'root-password-1' },
  })
  const added = await request.put(`${baseURL}/api/s/main/members/eve`, { data: { role: 'reader' } })
  expect(added.ok()).toBeTruthy()

  await expect(eveRow).toHaveCount(1) // appeared live — no reload
})

test('a reader gets a read-only chrome — no create/edit/delete affordances', async ({ page }) => {
  await page.goto('/')
  await login(page, 'ron', 'ron-password-01')
  await expect(treeNote(page, 'Main Note')).toBeVisible() // ron can READ `main`

  // No creation affordances anywhere in the chrome — the bug was these showing,
  // then the server rejecting the save (the fake-create trap). The rail's
  // standalone "+" was dropped in #245, so the create affordance lives in the panel
  // head (Collapse · Refresh · New) — gated on write, so a reader sees no New.
  await expect(page.getByTestId('new-note')).toHaveCount(0)
  await expect(page.getByTestId('new-menu')).toHaveCount(0)

  // Opening a note offers no Edit (so no save to reject). The ⋮ "More actions" kebab
  // is reader-SAFE (#232): it renders once the note loads and carries ONLY "Copy note
  // id" — every mutation (Pin / Delete) is gated out. (Awaiting the kebab also de-races
  // this: navigate-first flips /n before the note detail lands, and the kebab appears
  // with the loaded note — asserting its absence would race the load.)
  await treeNote(page, 'Main Note').click()
  await expect(page).toHaveURL(/\/n\//)
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0)
  const kebab = page.getByRole('button', { name: 'More actions' })
  await expect(kebab).toBeVisible()
  await kebab.click()
  await expect(page.getByRole('menuitem', { name: 'Copy note id' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Pin to agent context' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(kebab).toBeFocused()
  await kebab.click()
  await page.getByRole('menuitem', { name: 'Copy note id' }).click()
  await expect(kebab).toBeFocused()

  // The note's context menu keeps read actions (Copy) but drops every mutation.
  const treeRow = page.locator('[data-testid="tree-note"]').first()
  await treeRow.focus()
  await treeRow.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Copy wikilink' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0)
  await page.getByRole('menuitem', { name: 'Copy wikilink' }).click()
  await expect(treeRow).toBeFocused()

  // A plain (non-admin) reader can VIEW the members list but gets no management
  // controls — the negative side of the admin asymmetry (#121): no admin flag, not
  // an owner → `members:manage` denied, so no add form, no per-row actions.
  await page.goto('/s/main/management/members')
  await expect(page.getByTestId('members-list')).toBeVisible()
  await expect(page.getByTestId('member-add-form')).toHaveCount(0)
  await expect(page.getByTestId('member-actions')).toHaveCount(0)
})

test('a host-admin who is only a reader gets no project-management actions (#121)', async ({
  page,
}) => {
  await page.goto('/')
  await login(page, 'adron', 'adron-password-1')
  await expect(treeNote(page, 'Main Note')).toBeVisible() // an admin can READ `main`

  // Marking a folder is a `space:write` act; the server's admin override is for
  // management/recovery (need:'owner'), never `space:write` — so the server would
  // 403 a project mutation from this admin-reader. The client must mirror that:
  // the projects tab is reachable by any reader (Export lives there too), but every
  // mutation has to be inert. Before #121 the client trusted `admin` and showed
  // live Mark/Unmark here, the same "affordance shown → server rejects" trap as the
  // reader bug, one tier up (the tree menu was already masked by canWrite, #111).
  await page.goto('/s/main/management/projects')

  // The always-present root row's switch is disabled — the root can't be marked…
  await expect(page.getByTestId('mark-root-project')).toBeDisabled()
  // …and the seeded `demo` project offers no Unmark.
  await expect(page.getByTestId('projects-list')).toContainText('main/demo')
  await expect(page.getByRole('button', { name: 'Unmark' })).toHaveCount(0)

  // The other half of the asymmetry: managing MEMBERS is `members:manage`
  // (need:'owner'), where the server's admin-override IS valid — so the same
  // admin-reader DOES keep the members controls. This pins that the project gate
  // tightened without collapsing the (correct) admin path for member management.
  await page.goto('/s/main/management/members')
  await expect(page.getByTestId('member-add-form')).toBeVisible()
  await expect(page.getByTestId('member-actions').first()).toBeVisible()
})
