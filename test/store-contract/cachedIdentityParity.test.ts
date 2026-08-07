import { describe, expect, it } from 'vitest'

import { CachedStore, encodeWikilinkIdentity, type Graph } from '@notarium/core'
import { InMemoryStore } from '@notarium/engine-memory'

const setup = async () => {
  const inner = new InMemoryStore({
    space: 'main',
    now: '2026-08-05T00:00:00.000Z',
    notes: [],
  })
  const store = new CachedStore({ inner, pollIntervalMs: 0, relationType: 'links_to' })

  await store.start()
  return { inner, store }
}

const sourceProjection = (graph: Graph, sourceId: string) => {
  const targets = graph.links
    .filter((edge) => edge.source === sourceId)
    .map((edge) => edge.target)
    .sort()

  return targets.map((target) => {
    const node = graph.nodes.find((candidate) => candidate.id === target)

    return node?.ghost
      ? { ghost: true, target: node.target, creatable: node.creatable }
      : { ghost: false, target }
  })
}

describe('CachedStore identity resolver parity', () => {
  it('moves exact legacy note/folder leaves through the read-model fence', async () => {
    const inner = new InMemoryStore({
      space: 'main',
      notes: [
        { id: 'legacy-note', title: 'Legacy Note', filePath: 'foo:bar.md', content: 'note' },
        {
          id: 'nested-note',
          title: 'Nested Note',
          filePath: 'folder:legacy/note.md',
          content: 'nested',
        },
      ],
    })
    const store = new CachedStore({ inner, pollIntervalMs: 0, relationType: 'links_to' })

    try {
      await store.start()
      await store.makeDir!('archive')
      await store.move({ id: 'legacy-note', destinationPath: 'archive/foo:bar.md' })
      await store.move({
        id: 'folder:legacy',
        destinationPath: 'archive/folder:legacy',
        isDirectory: true,
      })

      await expect(store.read('legacy-note')).resolves.toMatchObject({
        filePath: 'archive/foo:bar.md',
      })
      await expect(store.read('nested-note')).resolves.toMatchObject({
        filePath: 'archive/folder:legacy/note.md',
      })
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('separates exact legacy storage paths from authored identity envelopes', async () => {
    const address = 'notarium-id:foo.md'
    const inner = new InMemoryStore({
      space: 'main',
      notes: [
        { id: 'literal-path', title: 'Literal Path', filePath: address, content: 'literal' },
        { id: 'foo.md', title: 'Stable Target', filePath: 'target.md', content: 'target' },
      ],
    })
    const store = new CachedStore({ inner, pollIntervalMs: 0, relationType: 'links_to' })

    try {
      await store.start()
      expect((await store.list()).some((note) => note.filePath === address)).toBe(true)
      await expect(store.read(address)).resolves.toMatchObject({ id: 'literal-path' })
      await expect(store.resolveWikilink(address)).resolves.toMatchObject({ id: 'foo.md' })
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('does not confuse an opaque graph id with another note storage path', async () => {
    const targetId = 'target-id'
    const address = encodeWikilinkIdentity(targetId)
    const inner = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'other.md',
          title: 'Collision Source',
          filePath: 'source.md',
          content: `[[${address}|Target]]`,
        },
        {
          id: 'decoy-id',
          title: 'Path Decoy',
          filePath: 'other.md',
          content: 'decoy',
        },
        { id: targetId, title: 'Target', filePath: 'target.md', content: 'target' },
      ],
    })
    const store = new CachedStore({ inner, pollIntervalMs: 0, relationType: 'links_to' })

    try {
      await store.start()
      expect(sourceProjection(await store.graph(), 'other.md')).toEqual([
        { ghost: false, target: targetId },
      ])
      expect(sourceProjection(await store.graph(), 'decoy-id')).toEqual([])

      const read = inner.read.bind(inner)

      inner.read = async (id) => {
        if (id === encodeWikilinkIdentity('other.md')) {
          throw new Error('injected source read failure')
        }

        return read(id)
      }
      await store.remove(targetId)

      expect(sourceProjection(await store.graph(), 'other.md')).toEqual([
        { ghost: true, target: address, creatable: false },
      ])
      expect(sourceProjection(await store.graph(), 'decoy-id')).toEqual([])
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('keeps prefix-shaped opaque ids distinct from their authored envelope syntax', async () => {
    const { store } = await setup()

    try {
      await store.write({ id: 'decoy-id', title: 'missing-id', content: 'decoy' })
      const opaque = await store.write({
        id: 'notarium-id:%zz',
        title: 'Opaque Reserved',
        content: 'opaque',
      })

      await expect(store.read(encodeWikilinkIdentity('missing-id'))).rejects.toMatchObject({
        isNotFound: true,
      })
      await expect(store.read('notarium-id:%zz')).resolves.toMatchObject({ id: opaque.id })
      await expect(store.resolveWikilink('notarium-id:%zz')).rejects.toMatchObject({
        isNotFound: true,
      })
      await expect(
        store.resolveWikilink(encodeWikilinkIdentity('notarium-id:%zz')),
      ).resolves.toMatchObject({ id: opaque.id })
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('lets a human reference fall through a tombstoned plain id to a live title', async () => {
    const { store } = await setup()

    try {
      await store.write({ id: 'Foo', title: 'Former Foo', content: 'old' })
      await store.remove('Foo')
      await store.write({ id: 'live-foo', title: 'Foo', content: 'live human target' })

      await expect(store.read('Foo')).rejects.toMatchObject({ isNotFound: true })
      await expect(store.resolveWikilink('Foo')).resolves.toMatchObject({
        id: 'live-foo',
        content: 'live human target',
      })
      await expect(store.resolveWikilink(encodeWikilinkIdentity('Foo'))).rejects.toMatchObject({
        isNotFound: true,
      })
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('keeps hidden-class titles out of human wikilink resolution', async () => {
    const { store } = await setup()

    try {
      await store.write({ id: 'source', title: 'Source', content: '[[Secret]]' })
      await store.write({
        id: 'secret-memory',
        title: 'Secret',
        content: 'private memory',
        targetClass: 'agent-memory',
      })

      await expect(store.resolveWikilink('Secret')).rejects.toMatchObject({ isNotFound: true })
      await expect(
        store.resolveWikilink(encodeWikilinkIdentity('secret-memory')),
      ).rejects.toMatchObject({ isNotFound: true })
      await expect(store.read(encodeWikilinkIdentity('secret-memory'))).resolves.toMatchObject({
        content: 'private memory',
      })
      const graph = await store.graph()
      const edge = graph.links.find((candidate) => candidate.source === 'source')!
      expect(graph.nodes.find((candidate) => candidate.id === edge.target)).toMatchObject({
        ghost: true,
        target: 'secret',
      })
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('keeps cold-boot links to hidden targets as non-leaking ghosts', async () => {
    const address = encodeWikilinkIdentity('secret')
    const inner = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'source',
          title: 'Source',
          filePath: 'source.md',
          content: `[[Secret]]\n[[${address}|Stable Secret]]`,
        },
        {
          id: 'secret',
          title: 'Secret',
          class: 'agent-memory',
          filePath: 'secret.md',
          content: 'private memory',
        },
      ],
    })
    const store = new CachedStore({ inner, pollIntervalMs: 0, relationType: 'links_to' })

    try {
      await store.start()
      const projection = sourceProjection(await store.graph(), 'source')

      expect(projection).toHaveLength(2)
      expect(projection).toEqual(
        expect.arrayContaining([
          { ghost: true, target: 'secret', creatable: true },
          { ghost: true, target: address, creatable: false },
        ]),
      )
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('resolves live visible wikilinks without leaking hidden namesakes after boot degrades', async () => {
    const inner = new InMemoryStore({
      space: 'main',
      notes: [
        {
          id: 'hidden-namesake',
          title: 'Target',
          class: 'agent-memory',
          filePath: 'a-hidden.md',
          content: 'private namesake',
        },
        {
          id: 'target',
          title: 'Target',
          filePath: 'z-target.md',
          content: 'visible target',
        },
        {
          id: 'secret-memory',
          title: 'Secret',
          class: 'agent-memory',
          filePath: 'secret.md',
          content: 'private secret',
        },
      ],
    })

    inner.changes = async () => {
      throw new Error('injected boot failure')
    }
    const store = new CachedStore({ inner, pollIntervalMs: 0, relationType: 'links_to' })

    try {
      await store.start()

      expect((await store.syncStatus()).scan.phase).toBe('error')
      await expect(store.resolveWikilink('Target')).resolves.toMatchObject({
        id: 'target',
        content: 'visible target',
      })
      await expect(store.resolveWikilink(encodeWikilinkIdentity('target'))).resolves.toMatchObject({
        id: 'target',
        content: 'visible target',
      })
      await expect(store.resolveWikilink('Secret')).rejects.toMatchObject({ isNotFound: true })
      await expect(
        store.resolveWikilink(encodeWikilinkIdentity('secret-memory')),
      ).rejects.toMatchObject({ isNotFound: true })
      await expect(store.read('secret-memory')).resolves.toMatchObject({
        content: 'private secret',
      })
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('does not let a stale snapshot path read through to a namesake', async () => {
    const { inner, store } = await setup()

    try {
      const victim = await store.write({ id: 'victim-id', title: 'Victim', content: 'victim' })
      const decoy = await store.write({
        id: 'decoy-id',
        title: 'Victim',
        fileName: 'decoy',
        content: 'decoy bytes',
      })

      await inner.remove(encodeWikilinkIdentity(victim.id!))

      await expect(store.read(victim.id!)).rejects.toMatchObject({ isNotFound: true })
      expect((await inner.read(encodeWikilinkIdentity(decoy.id!))).content).toBe('decoy bytes')
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('keeps preview peeks exact after an external delete and id/path collision', async () => {
    const { inner, store } = await setup()

    try {
      const victim = await store.write({
        id: 'decoy.md',
        title: 'Preview Victim',
        fileName: 'target',
        content: 'TARGET',
      })
      await store.write({
        id: 'other-id',
        title: 'Preview Decoy',
        fileName: 'decoy',
        content: 'DECOY',
      })

      await store.checkpoint()
      await inner.remove(encodeWikilinkIdentity(victim.id!))
      await store.checkpoint()

      expect(store.previewPeek(victim.id!)).toBeNull()
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('keeps stale write and move operations exact after their id is deleted', async () => {
    const { store } = await setup()

    try {
      const victim = await store.write({ id: 'victim-id', title: 'Victim', content: 'same bytes' })
      const decoy = await store.write({
        id: 'decoy-id',
        title: 'victim-id',
        content: 'same bytes',
      })
      const stale = await store.read(victim.id!)

      await store.remove(victim.id!)

      expect(store.previewPeek(victim.id!)).toBeNull()

      await expect(
        store.write({
          originalId: victim.id,
          title: 'Victim',
          content: 'stale save bytes',
          versionToken: stale.versionToken,
        }),
      ).rejects.toMatchObject({ isNotFound: true })
      await expect(store.move({ id: victim.id!, destinationPath: 'moved.md' })).rejects.toBeTruthy()
      expect(await store.read(decoy.id!)).toMatchObject({
        id: decoy.id,
        filePath: decoy.filePath,
        content: 'same bytes',
      })
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('re-derives human and stable link intents after an API delete', async () => {
    const { inner, store } = await setup()

    try {
      const target = await store.write({ title: 'Replaceable Target', content: 'target' })
      const address = encodeWikilinkIdentity(target.id!)
      const human = await store.write({
        title: 'Human Source',
        content: '[[Replaceable Target]]',
      })
      const mixed = await store.write({
        title: 'Mixed Source',
        content: `[[Replaceable Target]]\n[[${address}|Replaceable Target]]`,
      })

      await store.remove(target.id!)

      const cached = await store.graph()
      const fresh = await inner.graph()

      expect(sourceProjection(cached, human.id!)).toEqual(sourceProjection(fresh, human.id!))
      expect(sourceProjection(cached, mixed.id!)).toEqual(sourceProjection(fresh, mixed.id!))
      expect(sourceProjection(cached, human.id!)).toEqual([
        { ghost: true, target: 'replaceable-target', creatable: true },
      ])
      expect(sourceProjection(cached, mixed.id!)).toEqual([
        { ghost: true, target: address, creatable: false },
        { ghost: true, target: 'replaceable-target', creatable: true },
      ])
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('keeps a re-derived source id exact when another raw id is shaped like its envelope', async () => {
    const { store } = await setup()

    try {
      const target = await store.write({ id: 'target', title: 'Target', content: 'target' })
      await store.write({
        id: 'foo',
        title: 'Exact Source',
        content: `[[${encodeWikilinkIdentity(target.id!)}|Target]]`,
      })
      await store.write({
        id: 'notarium-id:foo',
        title: 'Envelope ID Decoy',
        content: '[[Wrong Missing]]',
      })

      await store.remove(target.id!)

      expect(sourceProjection(await store.graph(), 'foo')).toEqual([
        {
          ghost: true,
          target: encodeWikilinkIdentity(target.id!),
          creatable: false,
        },
      ])
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('does not let a stale ghost stub capture a later stable edge to a colliding real id', async () => {
    const { store } = await setup()

    try {
      const opaque = await store.write({ id: 'ghost:missing', title: 'Opaque', content: 'real' })
      const source = await store.write({ title: 'Collision Source', content: '[[missing]]' })

      expect(sourceProjection(await store.graph(), source.id!)).toEqual([
        { ghost: true, target: 'missing', creatable: true },
      ])

      const before = await store.read(source.id!)
      await store.write({
        originalId: source.id,
        title: 'Collision Source',
        content: `[[${encodeWikilinkIdentity(opaque.id!)}|Opaque]]`,
        versionToken: before.versionToken,
      })

      expect(sourceProjection(await store.graph(), source.id!)).toEqual([
        { ghost: false, target: opaque.id },
      ])
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('keeps a selected id exact when another raw id is shaped like its envelope', async () => {
    const { store } = await setup()

    try {
      await store.write({
        id: 'foo',
        title: 'Human Target',
        directory: 'folder',
        content: 'target',
      })
      const opaque = await store.write({
        id: 'notarium-id:foo',
        title: 'Envelope ID Decoy',
        content: 'decoy',
      })
      await expect(store.read('foo')).resolves.toMatchObject({ title: 'Human Target' })
      await expect(store.read('notarium-id:foo')).resolves.toMatchObject({ id: opaque.id })
      for (const ref of ['foo', 'Human Target', 'folder/Human Target', 'notarium-id:foo']) {
        await expect(store.resolveWikilink(ref)).resolves.toMatchObject({
          id: 'foo',
          title: 'Human Target',
        })
      }
      await expect(
        store.resolveWikilink(encodeWikilinkIdentity('notarium-id:foo')),
      ).resolves.toMatchObject({ id: opaque.id, title: 'Envelope ID Decoy' })
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('re-derives stable intent after an external delete lands through delta', async () => {
    const { inner, store } = await setup()

    try {
      const target = await store.write({ title: 'Externally Removed', content: 'target' })
      const address = encodeWikilinkIdentity(target.id!)
      const source = await store.write({
        title: 'External Delete Source',
        content: `[[${address}|Externally Removed]]`,
      })

      await store.checkpoint()
      await inner.remove(target.id!)
      await store.checkpoint()

      expect(sourceProjection(await store.graph(), source.id!)).toEqual(
        sourceProjection(await inner.graph(), source.id!),
      )
      expect(sourceProjection(await store.graph(), source.id!)).toEqual([
        { ghost: true, target: address, creatable: false },
      ])
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('holds the inbound source claim through post-delete edge derivation', async () => {
    const { inner, store } = await setup()

    try {
      const target = await store.write({ title: 'Claimed Target', content: 'target' })
      const source = await store.write({ title: 'Claimed Source', content: '[[Claimed Target]]' })
      const before = await store.read(source.id!)
      const originalRead = inner.read.bind(inner)
      let announceRead!: () => void
      let releaseRead!: () => void
      const readStarted = new Promise<void>((resolve) => {
        announceRead = resolve
      })
      const readRelease = new Promise<void>((resolve) => {
        releaseRead = resolve
      })
      let intercepted = false

      inner.read = async (id) => {
        const captured = await originalRead(id)

        if (!intercepted && id === encodeWikilinkIdentity(source.id!)) {
          intercepted = true
          announceRead()
          await readRelease
        }

        return captured
      }

      const deleting = store.remove(target.id!)

      await readStarted
      const saving = store.write({
        originalId: source.id,
        title: 'Claimed Source',
        content: 'fresh body without a link',
        versionToken: before.versionToken,
      })

      // The source write is queued behind delete's source claim; without that claim
      // it lands now and the delayed old read overwrites its edge patch on release.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect((await originalRead(source.id!)).content).toContain('Claimed Target')

      releaseRead()
      await deleting
      await saving

      expect((await store.graph()).links.some((edge) => edge.source === source.id)).toBe(false)
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('publishes target removal and async inbound re-derivation as one graph state', async () => {
    const { inner, store } = await setup()

    try {
      const target = await store.write({
        id: 'opaque-target-id',
        title: 'Human Target',
        content: 'target',
      })
      const source = await store.write({ title: 'Atomic Source', content: '[[Human Target]]' })
      const read = inner.read.bind(inner)
      let announceRead!: () => void
      let releaseRead!: () => void
      const readStarted = new Promise<void>((resolve) => {
        announceRead = resolve
      })
      const readRelease = new Promise<void>((resolve) => {
        releaseRead = resolve
      })

      inner.read = async (id) => {
        const detail = await read(id)

        if (id === encodeWikilinkIdentity(source.id!)) {
          announceRead()
          await readRelease
        }

        return detail
      }

      const deleting = store.remove(target.id!)

      await readStarted
      let graphSettled = false
      const during = store.graph().then((graph) => {
        graphSettled = true
        return graph
      })

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(graphSettled).toBe(false)

      releaseRead()
      await deleting
      expect(sourceProjection(await during, source.id!)).toEqual([
        { ghost: true, target: 'human-target', creatable: true },
      ])
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('does not let a scoped fallback baseline erase an unrelated concurrent write', async () => {
    const { inner, store } = await setup()

    try {
      const target = await store.write({ title: 'Fallback Victim', content: 'target' })
      const source = await store.write({ title: 'Failing Source', content: '[[Fallback Victim]]' })
      const unrelated = await store.write({ title: 'Concurrent Source', content: 'before' })
      const before = await store.read(unrelated.id!)
      const originalRead = inner.read.bind(inner)
      const originalGraph = inner.graph.bind(inner)
      let graphCaptured!: () => void
      let releaseGraph!: () => void
      const captured = new Promise<void>((resolve) => {
        graphCaptured = resolve
      })
      const graphRelease = new Promise<void>((resolve) => {
        releaseGraph = resolve
      })
      let blockGraph = true

      inner.read = async (id) => {
        if (id === encodeWikilinkIdentity(source.id!)) {
          throw new Error('injected source read failure')
        }

        return originalRead(id)
      }
      inner.graph = async () => {
        const graph = await originalGraph()

        if (blockGraph) {
          blockGraph = false
          graphCaptured()
          await graphRelease
        }

        return graph
      }

      const deleting = store.remove(target.id!)

      await captured
      await store.write({
        originalId: unrelated.id,
        title: 'Concurrent Source',
        content: '[[Unrelated Missing]]',
        versionToken: before.versionToken,
      })
      releaseGraph()
      await deleting

      expect(sourceProjection(await store.graph(), unrelated.id!)).toEqual(
        sourceProjection(await originalGraph(), unrelated.id!),
      )
      expect(sourceProjection(await store.graph(), unrelated.id!)).toEqual([
        { ghost: true, target: 'unrelated-missing', creatable: true },
      ])
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('does not admit a new inbound link after the removal source set is sampled', async () => {
    const { inner, store } = await setup()

    try {
      const target = await store.write({ title: 'Phantom Target', content: 'target' })
      const source = await store.write({ title: 'Phantom Source', content: 'no link yet' })
      const before = await store.read(source.id!)
      const originalRead = inner.read.bind(inner)
      let announceRead!: () => void
      let releaseRead!: () => void
      const readStarted = new Promise<void>((resolve) => {
        announceRead = resolve
      })
      const readRelease = new Promise<void>((resolve) => {
        releaseRead = resolve
      })
      let intercepted = false

      inner.read = async (id) => {
        const captured = await originalRead(id)

        if (
          !intercepted &&
          (id === target.id || id === target.filePath || id === encodeWikilinkIdentity(target.id!))
        ) {
          intercepted = true
          announceRead()
          await readRelease
        }

        return captured
      }

      const deleting = store.remove(target.id!)

      await readStarted
      const address = encodeWikilinkIdentity(target.id!)
      const saving = store.write({
        originalId: source.id,
        title: 'Phantom Source',
        content: `[[${address}|Phantom Target]]`,
        versionToken: before.versionToken,
      })

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect((await originalRead(source.id!)).content).toBe('no link yet')

      releaseRead()
      await deleting
      await saving

      expect(sourceProjection(await store.graph(), source.id!)).toEqual(
        sourceProjection(await inner.graph(), source.id!),
      )
      expect(sourceProjection(await store.graph(), source.id!)).toEqual([
        { ghost: true, target: address, creatable: false },
      ])
    } finally {
      store.stop()
      await store.settle()
    }
  })

  it('keeps independent source writes to the same target parallel', async () => {
    const { inner, store } = await setup()

    try {
      const target = await store.write({ title: 'Popular Target', content: 'target' })
      const first = await store.write({ title: 'First Source', content: 'first' })
      const second = await store.write({ title: 'Second Source', content: 'second' })
      const firstBefore = await store.read(first.id!)
      const secondBefore = await store.read(second.id!)
      const originalWrite = inner.write.bind(inner)
      let announceWrite!: () => void
      let releaseWrite!: () => void
      const writeStarted = new Promise<void>((resolve) => {
        announceWrite = resolve
      })
      const writeRelease = new Promise<void>((resolve) => {
        releaseWrite = resolve
      })
      let intercepted = false

      inner.write = async (input) => {
        if (!intercepted && input.originalId === encodeWikilinkIdentity(first.id!)) {
          intercepted = true
          announceWrite()
          await writeRelease
        }

        return originalWrite(input)
      }

      const address = encodeWikilinkIdentity(target.id!)
      const firstSave = store.write({
        originalId: first.id,
        title: 'First Source',
        content: `[[${address}|Popular Target]]`,
        versionToken: firstBefore.versionToken,
      })

      await writeStarted
      const secondSave = store.write({
        originalId: second.id,
        title: 'Second Source',
        content: `[[${address}|Popular Target]]`,
        versionToken: secondBefore.versionToken,
      })

      await secondSave
      expect((await inner.read(encodeWikilinkIdentity(second.id!))).content).toContain(address)

      releaseWrite()
      await firstSave
    } finally {
      store.stop()
      await store.settle()
    }
  })
})
