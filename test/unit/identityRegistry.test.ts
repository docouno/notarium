// The identity registry (P7, #51): filePath ↔ note-id with write-behind
// persistence. What these tests pin is the identity ALGEBRA the read-model
// builds on: ids are minted once and stay stable; a file's frontmatter claim
// wins over an auto-id (except against a live owner — a copied file); a
// tombstoned id resurrects on a new path (external move); createdAt is never
// invented — null stays null until someone genuinely knows the date.

import { describe, expect, it } from 'vitest'
import { type IdentityPersistence, type IdentityRecord, IdentityRegistry } from '@notarium/core'

const NOW = '2026-06-11T12:00:00.000Z'
const makeRegistry = (persistence?: IdentityPersistence) =>
  new IdentityRegistry({ persistence, now: () => new Date(NOW) })

const deferred = () => {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/** In-memory persistence double: records every upsert batch for inspection.
 *  Space-filters loadAll like the real drivers (#16). */
const fakePersistence = (seed: IdentityRecord[] = []) => {
  const upserted: IdentityRecord[] = []
  const loadedFor: string[] = []
  const persistence: IdentityPersistence = {
    init: async () => {},
    loadAll: async (space) => {
      loadedFor.push(space)
      return seed.filter((r) => r.space === space)
    },
    upsertMany: async (records) => {
      upserted.push(...records.map((r) => ({ ...r })))
    },
    close: async () => {},
  }
  return { persistence, upserted, loadedFor }
}

describe('IdentityRegistry — ensure', () => {
  it('mints a 12-char id on first sight and returns the same record afterwards', () => {
    const reg = makeRegistry()
    const rec = reg.ensure('demo/a.md')
    expect(rec.id).toMatch(/^[A-Za-z0-9_-]{12}$/)
    expect(reg.ensure('demo/a.md')).toBe(rec)
    expect(reg.idFor('demo/a.md')).toBe(rec.id)
    expect(reg.pathFor(rec.id)).toBe('demo/a.md')
  })

  it('does NOT invent createdAt: absent stays null, never "now"', () => {
    const reg = makeRegistry()
    const rec = reg.ensure('demo/a.md')
    expect(rec.createdAt).toBeNull()
    // a later ensure without a date changes nothing
    expect(reg.ensure('demo/a.md').createdAt).toBeNull()
  })

  it('a later ensure WITH a date fills a null createdAt (and only a null one)', () => {
    const reg = makeRegistry()
    reg.ensure('demo/a.md')
    expect(reg.ensure('demo/a.md', '2026-01-01T00:00:00Z').createdAt).toBe('2026-01-01T00:00:00Z')
    // first-seen wins: a different date later does not overwrite it
    expect(reg.ensure('demo/a.md', '2026-02-02T00:00:00Z').createdAt).toBe('2026-01-01T00:00:00Z')
  })
})

describe('IdentityRegistry — setCreatedAt (#186 authored date edit)', () => {
  it('OVERWRITES a pinned date (unlike ensure), and ensure no longer reverts it', () => {
    const reg = makeRegistry()
    reg.ensure('demo/a.md', '2026-01-01T00:00:00Z')
    const id = reg.idFor('demo/a.md')!
    reg.setCreatedAt(id, '2019-03-14T00:00:00.000Z')
    expect(reg.recordFor(id)?.createdAt).toBe('2019-03-14T00:00:00.000Z')
    // ensure() fills only a NULL date — it must NOT revert an authored reset back
    // to the first-seen value (this is what keeps the edit alive across a rescan).
    expect(reg.ensure('demo/a.md', '2099-09-09T00:00:00Z').createdAt).toBe(
      '2019-03-14T00:00:00.000Z',
    )
    // An unknown id is a no-op: an identity-capable inner engine owns its own dates.
    expect(() => reg.setCreatedAt('no-such-id', '2020-01-01T00:00:00Z')).not.toThrow()
  })

  it('persists the reset so it survives a restart; a same-value set is a no-op', async () => {
    const { persistence, upserted } = fakePersistence()
    const reg = makeRegistry(persistence)
    reg.ensure('demo/a.md', '2026-01-01T00:00:00Z')
    const id = reg.idFor('demo/a.md')!
    reg.setCreatedAt(id, '2019-03-14T00:00:00.000Z')
    await reg.flush()
    // The write-behind flush carries the reset date — a restart's load() reads it,
    // so the Feed date survives (the bare engine reads createdAt off the registry).
    expect(upserted.find((r) => r.id === id)?.createdAt).toBe('2019-03-14T00:00:00.000Z')
    // Setting the same value again dirties nothing — no redundant flush.
    upserted.length = 0
    reg.setCreatedAt(id, '2019-03-14T00:00:00.000Z')
    await reg.flush()
    expect(upserted).toEqual([])
  })
})

describe('IdentityRegistry — adoptFileId', () => {
  it('noop when the file claims the id the path already has (marks it materialized)', () => {
    const reg = makeRegistry()
    const rec = reg.ensure('demo/a.md')
    expect(rec.materialized).toBe(false)
    expect(reg.adoptFileId('demo/a.md', rec.id)).toEqual({ kind: 'noop' })
    expect(reg.recordFor(rec.id)?.materialized).toBe(true)
  })

  it('a frontmatter claim beats the path’s auto-id', () => {
    const reg = makeRegistry()
    const auto = reg.ensure('demo/a.md', '2026-01-01T00:00:00Z')
    const res = reg.adoptFileId('demo/a.md', 'file-claim-id')
    expect(res).toEqual({ kind: 'adopted', previousId: auto.id })
    expect(reg.idFor('demo/a.md')).toBe('file-claim-id')
    expect(reg.pathFor(auto.id)).toBeUndefined() // the superseded auto-id is gone
    // the path's first-seen date follows the note, not the id
    expect(reg.recordFor('file-claim-id')?.createdAt).toBe('2026-01-01T00:00:00Z')
    expect(reg.recordFor('file-claim-id')?.materialized).toBe(true)
  })

  it('a claim already owned by another LIVE path is a duplicate — the copy keeps its own id', () => {
    const reg = makeRegistry()
    reg.ensure('demo/original.md')
    reg.adoptFileId('demo/original.md', 'shared-id')
    const copyAuto = reg.ensure('demo/copy.md')
    expect(reg.adoptFileId('demo/copy.md', 'shared-id')).toEqual({
      kind: 'duplicate',
      ownerPath: 'demo/original.md',
    })
    expect(reg.idFor('demo/copy.md')).toBe(copyAuto.id)
    expect(reg.pathFor('shared-id')).toBe('demo/original.md')
  })

  it('a tombstoned id resurrects on a new path — the external-move channel', () => {
    const reg = makeRegistry()
    reg.ensure('old/place.md', '2026-01-01T00:00:00Z')
    reg.adoptFileId('old/place.md', 'durable-id')
    expect(reg.markDeleted('old/place.md')).toBe('durable-id')
    expect(reg.pathFor('durable-id')).toBeUndefined()

    const res = reg.adoptFileId('new/place.md', 'durable-id')
    expect(res.kind).toBe('adopted')
    expect(reg.pathFor('durable-id')).toBe('new/place.md')
    // the resurrected record keeps the tombstone's first-seen date
    expect(reg.recordFor('durable-id')?.createdAt).toBe('2026-01-01T00:00:00Z')
    expect(reg.recordFor('durable-id')?.deletedAt).toBeNull()
  })
})

describe('IdentityRegistry — rename / renamePrefix / markDeleted', () => {
  it('rename moves the path binding; the id never changes', () => {
    const reg = makeRegistry()
    const rec = reg.ensure('demo/a.md')
    reg.rename('demo/a.md', 'archive/a.md')
    expect(reg.idFor('archive/a.md')).toBe(rec.id)
    expect(reg.idFor('demo/a.md')).toBeUndefined()
    expect(reg.pathFor(rec.id)).toBe('archive/a.md')
  })

  it('rename onto an occupied path tombstones the displaced occupant', () => {
    const reg = makeRegistry()
    const mover = reg.ensure('demo/a.md')
    const occupant = reg.ensure('demo/b.md')
    reg.rename('demo/a.md', 'demo/b.md')
    expect(reg.idFor('demo/b.md')).toBe(mover.id)
    expect(reg.pathFor(occupant.id)).toBeUndefined()
    expect(reg.recordFor(occupant.id)?.deletedAt).toBe(NOW)
  })

  it('renamePrefix carries every binding under the folder; outsiders stay put', () => {
    const reg = makeRegistry()
    const inA = reg.ensure('demo/a.md')
    const inDeep = reg.ensure('demo/sub/b.md')
    const outside = reg.ensure('demos/c.md') // prefix-LOOKALIKE, not under demo/
    reg.renamePrefix('demo', 'archive/demo')
    expect(reg.pathFor(inA.id)).toBe('archive/demo/a.md')
    expect(reg.pathFor(inDeep.id)).toBe('archive/demo/sub/b.md')
    expect(reg.pathFor(outside.id)).toBe('demos/c.md')
  })

  it('markDeleted tombstones: pathFor goes undefined, recordFor still answers', () => {
    const reg = makeRegistry()
    const rec = reg.ensure('demo/a.md')
    reg.markDeleted('demo/a.md')
    expect(reg.pathFor(rec.id)).toBeUndefined()
    expect(reg.idFor('demo/a.md')).toBeUndefined()
    expect(reg.recordFor(rec.id)?.deletedAt).toBe(NOW)
  })

  it('reconciles stale live bindings against an authoritative inventory', () => {
    const reg = makeRegistry()
    const kept = reg.ensure('demo/kept.md')
    const gone = reg.ensure('demo/gone.md')

    reg.reconcileLivePaths(['demo/kept.md'])

    expect(reg.pathFor(kept.id)).toBe('demo/kept.md')
    expect(reg.pathFor(gone.id)).toBeUndefined()
    expect(reg.recordFor(gone.id)?.deletedAt).toBe(NOW)
  })
})

describe('IdentityRegistry — persistence', () => {
  it('load() restores live bindings and keeps tombstones reachable by id only', async () => {
    const { persistence } = fakePersistence([
      {
        id: 'live-id-00001',
        filePath: 'demo/a.md',
        space: 'main',
        createdAt: null,
        materialized: true,
        deletedAt: null,
      },
      {
        id: 'dead-id-00001',
        filePath: 'demo/gone.md',
        space: 'main',
        createdAt: null,
        materialized: true,
        deletedAt: '2026-06-01T00:00:00Z',
      },
    ])
    const reg = makeRegistry(persistence)
    await reg.load()
    expect(reg.idFor('demo/a.md')).toBe('live-id-00001')
    expect(reg.pathFor('dead-id-00001')).toBeUndefined()
    expect(reg.recordFor('dead-id-00001')?.deletedAt).toBe('2026-06-01T00:00:00Z')
  })

  it('flush() delivers dirty records — including the tombstone of an auto-id superseded by adoption', async () => {
    const { persistence, upserted } = fakePersistence()
    const reg = makeRegistry(persistence)
    const auto = reg.ensure('demo/a.md')
    reg.adoptFileId('demo/a.md', 'file-claim-id')
    await reg.flush()

    const byId = new Map(upserted.map((r) => [r.id, r]))
    expect(byId.get('file-claim-id')).toMatchObject({
      filePath: 'demo/a.md',
      materialized: true,
      deletedAt: null,
    })
    // The superseded auto-id is no longer reachable via the registry, but its
    // tombstone still rides the flush — persistence must not resurrect it.
    expect(byId.get(auto.id)).toMatchObject({ deletedAt: NOW })

    // flush is drain-once: nothing left dirty afterwards
    upserted.length = 0
    await reg.flush()
    expect(upserted).toEqual([])
  })

  it('serializes overlapping flushes so an older batch cannot overwrite a newer path', async () => {
    const firstEntered = deferred()
    const releaseFirst = deferred()
    const persisted = new Map<string, IdentityRecord>()
    const batches: IdentityRecord[][] = []
    const persistence: IdentityPersistence = {
      init: async () => {},
      loadAll: async () => [],
      upsertMany: async (records) => {
        const batch = records.map((record) => ({ ...record }))
        batches.push(batch)
        if (batches.length === 1) {
          firstEntered.resolve()
          await releaseFirst.promise
        }
        for (const record of batch) {
          persisted.set(record.id, record)
        }
      },
      close: async () => {},
    }
    const reg = makeRegistry(persistence)
    const rec = reg.ensure('demo/a.md')
    const older = reg.flush()

    await firstEntered.promise
    reg.rename('demo/a.md', 'archive/a.md')
    const newer = reg.flush()
    releaseFirst.resolve()
    await Promise.all([older, newer])

    expect(batches.map((batch) => batch.map((record) => record.filePath))).toEqual([
      ['demo/a.md'],
      ['archive/a.md'],
    ])
    expect(persisted.get(rec.id)?.filePath).toBe('archive/a.md')
  })

  it('keeps an explicit flush joined through dirt added in the tail-settle window', async () => {
    const firstEntered = deferred()
    const lateStarted = deferred()
    const attempted: IdentityRecord[][] = []
    let releaseFirst!: () => void
    let lateFlush!: Promise<void>
    const persistence: IdentityPersistence = {
      init: async () => {},
      loadAll: async () => [],
      upsertMany: (records) => {
        attempted.push(records.map((record) => ({ ...record })))
        if (attempted.length > 1) {
          return Promise.resolve()
        }

        return new Promise<void>((resolve) => {
          releaseFirst = () => {
            // Resolving queues flushDirty's continuation first. This microtask
            // then lands after it observed an empty set, but before the tracked
            // tail's finally handler runs.
            resolve()
            queueMicrotask(() => {
              reg.rename('demo/a.md', 'archive/a.md')
              lateFlush = reg.flush()
              lateStarted.resolve()
            })
          }
          firstEntered.resolve()
        })
      },
      close: async () => {},
    }

    const reg = makeRegistry(persistence)
    reg.ensure('demo/a.md')
    const active = reg.flush()

    await firstEntered.promise
    releaseFirst()
    await lateStarted.promise
    await Promise.all([active, lateFlush])

    expect(attempted.map((batch) => batch.map((record) => record.filePath))).toEqual([
      ['demo/a.md'],
      ['archive/a.md'],
    ])
  })

  it('re-dirties a failed batch and retries the newest state without losing an in-flight change', async () => {
    const firstEntered = deferred()
    const failFirst = deferred()
    const persisted = new Map<string, IdentityRecord>()
    const attempted: IdentityRecord[][] = []
    const persistence: IdentityPersistence = {
      init: async () => {},
      loadAll: async () => [],
      upsertMany: async (records) => {
        const batch = records.map((record) => ({ ...record }))
        attempted.push(batch)
        if (attempted.length === 1) {
          firstEntered.resolve()
          await failFirst.promise
        }
        for (const record of batch) {
          persisted.set(record.id, record)
        }
      },
      close: async () => {},
    }
    const reg = makeRegistry(persistence)
    const rec = reg.ensure('demo/a.md')
    const failed = reg.flush()

    await firstEntered.promise
    reg.rename('demo/a.md', 'archive/a.md')
    failFirst.reject(new Error('persistence unavailable'))
    await expect(failed).rejects.toThrow('persistence unavailable')
    await reg.flush()

    expect(attempted.map((batch) => batch.map((record) => record.filePath))).toEqual([
      ['demo/a.md'],
      ['archive/a.md'],
    ])
    expect(persisted.get(rec.id)?.filePath).toBe('archive/a.md')
  })

  it('makes a concurrent settle-style flush join the active persistence write', async () => {
    const entered = deferred()
    const release = deferred()
    let writes = 0
    const persistence: IdentityPersistence = {
      init: async () => {},
      loadAll: async () => [],
      upsertMany: async () => {
        writes++
        entered.resolve()
        await release.promise
      },
      close: async () => {},
    }
    const reg = makeRegistry(persistence)

    reg.ensure('demo/a.md')
    const active = reg.flush()
    await entered.promise
    let joined = false
    const settle = reg.flush().then(() => {
      joined = true
    })

    await Promise.resolve()
    expect(joined).toBe(false)
    release.resolve()
    await Promise.all([active, settle])
    expect(joined).toBe(true)
    expect(writes).toBe(1)
  })
})

describe('IdentityRegistry — space (#16 groundwork)', () => {
  it('stamps its space on every record it mints or adopts', () => {
    const reg = new IdentityRegistry({ space: 'work', now: () => new Date(NOW) })
    expect(reg.ensure('demo/a.md').space).toBe('work')
    reg.adoptFileId('demo/b.md', 'file-claim-id')
    expect(reg.recordFor('file-claim-id')?.space).toBe('work')
  })

  it("defaults to 'main' when the host wires no space", () => {
    expect(makeRegistry().ensure('demo/a.md').space).toBe('main')
  })

  it("load() ingests strictly its own space — a sibling space's identical path never cross-wires (#16)", async () => {
    const { persistence, loadedFor } = fakePersistence([
      // The same file_path exists in BOTH spaces — normal once spaces are real.
      {
        id: 'work-id-00001',
        filePath: 'demo/a.md',
        space: 'work',
        createdAt: null,
        materialized: true,
        deletedAt: null,
      },
      {
        id: 'play-id-00001',
        filePath: 'demo/a.md',
        space: 'play',
        createdAt: null,
        materialized: true,
        deletedAt: null,
      },
    ])
    const reg = new IdentityRegistry({ persistence, space: 'work', now: () => new Date(NOW) })
    await reg.load()
    expect(loadedFor).toEqual(['work']) // the filter is the persistence's contract
    expect(reg.idFor('demo/a.md')).toBe('work-id-00001')
    expect(reg.recordFor('play-id-00001')).toBeUndefined()
  })

  // Pre-space rows ('') are adopted by the DEFAULT space at host boot
  // (MetaDb.adoptLegacyRows) before any registry loads — covered by the
  // meta-DB driver tests; the registry itself never sees '' rows anymore.
})
