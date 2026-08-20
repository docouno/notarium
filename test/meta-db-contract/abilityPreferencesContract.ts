import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { OwnedAbilityLocator } from '@notarium/contract'
import {
  type RevisionInput,
  SPACE_LIFECYCLE_PHASE,
  type SpaceLifecyclePersistence,
} from '@notarium/core'

import {
  ABILITY_TARGET_PURGED,
  type AbilityPreferencesPersistence,
  type SpacesPersistence,
} from '../../packages/server/src/services/metaDb/types'

/** What owner preferences need OF THEIR HOST: the Space registry, the revision journal
 *  whose purges end an override, and the whole-Space purge. A `MetaDb` is one such
 *  host; a meta-DB-less adapter driven by in-memory journal events is another, and the
 *  purge fence is asked of both — a host that cannot refuse a purged target can never
 *  exercise the refusal its callers handle. */
export type AbilityPreferencesHost = {
  abilityPreferences: AbilityPreferencesPersistence
  spaces: Pick<SpacesPersistence, 'upsert' | 'getById'>
  /** The Space lifecycle journal, because the fence asks the PHASE and not only
   *  whether a row is there. `purge-intent` is the one ended phase that still HAS the
   *  row, so it is the only one a `SELECT 1 FROM spaces` cannot tell from a live
   *  Space — and the only one a host has to be able to put a Space into for the arc
   *  below to mean anything. */
  spaceLifecycle: Pick<SpaceLifecyclePersistence, 'ensure' | 'transition'>
  revisions: {
    append(revision: RevisionInput, content: string | null): Promise<unknown>
    purgeNotes(space: string, noteIds: readonly string[]): Promise<unknown>
  }
  purgeSpace(space: string): Promise<void>
}

const personalRole: OwnedAbilityLocator = {
  source: 'owned',
  kind: 'role',
  packageId: 'AbCdefGhij_1',
  location: { scope: 'personal', spaceId: 'space-main' },
}

const ownedTarget = { locator: personalRole, registryNoteId: 'RegistryNote01' } as const

/** The same shape in a Space that was never created. The durable fence opens with
 *  `SELECT 1 FROM spaces`, so "never there" and "purged" are ONE answer to it — and a
 *  twin with no Space registry answers neither, which is the divergence this pins. */
const homelessRole: OwnedAbilityLocator = {
  source: 'owned',
  kind: 'role',
  packageId: 'AbCdefGhij_2',
  location: { scope: 'personal', spaceId: 'space-never-created' },
}

const homelessTarget = { locator: homelessRole, registryNoteId: 'RegistryNote02' } as const

/** The refusal every implementation makes, read the way a route reads it. Matching the
 *  MESSAGE would pass for a `new Error` that no route can tell from a bug. */
const purged = { code: ABILITY_TARGET_PURGED }

const AT = '2026-08-15T00:00:05Z'

const softDelete = (): RevisionInput => ({
  noteId: ownedTarget.registryNoteId,
  space: 'space-main',
  baseRevisionId: null,
  theirRevisionId: null,
  sourceRevisionId: null,
  kind: 'delete',
  entryRole: 'origin',
  principal: 'ui',
  contentHash: null,
  stateFormat: null,
  title: 'Role registry',
  class: 'agent-role',
  slug: null,
  tags: [],
  createdAt: '2026-08-15T00:00:02Z',
  charsAdded: 0,
  charsRemoved: 1,
})

export const describeAbilityPreferencesContract = (
  name: string,
  factory: () => Promise<{ db: AbilityPreferencesHost; teardown?: () => Promise<void> }>,
): void => {
  describe(`Ability preferences contract — ${name}`, () => {
    let db: AbilityPreferencesHost
    let teardown: (() => Promise<void>) | undefined

    beforeEach(async () => {
      ;({ db, teardown } = await factory())
      await db.spaces.upsert({
        id: 'space-main',
        slug: 'main',
        displayName: 'Main',
        notesDir: 'main',
        aliases: [],
        createdAt: '2026-08-15T00:00:00Z',
        archivedAt: null,
        archivedBy: null,
      })
    })

    afterEach(async () => teardown?.())

    it('stores only disabled overrides and defaults System and Owned to enabled', async () => {
      const system = { source: 'system', kind: 'role', packageId: 'ZME09f9AROG8' } as const

      expect(await db.abilityPreferences.isEnabled('user:alice', system)).toBe(true)
      expect(await db.abilityPreferences.isEnabled('user:alice', personalRole)).toBe(true)
      await db.abilityPreferences.setEnabled(
        'user:alice',
        { locator: system },
        false,
        '2026-08-15T00:00:01Z',
      )
      await db.abilityPreferences.setEnabled(
        'user:alice',
        ownedTarget,
        false,
        '2026-08-15T00:00:02Z',
      )

      expect(await db.abilityPreferences.isEnabled('user:alice', system)).toBe(false)
      expect(await db.abilityPreferences.isEnabled('user:bob', system)).toBe(true)
      expect(await db.abilityPreferences.disabled('user:alice', [system, personalRole])).toEqual(
        new Set([JSON.stringify(system), JSON.stringify(personalRole)]),
      )

      await db.abilityPreferences.setEnabled(
        'user:alice',
        { locator: system },
        true,
        '2026-08-15T00:00:03Z',
      )
      expect(await db.abilityPreferences.isEnabled('user:alice', system)).toBe(true)
    })

    it('retains an Owned override through soft delete until permanent note purge', async () => {
      await db.abilityPreferences.setEnabled(
        'user:alice',
        ownedTarget,
        false,
        '2026-08-15T00:00:01Z',
      )
      expect(await db.abilityPreferences.isEnabled('user:alice', personalRole)).toBe(false)
      await db.revisions.append(softDelete(), null)
      expect(await db.abilityPreferences.isEnabled('user:alice', personalRole)).toBe(false)

      await db.revisions.purgeNotes('space-main', [ownedTarget.registryNoteId])
      expect(await db.abilityPreferences.isEnabled('user:alice', personalRole)).toBe(true)
    })

    it('cannot leave an orphan when disable races whole-Space purge', async () => {
      await Promise.allSettled([
        db.abilityPreferences.setEnabled('user:alice', ownedTarget, false, '2026-08-15T00:00:01Z'),
        db.purgeSpace('space-main'),
      ])

      expect(await db.abilityPreferences.isEnabled('user:alice', personalRole)).toBe(true)
      await expect(
        db.abilityPreferences.setEnabled('user:alice', ownedTarget, false, '2026-08-15T00:00:02Z'),
      ).rejects.toMatchObject(purged)
    })

    // The SAME race with the other value of the flag. Both checks used to be
    // `enabled=false`, and the twin's fence sat after `if (enabled) { delete; return }`
    // — so the one direction the contract never asked was exactly the one direction
    // the twin answered differently from the drivers.
    it('cannot re-enable a target that lost its whole Space, either', async () => {
      await Promise.allSettled([
        db.abilityPreferences.setEnabled('user:alice', ownedTarget, false, '2026-08-15T00:00:01Z'),
        db.purgeSpace('space-main'),
      ])

      await expect(
        db.abilityPreferences.setEnabled('user:alice', ownedTarget, true, '2026-08-15T00:00:02Z'),
      ).rejects.toMatchObject(purged)
    })

    it('cannot leave an orphan when disable races exact note purge', async () => {
      await Promise.allSettled([
        db.abilityPreferences.setEnabled('user:alice', ownedTarget, false, '2026-08-15T00:00:01Z'),
        db.revisions.purgeNotes('space-main', [ownedTarget.registryNoteId]),
      ])

      expect(await db.abilityPreferences.isEnabled('user:alice', personalRole)).toBe(true)
      await expect(
        db.abilityPreferences.setEnabled('user:alice', ownedTarget, false, '2026-08-15T00:00:02Z'),
      ).rejects.toMatchObject(purged)
    })

    // There is nothing to turn back on: the registry note is gone for good, and an
    // implementation that answers "done" tells its caller the ability is back.
    it('cannot re-enable a target whose registry note was purged', async () => {
      await db.abilityPreferences.setEnabled(
        'user:alice',
        ownedTarget,
        false,
        '2026-08-15T00:00:01Z',
      )
      await db.revisions.purgeNotes('space-main', [ownedTarget.registryNoteId])

      await expect(
        db.abilityPreferences.setEnabled('user:alice', ownedTarget, true, '2026-08-15T00:00:02Z'),
      ).rejects.toMatchObject(purged)
    })

    // The state between "the purge was decided" and "the purge ran", which is not an
    // instant: `spaceManager` writes `purge-intent` in its own transaction and then
    // refuses to start the sweep while a restore has the Space pinned (`space_busy`),
    // so a Space sits here — with its `spaces` row intact — for as long as that lasts.
    // Every earlier arc in this file reaches an ended lifecycle by DELETING that row,
    // which is why `SELECT 1 FROM spaces` alone passed all of them: it is true here and
    // false everywhere else. Deliberately no `purgeSpace` after the transition.
    it('refuses an override once the home Space entered purge-intent', async () => {
      await db.spaceLifecycle.ensure('space-main', SPACE_LIFECYCLE_PHASE.active, AT)

      expect(
        (
          await db.spaceLifecycle.transition({
            space: 'space-main',
            expectedPhases: [SPACE_LIFECYCLE_PHASE.active],
            phase: SPACE_LIFECYCLE_PHASE.purgeIntent,
            changedAt: AT,
          })
        ).status,
      ).toBe('transitioned')
      // The premise of the arc, asserted rather than assumed: the row is still there.
      expect(await db.spaces.getById('space-main')).not.toBeNull()

      await expect(
        db.abilityPreferences.setEnabled('user:alice', ownedTarget, false, AT),
      ).rejects.toMatchObject(purged)
      // The other direction too: a re-enable of an ability whose Space is on its way
      // out has nothing to turn on, and answering "done" says it is coming back.
      await expect(
        db.abilityPreferences.setEnabled('user:alice', ownedTarget, true, AT),
      ).rejects.toMatchObject(purged)
    })

    // No Space row, no override — the durable fence cannot tell a Space that was
    // purged from one that never existed, and neither may a twin.
    it('refuses an override whose home Space is not there at all', async () => {
      await expect(
        db.abilityPreferences.setEnabled(
          'user:alice',
          homelessTarget,
          false,
          '2026-08-15T00:00:01Z',
        ),
      ).rejects.toMatchObject(purged)
      expect(await db.abilityPreferences.isEnabled('user:alice', homelessRole)).toBe(true)
    })
  })
}
