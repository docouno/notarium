import type { Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  analyzeDocumentState,
  encodeDocumentState,
  frontmatterListEntry,
  frontmatterScalarEntry,
  logicalNoteState,
} from '@notarium/core'
import type { Fixture } from '../fake-server/app'
import { expect, test } from './fixtures'

// Journey (#12): note history, VSCode-style panel pair. The aside's History
// tab holds the timeline (including the pre-edit baseline the first edit
// captured) with "+N −M" char counters per revision; picking a revision swaps
// the main column to the revision view with a word-level diff and a banner;
// restore rolls the note back through the CAS path and lands in the history
// as a 'restore' revision; the ways back to the current version are the
// banner button, Escape, deselecting and leaving the tab.

const NOTE = 'fake-demo-carbon'
const BODY = 'The basis of organic chemistry. Bonds with [[Titanium]] under heat.'

const baseFixture = (): Fixture =>
  JSON.parse(readFileSync(new URL('../fixtures/base.json', import.meta.url), 'utf8')) as Fixture

const carbonState = (
  reviewStatus: string,
): Pick<
  NonNullable<Fixture['spaces'][number]['activity']>[number],
  'stateBlobBase64' | 'stateFormat' | 'restoreSafety' | 'semanticFingerprint'
> => {
  const source = new TextEncoder().encode(
    logicalNoteState({
      title: 'Carbon',
      body: BODY,
      frontmatter: [
        frontmatterScalarEntry('type', 'element'),
        frontmatterListEntry('tags', ['element']),
        frontmatterScalarEntry('created', '2026-06-02T10:30:00.000Z'),
        frontmatterScalarEntry('review-status', reviewStatus),
      ],
    }).markdown,
  )
  const state = analyzeDocumentState({ source, pathFallbackTitle: 'Carbon' })

  return {
    stateBlobBase64: Buffer.from(encodeDocumentState(state)).toString('base64'),
    stateFormat: state.format,
    restoreSafety: state.restoreSafety.status,
    semanticFingerprint: state.semanticFingerprint,
  }
}

const resetCarbonHistory = async (
  page: Page,
  activity: NonNullable<Fixture['spaces'][number]['activity']>,
) => {
  const fixture = baseFixture()
  const carbon = fixture.spaces[0].notes.find((note) => note.title === 'Carbon')!
  carbon.frontmatter = 'review-status: reviewed'
  fixture.spaces[0].activity = activity
  await page.request.post('/api/__test/reset', { data: { fixture } })
}

const openCarbon = async (page: Page) => {
  await page.goto('/')
  await page.locator(`[data-testid="tree-note"][data-id="${NOTE}"]`).click()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
}

const editBody = async (page: Page, text: string) => {
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const body = page.locator('.cm-content')
  await body.click()
  await body.fill(text)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
}

const openHistoryTab = async (page: Page) => {
  // The aside starts collapsed; open it, then activate the History tab (#35: one
  // tab among the inspector's panels, wherever the saved layout places it).
  const opener = page.getByRole('button', { name: 'Open panel' })

  if (await opener.isVisible()) {
    await opener.click()
  }
  await page.getByRole('tab', { name: 'History' }).click()
  await expect(page.getByTestId('note-history')).toBeVisible()
}

test('two edits build a timeline with char counters; picking a revision shows its diff', async ({
  page,
}) => {
  await openCarbon(page)
  await editBody(page, 'First body.')
  await editBody(page, 'Second edited body with more detail.')
  await openHistoryTab(page)

  // Newest first: write, write, and the baseline the first edit captured.
  const items = page.getByTestId('history-item')
  await expect(items).toHaveCount(3)
  await expect(items.nth(0)).toContainText('Edited')
  await expect(items.nth(2)).toContainText('External change')
  await expect(page.getByTestId('note-history')).toContainText('3 revisions')

  // Snapshot counters expose both sides of the replacement; the word diff below
  // proves the same transition in detail without coupling this journey to exact counts.
  await expect(items.nth(0)).toContainText('+')
  await expect(items.nth(0)).toContainText('−')
  await expect(items.nth(2)).toContainText('+')

  // The reader stays until a revision is picked.
  await expect(page.getByTestId('revision-view')).toBeHidden()
  await items.nth(1).click()
  await expect(page.getByTestId('revision-banner')).toContainText('Back to note')

  // While viewing a revision the document actions step back.
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeHidden()

  // The middle revision's diff: against its chain parent.
  const diff = page.getByTestId('history-diff')
  await expect(diff).toContainText('basis of organic chemistry')
  await expect(diff.locator('del').first()).toBeVisible()

  // The baseline holds the fixture's original body.
  await items.nth(2).click()
  await expect(diff).toContainText('The basis of organic chemistry')

  // Clicking the selected row again deselects — back to the reader.
  await items.nth(2).click()
  await expect(page.getByTestId('revision-view')).toBeHidden()
  await expect(page.getByRole('article')).toBeVisible()
})

test('a metadata-only revision shows authored frontmatter in Changes', async ({ page }) => {
  await resetCarbonHistory(page, [
    {
      date: '2026-06-02T10:30:00.000Z',
      kind: 'created',
      noteId: NOTE,
      title: 'Carbon',
      content: BODY,
      ...carbonState('draft'),
    },
    {
      date: '2026-06-07T00:00:00.000Z',
      kind: 'edited',
      noteId: NOTE,
      title: 'Carbon',
      content: BODY,
      ...carbonState('reviewed'),
    },
  ])
  await openCarbon(page)
  await openHistoryTab(page)

  await page.getByTestId('history-item').nth(0).click()
  const diff = page.getByTestId('history-diff')
  await expect(diff.locator('del')).toContainText('draft')
  await expect(diff.locator('ins')).toContainText('reviewed')
  await expect(page.getByTestId('history-partial')).toHaveCount(0)
})

test('legacy history stays explicitly partial when strict restore is unavailable', async ({
  page,
}) => {
  await resetCarbonHistory(page, [
    {
      date: '2026-06-02T10:30:00.000Z',
      kind: 'baseline',
      noteId: NOTE,
      title: 'Carbon',
      content: 'Legacy body only.',
    },
    {
      date: '2026-06-07T00:00:00.000Z',
      kind: 'edited',
      noteId: NOTE,
      title: 'Carbon',
      content: BODY,
      ...carbonState('reviewed'),
    },
  ])
  await openCarbon(page)
  await openHistoryTab(page)

  const legacy = page.getByTestId('history-item').nth(1)
  await expect(legacy).toContainText('partial snapshot')
  await legacy.click()
  await expect(page.getByTestId('history-partial')).toContainText('Legacy partial snapshot')
  await expect(page.getByTestId('history-unavailable')).toContainText(
    'cannot provide crash-safe single-note restore',
  )
  await expect(page.getByTestId('history-restore')).toBeDisabled()
  await expect(page.getByTestId('history-restore')).toHaveAttribute(
    'title',
    /capability-unavailable/,
  )
})

test('a full revision over an honest gap shows unavailable comparison, not legacy or loading', async ({
  page,
}) => {
  await resetCarbonHistory(page, [
    {
      date: '2026-06-02T10:30:00.000Z',
      kind: 'baseline',
      noteId: NOTE,
      title: 'Carbon',
    },
    {
      date: '2026-06-07T00:00:00.000Z',
      kind: 'edited',
      noteId: NOTE,
      title: 'Carbon',
      content: BODY,
      ...carbonState('reviewed'),
    },
  ])
  await openCarbon(page)
  await openHistoryTab(page)

  await page.getByTestId('history-item').nth(0).click()
  await expect(page.getByTestId('history-comparison-gap')).toContainText(
    'parent revision content was not captured',
  )
  await expect(page.getByTestId('history-partial')).toHaveCount(0)
  await expect(page.getByTestId('revision-skeleton')).toHaveCount(0)
})

test('an opaque revision opens directly on its exact source', async ({ page }) => {
  const bytes = Uint8Array.from([0xff, 0, 0xfe, 0x61])
  const state = analyzeDocumentState({ source: bytes, pathFallbackTitle: 'Carbon' })

  await resetCarbonHistory(page, [
    {
      date: '2026-06-02T10:30:00.000Z',
      kind: 'created',
      noteId: NOTE,
      title: 'Carbon',
      stateBlobBase64: Buffer.from(encodeDocumentState(state)).toString('base64'),
      stateFormat: state.format,
      restoreSafety: state.restoreSafety.status,
      semanticFingerprint: state.semanticFingerprint,
    },
  ])
  await openCarbon(page)
  await openHistoryTab(page)
  await page.getByTestId('history-item').click()

  await expect(page.getByTestId('history-source')).toHaveText('base64\n/wD+YQ==')
  await expect(page.getByRole('button', { name: 'Content' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByTestId('history-diff')).toHaveCount(0)
})

test('a stale history restore explains the canonical version-conflict', async ({ page }) => {
  await resetCarbonHistory(page, [
    {
      date: '2026-06-02T10:30:00.000Z',
      kind: 'created',
      noteId: NOTE,
      title: 'Carbon',
      content: BODY,
      ...carbonState('draft'),
    },
    {
      date: '2026-06-07T00:00:00.000Z',
      kind: 'edited',
      noteId: NOTE,
      title: 'Carbon',
      content: BODY,
      ...carbonState('reviewed'),
    },
  ])
  await page.route(
    (url) => url.pathname === '/api/note/revisions',
    async (route) => {
      const response = await route.fetch()
      const payload = (await response.json()) as {
        revisions: Array<Record<string, unknown>>
        total: number
      }

      await route.fulfill({
        response,
        json: {
          ...payload,
          revisions: payload.revisions.map((revision) => ({
            ...revision,
            restoreAvailability: 'full',
          })),
        },
      })
    },
  )
  await page.route(
    (url) => url.pathname === '/api/note/restore',
    (route) =>
      route.fulfill({
        status: 409,
        json: {
          status: 'conflict',
          error: 'restore conflict',
          operationId: 'stale-history-restore',
          reason: 'version-conflict',
        },
      }),
  )
  await openCarbon(page)
  await openHistoryTab(page)
  await page.getByTestId('history-item').nth(1).click()
  await page.getByTestId('history-restore').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true }).click()

  await expect(page.getByRole('dialog')).toContainText(
    'The note changed while you were looking at its history. Review the latest state and try again.',
  )
})

test('a legacy trash tombstone is visibly partial and says uncaptured metadata is unrecoverable', async ({
  page,
}) => {
  const fixture = baseFixture()
  fixture.spaces[0].notes = fixture.spaces[0].notes.filter((note) => note.title !== 'Carbon')
  fixture.spaces[0].activity = [
    {
      date: '2026-06-07T00:00:00.000Z',
      kind: 'deleted',
      noteId: NOTE,
      title: 'Carbon',
      content: BODY,
    },
  ]
  await page.request.post('/api/__test/reset', { data: { fixture } })
  await page.goto('/s/main/trash')

  const row = page.getByTestId('trash-row').filter({ hasText: 'Carbon' })
  await expect(row.getByTestId('trash-recovery-status')).toHaveText('Partial restore')
  await expect(row.getByTestId('trash-recovery-status')).toHaveAttribute(
    'title',
    /metadata that was never captured cannot be recovered/,
  )
  await expect(row.getByTestId('trash-restore')).toHaveCount(0)
  await expect(page.getByTestId('trash-restore-unavailable')).toContainText(
    'Note restore is unavailable on this server',
  )

  // The fake has no global tombstone registry, so its id-addressed route cannot
  // open deleted notes. Supply the production deleted-detail shape to exercise
  // the banner independently from the already-proved list projection.
  await page.route(
    (url) => url.pathname === '/api/note' && url.searchParams.get('id') === NOTE,
    (route) =>
      route.fulfill({
        json: {
          id: NOTE,
          space: 'main',
          title: 'Carbon',
          filePath: 'demo/Carbon.md',
          class: 'user-doc',
          content: BODY,
          frontmatter: {},
          versionToken: '',
          deleted: true,
          deletedAt: '2026-06-07T00:00:00.000Z',
          deletedBy: null,
          restorable: true,
          restoreAvailability: 'capability-unavailable',
        },
      }),
  )
  await row.getByTestId('trash-row-open').click()
  await expect(page.getByTestId('deleted-restore')).toBeDisabled()
  await expect(page.getByTestId('deleted-restore-unavailable')).toContainText(
    'cannot publish them with crash-safe restore',
  )
})

test('restoring a partial copy from its deleted-note view requires the same explicit warning', async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname === '/api/note' && url.searchParams.get('id') === NOTE,
    (route) =>
      route.fulfill({
        json: {
          id: NOTE,
          space: 'main',
          title: 'Carbon',
          filePath: 'demo/Carbon.md',
          class: 'user-doc',
          content: BODY,
          frontmatter: {},
          versionToken: '',
          deleted: true,
          deletedAt: '2026-06-07T00:00:00.000Z',
          deletedBy: null,
          restorable: true,
          restoreAvailability: 'partial',
        },
      }),
  )
  await page.goto(`/n/${NOTE}`)

  await page.getByTestId('deleted-restore').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Restore this partial copy?')
  await expect(dialog).toContainText('metadata that was never captured cannot be recovered')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('deleted-note-view')).toBeVisible()
})

test('fake history does not simulate a weaker restore when strict publication is unavailable', async ({
  page,
}) => {
  await openCarbon(page)
  await editBody(page, 'Edited away from the original.')
  await openHistoryTab(page)

  // The fake has no restart-durable authority. The historical state remains
  // inspectable, but the UI must not pretend a best-effort rollback is strict.
  await page.getByTestId('history-item').nth(1).click()
  await expect(page.getByTestId('history-unavailable')).toContainText(
    'cannot provide crash-safe single-note restore',
  )
  await expect(page.getByTestId('history-restore')).toBeDisabled()
  await expect(page.getByTestId('history-item')).toHaveCount(2)
})

test('ways back to the current version: banner and Escape; switching tabs keeps the revision (#35)', async ({
  page,
}) => {
  await openCarbon(page)
  await editBody(page, 'An edit to give the timeline something.')
  await openHistoryTab(page)
  const items = page.getByTestId('history-item')

  // Banner button.
  await items.nth(0).click()
  await page.getByTestId('history-back').click()
  await expect(page.getByTestId('revision-view')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()

  // Escape.
  await items.nth(0).click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('revision-view')).toBeHidden()

  // Switching the aside tab away now only hides the timeline — the open revision
  // stays in the main column. History is one tab of a group (#35), possibly shown
  // beside others, so the revision view is no longer bound to which tab is active;
  // Escape / banner / deselect close it.
  await items.nth(0).click()
  await page.getByTestId('aside-tab-meta').click()
  await expect(page.getByTestId('note-history')).toBeHidden()
  await expect(page.getByTestId('revision-view')).toBeVisible()
})

test('a note never edited has no history yet — and says so once', async ({ page }) => {
  await openCarbon(page)
  await openHistoryTab(page)
  await expect(page.getByTestId('note-history')).toContainText('No history yet')
  // The placard alone carries the empty state — no redundant "0 revisions"
  // count line over it (#35 empty-state polish).
  await expect(page.getByTestId('note-history')).not.toContainText('revision')
})
