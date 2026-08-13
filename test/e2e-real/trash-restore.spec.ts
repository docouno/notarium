import { expect, test } from '@playwright/test'

test('real mixed bulk restore explains a collision and reaches a peer through SSE', async ({
  page,
  context,
}) => {
  const peer = await context.newPage()
  const trashUrl = '/s/main/trash?tab=notes'

  await Promise.all([page.goto(trashUrl), peer.goto(trashUrl)])
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'ok')
  await expect(peer.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'ok')

  const collision = page.getByTestId('trash-row').filter({ hasText: 'Earlier weekly status' })
  const peerCollision = peer.getByTestId('trash-row').filter({ hasText: 'Earlier weekly status' })
  const title = 'Meeting note 001'
  const restored = page.getByTestId('trash-row').filter({ hasText: title })
  const peerRow = peer.getByTestId('trash-row').filter({ hasText: title })

  await expect(peerCollision).toBeVisible()
  await expect(peerRow).toBeVisible()
  await collision.getByTestId('trash-row-check').check({ force: true })
  await restored.getByTestId('trash-row-check').check({ force: true })
  await page.getByTestId('trash-restore-selected').click()
  await expect(
    page.getByText(
      'Restored 1 of 2 available items. 1 couldn’t be restored. The original path is occupied by another note. Move or rename that note, then try restoring again.',
    ),
  ).toBeVisible()
  await expect(collision).toBeVisible()
  await expect(restored).toHaveCount(0)

  // This page made no restore request and has no shared JS state with the actor
  // page. Its row disappears only after the production outbox wakes the real
  // store/SSE channel and TrashPage refetches the real REST collection.
  await expect(peerRow).toHaveCount(0, { timeout: 10_000 })
  await expect(peerCollision).toBeVisible()
})
