import { beforeEach, describe, expect, it } from 'vitest'

import type { OwnedAbilityLocator } from '@notarium/contract'
import { serializeAbilityLocator } from '@notarium/core'

import type {
  AbilityPlacementPersistence,
  AbilityPreferencesPersistence,
  AgentSessionsPersistence,
  ContextOrderPersistence,
  ContextSetsPersistence,
  ProjectsPersistence,
  ScopePinsPersistence,
  SpacesPersistence,
} from '../../packages/server/src/services/metaDb/types'

const PACKAGE_ID = 'AbCdefGhij_1'
const REGISTRY_NOTE_ID = 'RegistryNote1'
const MANIFEST_NOTE_ID = 'ManifestNote1'

const projectLocator: OwnedAbilityLocator = {
  source: 'owned',
  kind: 'role',
  packageId: PACKAGE_ID,
  location: { scope: 'project', spaceId: 'space-main', projectId: 'project-a' },
}

const spaceLocator: OwnedAbilityLocator = {
  source: 'owned',
  kind: 'role',
  packageId: PACKAGE_ID,
  location: { scope: 'space', spaceId: 'space-main' },
}

const FROM_TARGET = `project:project-a:${PACKAGE_ID}`
const TO_TARGET = `space:space-main:${PACKAGE_ID}`

const move = {
  fromTargetId: FROM_TARGET,
  toTargetId: TO_TARGET,
  fromLocator: serializeAbilityLocator(projectLocator),
  toLocator: serializeAbilityLocator(spaceLocator),
  registryNoteId: REGISTRY_NOTE_ID,
  manifestNoteId: MANIFEST_NOTE_ID,
}

const reverseMove = {
  fromTargetId: TO_TARGET,
  toTargetId: FROM_TARGET,
  fromLocator: serializeAbilityLocator(spaceLocator),
  toLocator: serializeAbilityLocator(projectLocator),
  registryNoteId: REGISTRY_NOTE_ID,
  manifestNoteId: MANIFEST_NOTE_ID,
}

/** BOTH spellings of the one package, asked in ONE question — the shape the hot path
 *  asks in. `isEnabled` and `disabled` are the same question at two arities, and only
 *  the second is on that path: `effectivePackages` asks it once per location on every
 *  discovery and every MCP activation, over a locator list built from the library
 *  LISTING while the answer comes from this table. A promotion between those two reads
 *  is exactly the window the trail exists for, so the batch has to resolve it too — a
 *  reader that resolves only the single question answers "enabled" for a role its owner
 *  switched off, and a session raises it. */
const bothSpellings = async (
  abilityPreferences: Pick<AbilityPreferencesPersistence, 'disabled'>,
  owner: string,
): Promise<Set<string>> => abilityPreferences.disabled(owner, [projectLocator, spaceLocator])

/** …and what that question answers when the package is off: the caller's own spelling
 *  back, whichever of the two it happens to hold. */
const BOTH_DISABLED = new Set([
  serializeAbilityLocator(projectLocator),
  serializeAbilityLocator(spaceLocator),
])

/** Every table a placement move rewrites, plus the two registries their rows hang off.
 *  A `MetaDb` is one such host; anything that keeps all five in memory is another. */
export type AbilityPlacementHost = {
  abilityPlacement: AbilityPlacementPersistence
  spaces: Pick<SpacesPersistence, 'upsert'>
  projects: Pick<ProjectsPersistence, 'upsert'>
  contextSets: Pick<ContextSetsPersistence, 'createSet' | 'attach' | 'setsForTarget'>
  scopePins: Pick<ScopePinsPersistence, 'addPin' | 'pinsForTarget'>
  contextOrder: Pick<ContextOrderPersistence, 'setOrder' | 'orderForTarget'>
  abilityPreferences: Pick<AbilityPreferencesPersistence, 'setEnabled' | 'isEnabled' | 'disabled'>
  sessions: Pick<AgentSessionsPersistence, 'insert' | 'listRecent'>
}

/** Promoting a project version to the Space base changes the role's ADDRESS, and
 *  four different tables are keyed by that address. This contract is the proof that
 *  every one of them follows in the same transaction — the failure it guards against
 *  is silent: the package moves, the pins/sets/order/preference/episode stay behind,
 *  and the user's context simply appears to be gone. */
export const describeAbilityPlacementContract = (
  name: string,
  factory: () => Promise<{ db: AbilityPlacementHost; teardown?: () => Promise<void> }>,
): void => {
  describe(`Ability placement contract — ${name}`, () => {
    let db: AbilityPlacementHost

    beforeEach(async () => {
      ;({ db } = await factory())
      await db.spaces.upsert({
        id: 'space-main',
        slug: 'main',
        displayName: 'Main',
        notesDir: 'main',
        aliases: [],
        createdAt: '2026-08-17T00:00:00Z',
        archivedAt: null,
        archivedBy: null,
      })
      await db.projects.upsert({
        id: 'project-a',
        space: 'space-main',
        path: 'a',
        slug: 'a',
        aliases: [],
        pathAliases: [],
        displayName: 'A',
        status: 'active',
        lastSeen: '2026-08-17T00:00:00Z',
        createdAt: '2026-08-17T00:00:00Z',
      })
    })

    it('moves pins, sets, order, the owner preference and a live episode at once', async () => {
      await db.contextSets.createSet({
        id: 'set-1',
        homeSpace: 'space-main',
        name: 'Release',
        items: [],
        createdAt: '2026-08-17T00:00:00Z',
      })
      await db.contextSets.attach({
        setId: 'set-1',
        targetKind: 'role',
        targetId: FROM_TARGET,
        targetSpace: 'space-main',
        createdAt: '2026-08-17T00:00:00Z',
      })
      await db.scopePins.addPin({
        targetKind: 'role',
        targetId: FROM_TARGET,
        targetSpace: 'space-main',
        noteSpace: 'space-main',
        noteId: 'PinnedNote01',
        createdAt: '2026-08-17T00:00:00Z',
      })
      await db.contextOrder.setOrder('role', FROM_TARGET, 'space-main', [
        { entryKind: 'pin', entryRef: 'PinnedNote01' },
        { entryKind: 'set', entryRef: 'set-1' },
      ])
      await db.abilityPreferences.setEnabled(
        'user:alice',
        { locator: projectLocator, registryNoteId: 'RegistryNote1' },
        false,
        '2026-08-17T00:00:00Z',
      )
      await db.sessions.insert({
        id: 'session-1',
        owner: 'user:alice',
        name: 'work',
        named: true,
        parentId: null,
        createdAt: '2026-08-17T00:00:00Z',
        lastSeenAt: '2026-08-17T00:00:00Z',
        calls: 1,
        role: 'review',
        roleLocator: projectLocator,
        roleContextProjectId: 'project-a',
        projectId: null,
      })

      await db.abilityPlacement.moveOwnedRolePlacement(move)

      await expect(db.contextSets.setsForTarget('role', TO_TARGET)).resolves.toMatchObject([
        { id: 'set-1' },
      ])
      await expect(db.contextSets.setsForTarget('role', FROM_TARGET)).resolves.toEqual([])
      await expect(db.scopePins.pinsForTarget('role', TO_TARGET)).resolves.toMatchObject([
        { noteId: 'PinnedNote01' },
      ])
      await expect(db.scopePins.pinsForTarget('role', FROM_TARGET)).resolves.toEqual([])
      await expect(db.contextOrder.orderForTarget('role', TO_TARGET)).resolves.toMatchObject([
        { entryKind: 'pin', entryRef: 'PinnedNote01', rank: 0 },
        { entryKind: 'set', entryRef: 'set-1', rank: 1 },
      ])
      await expect(db.contextOrder.orderForTarget('role', FROM_TARGET)).resolves.toEqual([])
      // The owner's `disabled` bit is keyed by the whole locator, placement included —
      // so the move carries it, and the address it left forwards to the address it
      // took: one package, one answer, whichever spelling a caller still holds.
      await expect(db.abilityPreferences.isEnabled('user:alice', spaceLocator)).resolves.toBe(false)
      await expect(db.abilityPreferences.isEnabled('user:alice', projectLocator)).resolves.toBe(
        false,
      )
      // …and the same in the batch the session path asks, which is the only one of the
      // two that decides which roles an agent raises.
      await expect(bothSpellings(db.abilityPreferences, 'user:alice')).resolves.toEqual(
        BOTH_DISABLED,
      )
      // Exact resume is fail-closed, so an episode left behind drops to base mode.
      await expect(
        db.sessions.listRecent('user:alice', '2026-08-16T00:00:00Z', 5),
      ).resolves.toMatchObject([{ id: 'session-1', roleLocator: spaceLocator }])
    })

    it('exposes only a recorded target and rewrites the trail on a back move', async () => {
      await expect(
        db.abilityPlacement.resolveMovedOwnedRoleLocator(move.fromLocator),
      ).resolves.toBeNull()

      await db.abilityPlacement.moveOwnedRolePlacement(move)

      await expect(
        db.abilityPlacement.resolveMovedOwnedRoleLocator(move.fromLocator),
      ).resolves.toEqual({
        toLocator: move.toLocator,
        registryNoteId: REGISTRY_NOTE_ID,
        manifestNoteId: MANIFEST_NOTE_ID,
      })
      await expect(
        db.abilityPlacement.resolveMovedOwnedRoleLocator(move.toLocator),
      ).resolves.toBeNull()

      await db.abilityPlacement.moveOwnedRolePlacement(reverseMove)

      await expect(
        db.abilityPlacement.resolveMovedOwnedRoleLocator(move.fromLocator),
      ).resolves.toBeNull()
      await expect(
        db.abilityPlacement.resolveMovedOwnedRoleLocator(move.toLocator),
      ).resolves.toEqual({
        toLocator: move.fromLocator,
        registryNoteId: REGISTRY_NOTE_ID,
        manifestNoteId: MANIFEST_NOTE_ID,
      })
    })

    it('leaves pointer tables empty when the old placement holds nothing', async () => {
      await expect(db.abilityPlacement.moveOwnedRolePlacement(move)).resolves.toBeUndefined()
      await expect(db.contextSets.setsForTarget('role', TO_TARGET)).resolves.toEqual([])
      await expect(db.scopePins.pinsForTarget('role', TO_TARGET)).resolves.toEqual([])
    })

    // The two writers of `ability_preferences`, released together. They are the only
    // pair in this schema that can address the same LOCATOR while sharing no row: this
    // one inserts `(owner, locator)`, the move rewrites the column for every owner at
    // once and can name no prefix of that key.
    //
    // Serializing them is NOT the whole answer, and the round that added the advisory
    // asserted only the shape "not at both, not at neither" — which the harmful result
    // satisfies. If the move goes first, the disable is written at an address the
    // package has already left: the bit is at the source, the role is at the
    // destination, and `isEnabled` there answers "enabled" for a role its owner has
    // just switched off. So the assertion is not about which of them won; it is that
    // the owner's CHOICE survives either order, at whichever spelling of the address it
    // is asked about. What makes that true is the trail the move records
    // (`ability_placement_trail`), through which both halves of this port resolve.
    it('keeps an owner disable racing a placement move, whichever of them wins', async () => {
      await Promise.allSettled([
        db.abilityPreferences.setEnabled(
          'user:alice',
          { locator: projectLocator, registryNoteId: 'RegistryNote1' },
          false,
          '2026-08-17T00:00:00Z',
        ),
        db.abilityPlacement.moveOwnedRolePlacement(move),
      ])

      const enabled = [
        await db.abilityPreferences.isEnabled('user:alice', projectLocator),
        await db.abilityPreferences.isEnabled('user:alice', spaceLocator),
      ]

      // One choice, one answer: `true` anywhere here is the bit lost.
      expect(enabled).toEqual([false, false])
      // Including when the answer is asked for both addresses at once, which is how the
      // session path asks it.
      await expect(bothSpellings(db.abilityPreferences, 'user:alice')).resolves.toEqual(
        BOTH_DISABLED,
      )
    })

    // The half of that race no lock can decide, isolated so it is not read as a timing
    // accident: the move has COMMITTED, and only then does the disable arrive naming
    // the address the owner's page was rendered from. Nothing is racing here — the
    // stale address is simply the address a caller had, and an implementation that
    // stores the bit there stores it where nothing will ever read it.
    it('applies a disable written at the address the move has already left', async () => {
      await db.abilityPlacement.moveOwnedRolePlacement(move)
      await db.abilityPreferences.setEnabled(
        'user:alice',
        { locator: projectLocator, registryNoteId: 'RegistryNote1' },
        false,
        '2026-08-17T00:00:00Z',
      )

      await expect(db.abilityPreferences.isEnabled('user:alice', spaceLocator)).resolves.toBe(false)
      // …and the stale spelling answers the same, because it names the same package.
      await expect(db.abilityPreferences.isEnabled('user:alice', projectLocator)).resolves.toBe(
        false,
      )
      // The same is true of the batch, and it is the batch a listing holds stale
      // addresses in: it is built from the library scan, one query per LOCATION.
      await expect(bothSpellings(db.abilityPreferences, 'user:alice')).resolves.toEqual(
        BOTH_DISABLED,
      )
    })

    // A demotion, which is the promotion above run backwards — and the case that
    // decides the ORDER of the three statements the trail is kept with. The address
    // this package started at is now the address it stands at, so the forwarding it
    // acquired has to be gone; a row saying "the space base forwards to the project
    // version" would send every later disable to a placement nothing occupies. In the
    // durable dialects the same order is what keeps the second move from re-pointing
    // the first move's row ONTO its own source, which is a row that forwards an
    // address to itself — the one thing `0016` refuses outright.
    it('stops forwarding an address a later move gives the package back', async () => {
      await db.abilityPlacement.moveOwnedRolePlacement(move)
      await expect(
        db.abilityPlacement.moveOwnedRolePlacement({
          fromTargetId: TO_TARGET,
          toTargetId: FROM_TARGET,
          fromLocator: move.toLocator,
          toLocator: move.fromLocator,
          registryNoteId: REGISTRY_NOTE_ID,
          manifestNoteId: MANIFEST_NOTE_ID,
        }),
      ).resolves.toBeUndefined()

      await db.abilityPreferences.setEnabled(
        'user:alice',
        { locator: spaceLocator, registryNoteId: 'RegistryNote1' },
        false,
        '2026-08-17T00:00:00Z',
      )

      // Written at the address the package LEFT this time, so it lands at the project
      // placement it went back to — and the Space base it no longer occupies answers
      // the same, because that spelling now forwards there.
      await expect(db.abilityPreferences.isEnabled('user:alice', projectLocator)).resolves.toBe(
        false,
      )
      await expect(db.abilityPreferences.isEnabled('user:alice', spaceLocator)).resolves.toBe(false)
      // A trail walked the wrong way round is still a wrong answer in the batch, where
      // the two spellings arrive together and nothing tells them apart but the trail.
      await expect(bothSpellings(db.abilityPreferences, 'user:alice')).resolves.toEqual(
        BOTH_DISABLED,
      )
    })

    it('lets the destination be reused after a promotion was undone by hand', async () => {
      await db.scopePins.addPin({
        targetKind: 'role',
        targetId: TO_TARGET,
        targetSpace: 'space-main',
        noteSpace: 'space-main',
        noteId: 'StaleNote01',
        createdAt: '2026-08-17T00:00:00Z',
      })
      await db.scopePins.addPin({
        targetKind: 'role',
        targetId: FROM_TARGET,
        targetSpace: 'space-main',
        noteSpace: 'space-main',
        noteId: 'PinnedNote01',
        createdAt: '2026-08-17T00:00:00Z',
      })
      // The same leftover, in the one table that is keyed by the LOCATOR rather than
      // the target id. Seeded for an owner who has nothing at the source, so the only
      // thing that can clear it is the destination delete the drivers run beside every
      // update — and clearing it is the whole difference between "this owner turned
      // the role off once, at an address it has since left" and "this owner has it
      // turned off now".
      await db.abilityPreferences.setEnabled(
        'user:bob',
        { locator: spaceLocator, registryNoteId: 'RegistryNote1' },
        false,
        '2026-08-17T00:00:00Z',
      )

      await db.abilityPlacement.moveOwnedRolePlacement(move)

      // The destination belongs to the package being moved either way, so a leftover
      // row there is replaced rather than allowed to abort the move on its key.
      await expect(db.scopePins.pinsForTarget('role', TO_TARGET)).resolves.toMatchObject([
        { noteId: 'PinnedNote01' },
      ])
      await expect(db.abilityPreferences.isEnabled('user:bob', spaceLocator)).resolves.toBe(true)
      // Nothing is off for this owner, at either spelling — the batch names no address
      // it was not asked about, and forwards no answer from a cleared one.
      await expect(bothSpellings(db.abilityPreferences, 'user:bob')).resolves.toEqual(new Set())
    })
  })
}

/** The NAMED fork of the contract above, and the reason it exists is not "this host is
 *  in memory" — it is WHICH of the five tables the host actually holds. Context sets,
 *  scope pins, the order overlay and the durable episode are meta-DB facets and go
 *  away with it; the owner preference does NOT. A host composed without a meta-DB is
 *  still handed a preference twin (`inMemoryAbilityPersistence()`), and a preference
 *  row is keyed by the WHOLE locator, placement included — so the move is not a no-op
 *  here, it carries exactly one table, and that carry is the whole behaviour this arm
 *  exists to pin down.
 *
 *  The arm is claimed by handing over the placement facet AND the preference table it
 *  was composed over — the same instance, because sharing the instance is the only
 *  thing that makes the carry observable at all. A host that also holds the other four
 *  answers the FULL contract above instead. */
export const describeAbilityPlacementPreferencesOnlyContract = (
  name: string,
  factory: () => Promise<{
    abilityPlacement: AbilityPlacementPersistence
    abilityPreferences: Pick<AbilityPreferencesPersistence, 'setEnabled' | 'isEnabled' | 'disabled'>
  }>,
): void => {
  describe(`Ability placement contract (host holding preferences only) — ${name}`, () => {
    const disable = async (
      abilityPreferences: Pick<AbilityPreferencesPersistence, 'setEnabled'>,
      owner: string,
      locator: OwnedAbilityLocator,
    ): Promise<void> => {
      await abilityPreferences.setEnabled(
        owner,
        { locator, registryNoteId: 'RegistryNote1' },
        false,
        '2026-08-17T00:00:00Z',
      )
    }

    it('carries the owner preference to the new placement, for every owner at once', async () => {
      const { abilityPlacement, abilityPreferences } = await factory()

      await disable(abilityPreferences, 'user:alice', projectLocator)
      await disable(abilityPreferences, 'user:bob', projectLocator)

      await expect(abilityPlacement.moveOwnedRolePlacement(move)).resolves.toBeUndefined()

      // The `disabled` bit is keyed by the whole locator, placement included, and the
      // move carries no owner — so a rewrite that misses it silently RE-ENABLES a role
      // every one of these owners had turned off: the row keeps naming the pre-move
      // locator, and an absent row reads as enabled.
      await expect(abilityPreferences.isEnabled('user:alice', spaceLocator)).resolves.toBe(false)
      await expect(abilityPreferences.isEnabled('user:bob', spaceLocator)).resolves.toBe(false)
      // The address the package LEFT answers for the address it took: a caller holding
      // the pre-move spelling is asking about the same package, and the alternative is
      // an answer that flips to "enabled" for everyone whose page was a second old.
      await expect(abilityPreferences.isEnabled('user:alice', projectLocator)).resolves.toBe(false)
      await expect(abilityPreferences.isEnabled('user:bob', projectLocator)).resolves.toBe(false)
      // And in the batch, per owner: this is the host a meta-DB-less deployment runs
      // on, and its `start_session` reads exactly this call.
      await expect(bothSpellings(abilityPreferences, 'user:alice')).resolves.toEqual(BOTH_DISABLED)
      await expect(bothSpellings(abilityPreferences, 'user:bob')).resolves.toEqual(BOTH_DISABLED)
    })

    it('exposes only a recorded target and rewrites the trail on a back move', async () => {
      const { abilityPlacement } = await factory()

      await expect(
        abilityPlacement.resolveMovedOwnedRoleLocator(move.fromLocator),
      ).resolves.toBeNull()

      await abilityPlacement.moveOwnedRolePlacement(move)

      await expect(
        abilityPlacement.resolveMovedOwnedRoleLocator(move.fromLocator),
      ).resolves.toEqual({
        toLocator: move.toLocator,
        registryNoteId: REGISTRY_NOTE_ID,
        manifestNoteId: MANIFEST_NOTE_ID,
      })
      await expect(
        abilityPlacement.resolveMovedOwnedRoleLocator(move.toLocator),
      ).resolves.toBeNull()

      await abilityPlacement.moveOwnedRolePlacement(reverseMove)

      await expect(
        abilityPlacement.resolveMovedOwnedRoleLocator(move.fromLocator),
      ).resolves.toBeNull()
      await expect(abilityPlacement.resolveMovedOwnedRoleLocator(move.toLocator)).resolves.toEqual({
        toLocator: move.fromLocator,
        registryNoteId: REGISTRY_NOTE_ID,
        manifestNoteId: MANIFEST_NOTE_ID,
      })
    })

    // The same fact the full contract states, in the host that keeps this table and
    // nothing else: forwarding lives in the preference port, not in the four meta-DB
    // tables the move also rewrites.
    it('applies a disable written at the address the move has already left', async () => {
      const { abilityPlacement, abilityPreferences } = await factory()

      await expect(abilityPlacement.moveOwnedRolePlacement(move)).resolves.toBeUndefined()
      await disable(abilityPreferences, 'user:alice', projectLocator)

      await expect(abilityPreferences.isEnabled('user:alice', spaceLocator)).resolves.toBe(false)
      await expect(abilityPreferences.isEnabled('user:alice', projectLocator)).resolves.toBe(false)
      await expect(bothSpellings(abilityPreferences, 'user:alice')).resolves.toEqual(BOTH_DISABLED)
    })

    it('clears a destination the moving package left behind by hand', async () => {
      const { abilityPlacement, abilityPreferences } = await factory()

      // A leftover at the destination and nothing at the source — a promotion undone
      // by hand and redone. The destination belongs to the package being moved either
      // way, so the row there is cleared rather than left to answer for a placement
      // this package no longer occupies. Same delete-then-update the drivers run
      // (`DELETE FROM ability_preferences WHERE locator = ?` before the UPDATE).
      await disable(abilityPreferences, 'user:alice', spaceLocator)

      await expect(abilityPlacement.moveOwnedRolePlacement(move)).resolves.toBeUndefined()

      await expect(abilityPreferences.isEnabled('user:alice', spaceLocator)).resolves.toBe(true)
      await expect(abilityPreferences.isEnabled('user:alice', projectLocator)).resolves.toBe(true)
      await expect(bothSpellings(abilityPreferences, 'user:alice')).resolves.toEqual(new Set())
    })

    it('runs a second time without pretending the repeat costs nothing', async () => {
      const { abilityPlacement, abilityPreferences } = await factory()

      await disable(abilityPreferences, 'user:alice', projectLocator)

      await expect(abilityPlacement.moveOwnedRolePlacement(move)).resolves.toBeUndefined()
      await expect(abilityPlacement.moveOwnedRolePlacement(move)).resolves.toBeUndefined()

      // The second run finds nothing at the source and a row at the destination, so
      // the clearing rule above applies to it — and the owner's disabled bit is gone.
      // This move is NOT idempotent on the preference table, in any implementation of
      // the port: the drivers delete the destination row inside the same transaction.
      // Nothing retries it either — `RolesService.moveRolePlacement` puts the package
      // BACK when the rewrite fails, so a redo starts at the source with its row still
      // there. Written down because the arm this replaced claimed idempotency and
      // observed only a resolving promise, which nothing could ever contradict.
      await expect(abilityPreferences.isEnabled('user:alice', spaceLocator)).resolves.toBe(true)
      await expect(abilityPreferences.isEnabled('user:alice', projectLocator)).resolves.toBe(true)
      await expect(bothSpellings(abilityPreferences, 'user:alice')).resolves.toEqual(new Set())
    })
  })
}
