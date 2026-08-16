// The identity registry (P7, #51): filePath ↔ note-id with write-behind
// persistence. What these tests pin is the identity ALGEBRA the read-model
// builds on: ids are minted once and stay stable; a file's frontmatter claim
// wins over an auto-id (except against a live owner — a copied file); a
// tombstoned id resurrects on a new path (external move); createdAt is never
// invented — null stays null until someone genuinely knows the date.

import { describe, expect, it } from 'vitest'
import { type IdentityPersistence, type IdentityRecord, IdentityRegistry } from '@notarium/core'

import { InMemoryIdentity } from '../fake-server/identity'

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

/** In-memory persistence double: the shared twin, plus the claim log the
 *  write-behind assertions read. Space-filters loadAll like the real drivers (#16). */
const fakePersistence = (seed: IdentityRecord[] = []) => {
  const persistence = new InMemoryIdentity(seed)
  return { persistence, upserted: persistence.claimed, loadedFor: persistence.loadedFor }
}

/** A minimal hand-rolled double for the write-behind ORDERING tests: they need to
 *  hold one batch open, which the shared twin deliberately cannot do. */
const claimLane = (
  claim: (records: readonly IdentityRecord[]) => Promise<void>,
): IdentityPersistence => ({
  init: async () => {},
  loadAll: async () => [],
  claimMany: async (records) => {
    await claim(records)
    return records.map((record) => ({
      id: record.id,
      status: 'claimed' as const,
      legacyNameAliases: record.legacyNameAliases,
    }))
  },
  mergeLegacyNameAlias: async () => ({ status: 'not-owned' }),
  settleFileClaim: async () => {
    throw new Error('these tests never settle a file claim')
  },
  close: async () => {},
})

describe('IdentityRegistry — a minted id another space already owns', () => {
  // 72 bits make this astronomically unlikely, which is exactly why it needs a
  // test: the branch is otherwise never executed by anything, and what it prevents
  // — a note quietly keeping an id whose durable owner is elsewhere — is the whole
  // point of the arbiter.
  it('re-mints an id the flush finds foreign and tells the read-model to re-key it', async () => {
    const batches: IdentityRecord[][] = []
    const remints: Array<[string, string]> = []
    const persistence: IdentityPersistence = {
      init: async () => {},
      loadAll: async () => [],
      claimMany: async (records) => {
        batches.push(records.map((r) => ({ ...r })))

        return records.map((r) =>
          batches.length === 1
            ? { id: r.id, status: 'foreign-owner' as const, owner: { ...r, space: 'other' } }
            : {
                id: r.id,
                status: 'claimed' as const,
                legacyNameAliases: r.legacyNameAliases,
              },
        )
      },
      mergeLegacyNameAlias: async () => ({ status: 'not-owned' }),
      settleFileClaim: async () => {
        throw new Error('this test never settles a file claim')
      },
      close: async () => {},
    }
    const reg = new IdentityRegistry({
      persistence,
      now: () => new Date(NOW),
      onRemint: (previousId, nextId) => remints.push([previousId, nextId]),
    })
    const minted = reg.ensure('demo/a.md').id

    await reg.flush()

    const next = reg.idFor('demo/a.md')!

    expect(next).not.toBe(minted)
    expect(next).toMatch(/^[A-Za-z0-9_-]{12}$/)
    // The read-model is told, so everything filed under the refused spelling moves.
    expect(remints).toEqual([[minted, next]])
    // The refused spelling is not ours and is not kept as one of our records.
    expect(reg.recordFor(minted)).toBeUndefined()
    expect(reg.pathFor(minted)).toBeUndefined()
    // …and the fresh id is still owed to persistence.
    await reg.flush()
    expect(batches.at(-1)!.map((r) => r.id)).toEqual([next])
  })
})

describe('IdentityRegistry — settlement vs unflushed local state', () => {
  // The arbiter answers WHO owns an id, not when the note was born. Its answer is
  // read from a row that predates any edit still sitting here unflushed, so an
  // authored date change (#186) must survive being installed over — otherwise the
  // next read of the file, which settles the very same id, silently rolls it back.
  it('keeps an unflushed authored createdAt when the same id is settled again', async () => {
    const { persistence } = fakePersistence()
    const reg = makeRegistry(persistence)

    await reg.settleFileClaim('demo/a.md', 'file-claim-id')
    await reg.flush()
    expect((await persistence.findById('file-claim-id'))?.createdAt).toBe(NOW)

    const authored = '2019-03-14T00:00:00.000Z'

    reg.setCreatedAt('file-claim-id', authored)
    // A read of the file inside the write-behind window: same path, same claim.
    await reg.settleFileClaim('demo/a.md', 'file-claim-id')

    expect(reg.recordFor('file-claim-id')?.createdAt).toBe(authored)
    // …and it is still owed to persistence, so the flush that follows writes it.
    await reg.flush()
    expect((await persistence.findById('file-claim-id'))?.createdAt).toBe(authored)
  })
})

describe('IdentityRegistry — a local mutation inside the settlement window', () => {
  // The lane serializes ASYNC operations. `rename` and `markDeleted` are
  // synchronous, so they land inside a settlement's await — and what they record
  // postdates the aggregate's answer. Installing the answer over them would roll
  // back a fact the process has already acted on.
  /** The shared twin with ONE seam: the settlement is held open, so a synchronous
   *  local call can be placed inside the transaction window on purpose. */
  const heldSettlement = () => {
    const store = new InMemoryIdentity()
    const open = deferred()
    const release = deferred()
    const persistence: IdentityPersistence = {
      init: () => store.init(),
      loadAll: (space) => store.loadAll(space),
      claimMany: (records) => store.claimMany(records),
      mergeLegacyNameAlias: (input) => store.mergeLegacyNameAlias(input),
      findById: (id) => store.findById(id),
      settleFileClaim: async (claim) => {
        open.resolve()
        await release.promise
        return store.settleFileClaim(claim)
      },
      close: () => store.close(),
    }
    return { persistence, store, open: open.promise, release: release.resolve }
  }

  it('keeps a delete that raced the settlement, tombstone and all', async () => {
    const { persistence, open, release } = heldSettlement()
    const reg = makeRegistry(persistence)
    const settling = reg.settleFileClaim('demo/a.md', 'file-claim-id')

    await open // the aggregate is mid-transaction
    expect(reg.markDeleted('demo/a.md')).toBeDefined()
    release()
    await settling

    // The note is gone: no live path resolves to it…
    expect(reg.idFor('demo/a.md')).toBeUndefined()
    // …and the tombstone is real, not a record the install quietly revived.
    expect(reg.recordFor('file-claim-id')?.deletedAt).toBe(NOW)
  })

  it('keeps a rename that raced the settlement — one live path, not two', async () => {
    const { persistence, open, release } = heldSettlement()
    const reg = makeRegistry(persistence)
    const settling = reg.settleFileClaim('demo/a.md', 'file-claim-id')

    await open
    reg.rename('demo/a.md', 'demo/b.md')
    release()
    await settling

    expect(reg.idFor('demo/b.md')).toBe('file-claim-id')
    // The old path must not still route to the same id: two live bindings on one
    // note is exactly what the read-model cannot represent.
    expect(reg.idFor('demo/a.md')).toBeUndefined()
    expect(reg.recordFor('file-claim-id')?.filePath).toBe('demo/b.md')
  })

  it('holds the lane: a second settlement cannot open while the first is in flight', async () => {
    // What the lane is FOR. Two settlements arbitrate the same table and each
    // installs into the same maps from a snapshot it took before its await — run
    // them concurrently and the second commits over the first's answer.
    const { persistence, open, release } = heldSettlement()
    const entered: string[] = []
    const counting: IdentityPersistence = {
      ...persistence,
      settleFileClaim: (claim) => {
        entered.push(claim.filePath)
        return persistence.settleFileClaim(claim)
      },
    }
    const reg = makeRegistry(counting)
    const first = reg.settleFileClaim('demo/a.md', 'first-claim1')
    const second = reg.settleFileClaim('demo/b.md', 'secondclaim')

    await open
    expect(entered).toEqual(['demo/a.md'])

    release()
    await Promise.all([first, second])
    expect(entered).toEqual(['demo/a.md', 'demo/b.md'])
  })

  it('holds the lane against a FLUSH, so no batch commits across a settlement', async () => {
    // The other half of what the lane is for, and the reachable one: the publication
    // fence calls `identity.flush()` outside any mutation claim, so a batch can be
    // snapshotted while a settlement is mid-transaction. Outside the lane that batch
    // writes the PRE-settlement record after the transaction retired it — the retired
    // id is durable and live again at the same path.
    const { persistence, store, open, release } = heldSettlement()
    const claimed: string[][] = []
    const counting: IdentityPersistence = {
      ...persistence,
      claimMany: (records) => {
        claimed.push(records.map((r) => r.id))
        return persistence.claimMany(records)
      },
    }
    const reg = makeRegistry(counting)
    const auto = reg.ensure('demo/a.md').id
    const settling = reg.settleFileClaim('demo/a.md', 'file-claim-id')

    await open // the aggregate is mid-transaction, deciding that id's fate
    const flushing = reg.flush()
    await new Promise((tick) => setTimeout(tick, 0))

    // Nothing may reach persistence while the settlement owns the lane.
    expect(claimed).toEqual([])

    release()
    await Promise.all([settling, flushing])

    // The superseded id was never written back over the tombstone the settlement
    // transaction wrote for it, and the path carries the settled one.
    expect(claimed.flat()).not.toContain(auto)
    expect(await store.findById(auto)).toMatchObject({ deletedAt: NOW })
    expect((await store.findById('file-claim-id'))?.filePath).toBe('demo/a.md')
    expect(reg.idFor('demo/a.md')).toBe('file-claim-id')
  })

  it('still owes the raced fact to persistence', async () => {
    const { persistence, store, open, release } = heldSettlement()
    const reg = makeRegistry(persistence)
    const settling = reg.settleFileClaim('demo/a.md', 'file-claim-id')

    await open
    reg.rename('demo/a.md', 'demo/b.md')
    release()
    await settling
    // The settlement made the row durable at the OLD path; only a still-dirty
    // record makes the write-behind carry the move across.
    await reg.flush()

    expect((await store.findById('file-claim-id'))?.filePath).toBe('demo/b.md')
  })
})

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

describe('IdentityRegistry — settleFileClaim (no shared persistence)', () => {
  it('noop when the file claims the id the path already has (marks it materialized)', async () => {
    const reg = makeRegistry()
    const rec = reg.ensure('demo/a.md')
    expect(rec.materialized).toBe(false)
    expect(await reg.settleFileClaim('demo/a.md', rec.id)).toEqual({ kind: 'noop' })
    expect(reg.recordFor(rec.id)?.materialized).toBe(true)
  })

  it('a frontmatter claim beats the path’s auto-id', async () => {
    const reg = makeRegistry()
    const auto = reg.ensure('demo/a.md', '2026-01-01T00:00:00Z')
    const res = await reg.settleFileClaim('demo/a.md', 'file-claim-id')
    expect(res).toEqual({ kind: 'adopted' })
    expect(reg.idFor('demo/a.md')).toBe('file-claim-id')
    expect(reg.pathFor(auto.id)).toBeUndefined() // the superseded auto-id is gone
    // the path's first-seen date follows the note, not the id
    expect(reg.recordFor('file-claim-id')?.createdAt).toBe('2026-01-01T00:00:00Z')
    expect(reg.recordFor('file-claim-id')?.materialized).toBe(true)
  })

  it('a claim already owned by another LIVE path is a duplicate — the copy keeps its own id', async () => {
    const reg = makeRegistry()
    reg.ensure('demo/original.md')
    await reg.settleFileClaim('demo/original.md', 'shared-id')
    const copyAuto = reg.ensure('demo/copy.md')
    expect(await reg.settleFileClaim('demo/copy.md', 'shared-id')).toEqual({
      kind: 'duplicate',
      ownerPath: 'demo/original.md',
    })
    expect(reg.idFor('demo/copy.md')).toBe(copyAuto.id)
    expect(reg.pathFor('shared-id')).toBe('demo/original.md')
  })

  it('a tombstoned id resurrects on a new path — the external-move channel', async () => {
    const reg = makeRegistry()
    reg.ensure('old/place.md', '2026-01-01T00:00:00Z')
    await reg.settleFileClaim('old/place.md', 'durable-id')
    expect(reg.markDeleted('old/place.md')).toBe('durable-id')
    expect(reg.pathFor('durable-id')).toBeUndefined()

    const res = await reg.settleFileClaim('new/place.md', 'durable-id')
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
        legacyNameAliases: [],
        filePath: 'demo/a.md',
        space: 'main',
        createdAt: null,
        materialized: true,
        deletedAt: null,
      },
      {
        id: 'dead-id-00001',
        legacyNameAliases: [],
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

  it('persists materialization, so a boot re-adopts the id instead of re-minting', async () => {
    const { persistence, upserted } = fakePersistence()
    const reg = makeRegistry(persistence)
    const auto = reg.ensure('demo/a.md')

    await reg.flush()
    expect(persistence.rows.get(auto.id)).toMatchObject({ materialized: false })

    // The write path has just put this id into the file's frontmatter. Until that
    // fact is DURABLE the next boot reads an unmaterialized row, treats the file's
    // claim as unproven and settles all over again.
    reg.markMaterialized(auto.id)
    expect(reg.recordFor(auto.id)?.materialized).toBe(true)
    await reg.flush()
    expect(persistence.rows.get(auto.id)).toMatchObject({ materialized: true })

    // Idempotent: a second call has nothing to write, so it does not queue a batch.
    const batches = upserted.length
    reg.markMaterialized(auto.id)
    await reg.flush()
    expect(upserted.length).toBe(batches)
  })

  it('settles the claim and its predecessor’s tombstone in ONE durable step', async () => {
    const { persistence, upserted } = fakePersistence()
    const reg = makeRegistry(persistence)
    const auto = reg.ensure('demo/a.md')
    await reg.settleFileClaim('demo/a.md', 'file-claim-id')

    expect(persistence.rows.get('file-claim-id')).toMatchObject({
      filePath: 'demo/a.md',
      materialized: true,
      deletedAt: null,
    })
    // The superseded auto-id is retired by the settlement itself — a later
    // write-behind batch must not resurrect it as a live row.
    expect(persistence.rows.get(auto.id)).toMatchObject({ deletedAt: NOW })

    upserted.length = 0
    await reg.flush()
    expect(upserted).toEqual([])
    expect(persistence.rows.get(auto.id)).toMatchObject({ deletedAt: NOW })
  })

  it('does not answer from a row persistence has never seen', async () => {
    // The fast path skips the aggregate because the record it holds WAS the row the
    // transaction would read. A dirty record is precisely the case where it was not:
    // this one is materialized locally and not yet flushed, so answering `noop` would
    // call an id settled that no arbiter has ever been asked about.
    const { persistence } = fakePersistence()
    const asked: string[] = []
    const settleFileClaim = persistence.settleFileClaim.bind(persistence)

    persistence.settleFileClaim = async (claim) => {
      asked.push(claim.observedId)
      return settleFileClaim(claim)
    }
    const reg = makeRegistry(persistence)

    reg.bindOwnedId('demo/a.md', 'local-claim1')
    expect(await reg.settleFileClaim('demo/a.md', 'local-claim1')).toEqual({ kind: 'noop' })
    expect(asked).toEqual(['local-claim1'])

    // Once it IS durable and clean, the same call costs no transaction.
    await reg.flush()
    asked.length = 0

    expect(await reg.settleFileClaim('demo/a.md', 'local-claim1')).toEqual({ kind: 'noop' })
    expect(asked).toEqual([])
  })

  it('leaves a copied file its own id — and still owes that row to persistence', async () => {
    // `duplicate-path-owner` is a DISTINCT outcome for a reason: nothing moved, so
    // there is no authoritative row to install and the claimant's own freshly minted
    // record is still unwritten. Treating it like `accepted` clears its dirt against
    // a row the transaction never wrote, and the copy is re-minted after a restart.
    const { persistence } = fakePersistence()
    const reg = makeRegistry(persistence)

    await reg.settleFileClaim('demo/original.md', 'shared-claim')
    await reg.flush()

    // The user copies the file: the same frontmatter claim now sits at a second path.
    const copyId = reg.ensure('demo/copy.md').id

    expect(await reg.settleFileClaim('demo/copy.md', 'shared-claim')).toEqual({
      kind: 'duplicate',
      ownerPath: 'demo/original.md',
    })
    expect(reg.idFor('demo/copy.md')).toBe(copyId)
    expect(reg.idFor('demo/original.md')).toBe('shared-claim')

    await reg.flush()

    expect(await persistence.findById(copyId)).toMatchObject({ filePath: 'demo/copy.md' })
    // …and the original is untouched by the refusal.
    expect(await persistence.findById('shared-claim')).toMatchObject({
      filePath: 'demo/original.md',
      deletedAt: null,
    })
  })

  it('serializes overlapping flushes so an older batch cannot overwrite a newer path', async () => {
    const firstEntered = deferred()
    const releaseFirst = deferred()
    const persisted = new Map<string, IdentityRecord>()
    const batches: IdentityRecord[][] = []
    const persistence = claimLane(async (records) => {
      const batch = records.map((record) => ({ ...record }))
      batches.push(batch)
      if (batches.length === 1) {
        firstEntered.resolve()
        await releaseFirst.promise
      }
      for (const record of batch) {
        persisted.set(record.id, record)
      }
    })
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
    const persistence = claimLane((records) => {
      attempted.push(records.map((record) => ({ ...record })))
      if (attempted.length > 1) {
        return Promise.resolve()
      }

      return new Promise<void>((resolve) => {
        releaseFirst = () => {
          // Resolving queues the batch's continuation first. This microtask then
          // lands after it observed an empty set, but before the tracked tail's
          // finally handler runs.
          resolve()
          queueMicrotask(() => {
            reg.rename('demo/a.md', 'archive/a.md')
            lateFlush = reg.flush()
            lateStarted.resolve()
          })
        }
        firstEntered.resolve()
      })
    })

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
    const persistence = claimLane(async (records) => {
      const batch = records.map((record) => ({ ...record }))
      attempted.push(batch)
      if (attempted.length === 1) {
        firstEntered.resolve()
        await failFirst.promise
      }
      for (const record of batch) {
        persisted.set(record.id, record)
      }
    })
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
    const persistence = claimLane(async () => {
      writes++
      entered.resolve()
      await release.promise
    })
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

describe('IdentityRegistry — durable legacy name aliases', () => {
  it('keeps alias-only debt out of the structural write-behind and returns copies', async () => {
    const { persistence, upserted } = fakePersistence()
    const reg = makeRegistry(persistence)
    const id = reg.ensure('demo/a.md').id

    await reg.flush()
    upserted.length = 0

    expect(reg.rememberLegacyNameAlias(id, 'historic-name')).toBe(true)
    expect(reg.rememberLegacyNameAlias(id, 'historic-name')).toBe(false)
    const snapshot = reg.recordFor(id)!
    ;(snapshot.legacyNameAliases as string[]).push('mutated-copy')
    expect(reg.recordFor(id)?.legacyNameAliases).toEqual(['historic-name'])

    await reg.flush()
    expect(upserted).toEqual([])
    expect((await persistence.findById(id))?.legacyNameAliases).toEqual([])

    await reg.persistLegacyNameAlias(id, 'historic-name')
    expect((await persistence.findById(id))?.legacyNameAliases).toEqual(['historic-name'])
    expect(upserted).toEqual([])
  })

  it('honestly keeps aliases process-local when persistence is absent', async () => {
    const reg = makeRegistry()
    const id = reg.ensure('demo/a.md').id

    await expect(reg.persistLegacyNameAlias(id, 'historic-name')).resolves.toMatchObject({
      id,
      legacyNameAliases: ['historic-name'],
    })
  })

  it('establishes a new row before acknowledging its alias without flushing unrelated dirt', async () => {
    const { persistence, upserted } = fakePersistence()
    const reg = makeRegistry(persistence)
    const target = reg.ensure('target.md').id
    const unrelated = reg.ensure('unrelated.md').id

    await reg.persistLegacyNameAlias(target, 'historic-name')

    expect((await persistence.findById(target))?.legacyNameAliases).toEqual(['historic-name'])
    expect(upserted.map((row) => row.id)).toContain(target)
    expect(upserted.map((row) => row.id)).not.toContain(unrelated)
    expect(await persistence.findById(unrelated)).toBeNull()
  })

  it('carries an alias ACK queued during settlement onto the authoritative final id', async () => {
    const store = new InMemoryIdentity()
    const entered = deferred()
    const release = deferred()
    const persistence: IdentityPersistence = {
      init: () => store.init(),
      loadAll: (space) => store.loadAll(space),
      findById: (id) => store.findById(id),
      claimMany: (records) => store.claimMany(records),
      mergeLegacyNameAlias: (input) => store.mergeLegacyNameAlias(input),
      settleFileClaim: async (claim) => {
        entered.resolve()
        await release.promise
        return store.settleFileClaim(claim)
      },
      close: () => store.close(),
    }
    const reg = makeRegistry(persistence)
    const previousId = reg.ensure('demo/a.md').id
    const settling = reg.settleFileClaim('demo/a.md', 'final-note-id')

    await entered.promise
    const persisting = reg.persistLegacyNameAlias(previousId, 'historic-name')
    release.resolve()
    await Promise.all([settling, persisting])

    expect(reg.recordFor(previousId)).toBeUndefined()
    expect(reg.recordFor('final-note-id')?.legacyNameAliases).toEqual(['historic-name'])
    expect((await store.findById('final-note-id'))?.legacyNameAliases).toEqual(['historic-name'])
  })

  it('persists aliases on an identity resurrected after it was once superseded', async () => {
    const store = new InMemoryIdentity()
    const reg = makeRegistry(store)
    const previousId = reg.ensure('demo/a.md').id

    await reg.flush()
    await reg.settleFileClaim('demo/a.md', 'final-note-id')
    reg.ensure('demo/resurrected.md')
    await reg.settleFileClaim('demo/resurrected.md', previousId)
    await reg.persistLegacyNameAlias(previousId, 'resurrected-name')

    expect((await store.findById(previousId))?.legacyNameAliases).toEqual(['resurrected-name'])
    expect((await store.findById('final-note-id'))?.legacyNameAliases).toEqual([])
  })

  it('reverses a settlement without leaving an alias successor cycle', async () => {
    const store = new InMemoryIdentity()
    const reg = makeRegistry(store)
    const previousId = reg.ensure('demo/a.md').id

    await reg.flush()
    await reg.settleFileClaim('demo/a.md', 'final-note-id')
    await reg.settleFileClaim('demo/a.md', previousId)

    await expect(reg.persistLegacyNameAlias(previousId, 'returned-name')).resolves.toMatchObject({
      id: previousId,
      legacyNameAliases: ['returned-name'],
    })
    expect((await store.findById(previousId))?.legacyNameAliases).toEqual(['returned-name'])
  })

  it('keeps a late alias as exact debt while an older structural claim is pending', async () => {
    const store = new InMemoryIdentity()
    const entered = deferred()
    const release = deferred()
    const persistence: IdentityPersistence = {
      init: () => store.init(),
      loadAll: (space) => store.loadAll(space),
      findById: (id) => store.findById(id),
      claimMany: async (records) => {
        entered.resolve()
        await release.promise
        return store.claimMany(records)
      },
      mergeLegacyNameAlias: (input) => store.mergeLegacyNameAlias(input),
      settleFileClaim: (claim) => store.settleFileClaim(claim),
      close: () => store.close(),
    }
    const reg = makeRegistry(persistence)
    const id = reg.ensure('demo/a.md').id
    const flushing = reg.flush()

    await entered.promise
    const persisting = reg.persistLegacyNameAlias(id, 'late-alias')
    release.resolve()
    await Promise.all([flushing, persisting])

    expect((await store.findById(id))?.legacyNameAliases).toEqual(['late-alias'])
  })
})

describe('IdentityRegistry — causal identity adoption', () => {
  const durable = (over: Partial<IdentityRecord> = {}): IdentityRecord => ({
    id: 'causal-note1',
    filePath: 'old.md',
    space: 'main',
    createdAt: '2020-01-01T00:00:00.000Z',
    materialized: true,
    deletedAt: null,
    addressRevision: 1,
    legacyNameAliases: [],
    ...over,
  })

  it('always unions aliases but keeps every structurally dirty local field', async () => {
    const store = new InMemoryIdentity([durable()])
    const reg = makeRegistry(store)

    await reg.load()
    reg.rename('old.md', 'local-new.md')
    store.rows.set(
      'causal-note1',
      durable({
        filePath: 'durable-newer.md',
        addressRevision: 9,
        legacyNameAliases: ['durable-alias'],
      }),
    )

    await reg.adoptPersisted('causal-note1')
    expect(reg.recordFor('causal-note1')).toMatchObject({
      filePath: 'local-new.md',
      addressRevision: 1,
      legacyNameAliases: ['durable-alias'],
    })

    await reg.flush()
    expect(await store.findById('causal-note1')).toMatchObject({
      filePath: 'local-new.md',
      legacyNameAliases: ['durable-alias'],
    })
  })

  it('applies the clean revision algebra and fails closed on a repeated equal conflict', async () => {
    const store = new InMemoryIdentity([durable()])
    const reg = makeRegistry(store)

    await reg.load()
    store.rows.set(
      'causal-note1',
      durable({
        filePath: 'lower.md',
        addressRevision: 0,
        legacyNameAliases: ['lower-alias'],
      }),
    )
    await reg.adoptPersisted('causal-note1')
    expect(reg.recordFor('causal-note1')).toMatchObject({
      filePath: 'old.md',
      legacyNameAliases: ['lower-alias'],
    })

    store.rows.set(
      'causal-note1',
      durable({
        filePath: 'greater.md',
        addressRevision: 2,
        legacyNameAliases: ['greater-alias'],
      }),
    )
    await reg.adoptPersisted('causal-note1')
    expect(reg.recordFor('causal-note1')).toMatchObject({
      filePath: 'greater.md',
      addressRevision: 2,
      legacyNameAliases: ['greater-alias', 'lower-alias'],
    })

    store.rows.set('causal-note1', durable({ filePath: 'conflict.md', addressRevision: 2 }))
    await expect(reg.adoptPersisted('causal-note1')).rejects.toThrow(
      'conflicting address revision 2',
    )
    expect(reg.recordFor('causal-note1')?.filePath).toBe('greater.md')
  })
})

describe('IdentityRegistry — space (#16 groundwork)', () => {
  it('stamps its space on every record it mints or adopts', async () => {
    const reg = new IdentityRegistry({ space: 'work', now: () => new Date(NOW) })
    expect(reg.ensure('demo/a.md').space).toBe('work')
    await reg.settleFileClaim('demo/b.md', 'file-claim-id')
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
        legacyNameAliases: [],
        filePath: 'demo/a.md',
        space: 'work',
        createdAt: null,
        materialized: true,
        deletedAt: null,
      },
      {
        id: 'play-id-00001',
        legacyNameAliases: [],
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
