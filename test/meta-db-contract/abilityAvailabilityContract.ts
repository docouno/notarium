import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SPACE_LIFECYCLE_PHASE, type SpaceLifecyclePersistence } from '@notarium/core'

import {
  ABILITY_TARGET_PURGED,
  type AbilityAvailabilityPersistence,
  type FolderIdentityPersistence,
  type ProjectsPersistence,
  type SpacesPersistence,
} from '../../packages/server/src/services/metaDb/types'

/** The package DIRECTORY and the registry NOTE of one Owned package — deliberately
 *  different strings, because that is the only state in which the two keys can be told
 *  apart. They coincide until claim arbitration issues the note a different id
 *  (`roles/library.ts`: "the two differ after claim arbitration"), and a fixture that
 *  lets them coincide proves whichever keying it was given. */
const PACKAGE_DIRECTORY = 'AbCdefGhij_1'
const REGISTRY_NOTE = 'RegistryNote01'

/** The refusal every implementation makes, read the way a route reads it. */
const purged = { code: ABILITY_TARGET_PURGED }

/** What availability needs OF ITS HOST, and nothing else: the registries its foreign
 *  keys point at, and the two lifecycle events that end a policy. A `MetaDb` is one
 *  such host; a meta-DB-less adapter driven by an in-memory registry is another, and
 *  the contract is the same for both. */
export type AbilityAvailabilityHost = {
  abilityAvailability: AbilityAvailabilityPersistence
  spaces: Pick<SpacesPersistence, 'upsert' | 'getById'>
  /** The Space lifecycle journal — the fence asks the PHASE, not only whether the row
   *  is there, and `purge-intent` is the one ended phase that still has one. */
  spaceLifecycle: Pick<SpaceLifecyclePersistence, 'ensure' | 'transition'>
  projects: Pick<ProjectsPersistence, 'upsert' | 'delete'>
  folders: Pick<FolderIdentityPersistence, 'upsert'>
  /** Permanent purge of the package's registry note. */
  revisions: { purgeNotes(space: string, noteIds: readonly string[]): Promise<unknown> }
  purgeSpace(space: string): Promise<void>
}

export const describeAbilityAvailabilityContract = (
  name: string,
  factory: () => Promise<{ db: AbilityAvailabilityHost; teardown?: () => Promise<void> }>,
): void => {
  describe(`Ability availability contract — ${name}`, () => {
    let db: AbilityAvailabilityHost
    let teardown: (() => Promise<void>) | undefined

    beforeEach(async () => {
      ;({ db, teardown } = await factory())
      await db.spaces.upsert({
        id: 'space-main',
        slug: 'main',
        displayName: 'Main',
        notesDir: 'main',
        aliases: [],
        createdAt: '2026-08-14T00:00:00Z',
        archivedAt: null,
        archivedBy: null,
      })
      for (const id of ['project-a', 'project-b', 'project-c']) {
        await db.projects.upsert({
          id,
          space: 'space-main',
          path: id,
          slug: id,
          aliases: [],
          pathAliases: [],
          displayName: id,
          status: 'active',
          lastSeen: '2026-08-14T00:00:00Z',
          createdAt: '2026-08-14T00:00:00Z',
        })
      }
    })

    afterEach(async () => teardown?.())

    it('keeps one package identity available in A/B and unavailable in C', async () => {
      await db.abilityAvailability.set(
        'space-main',
        'package-one',
        {
          mode: 'selected-projects',
          projectIds: ['project-a', 'project-b', 'project-a'],
        },
        null,
      )

      expect(await db.abilityAvailability.get('space-main', 'package-one')).toEqual({
        homeSpace: 'space-main',
        packageId: 'package-one',
        mode: 'selected-projects',
        projectIds: ['project-a', 'project-b'],
      })
      const record = await db.abilityAvailability.get('space-main', 'package-one')
      expect(record?.mode).toBe('selected-projects')
      expect(record?.mode === 'selected-projects' ? record.projectIds : []).not.toContain(
        'project-c',
      )
      expect(await db.abilityAvailability.listForSpace('space-main')).toHaveLength(1)
    })

    it('reserves, finalizes and protects a pre-publication reach with CAS semantics', async () => {
      expect(
        await db.abilityAvailability.reserve('space-main', PACKAGE_DIRECTORY, {
          mode: 'selected-projects',
          projectIds: ['project-b', 'project-a', 'project-a'],
        }),
      ).toBe(true)
      expect(
        await db.abilityAvailability.reserve('space-main', PACKAGE_DIRECTORY, {
          mode: 'selected-projects',
          projectIds: ['project-c'],
        }),
      ).toBe(false)
      expect(await db.abilityAvailability.get('space-main', PACKAGE_DIRECTORY)).toEqual({
        homeSpace: 'space-main',
        packageId: PACKAGE_DIRECTORY,
        mode: 'selected-projects',
        projectIds: ['project-a', 'project-b'],
      })

      expect(
        await db.abilityAvailability.finalize('space-main', PACKAGE_DIRECTORY, REGISTRY_NOTE),
      ).toBe(true)
      expect(
        await db.abilityAvailability.finalize('space-main', PACKAGE_DIRECTORY, 'OtherRegistry'),
      ).toBe(false)
      expect(await db.abilityAvailability.cancel('space-main', PACKAGE_DIRECTORY)).toBe(false)
      expect(await db.abilityAvailability.get('space-main', PACKAGE_DIRECTORY)).not.toBeNull()
    })

    it('reserves the exact all-project reach before publication', async () => {
      expect(
        await db.abilityAvailability.reserve('space-main', PACKAGE_DIRECTORY, {
          mode: 'all-projects',
        }),
      ).toBe(true)
      expect(await db.abilityAvailability.get('space-main', PACKAGE_DIRECTORY)).toEqual({
        homeSpace: 'space-main',
        packageId: PACKAGE_DIRECTORY,
        mode: 'all-projects',
      })
      expect(
        await db.abilityAvailability.finalize('space-main', PACKAGE_DIRECTORY, REGISTRY_NOTE),
      ).toBe(true)
    })

    it('cancels only an unfinalized reservation and leaves the package id reusable', async () => {
      expect(
        await db.abilityAvailability.reserve('space-main', PACKAGE_DIRECTORY, {
          mode: 'selected-projects',
          projectIds: ['project-a'],
        }),
      ).toBe(true)
      expect(await db.abilityAvailability.cancel('space-main', PACKAGE_DIRECTORY)).toBe(true)
      expect(await db.abilityAvailability.cancel('space-main', PACKAGE_DIRECTORY)).toBe(false)
      expect(await db.abilityAvailability.get('space-main', PACKAGE_DIRECTORY)).toBeNull()
      expect(
        await db.abilityAvailability.reserve('space-main', PACKAGE_DIRECTORY, {
          mode: 'selected-projects',
          projectIds: ['project-b'],
        }),
      ).toBe(true)
    })

    it('replaces the whole selected set atomically and grantProject unions one binding', async () => {
      await db.abilityAvailability.set(
        'space-main',
        'package-one',
        {
          mode: 'selected-projects',
          projectIds: ['project-a', 'project-b'],
        },
        null,
      )
      await db.abilityAvailability.set(
        'space-main',
        'package-one',
        {
          mode: 'selected-projects',
          projectIds: ['project-c'],
        },
        null,
      )
      await db.abilityAvailability.grantProject('space-main', 'package-one', 'project-a', null)

      expect(await db.abilityAvailability.get('space-main', 'package-one')).toEqual({
        homeSpace: 'space-main',
        packageId: 'package-one',
        mode: 'selected-projects',
        projectIds: ['project-a', 'project-c'],
      })
    })

    // `all-projects` is a policy WITHOUT bindings, and every write path has to keep it
    // that way: a grant into it must be a no-op, not a demotion. Read the branch the
    // other way round and the role silently narrows from "the whole Space" to "the one
    // project someone happened to grant" — a shrunk zone nobody asked for and nothing
    // announces.
    it('keeps an all-projects policy whole when one project is granted into it', async () => {
      await db.abilityAvailability.set('space-main', 'package-one', { mode: 'all-projects' }, null)
      await db.abilityAvailability.grantProject('space-main', 'package-one', 'project-a', null)

      expect(await db.abilityAvailability.get('space-main', 'package-one')).toEqual({
        homeSpace: 'space-main',
        packageId: 'package-one',
        mode: 'all-projects',
      })
      expect(await db.abilityAvailability.listForSpace('space-main')).toEqual([
        { homeSpace: 'space-main', packageId: 'package-one', mode: 'all-projects' },
      ])
    })

    it('switches between all-projects and a selected set without leaving stale bindings', async () => {
      await db.abilityAvailability.set(
        'space-main',
        'package-one',
        {
          mode: 'selected-projects',
          projectIds: ['project-a', 'project-b'],
        },
        null,
      )
      await db.abilityAvailability.set('space-main', 'package-one', { mode: 'all-projects' }, null)

      expect(await db.abilityAvailability.get('space-main', 'package-one')).toEqual({
        homeSpace: 'space-main',
        packageId: 'package-one',
        mode: 'all-projects',
      })

      await db.abilityAvailability.set(
        'space-main',
        'package-one',
        {
          mode: 'selected-projects',
          projectIds: ['project-c'],
        },
        null,
      )

      expect(await db.abilityAvailability.get('space-main', 'package-one')).toEqual({
        homeSpace: 'space-main',
        packageId: 'package-one',
        mode: 'selected-projects',
        projectIds: ['project-c'],
      })
    })

    // Forgetting the policy is NOT `set(selected, [])`: for a Role an absent row reads
    // as "everywhere" and an empty selection as "nowhere", so the two are opposite
    // answers. And forgetting must take the child bindings with it — where foreign keys
    // are off, an orphan binding is invisible until the package id comes back.
    it('forgets the policy and its bindings, and reads back as absent', async () => {
      await db.abilityAvailability.set(
        'space-main',
        'package-one',
        {
          mode: 'selected-projects',
          projectIds: ['project-a', 'project-b'],
        },
        null,
      )
      await db.abilityAvailability.set(
        'space-main',
        'package-two',
        {
          mode: 'selected-projects',
          projectIds: ['project-c'],
        },
        null,
      )

      await db.abilityAvailability.clear('space-main', 'package-one')

      expect(await db.abilityAvailability.get('space-main', 'package-one')).toBeNull()
      expect(await db.abilityAvailability.listForSpace('space-main')).toEqual([
        {
          homeSpace: 'space-main',
          packageId: 'package-two',
          mode: 'selected-projects',
          projectIds: ['project-c'],
        },
      ])

      // The bindings are proved gone by the one read that can see them again: a later
      // grant re-creates the parent row, and anything the clear left under that key
      // resurfaces WITH it. A whole-set `set` would have swept them first and hidden
      // the leak — which is why the observation is a grant.
      await db.abilityAvailability.grantProject('space-main', 'package-one', 'project-c', null)
      expect(await db.abilityAvailability.get('space-main', 'package-one')).toEqual({
        homeSpace: 'space-main',
        packageId: 'package-one',
        mode: 'selected-projects',
        projectIds: ['project-c'],
      })
    })

    it('serializes concurrent whole-set replacements without a torn allowlist', async () => {
      await Promise.all([
        db.abilityAvailability.set(
          'space-main',
          'package-one',
          {
            mode: 'selected-projects',
            projectIds: ['project-a', 'project-b'],
          },
          null,
        ),
        db.abilityAvailability.set(
          'space-main',
          'package-one',
          {
            mode: 'selected-projects',
            projectIds: ['project-c'],
          },
          null,
        ),
      ])
      const record = await db.abilityAvailability.get('space-main', 'package-one')
      const projectIds = record?.mode === 'selected-projects' ? record.projectIds : []

      expect([['project-a', 'project-b'], ['project-c']]).toContainEqual(projectIds)
    })

    // A target that is not a project of this home Space is the state the schema models
    // explicitly — the `0014` retype trigger exists for it — so the refusal is asked by
    // CODE. Asserting the message instead froze a bare `Error`, which a route cannot
    // tell from a bug and answered 500 with an internal string.
    it('refuses a project outside the home Space with the purged code', async () => {
      await db.spaces.upsert({
        id: 'space-other',
        slug: 'other',
        displayName: 'Other',
        notesDir: 'other',
        aliases: [],
        createdAt: '2026-08-14T00:00:00Z',
        archivedAt: null,
        archivedBy: null,
      })
      await db.projects.upsert({
        id: 'project-other',
        space: 'space-other',
        path: 'other',
        slug: 'other',
        aliases: [],
        pathAliases: [],
        displayName: 'Other',
        status: 'active',
        lastSeen: '2026-08-14T00:00:00Z',
        createdAt: '2026-08-14T00:00:00Z',
      })

      await expect(
        db.abilityAvailability.set(
          'space-main',
          'package-one',
          {
            mode: 'selected-projects',
            projectIds: ['project-other'],
          },
          null,
        ),
      ).rejects.toMatchObject(purged)
      await expect(
        db.abilityAvailability.grantProject('space-main', 'package-one', 'project-other', null),
      ).rejects.toMatchObject(purged)
    })

    // The same refusal reached without any race: the project's own row is retyped to a
    // plain folder while a role version still lives in that directory, and the next
    // placement write names it.
    it('refuses a retyped project with the purged code', async () => {
      await db.folders.upsert({
        id: 'project-a',
        space: 'space-main',
        path: 'project-a',
        pathAliases: [],
        lastSeen: '2026-08-14T00:00:00Z',
        createdAt: '2026-08-14T00:00:00Z',
      })

      await expect(
        db.abilityAvailability.set(
          'space-main',
          'package-one',
          {
            mode: 'selected-projects',
            projectIds: ['project-a'],
          },
          null,
        ),
      ).rejects.toMatchObject(purged)
      await expect(
        db.abilityAvailability.grantProject('space-main', 'package-one', 'project-a', null),
      ).rejects.toMatchObject(purged)
    })

    it('drops stale bindings with a project and the policy with its home Space', async () => {
      await db.abilityAvailability.set(
        'space-main',
        'package-one',
        {
          mode: 'selected-projects',
          projectIds: ['project-a', 'project-b'],
        },
        null,
      )
      await db.projects.delete('project-a')
      expect(await db.abilityAvailability.get('space-main', 'package-one')).toEqual({
        homeSpace: 'space-main',
        packageId: 'package-one',
        mode: 'selected-projects',
        projectIds: ['project-b'],
      })
      await db.folders.upsert({
        id: 'project-b',
        space: 'space-main',
        path: 'project-b',
        pathAliases: [],
        lastSeen: '2026-08-14T00:00:00Z',
        createdAt: '2026-08-14T00:00:00Z',
      })
      expect(await db.abilityAvailability.get('space-main', 'package-one')).toEqual({
        homeSpace: 'space-main',
        packageId: 'package-one',
        mode: 'selected-projects',
        projectIds: [],
      })

      await db.purgeSpace('space-main')
      expect(await db.abilityAvailability.get('space-main', 'package-one')).toBeNull()
    })

    // Owner state does not outlive the thing it is about — but the thing it is about
    // is named TWICE. The policy is keyed by the package directory; the lifecycle that
    // ends it belongs to the registry note, and the two are different strings once
    // claim arbitration has run. Both ids appear here, and each is purged separately,
    // so a sweep keyed by the wrong one fails on one half or the other.
    it('forgets the policy by its registry note, not by its package directory', async () => {
      await db.abilityAvailability.set(
        'space-main',
        PACKAGE_DIRECTORY,
        { mode: 'selected-projects', projectIds: ['project-a'] },
        REGISTRY_NOTE,
      )
      await db.abilityAvailability.set('space-main', 'package-two', { mode: 'all-projects' }, null)

      // Purging a note that merely SHARES the package's directory name is not this
      // package's lifecycle end. A sweep keyed by `package_id` forgets it here.
      await db.revisions.purgeNotes('space-main', [PACKAGE_DIRECTORY])
      expect(await db.abilityAvailability.get('space-main', PACKAGE_DIRECTORY)).toEqual({
        homeSpace: 'space-main',
        packageId: PACKAGE_DIRECTORY,
        mode: 'selected-projects',
        projectIds: ['project-a'],
      })

      await db.revisions.purgeNotes('space-main', [REGISTRY_NOTE])
      expect(await db.abilityAvailability.get('space-main', PACKAGE_DIRECTORY)).toBeNull()
      expect(await db.abilityAvailability.get('space-main', 'package-two')).toEqual({
        homeSpace: 'space-main',
        packageId: 'package-two',
        mode: 'all-projects',
      })
    })

    // Forgetting the row is only half of a lifecycle END. The other half is the
    // FENCE: the sweep runs once, and the next writer must not put the row back. It
    // can — `set` is an upsert and the caller that writes it is a route handling a
    // request that was already in flight — and then nothing sweeps it a second time,
    // because the note whose purge would have swept it is gone for good. What is left
    // is a policy on a `package_id`, and a package id is a DIRECTORY NAME that the
    // next package to be installed under it inherits. The preference twin of this
    // facet has asked for both halves since it was written; this one asked for
    // neither, which is why both drivers had the sweep and no fence at all.
    it('refuses to recreate a policy whose registry note was purged', async () => {
      await db.abilityAvailability.set(
        'space-main',
        PACKAGE_DIRECTORY,
        { mode: 'selected-projects', projectIds: ['project-a'] },
        REGISTRY_NOTE,
      )
      await db.revisions.purgeNotes('space-main', [REGISTRY_NOTE])
      expect(await db.abilityAvailability.get('space-main', PACKAGE_DIRECTORY)).toBeNull()

      await expect(
        db.abilityAvailability.set(
          'space-main',
          PACKAGE_DIRECTORY,
          { mode: 'all-projects' },
          REGISTRY_NOTE,
        ),
      ).rejects.toMatchObject(purged)
      await expect(
        db.abilityAvailability.grantProject(
          'space-main',
          PACKAGE_DIRECTORY,
          'project-a',
          REGISTRY_NOTE,
        ),
      ).rejects.toMatchObject(purged)
      expect(await db.abilityAvailability.get('space-main', PACKAGE_DIRECTORY)).toBeNull()
    })

    it('cannot leave an orphan policy when a write races exact note purge', async () => {
      await db.abilityAvailability.set(
        'space-main',
        PACKAGE_DIRECTORY,
        { mode: 'all-projects' },
        REGISTRY_NOTE,
      )

      await Promise.allSettled([
        db.abilityAvailability.set(
          'space-main',
          PACKAGE_DIRECTORY,
          { mode: 'selected-projects', projectIds: ['project-a'] },
          REGISTRY_NOTE,
        ),
        db.revisions.purgeNotes('space-main', [REGISTRY_NOTE]),
      ])

      expect(await db.abilityAvailability.get('space-main', PACKAGE_DIRECTORY)).toBeNull()
      await expect(
        db.abilityAvailability.set(
          'space-main',
          PACKAGE_DIRECTORY,
          { mode: 'all-projects' },
          REGISTRY_NOTE,
        ),
      ).rejects.toMatchObject(purged)
    })

    // The fence is the NOTE's, never the directory's. A package id is reusable by
    // construction, so refusing every write under a directory whose name once matched
    // a purged note would bury the next package installed there — the same asymmetry
    // the sweep already makes, read from the writing side.
    it('lets a new registry note claim a package directory the purge emptied', async () => {
      await db.abilityAvailability.set(
        'space-main',
        PACKAGE_DIRECTORY,
        { mode: 'all-projects' },
        REGISTRY_NOTE,
      )
      await db.revisions.purgeNotes('space-main', [REGISTRY_NOTE])

      await db.abilityAvailability.set(
        'space-main',
        PACKAGE_DIRECTORY,
        { mode: 'selected-projects', projectIds: ['project-b'] },
        'RegistryNote02',
      )

      expect(await db.abilityAvailability.get('space-main', PACKAGE_DIRECTORY)).toEqual({
        homeSpace: 'space-main',
        packageId: PACKAGE_DIRECTORY,
        mode: 'selected-projects',
        projectIds: ['project-b'],
      })
    })

    // A row whose writer never knew the note id keeps the pre-arbitration answer —
    // the package id IS its only key, and it is the best such a row can do.
    it('still forgets a policy that never learned its registry note', async () => {
      await db.abilityAvailability.set(
        'space-main',
        'package-legacy',
        { mode: 'all-projects' },
        null,
      )

      await db.revisions.purgeNotes('space-main', ['package-legacy'])

      expect(await db.abilityAvailability.get('space-main', 'package-legacy')).toBeNull()
    })

    // The home Space is a FOREIGN KEY durably, and nothing at all in a Map. Both
    // shapes of "no Space row" are one answer — and it is a refusal a route can read,
    // not a driver's `23503` and not a silent save.
    it('refuses a policy whose home Space was purged or never existed', async () => {
      await expect(
        db.abilityAvailability.set('space-nowhere', 'package-one', { mode: 'all-projects' }, null),
      ).rejects.toMatchObject(purged)
      await expect(
        db.abilityAvailability.grantProject('space-nowhere', 'package-one', 'project-a', null),
      ).rejects.toMatchObject(purged)

      await db.purgeSpace('space-main')

      await expect(
        db.abilityAvailability.set('space-main', 'package-one', { mode: 'all-projects' }, null),
      ).rejects.toMatchObject(purged)
    })

    // The window between the purge being DECIDED and the purge running, which
    // `spaceManager` holds open for as long as a pinned restore keeps the sweep from
    // starting (`space_busy`). Every other arc in this file ends a Space by deleting
    // its `spaces` row, so `SELECT 1 FROM spaces` alone satisfies all of them — this is
    // the one state where that row is still there and the answer must still be no. No
    // `purgeSpace` follows on purpose.
    it('refuses a policy once the home Space entered purge-intent', async () => {
      const at = '2026-08-14T00:01:00Z'

      await db.spaceLifecycle.ensure('space-main', SPACE_LIFECYCLE_PHASE.active, at)

      expect(
        (
          await db.spaceLifecycle.transition({
            space: 'space-main',
            expectedPhases: [SPACE_LIFECYCLE_PHASE.active],
            phase: SPACE_LIFECYCLE_PHASE.purgeIntent,
            changedAt: at,
          })
        ).status,
      ).toBe('transitioned')
      expect(await db.spaces.getById('space-main')).not.toBeNull()

      await expect(
        db.abilityAvailability.set(
          'space-main',
          PACKAGE_DIRECTORY,
          { mode: 'all-projects' },
          REGISTRY_NOTE,
        ),
      ).rejects.toMatchObject(purged)
      await expect(
        db.abilityAvailability.grantProject(
          'space-main',
          PACKAGE_DIRECTORY,
          'project-a',
          REGISTRY_NOTE,
        ),
      ).rejects.toMatchObject(purged)
    })

    it('cannot leave an orphan policy when a write races whole-Space purge', async () => {
      await Promise.allSettled([
        db.abilityAvailability.set('space-main', 'package-one', { mode: 'all-projects' }, null),
        db.purgeSpace('space-main'),
      ])

      expect(await db.abilityAvailability.get('space-main', 'package-one')).toBeNull()
      expect(await db.abilityAvailability.listForSpace('space-main')).toEqual([])
    })
  })
}
