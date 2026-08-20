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

test('an owned skill breaks its role through the common Trash and heals on restore', async ({
  page,
}, testInfo) => {
  // The production stack has no per-test reset, so a retry meets what the previous
  // attempt published. Names are the package key, so each attempt takes its own.
  const suffix = testInfo.retry ? `-${testInfo.retry}` : ''
  const skillName = `restore-evidence${suffix}`
  const roleName = `restore-captain${suffix}`
  // Authored through the public API so the journey below is the UI's: publishing a
  // package is not what this proves.
  const skill = await page.request.post('/api/me/agent-skills', {
    data: {
      name: skillName,
      description: 'Proves an attachment survives the Trash round trip.',
      instructions: '# Restore evidence\n\nCollect the evidence a release needs.',
      scope: 'personal',
    },
  })
  expect(skill.status(), await skill.text()).toBe(201)
  const published = await skill.json()
  const role = await page.request.post('/api/me/agent-roles/custom', {
    data: {
      name: roleName,
      description: 'Proves role deletion remains recoverable.',
      instructions: '# Restore captain\n\nKeep the role package recoverable.',
      scope: 'personal',
      attachments: [{ kind: 'exact', locator: published.locator, label: skillName }],
    },
  })
  expect(role.status(), await role.text()).toBe(201)

  await page.goto('/agents/abilities/roles')
  const card = page.getByTestId(`ability-owned-${roleName}`)
  await expect(card).toBeVisible()
  await page.getByRole('button', { name: 'Open library filters' }).click()
  await page.getByTestId('package-library-search').fill('restore')
  await expect(page).toHaveURL(/\/agents\/abilities\/roles\?q=restore$/)
  await expect(card).toBeVisible()
  // The filter is a server query over the whole collection, not a client sieve over
  // owned rows: a catalog template that does not match is gone too.
  await expect(page.locator('article[data-testid^="ability-catalog-"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Close library filters' }).click()

  await card.click()
  const detail = page.getByTestId('agent-ability-detail')
  await expect(detail).toContainText('Restore evidence · healthy')
  const roleUrl = page.url()

  // Deleting the SKILL is what breaks the role: the attachment is an exact package
  // id, and the id is what has to come back for the role to heal.
  await page.goto('/agents/abilities/skills')
  const skillCard = page.getByTestId(`ability-owned-${skillName}`)
  await expect(skillCard).toBeVisible()
  await page.getByTestId(`ability-owned-${skillName}-menu`).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(skillCard).toHaveCount(0)

  await page.goto(roleUrl)
  await expect(detail).toContainText(`${skillName} · missing`)
  await expect(detail).toContainText('Agent activation remains fail-closed')

  await page.goto('/s/main/trash')
  // Addressed by the package's note id, because restoring the RIGHT row is the point:
  // a same-name neighbour must not be able to stand in for it.
  const trashRow = page
    .getByTestId('trash-row')
    .filter({ has: page.locator(`[data-testid="trash-row-open"][href*="${published.noteId}"]`) })
  await expect(trashRow).toBeVisible()
  await trashRow.getByTestId('trash-restore').click()
  await expect(trashRow).toHaveCount(0)

  await page.goto(roleUrl)
  await expect(detail).toContainText('Restore evidence · healthy')
  await expect(detail).not.toContainText('Agent activation remains fail-closed')
  await page.goto('/agents/abilities/skills')
  await expect(page.getByTestId(`ability-owned-${skillName}`)).toBeVisible()
})
