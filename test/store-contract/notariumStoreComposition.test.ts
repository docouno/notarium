import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createNotariumStore,
  createNotariumStoreComposition,
  ensureNotariumResourceAuthority,
  type NotariumStoreComposition,
  NotariumStoreCompositionOwner,
  SpaceResourceAuthorityRegistry,
} from '@notarium/engine'

const roots: string[] = []

const mkroot = async (name: string): Promise<string> => {
  const root = await fs.mkdtemp(join(tmpdir(), `notarium-composition-${name}-`))

  roots.push(root)
  return root
}

describe('NotariumStore physical composition', () => {
  it('reuses the cold authority assembly for the later store', async () => {
    const root = await mkroot('cold-first')
    const owner = new NotariumStoreCompositionOwner()
    const registry = new SpaceResourceAuthorityRegistry()
    const mounts = [{ class: 'user-doc' as const, dir: root }]
    const indexDb = join(root, '.derived.db')
    const composition = owner.getOrCreate('space-a', mounts)
    const coldAuthority = ensureNotariumResourceAuthority({
      spaceId: 'space-a',
      resourceAuthorityRegistry: registry,
      composition,
    })
    await expect(fs.stat(indexDb)).rejects.toMatchObject({ code: 'ENOENT' })
    const mount = composition.mountsForStore()[0]
    const adapter = composition.adaptersForAuthority()[0]

    // Both projections close over one FileStoreAssembly: not merely equivalent
    // topology, but the exact base functions and shared capability objects.
    expect(adapter.files).toBe(mount.files)
    expect(adapter.files.read).toBe(mount.files.read)
    expect(adapter.capabilities.resourceExport).toBe(mount.fileCapabilities.resourceExport)
    expect(Object.keys(composition).sort()).toEqual(['adaptersForAuthority', 'mountsForStore'])

    const store = createNotariumStore({
      spaceId: 'space-a',
      resourceAuthorityRegistry: registry,
      composition: owner.getOrCreate('space-a', mounts),
      indexDb,
      integritySweepBatchSize: 0,
    })

    try {
      await expect(fs.stat(indexDb)).resolves.toBeDefined()
      expect(registry.get('space-a')).toBe(coldAuthority)
      const lease = await coldAuthority.admitResource('locked.md', 'exclusive', 'composition-test')
      let writeSettled = false
      const writing = store
        .write({ title: 'Locked', content: 'body' })
        .finally(() => (writeSettled = true))

      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(writeSettled).toBe(false)
      await lease.settle()
      await expect(writing).resolves.toMatchObject({ filePath: 'locked.md' })
    } finally {
      await store.stop()
    }
  })

  it('keeps the same projections when the store creates the authority first', async () => {
    const root = await mkroot('store-first')
    const owner = new NotariumStoreCompositionOwner()
    const registry = new SpaceResourceAuthorityRegistry()
    const mounts = [{ class: 'user-doc' as const, dir: root }]
    const composition = owner.getOrCreate('space-a', mounts)
    const store = createNotariumStore({
      spaceId: 'space-a',
      resourceAuthorityRegistry: registry,
      composition,
      integritySweepBatchSize: 0,
    })

    try {
      const createdAuthority = registry.get('space-a')
      const ensuredAuthority = ensureNotariumResourceAuthority({
        spaceId: 'space-a',
        resourceAuthorityRegistry: registry,
        composition: owner.getOrCreate('space-a', mounts),
      })
      const mount = composition.mountsForStore()[0]
      const adapter = composition.adaptersForAuthority()[0]

      expect(ensuredAuthority).toBe(createdAuthority)
      expect(adapter.files).toBe(mount.files)
      expect(adapter.files.read).toBe(mount.files.read)
      expect(adapter.capabilities.resourceExport).toBe(mount.fileCapabilities.resourceExport)
    } finally {
      await store.stop()
    }
  })

  it('keeps a genuine composition immutable across detached projections', async () => {
    const root = await mkroot('immutable')
    const registry = new SpaceResourceAuthorityRegistry()
    const composition = createNotariumStoreComposition([{ class: 'user-doc', dir: root }])
    const authorityMount = composition.mountsForStore()[0]
    const authorityAdapter = composition.adaptersForAuthority()[0]
    const otherMounts = composition.mountsForStore()
    const otherAdapters = composition.adaptersForAuthority()
    const originalRead = authorityMount.files.read
    const originalExport = authorityMount.fileCapabilities.resourceExport
    const mutableComposition = composition as {
      mountsForStore: typeof composition.mountsForStore
      adaptersForAuthority: typeof composition.adaptersForAuthority
    }
    const coldAuthority = ensureNotariumResourceAuthority({
      spaceId: 'space-a',
      resourceAuthorityRegistry: registry,
      composition,
    })

    expect(otherMounts).not.toBe(composition.mountsForStore())
    expect(otherMounts[0]).not.toBe(authorityMount)
    expect(otherAdapters).not.toBe(composition.adaptersForAuthority())
    expect(otherAdapters[0]).not.toBe(authorityAdapter)
    expect(otherAdapters[0].files).toBe(otherMounts[0].files)
    expect(otherAdapters[0].capabilities.resourceExport).toBe(
      otherMounts[0].fileCapabilities.resourceExport,
    )
    expect(
      [
        composition,
        composition.mountsForStore,
        composition.adaptersForAuthority,
        otherMounts,
        otherAdapters,
        authorityMount,
        authorityMount.files,
        authorityMount.fileCapabilities,
        authorityMount.fileAccelerators,
        authorityAdapter,
        authorityAdapter.capabilities,
        originalExport,
      ].every((value) => Object.isFrozen(value)),
    ).toBe(true)

    expect(() => {
      authorityMount.files = createNotariumStoreComposition([
        { class: 'user-doc', dir: root },
      ]).mountsForStore()[0].files
    }).toThrow(TypeError)
    expect(() => {
      authorityMount.files.read = async () => 'forged'
    }).toThrow(TypeError)
    expect(() => {
      authorityMount.fileCapabilities.resourceExport = undefined
    }).toThrow(TypeError)
    expect(() => {
      authorityAdapter.files = createNotariumStoreComposition([
        { class: 'user-doc', dir: root },
      ]).adaptersForAuthority()[0].files
    }).toThrow(TypeError)
    expect(() => {
      authorityAdapter.capabilities.resourceExport = undefined
    }).toThrow(TypeError)
    expect(() => {
      if (originalExport) {
        originalExport.exportFiles = async function* () {
          yield { path: 'forged.md', content: new Uint8Array() }
        }
      }
    }).toThrow(TypeError)
    expect(() => {
      mutableComposition.mountsForStore = () => [authorityMount]
    }).toThrow(TypeError)
    expect(() => {
      mutableComposition.adaptersForAuthority = () => [authorityAdapter]
    }).toThrow(TypeError)

    const store = createNotariumStore({
      spaceId: 'space-a',
      resourceAuthorityRegistry: registry,
      composition,
      integritySweepBatchSize: 0,
    })

    try {
      const storeMount = composition.mountsForStore()[0]
      const registeredAdapter = composition.adaptersForAuthority()[0]

      expect(registry.get('space-a')).toBe(coldAuthority)
      expect(storeMount.files).toBe(registeredAdapter.files)
      expect(storeMount.files.read).toBe(originalRead)
      expect(storeMount.fileCapabilities.resourceExport).toBe(originalExport)
      await store.write({ title: 'Immutable', content: 'shared locks still work' })
      await expect(store.read('immutable.md')).resolves.toMatchObject({
        content: 'shared locks still work',
      })
    } finally {
      await store.stop()
    }
  })

  it('rejects a frozen structural hybrid before any composition or store work', async () => {
    const rootA = await mkroot('authentic-a')
    const rootB = await mkroot('authentic-b')
    const indexDb = join(rootA, '.forged.db')
    const registry = new SpaceResourceAuthorityRegistry()
    const compositionA = createNotariumStoreComposition([{ class: 'user-doc', dir: rootA }])
    const compositionB = createNotariumStoreComposition([{ class: 'user-doc', dir: rootB }])
    let storeProjectionCalls = 0
    let authorityProjectionCalls = 0
    const hybrid = Object.freeze({
      mountsForStore: Object.freeze(() => {
        storeProjectionCalls++
        return compositionA.mountsForStore()
      }),
      adaptersForAuthority: Object.freeze(() => {
        authorityProjectionCalls++
        return compositionB.adaptersForAuthority()
      }),
    })
    const acceptsComposition: (composition: NotariumStoreComposition) => void = () => undefined

    // The private nominal member makes a structural owner unusable without a cast.
    // @ts-expect-error only the factory return type is a NotariumStoreComposition
    acceptsComposition(hybrid)
    const forgedComposition = hybrid as unknown as NotariumStoreComposition

    expect(() =>
      ensureNotariumResourceAuthority({
        spaceId: 'space-a',
        resourceAuthorityRegistry: registry,
        composition: forgedComposition,
      }),
    ).toThrow(/must be created by its factory/)
    expect(() =>
      createNotariumStore({
        spaceId: 'space-a',
        resourceAuthorityRegistry: registry,
        composition: forgedComposition,
        indexDb,
      }),
    ).toThrow(/must be created by its factory/)
    expect(storeProjectionCalls).toBe(0)
    expect(authorityProjectionCalls).toBe(0)
    expect(registry.get('space-a')).toBeUndefined()
    await expect(fs.stat(indexDb)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an equal-topology composition with a different identity before store construction', async () => {
    const root = await mkroot('identity')
    const registry = new SpaceResourceAuthorityRegistry()
    const mounts = [{ class: 'user-doc' as const, dir: root }]
    const compositionA = createNotariumStoreComposition(mounts)
    const compositionB = createNotariumStoreComposition(mounts)
    const indexDb = join(root, '.rejected.db')
    const authority = ensureNotariumResourceAuthority({
      spaceId: 'space-a',
      resourceAuthorityRegistry: registry,
      composition: compositionA,
    })

    expect(compositionB).not.toBe(compositionA)
    expect(() =>
      createNotariumStore({
        spaceId: 'space-a',
        resourceAuthorityRegistry: registry,
        composition: compositionB,
        indexDb,
      }),
    ).toThrow(/owner identity changed/)
    expect(() =>
      ensureNotariumResourceAuthority({
        spaceId: 'space-a',
        resourceAuthorityRegistry: registry,
        composition: compositionB,
      }),
    ).toThrow(/owner identity changed/)
    expect(registry.get('space-a')).toBe(authority)
    await expect(fs.stat(indexDb)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cannot pair a genuine owner identity with forged authority adapters', async () => {
    const root = await mkroot('forged-adapters')
    const registry = new SpaceResourceAuthorityRegistry()
    const mounts = [{ class: 'user-doc' as const, dir: root }]
    const compositionA = createNotariumStoreComposition(mounts)
    const compositionB = createNotariumStoreComposition(mounts)
    const authority = ensureNotariumResourceAuthority({
      spaceId: 'space-a',
      resourceAuthorityRegistry: registry,
      composition: compositionA,
    })
    let forgedAccessorCalls = 0
    const forgedOwner = Object.freeze({
      adaptersForAuthority: () => {
        forgedAccessorCalls++
        return compositionB.adaptersForAuthority()
      },
    })

    const splitRegistration = () =>
      registry.getOrCreateOwned({
        spaceId: 'space-a',
        // @ts-expect-error identity and adapters are not separate registration inputs
        ownerIdentity: compositionA,
        adapters: compositionB.adaptersForAuthority(),
      })

    expect(splitRegistration).toBeTypeOf('function')
    expect(() => registry.getOrCreateOwned({ spaceId: 'space-a', owner: forgedOwner })).toThrow(
      /owner identity changed/,
    )
    expect(forgedAccessorCalls).toBe(1)
    expect(registry.get('space-a')).toBe(authority)
  })

  it('rejects changed topology and still delegates cross-space overlap to the authority registry', async () => {
    const root = await mkroot('topology')
    const other = await mkroot('other')
    const nested = join(root, 'nested')
    await fs.mkdir(nested)
    const owner = new NotariumStoreCompositionOwner()
    const registry = new SpaceResourceAuthorityRegistry()
    const composition = owner.getOrCreate('space-a', [{ class: 'user-doc', dir: root }])

    ensureNotariumResourceAuthority({
      spaceId: 'space-a',
      resourceAuthorityRegistry: registry,
      composition,
    })
    expect(() => owner.getOrCreate('space-a', [{ class: 'user-doc', dir: other }])).toThrow(
      /notarium store composition changed/,
    )
    expect(() =>
      ensureNotariumResourceAuthority({
        spaceId: 'space-a',
        resourceAuthorityRegistry: registry,
        composition: createNotariumStoreComposition([{ class: 'user-doc', dir: other }]),
      }),
    ).toThrow(/resource authority composition changed/)
    expect(() => {
      // @ts-expect-error a shared authority registry requires its owner's composition
      createNotariumStore({ notesDir: other, resourceAuthorityRegistry: registry })
    }).toThrow(/shared authority registry requires `composition`/)
    expect(() =>
      ensureNotariumResourceAuthority({
        spaceId: 'space-b',
        resourceAuthorityRegistry: registry,
        composition: createNotariumStoreComposition([{ class: 'user-doc', dir: nested }]),
      }),
    ).toThrow(/overlap across spaces/)
  })

  it('snapshots live mount config once before topology and composition construction', async () => {
    const rootA = await mkroot('snapshot-a')
    const rootB = await mkroot('snapshot-b')
    const owner = new NotariumStoreCompositionOwner()
    const reads = { class: 0, dir: 0, prefix: 0 }
    const liveMount = {
      get class() {
        return ++reads.class === 1 ? ('user-doc' as const) : ('agent-memory' as const)
      },
      get dir() {
        return ++reads.dir === 1 ? rootA : rootB
      },
      get prefix() {
        return ++reads.prefix === 1 ? '' : '.notarium/memory'
      },
    }

    const composition = owner.getOrCreate('space-a', [liveMount])
    const honestA = owner.getOrCreate('space-a', [{ class: 'user-doc', dir: rootA, prefix: '' }])
    const mount = composition.mountsForStore()[0]
    const adapter = composition.adaptersForAuthority()[0]

    expect(reads).toEqual({ class: 1, dir: 1, prefix: 1 })
    expect(honestA).toBe(composition)
    expect(mount).toMatchObject({ class: 'user-doc', prefix: '' })
    expect(adapter).toMatchObject({
      id: 'mount-0:user-doc',
      prefix: '',
      physicalRoot: rootA,
    })
  })

  it('keeps the physical composition and authority across store eviction/reopen', async () => {
    const root = await mkroot('reopen')
    const indexDb = join(root, '.index.db')
    const owner = new NotariumStoreCompositionOwner()
    const registry = new SpaceResourceAuthorityRegistry()
    const mounts = [{ class: 'user-doc' as const, dir: root }]
    const composition = owner.getOrCreate('space-a', mounts)
    const authority = ensureNotariumResourceAuthority({
      spaceId: 'space-a',
      resourceAuthorityRegistry: registry,
      composition,
    })
    const first = createNotariumStore({
      spaceId: 'space-a',
      resourceAuthorityRegistry: registry,
      composition,
      indexDb,
      integritySweepBatchSize: 0,
    })
    const firstMount = composition.mountsForStore()[0]
    const firstAdapter = composition.adaptersForAuthority()[0]

    await first.write({ title: 'Persistent', content: 'before eviction' })
    await first.stop()

    const reopenedComposition = owner.getOrCreate('space-a', mounts)
    const reopened = createNotariumStore({
      spaceId: 'space-a',
      resourceAuthorityRegistry: registry,
      composition: reopenedComposition,
      indexDb,
      integritySweepBatchSize: 0,
    })

    try {
      expect(reopenedComposition).toBe(composition)
      expect(registry.get('space-a')).toBe(authority)
      expect(reopenedComposition.mountsForStore()[0].files).toBe(firstMount.files)
      expect(reopenedComposition.adaptersForAuthority()[0].capabilities.resourceExport).toBe(
        firstAdapter.capabilities.resourceExport,
      )
      await expect(reopened.read('persistent.md')).resolves.toMatchObject({
        content: 'before eviction',
      })
    } finally {
      await reopened.stop()
    }
  })

  it('accepts a fresh composition after purge removes both owners', async () => {
    const root = await mkroot('purge')
    const owner = new NotariumStoreCompositionOwner()
    const registry = new SpaceResourceAuthorityRegistry()
    const mounts = [{ class: 'user-doc' as const, dir: root }]
    const firstComposition = owner.getOrCreate('space-a', mounts)
    const firstAuthority = ensureNotariumResourceAuthority({
      spaceId: 'space-a',
      resourceAuthorityRegistry: registry,
      composition: firstComposition,
    })

    registry.remove('space-a')
    owner.remove('space-a')
    const freshComposition = owner.getOrCreate('space-a', mounts)
    const freshAuthority = ensureNotariumResourceAuthority({
      spaceId: 'space-a',
      resourceAuthorityRegistry: registry,
      composition: freshComposition,
    })
    const store = createNotariumStore({
      spaceId: 'space-a',
      resourceAuthorityRegistry: registry,
      composition: freshComposition,
      integritySweepBatchSize: 0,
    })

    try {
      expect(freshComposition).not.toBe(firstComposition)
      expect(freshAuthority).not.toBe(firstAuthority)
      expect(registry.get('space-a')).toBe(freshAuthority)
    } finally {
      await store.stop()
    }
  })
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})
