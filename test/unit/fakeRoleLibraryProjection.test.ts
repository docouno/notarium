import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

import type { NoteMeta } from '@notarium/core'
import { InMemoryStore } from '@notarium/engine-memory'

import {
  createRolesService,
  inMemoryAbilityPersistence,
  loadBundledAbilityInventory,
  type RoleLocation,
  type SkillPackage,
} from '../../packages/server/src/services/roles'
import { createStoreRoleLibrary } from '../fake-server/storeRoleLibrary'
import { writableLibrary } from '../roleLibraryComposition'

const NOW = '2099-08-05T12:00:00.000Z'
const LOCATION: RoleLocation = { scope: 'personal', space: 'personal' }
/** Never published anywhere in this file — the address a caller can hold while the
 *  projection has nothing under it. */
const ABSENT_DIRECTORY = 'AbCdefGhij_1'

const rolePackage = (directoryName: string, name: string): SkillPackage => ({
  directoryName,
  files: new Map([
    [
      'SKILL.md',
      Buffer.from(
        `---\nname: ${name}\ndescription: A role for the projection contract.\nmetadata:\n  notarium.kind: role\n---\n\nDo the work.\n`,
      ),
    ],
  ]),
})

/**
 * The window every publish passes through: the bytes are durable, the note
 * projection has not caught up with them yet. The real host answers inside this
 * window by skipping the package it cannot see
 * (`projectPublishedPackages`, packages/server/src/apps/server/server.ts) — so
 * whatever the fake does here is what the layer above gets to decide on.
 */
class LaggingProjectionStore extends InMemoryStore {
  override list(): Promise<NoteMeta[]> {
    return Promise.resolve([])
  }
}

describe('fake role library — package identities off the note projection', () => {
  it('answers a package the projection does not hold as absent, never as a throw', async () => {
    const store = new InMemoryStore({ space: 'personal', now: NOW, notes: [] })
    const library = writableLibrary(createStoreRoleLibrary(() => Promise.resolve(store)))

    expect(await library.putIfAbsent(LOCATION, rolePackage('ZyXwvUtsrq_2', 'projected'))).toBe(true)

    // Both port methods ANSWER the same, because the fake writes through the store it
    // reads and its projection is never behind. A partial map is the contract
    // (`RoleLibrary` in packages/server/src/services/roles/library.ts): present for
    // what is projected, silent about what is not.
    for (const readable of [
      await library.awaitReadableNoteIds(LOCATION, ['ZyXwvUtsrq_2', ABSENT_DIRECTORY]),
      await library.readableNoteIds(LOCATION, ['ZyXwvUtsrq_2', ABSENT_DIRECTORY]),
    ]) {
      expect(readable.get('ZyXwvUtsrq_2')).toEqual(expect.any(String))
      expect(readable.has(ABSENT_DIRECTORY)).toBe(false)
    }
    await expect(library.awaitReadableNoteIds(LOCATION, [ABSENT_DIRECTORY])).resolves.toEqual(
      new Map(),
    )
  })

  it('still tells the barrier-crossing question apart from the one without it', async () => {
    // Equal ANSWERS are not one question. The barrier `awaitReadableNoteIds` crosses
    // reconciles file truth and blocks mutations across the whole space while it runs;
    // the fake pays nothing for it, which is precisely why it used to implement both
    // methods with one function — and a double that cannot tell them apart cannot fail
    // a read path that takes the expensive one. The fake is the ONLY library under the
    // browser gates, so what it cannot express, none of them can catch.
    const store = new InMemoryStore({ space: 'personal', now: NOW, notes: [] })
    const crossed: string[][] = []
    const library = writableLibrary(
      createStoreRoleLibrary(() => Promise.resolve(store), undefined, {
        onBarrier: (_location, directoryNames) => crossed.push([...directoryNames]),
      }),
    )

    expect(await library.putIfAbsent(LOCATION, rolePackage('ZyXwvUtsrq_2', 'projected'))).toBe(true)

    await library.readableNoteIds(LOCATION, ['ZyXwvUtsrq_2'])
    expect(crossed).toEqual([])

    await library.awaitReadableNoteIds(LOCATION, ['ZyXwvUtsrq_2'])
    expect(crossed).toEqual([['ZyXwvUtsrq_2']])
  })

  it('leaves the verdict on a missing identity to RolesService, which degrades honestly', async () => {
    const library = writableLibrary(
      createStoreRoleLibrary(() =>
        Promise.resolve(new LaggingProjectionStore({ space: 'personal', now: NOW, notes: [] })),
      ),
    )
    // This host has no meta-DB, and says so rather than inheriting it by omission —
    // the spread goes first so anything stated below would override it.
    const roles = createRolesService({
      ...inMemoryAbilityPersistence(),
      catalog: loadBundledAbilityInventory,
      ...library.deps,
    })

    // The domain error is the point: the honest-degradation branch of `RolesService`
    // is REACHABLE through the fake transport, so the fake-server — the only layer
    // that runs the real service — can execute it. A transport-level throw
    // ('missing from the note projection') would short-circuit the service and leave
    // that branch dead here.
    await expect(
      roles.createCustomRole(
        'projection-lag',
        'A role published into a lagging projection.',
        'Do the work.',
        LOCATION,
      ),
    ).rejects.toThrow(/without a readable note identity/)
  })
})
