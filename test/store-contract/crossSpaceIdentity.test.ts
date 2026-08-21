// The cross-space note-id collision (#327), end to end: two real spaces, two
// real engines, ONE shared meta-DB — the exact shape a copied vault folder
// produces. Before the global arbiter, whichever space swept last took the id
// over, and a retry took it back; `notarium-id` was only as global as the poll
// order. What these tests pin is the whole road: the arbiter decides one owner,
// the loser's FILE is rewritten onto its own id, and the exact index is PROVEN
// against the bytes that are still on disk before anything is published.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { StoreEvent } from '@notarium/contract'

type ChangedEvent = Extract<StoreEvent, { type: 'changed' }>
import { CachedStore, NOTE_ID_FRONTMATTER_KEY } from '@notarium/core'
import {
  createLocalFsFiles,
  createNodeSqliteDriver,
  engineMountOf,
  type FileStoreAssembly,
  NotariumStore,
  resourceAuthorityAdapterOf,
  SpaceResourceAuthority,
} from '@notarium/engine'

import type { Principal } from '../../packages/server/src/services/authz'
import { SqliteMetaDb } from '../../packages/server/src/services/metaDb/sqliteMetaDb'
import { SpaceManager } from '../../packages/server/src/services/spaces'
import type { SpaceStore } from '../../packages/server/src/services/spaces'
import { createStoreAccess, readNoteAccess } from '../../packages/server/src/services/storeAccess'
import { withFacets } from './fileStoreAssembly'

const SHARED_ID = 'shared-note1'

const noteWith = (id: string, title: string, body: string): string =>
  `---\n${NOTE_ID_FRONTMATTER_KEY}: ${id}\ntitle: ${title}\n---\n\n${body}\n`

describe('cross-space note-id collision (#327)', () => {
  const cleanups: Array<() => void | Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup()
    }
    cleanups.length = 0
  })

  const world = () => {
    const root = mkdtempSync(join(tmpdir(), 'notarium-cross-space-'))
    const meta = new SqliteMetaDb(join(root, 'meta.sqlite'))

    cleanups.push(() => meta.close())
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))

    /** One space: its own notes dir, its own index, the SHARED identity table. */
    const space = (
      name: string,
      wrap?: (files: FileStoreAssembly) => FileStoreAssembly,
      identity?: (real: typeof meta.identity) => typeof meta.identity,
      wrapSql?: <T>(sql: T) => T,
    ) => {
      const dir = join(root, name)

      mkdirSync(dir, { recursive: true })
      const storage = wrap ? wrap(createLocalFsFiles(dir)) : createLocalFsFiles(dir)
      const resourceAuthority = new SpaceResourceAuthority(name, [
        resourceAuthorityAdapterOf({ id: 'notes', prefix: '', physicalRoot: dir }, storage),
      ])
      const engine = new NotariumStore({
        mounts: [engineMountOf({ class: 'user-doc', prefix: '' }, storage)],
        resourceAuthority,
        sql: (wrapSql ?? ((driver) => driver))(createNodeSqliteDriver(':memory:')),
        // Keep the rotating source sweep out of the way: these tests count
        // repair publications, not background verification.
        integritySweepBatchSize: 0,
      })
      const store = new CachedStore({
        inner: engine,
        identityPersistence: identity ? identity(meta.identity) : meta.identity,
        space: name,
        pollIntervalMs: 0,
        readBody: async (filePath) => readFileSync(join(dir, filePath), 'utf8'),
      })

      cleanups.push(async () => {
        store.stop()
        await store.settle()
      })

      return { dir, engine, store }
    }

    return { root, meta, space }
  }

  const write = (dir: string, name: string, content: string): void => {
    rmSync(join(dir, name), { force: true })
    writeFileSync(join(dir, name), content)
  }

  it('gives the id to the first space and rewrites the copy onto its own — no take-over on a retry', async () => {
    const { meta, space } = world()
    const alpha = space('alpha')
    const beta = space('beta')

    write(alpha.dir, 'note.md', noteWith(SHARED_ID, 'Alpha', 'alpha body'))
    write(beta.dir, 'copy.md', noteWith(SHARED_ID, 'Beta copy', 'beta body'))

    await alpha.store.start()
    await beta.store.start()

    // One owner, decided in the database and unchanged by who swept last.
    expect(await meta.identity.findById!(SHARED_ID)).toMatchObject({
      space: 'alpha',
      filePath: 'note.md',
      deletedAt: null,
    })
    const alphaNotes = await alpha.store.list()
    const betaNotes = await beta.store.list()

    expect(alphaNotes).toHaveLength(1)
    expect(alphaNotes[0].id).toBe(SHARED_ID)
    expect(betaNotes).toHaveLength(1)
    expect(betaNotes[0].id).not.toBe(SHARED_ID)

    const betaId = betaNotes[0].id!

    // Recorded as materialized BEFORE any further poll: `materialized` is what the
    // convergence just learned — the bytes carry this id — and the boot that reads
    // this row is the one that decides whether to arbitrate and rewrite it again.
    expect(await meta.identity.findById!(betaId)).toMatchObject({ materialized: true })

    // The loser's FILE is converged, not merely re-labelled in memory: its bytes
    // name its own id, so the collision does not come back on the next boot.
    const betaRaw = readFileSync(join(beta.dir, 'copy.md'), 'utf8')

    expect(betaRaw).toContain(`${NOTE_ID_FRONTMATTER_KEY}: ${betaId}`)
    expect(betaRaw).not.toContain(SHARED_ID)
    expect(betaRaw).toContain('beta body')
    // Alpha's bytes were never touched.
    expect(readFileSync(join(alpha.dir, 'note.md'), 'utf8')).toContain(
      `${NOTE_ID_FRONTMATTER_KEY}: ${SHARED_ID}`,
    )

    // A retry — the exact thing that used to hand the id back and forth.
    await alpha.store.checkpoint()
    await beta.store.checkpoint()
    expect(await meta.identity.findById!(SHARED_ID)).toMatchObject({
      space: 'alpha',
      filePath: 'note.md',
    })
    expect((await beta.store.list())[0].id).toBe(betaId)
    // `materialized` is what the convergence LEARNED: the bytes now carry this id.
    // Without it every later boot re-arbitrates and rewrites a file that is already
    // correct, and the registry's fast path can never answer for this row.
    expect(await meta.identity.findById!(betaId)).toMatchObject({
      space: 'beta',
      filePath: 'copy.md',
      materialized: true,
    })
  })

  it('moves through a late settlement successor without resurrecting the retired id', async () => {
    const { meta, space } = world()
    const alpha = space('alpha')
    const provisionalId = 'provisional1'
    const durableId = 'durable-id01'
    const oldPath = 'aza-stan-zhospary.md'
    const newPath = 'archive/current.md'
    const at = '2026-06-11T12:00:00.000Z'

    await meta.identity.init()
    await meta.identity.claimMany([
      {
        id: durableId,
        legacyNameAliases: [],
        filePath: 'former.md',
        space: 'alpha',
        createdAt: '2026-06-10T00:00:00.000Z',
        materialized: true,
        deletedAt: at,
      },
    ])
    write(alpha.dir, oldPath, noteWith(provisionalId, 'Қазақстан жоспары', 'alpha body'))
    await alpha.store.start()
    expect((await alpha.store.list())[0]).toMatchObject({ id: provisionalId, filePath: oldPath })

    const provisional = await meta.identity.findById!(provisionalId)

    expect(provisional).not.toBeNull()
    await meta.identity.settleFileClaim({
      space: 'alpha',
      filePath: oldPath,
      current: provisional!,
      observedId: durableId,
      at,
    })

    const changed: ChangedEvent[] = []

    alpha.store.subscribe((event) => {
      if (event.type === 'changed') {
        changed.push(event)
      }
    })
    const moved = await alpha.store.move({ id: provisionalId, destinationPath: newPath })

    expect(moved).toMatchObject({ id: durableId, filePath: newPath })
    expect(await alpha.store.list()).toMatchObject([{ id: durableId, filePath: newPath }])
    expect(readFileSync(join(alpha.dir, newPath), 'utf8')).toContain(
      `${NOTE_ID_FRONTMATTER_KEY}: ${durableId}`,
    )
    expect(await meta.identity.findById!(provisionalId)).toMatchObject({
      deletedAt: expect.any(String),
    })
    expect(await meta.identity.findById!(durableId)).toMatchObject({
      filePath: newPath,
      deletedAt: null,
    })
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({
      upserts: expect.arrayContaining([durableId]),
      removed: expect.arrayContaining([provisionalId]),
    })
  })

  it('proves the loser’s index row against its rewritten bytes, then goes quiet', async () => {
    const { space } = world()
    const alpha = space('alpha')
    const beta = space('beta')

    write(alpha.dir, 'note.md', noteWith(SHARED_ID, 'Alpha', 'alpha body'))
    write(beta.dir, 'copy.md', noteWith(SHARED_ID, 'Beta copy', 'beta body'))

    await alpha.store.start()
    await beta.store.start()
    const betaId = (await beta.store.list())[0].id!

    // The exact row describes the file as it is NOW — the read-model can address
    // the note by its settled id, and the read serves the converged bytes.
    await expect(beta.store.read(betaId)).resolves.toMatchObject({
      id: betaId,
      filePath: 'copy.md',
      content: expect.stringContaining('beta body'),
    })

    // The rewrite itself is a real file change, so the first poll after it may
    // carry ONE echo of the note it repaired — and then the repair must be over.
    // An unconditional reindex would instead look like a phantom external edit
    // poll after poll, forever.
    const changed: ChangedEvent[] = []

    beta.store.subscribe((event) => {
      if (event.type === 'changed') {
        changed.push(event)
      }
    })
    await beta.store.checkpoint()
    expect(changed.flatMap((event) => event.upserts)).toEqual([betaId])
    changed.length = 0
    await beta.store.checkpoint()
    await beta.store.checkpoint()
    expect(changed).toEqual([])
  })

  it('publishes NOTHING when the index already describes the claim it is asked to prove', async () => {
    const { space } = world()
    const alpha = space('alpha')
    const free = 'freeclaim001'

    // No collision at all: the file's claim is unowned, so the arbiter accepts it
    // and convergence has only to PROVE the index — which the boot scan just built
    // from these very bytes. The proof is a predicate, not a refresh. Reindexing
    // unconditionally here would publish a seq for a file nobody changed, and every
    // consumer would see a phantom external edit on it.
    write(alpha.dir, 'note.md', noteWith(free, 'Alpha', 'alpha body'))

    const changed: ChangedEvent[] = []

    alpha.store.subscribe((event) => {
      if (event.type === 'changed') {
        changed.push(event)
      }
    })
    await alpha.store.start()
    expect((await alpha.store.list())[0].id).toBe(free)

    changed.length = 0
    await alpha.store.checkpoint()
    await alpha.store.checkpoint()
    expect(changed).toEqual([])
  })

  it('reconciles a body edit that lands between the read and the index proof, losing no bytes', async () => {
    const { space } = world()
    const alpha = space('alpha')

    write(alpha.dir, 'note.md', noteWith(SHARED_ID, 'Alpha', 'alpha body'))
    await alpha.store.start()

    let betaDir = ''
    let convergedReads = 0
    // The window the final observation exists for: convergence reads the
    // rewritten file once to prove the index against it, and once more to close
    // the proof. R1 → R2 lands strictly BETWEEN those two reads.
    const beta = space('beta', (real) =>
      withFacets(real, {
        base: {
          read: async (path) => {
            if (path === 'copy.md' && convergedReads === 1) {
              convergedReads++
              write(betaDir, 'copy.md', noteWith(betaSettledId, 'Beta copy', 'second body'))
            }
            const raw = await real.base.read(path)

            if (path === 'copy.md' && raw != null && !raw.includes(SHARED_ID) && !convergedReads) {
              betaSettledId = raw.match(/notarium-id: (\S+)/)?.[1] ?? ''
              convergedReads++
            }

            return raw
          },
        },
      }),
    )
    let betaSettledId = ''

    betaDir = beta.dir
    write(betaDir, 'copy.md', noteWith(SHARED_ID, 'Beta copy', 'first body'))

    await beta.store.start()
    const betaId = (await beta.store.list())[0].id!
    const raw = readFileSync(join(betaDir, 'copy.md'), 'utf8')

    // The external writer's bytes survive, and they carry the settled identity.
    expect(raw).toContain('second body')
    expect(raw).toContain(`${NOTE_ID_FRONTMATTER_KEY}: ${betaId}`)
    // The INDEX describes those bytes, not the ones the proof started from —
    // this is what the final observation buys. A direct read would pass either
    // way (it serves from disk); the derived surfaces are where a stale proof
    // shows up, and they must not need another poll to catch up.
    await expect(beta.store.search('second')).resolves.toEqual([
      expect.objectContaining({ id: betaId }),
    ])
    await expect(beta.store.search('first')).resolves.toEqual([])
    // …and having reconciled it, the repair converges: one echo of the rewrite
    // at most, then silence — the external edit is NOT re-detected forever.
    const changed: ChangedEvent[] = []

    beta.store.subscribe((event) => {
      if (event.type === 'changed') {
        changed.push(event)
      }
    })
    await beta.store.checkpoint()
    expect(changed.flatMap((event) => event.upserts)).toEqual([betaId])
    changed.length = 0
    await beta.store.checkpoint()
    await beta.store.checkpoint()
    expect(changed).toEqual([])
  })

  it('fails closed on a file that never holds still, rather than publishing an unproven identity', async () => {
    const { space } = world()
    const alpha = space('alpha')

    write(alpha.dir, 'note.md', noteWith(SHARED_ID, 'Alpha', 'alpha body'))
    await alpha.store.start()

    let betaDir = ''
    let churn = 0
    // Every observation sees a different generation. `stat` and `read` are
    // separate storage calls, so the only honest answer is "not proven yet" —
    // never a claim of convergence over bytes nobody has held still.
    const beta = space('beta', (real) =>
      withFacets(real, {
        base: {
          read: async (path) => {
            if (path === 'copy.md') {
              write(betaDir, 'copy.md', noteWith(SHARED_ID, 'Beta copy', `body ${++churn}`))
            }

            return real.base.read(path)
          },
        },
      }),
    )

    betaDir = beta.dir
    write(betaDir, 'copy.md', noteWith(SHARED_ID, 'Beta copy', 'body 0'))

    await beta.store.start()
    // The boot is in honest error mode; nothing was published under an identity
    // the arbiter's convergence could not prove.
    expect((await beta.store.syncStatus()).scan).toMatchObject({ phase: 'error' })
    expect(readFileSync(join(betaDir, 'copy.md'), 'utf8')).toContain(SHARED_ID)
  })

  it('keeps failing closed on the RETRY, not only on the first attempt', async () => {
    // The arbiter's transaction commits before convergence runs, so an attempt whose
    // convergence threw still left a materialized row behind — and the registry's
    // fast path answers `noop` off that row from then on. A retry that reads only
    // the verdict therefore skips convergence and the index proof entirely, and the
    // second read publishes bytes no proof ever looked at.
    const { space } = world()
    let dir = ''
    let churn = 0
    const alpha = space('alpha', (real) =>
      withFacets(real, {
        base: {
          read: async (path) => {
            if (path === 'note.md') {
              write(dir, 'note.md', noteWith('freeclaim003', 'A', `body ${++churn}`))
            }

            return real.base.read(path)
          },
        },
      }),
    )

    dir = alpha.dir
    // A FREE claim: this path is `adopted`, the branch whose retry the fast path
    // silences. The foreign-owner case above can never reach it.
    write(dir, 'note.md', noteWith('freeclaim003', 'A', 'body 0'))
    await alpha.store.start()

    expect((await alpha.store.syncStatus()).scan).toMatchObject({ phase: 'error' })
    await expect(alpha.store.list()).rejects.toThrow()
  })

  it('publishes the id the path ENDED on when one poll re-arbitrates it twice', async () => {
    const { meta, space } = world()
    const first = 'firstclaim01'
    const second = 'secondclaim1'
    const third = 'thirdclaim01'
    let alphaDir = ''
    let armed = false
    let seen = 0
    let injected = false
    // Two hops in ONE poll. The delta keys the snapshot by the id the path holds
    // when it starts (`first`); the sweep then settles the file's new claim
    // (`second`), and an external writer replaces it again mid-convergence, so the
    // arbiter answers a third time. Re-keying from the LAST hop's retired id
    // (`second`) leaves the note published under `first` — an id whose durable row
    // is by then a tombstone.
    const alpha = space('alpha', (real) =>
      withFacets(real, {
        base: {
          read: async (path) => {
            if (armed && path === 'note.md' && ++seen === 2) {
              write(alphaDir, 'note.md', noteWith(third, 'Alpha', 'alpha body'))
              injected = true
            }

            return real.base.read(path)
          },
        },
      }),
    )

    alphaDir = alpha.dir
    write(alphaDir, 'note.md', noteWith(first, 'Alpha', 'alpha body'))
    await alpha.store.start()
    expect((await alpha.store.list())[0].id).toBe(first)

    armed = true
    write(alphaDir, 'note.md', noteWith(second, 'Alpha', 'alpha body'))
    await alpha.store.checkpoint()

    // Armed on the ORDINAL of a read, which is as brittle as it sounds: one extra read
    // upstream and the injection never happens — and several of these outcomes are also
    // the outcome of not racing at all, so the test would pass having proved nothing.
    // Every race here says out loud that it fired.
    expect(injected).toBe(true)

    const notes = await alpha.store.list()

    expect(notes).toHaveLength(1)
    expect(notes[0].id).toBe(third)
    expect(await meta.identity.findById!(third)).toMatchObject({
      space: 'alpha',
      filePath: 'note.md',
      deletedAt: null,
    })
    // The spellings the path passed through are tombstones — nothing may still be
    // serving under one of them.
    for (const retired of [first, second]) {
      expect(await meta.identity.findById!(retired)).toMatchObject({
        deletedAt: expect.any(String),
      })
    }
    await expect(alpha.store.read(third)).resolves.toMatchObject({ id: third })
  })

  it('re-keys a path that moved even when the LAST hop ends in a same-space duplicate', async () => {
    const { meta, space } = world()
    const held = 'dupclaim0001'
    const first = 'firstclaim01'
    const second = 'secondclaim1'
    let dir = ''
    let armed = false
    let seen = 0
    let injected = false
    // The last hop's verdict and the fact that the path moved are independent. Here
    // the path really moves (`first` → `second`, durable), and only THEN an external
    // writer plants an id another file of this same space already holds, so the final
    // verdict is `duplicate`. Reading the verdict instead of the movement drops the
    // re-key, and the snapshot goes on serving a tombstone — after which every poll
    // mints another id for the same file, without limit.
    const alpha = space('alpha', (real) =>
      withFacets(real, {
        base: {
          read: async (path) => {
            if (armed && path === 'note.md' && ++seen === 2) {
              write(dir, 'note.md', noteWith(held, 'Alpha', 'alpha body'))
              injected = true
            }

            return real.base.read(path)
          },
        },
      }),
    )

    dir = alpha.dir
    write(dir, 'orig.md', noteWith(held, 'Original', 'original body'))
    write(dir, 'note.md', noteWith(first, 'Alpha', 'alpha body'))
    await alpha.store.start()

    armed = true
    write(dir, 'note.md', noteWith(second, 'Alpha', 'alpha body'))
    await alpha.store.checkpoint()

    expect(injected).toBe(true)

    const idAt = async (filePath: string): Promise<string> =>
      (await alpha.store.list()).find((n) => n.filePath === filePath)!.id!

    expect(await idAt('note.md')).toBe(second)
    expect(await meta.identity.findById!(second)).toMatchObject({
      filePath: 'note.md',
      deletedAt: null,
    })
    expect(await meta.identity.findById!(first)).toMatchObject({ deletedAt: expect.any(String) })
    // …and it STAYS there. A dropped re-key is not one stale row: the next poll finds
    // the snapshot and the registry disagreeing and mints again, every poll, forever.
    for (let poll = 0; poll < 3; poll++) {
      await alpha.store.checkpoint()
      expect(await idAt('note.md')).toBe(second)
    }
    expect(await idAt('orig.md')).toBe(held)
  })

  it('treats a file that disappears mid-convergence as done, not as a permanent wedge', async () => {
    const { meta, space } = world()
    const alpha = space('alpha')

    write(alpha.dir, 'note.md', noteWith(SHARED_ID, 'Alpha', 'alpha body'))
    await alpha.store.start()

    let betaDir = ''
    let armed = false
    let seen = 0
    let injected = false
    // The external writer that removes the file while the loser's copy is being
    // brought onto its own id — the second read of the poll is the convergence
    // snapshot. There is nothing left to converge and nothing left to defend, but
    // the claim must not stay outstanding forever: it is retried on every read
    // surface and every poll of this SPACE, and it can never succeed again.
    const beta = space('beta', (real) =>
      withFacets(real, {
        base: {
          read: async (path) => {
            if (armed && path === 'copy.md' && ++seen === 2) {
              rmSync(join(betaDir, 'copy.md'), { force: true })
              injected = true
            }

            return real.base.read(path)
          },
        },
      }),
    )

    betaDir = beta.dir
    write(betaDir, 'copy.md', noteWith('betaown00001', 'Beta copy', 'beta body'))

    await beta.store.start()
    expect((await beta.store.list())[0].id).toBe('betaown00001')

    armed = true
    write(betaDir, 'copy.md', noteWith(SHARED_ID, 'Beta copy', 'beta body'))
    await beta.store.checkpoint()

    expect(injected).toBe(true)

    // Reads keep working: the settlement is finished, not left outstanding behind
    // the publication fence for a path that has no bytes to settle.
    await expect(beta.store.list()).resolves.toHaveLength(1)

    // The arbiter commits BEFORE convergence, so the durable row outlived the
    // file. It must be retired the moment convergence LEARNS that — not left live
    // until some later poll happens to notice the removal. Asserted here, inside
    // that window: a live row claiming bytes that no longer exist turns the file's
    // reappearance elsewhere into a copy of a phantom, which the duplicate
    // contract answers by minting a new id and severing the note's history.
    await beta.store.settle()
    expect(await meta.identity.findById!('betaown00001')).toMatchObject({
      filePath: 'copy.md',
      deletedAt: expect.any(String),
    })

    // And the next poll is ordinary — it observes the removal instead of failing
    // closed on the same impossible convergence forever.
    await beta.store.checkpoint()
    await expect(beta.store.list()).resolves.toEqual([])
    expect((await beta.store.syncStatus()).scan).not.toMatchObject({ phase: 'error' })

    // The file did not die, it MOVED: the tombstone is the external-move case the
    // contract already handles, and the note keeps its id and its history.
    write(betaDir, 'moved.md', noteWith('betaown00001', 'Beta copy', 'beta body'))
    await beta.store.checkpoint()

    expect((await beta.store.list()).map((n) => [n.filePath, n.id])).toEqual([
      ['moved.md', 'betaown00001'],
    ])
    expect(await meta.identity.findById!('betaown00001')).toMatchObject({
      space: 'beta',
      filePath: 'moved.md',
      deletedAt: null,
    })
  })

  it('keeps a re-key the sweep already learned when a LATER path fails', async () => {
    // A sweep learns each path's move by reading the registry before and after the
    // settlement. That pair exists only in that instant: once the registry has
    // moved, a retry sees no movement at all. So a pair collected and then dropped
    // by a neighbour's failure is not recoverable — the snapshot goes on serving an
    // id the settlement tombstoned, and every poll after that mints another.
    const { meta, space } = world()
    let failuresLeft = 0
    const alpha = space('alpha', undefined, (real) => ({
      ...real,
      settleFileClaim: async (claim) => {
        if (claim.filePath === 'b.md' && failuresLeft > 0) {
          failuresLeft--
          throw new Error('meta-db unavailable')
        }

        return real.settleFileClaim(claim)
      },
    }))

    await alpha.store.start()
    // A DELTA, not a boot: the boot rebuilds the snapshot from the engine
    // afterwards and would hide the loss. Here the snapshot is patched in place,
    // so a dropped pair stays dropped.
    write(alpha.dir, 'a.md', noteWith('freeclaim001', 'A', 'a body'))
    write(alpha.dir, 'b.md', noteWith('freeclaim002', 'B', 'b body'))
    failuresLeft = 1
    await alpha.store.checkpoint().catch(() => undefined)

    // The failure was transient, so the next surface drains `b.md` successfully —
    // and `a.md`, settled BEFORE the throw, must still be published under the id
    // the arbiter gave it.
    const notes = await alpha.store.list()

    expect(notes.map((n) => [n.filePath, n.id]).sort()).toEqual([
      ['a.md', 'freeclaim001'],
      ['b.md', 'freeclaim002'],
    ])
    expect(await meta.identity.findById!('freeclaim001')).toMatchObject({
      filePath: 'a.md',
      deletedAt: null,
    })
  })

  it('makes a second surface JOIN an in-flight drain instead of publishing past it', async () => {
    // The fence is only as good as its guard. A surface that finds a drain already
    // running and simply returns publishes whatever the snapshot holds right now —
    // which, for a path whose claim is still outstanding, is an id the settlement
    // is about to retire.
    const { meta, space } = world()
    const alpha = space('alpha')

    write(alpha.dir, 'note.md', noteWith(SHARED_ID, 'Alpha', 'alpha body'))
    await alpha.store.start()

    let fail = false
    let release: (() => void) | undefined
    let inSettlement: (() => void) | undefined
    const settlementOpen = new Promise<void>((done) => {
      inSettlement = done
    })
    const beta = space('beta', undefined, (real) => ({
      ...real,
      settleFileClaim: async (claim) => {
        if (fail) {
          throw new Error('meta-db unavailable')
        }
        inSettlement?.()
        inSettlement = undefined
        if (release) {
          await new Promise<void>((done) => {
            const held = release!

            release = () => {
              held()
              done()
            }
          })
        }

        return real.settleFileClaim(claim)
      },
    }))

    write(beta.dir, 'own.md', noteWith('betaown00001', 'Beta own', 'beta body'))
    await beta.store.start()

    fail = true
    write(beta.dir, 'copy.md', noteWith(SHARED_ID, 'Beta copy', 'beta body'))
    await beta.store.checkpoint().catch(() => undefined)
    fail = false
    release = () => undefined

    const first = beta.store.list()

    await settlementOpen
    let secondDone = false
    const second = beta.store.list().then((notes) => {
      secondDone = true
      return notes
    })

    await new Promise((done) => setTimeout(done, 50))
    // The drain is still inside the settlement, so nothing may have been published.
    expect(secondDone).toBe(false)

    release()
    const [, published] = await Promise.all([first, second])

    // Beta lost the arbitration, so its copy carries its OWN id — never the
    // provisional one the snapshot held while the drain was running.
    expect(published.map((n) => n.id)).not.toContain(SHARED_ID)
    expect(await meta.identity.findById!(SHARED_ID)).toMatchObject({ space: 'alpha' })
  })

  it('drains an outstanding claim under the mutation claim the re-key needs', async () => {
    // The drain is reached from places that hold nothing: a read surface's tail,
    // the write-behind timer. It re-keys the snapshot and rewrites a file, so it
    // has to take the claim itself — otherwise a save can interleave with the
    // settlement of the very note it is saving.
    const { meta, space } = world()
    const alpha = space('alpha')

    write(alpha.dir, 'note.md', noteWith(SHARED_ID, 'Alpha', 'alpha body'))
    await alpha.store.start()

    let fail = false
    let inSettlement: (() => void) | undefined
    const settlementOpen = new Promise<void>((done) => {
      inSettlement = done
    })
    const beta = space('beta', undefined, (real) => ({
      ...real,
      findById: (id: string) => real.findById!(id),
      settleFileClaim: async (claim) => {
        if (fail) {
          throw new Error('meta-db unavailable')
        }
        inSettlement?.()
        inSettlement = undefined
        await new Promise((done) => setTimeout(done, 30))
        return real.settleFileClaim(claim)
      },
    }))

    write(beta.dir, 'own.md', noteWith('betaown00001', 'Beta own', 'beta body'))
    await beta.store.start()

    // Leave a claim outstanding: the arbiter refused, so the path is behind the
    // publication fence with nothing settled.
    fail = true
    write(beta.dir, 'copy.md', noteWith(SHARED_ID, 'Beta copy', 'beta body'))
    await beta.store.checkpoint().catch(() => undefined)
    fail = false

    // A read surface drains it — with no claim of its own — while a save of the
    // OTHER note runs concurrently.
    const order: string[] = []
    const draining = beta.store.list().then(() => order.push('drain'))

    await settlementOpen
    const saving = beta.store.remove('betaown00001').then(() => order.push('save'))

    await Promise.all([draining, saving])

    expect(order).toEqual(['drain', 'save'])
    expect(await meta.identity.findById!(SHARED_ID)).toMatchObject({ space: 'alpha' })
  })

  it('keeps the delta cursor put when this delta\u2019s identities did not settle', async () => {
    // The cursor is the ONLY record that these paths were offered. Advancing it
    // before their identities are settled loses the delta outright: `changes()`
    // never offers them again, and an external file carrying a durable claim keeps
    // serving under the provisional id it was minted with.
    const { space } = world()
    const alpha = space('alpha')

    write(alpha.dir, 'note.md', noteWith(SHARED_ID, 'Alpha', 'alpha body'))
    await alpha.store.start()

    let fail = false
    const beta = space('beta', undefined, (real) => ({
      ...real,
      findById: (id: string) => real.findById!(id),
      settleFileClaim: async (claim) => {
        if (fail) {
          throw new Error('meta-db unavailable')
        }

        return real.settleFileClaim(claim)
      },
    }))

    write(beta.dir, 'own.md', noteWith('betaown00001', 'Beta own', 'beta body'))
    await beta.store.start()

    // Watch exactly what cursor each poll asks the engine with.
    const asked: Array<string | null> = []
    const realChanges = beta.engine.changes.bind(beta.engine)

    beta.engine.changes = (cursor) => {
      asked.push(cursor)
      return realChanges(cursor)
    }

    fail = true
    write(beta.dir, 'copy.md', noteWith(SHARED_ID, 'Beta copy', 'beta body'))
    await beta.store.checkpoint().catch(() => undefined)

    const beforeFailure = asked.at(-1)

    await beta.store.checkpoint().catch(() => undefined)
    // The failed delta is offered again, from the same place.
    expect(asked.at(-1)).toBe(beforeFailure)

    // …so once persistence recovers, the copy still converges onto its own id
    // instead of serving forever under the one it was minted with.
    fail = false
    await beta.store.checkpoint()
    const copy = (await beta.store.list()).find((n) => n.filePath === 'copy.md')

    expect(copy?.id).toBeDefined()
    expect(copy?.id).not.toBe(SHARED_ID)
  })

  it('converges a file that loses its claim entirely mid-flight (X \u2192 no ID)', async () => {
    // The other end of re-arbitration: an external writer does not replace the
    // claim, it strips it. There is nothing left to arbitrate, so convergence must
    // finish by writing back the identity the path already owns — not treat the
    // absent claim as a fresh one, and not give up and publish the loser's bytes
    // still naming another space's note.
    const { meta, space } = world()
    const alpha = space('alpha')

    write(alpha.dir, 'note.md', noteWith(SHARED_ID, 'Alpha', 'alpha body'))
    await alpha.store.start()

    let betaDir = ''
    let armed = false
    let seen = 0
    let injected = false
    const beta = space('beta', (real) =>
      withFacets(real, {
        base: {
          read: async (path) => {
            if (armed && path === 'copy.md' && ++seen === 2) {
              // No frontmatter at all — the claim is gone, the body stays.
              writeFileSync(join(betaDir, 'copy.md'), '# Beta copy\n\nbeta body\n')
              injected = true
            }

            return real.base.read(path)
          },
        },
      }),
    )

    betaDir = beta.dir
    write(betaDir, 'own.md', noteWith('betaown00001', 'Beta own', 'beta body'))
    await beta.store.start()

    armed = true
    write(betaDir, 'copy.md', noteWith(SHARED_ID, 'Beta copy', 'beta body'))
    await beta.store.checkpoint()

    expect(injected).toBe(true)

    const copy = (await beta.store.list()).find((n) => n.filePath === 'copy.md')

    expect(copy?.id).toBeDefined()
    expect(copy?.id).not.toBe(SHARED_ID)
    // The bytes carry the id the path ended on, so the collision does not return
    // on the next boot.
    const raw = readFileSync(join(betaDir, 'copy.md'), 'utf8')

    expect(raw).toContain(`${NOTE_ID_FRONTMATTER_KEY}: ${copy!.id}`)
    expect(raw).not.toContain(SHARED_ID)
    // …and alpha still owns the contested id, untouched.
    expect(await meta.identity.findById!(SHARED_ID)).toMatchObject({
      space: 'alpha',
      filePath: 'note.md',
    })
  })

  it('publishes nothing when the index proof fails, even on bytes that held still', async () => {
    // The proof is what a crash between the index row and its fingerprint costs:
    // the row says one thing, the fingerprint another, and storage meanwhile never
    // moved. A stable file is NOT evidence that the exact index describes it, so a
    // failed proof has to keep the fence shut rather than let the final observation
    // stand in for the proof it is only meant to linearize.
    const { space } = world()
    const alpha = space('alpha')

    write(alpha.dir, 'note.md', noteWith(SHARED_ID, 'Alpha', 'alpha body'))
    await alpha.store.start()

    let blindFingerprints = false
    const beta = space('beta', undefined, undefined, (driver) => {
      const real = driver as { get: (sql: string, params?: unknown[]) => Promise<unknown> }
      const get = real.get.bind(real)

      return {
        ...(driver as object),
        get: (sql: string, params?: unknown[]) =>
          blindFingerprints && sql.includes('file_fingerprints')
            ? Promise.resolve(undefined)
            : get(sql, params),
      } as typeof driver
    })

    write(beta.dir, 'own.md', noteWith('betaown00001', 'Beta own', 'beta body'))
    await beta.store.start()

    blindFingerprints = true
    write(beta.dir, 'copy.md', noteWith(SHARED_ID, 'Beta copy', 'beta body'))

    // Convergence cannot prove the index, so it fails closed instead of publishing.
    const failed = await beta.store
      .checkpoint()
      .then(() => null)
      .catch((err: Error) => err)

    expect(failed?.message).toMatch(/did not converge/)
    const published = await beta.store
      .list()
      .then((notes) => notes.some((n) => n.filePath === 'copy.md'))
      .catch(() => false)

    expect(published).toBe(false)

    // …and the moment the fingerprint is readable again, the same path converges.
    blindFingerprints = false
    await beta.store.checkpoint()
    const copy = (await beta.store.list()).find((n) => n.filePath === 'copy.md')

    expect(copy?.id).toBeDefined()
    expect(copy?.id).not.toBe(SHARED_ID)
  })

  it('routes the arbitrated id to its OWNER only — the loser cannot reach it', async () => {
    const { meta, space } = world()
    const alpha = space('alpha')
    const beta = space('beta')

    write(alpha.dir, 'note.md', noteWith(SHARED_ID, 'Alpha', 'alpha secret'))
    write(beta.dir, 'copy.md', noteWith(SHARED_ID, 'Beta copy', 'beta body'))
    await alpha.store.start()
    await beta.store.start()

    const betaId = (await beta.store.list())[0].id!
    const spaces = new SpaceManager({
      spaces: [
        { slug: 'alpha', displayName: 'Alpha' },
        { slug: 'beta', displayName: 'Beta' },
      ],
      createStore: (rec) =>
        (rec.slug === 'alpha' ? alpha.store : beta.store) as unknown as SpaceStore,
    })

    await spaces.init()
    const access = createStoreAccess(spaces)
    const member = (home: string): Principal => ({
      id: `user:${home}`,
      username: home,
      admin: false,
      scope: 'read',
      grants: new Map([[home, 'reader' as const]]),
      spaces: new Set([home]),
      system: false,
    })

    // The resolve is global and answers with the durable owner…
    expect(await meta.identity.findById!(SHARED_ID)).toMatchObject({ space: 'alpha' })
    await expect(spaces.resolveNote(SHARED_ID)).resolves.toMatchObject({ space: 'alpha' })
    await expect(spaces.resolveNote(betaId)).resolves.toMatchObject({ space: 'beta' })

    // …so a principal who can only see the claimant's space cannot reach the
    // owner's bytes through the id its own copy used to carry. There is no alias,
    // and "not found in my space" never falls back to a sibling's note.
    await expect(access.noteStore(member('beta'), SHARED_ID, 'note:read')).resolves.toBeNull()
    await expect(readNoteAccess(access, member('beta'), SHARED_ID, 'note:read')).resolves.toBeNull()

    // The owner still reads its own note, and the loser still reads its own.
    await expect(
      readNoteAccess(access, member('alpha'), SHARED_ID, 'note:read'),
    ).resolves.toMatchObject({
      space: 'alpha',
      note: expect.objectContaining({ content: expect.stringContaining('alpha secret') }),
    })
    await expect(
      readNoteAccess(access, member('beta'), betaId, 'note:read'),
    ).resolves.toMatchObject({
      space: 'beta',
    })
    // …and the owner cannot reach the loser's id either: the boundary is symmetric.
    await expect(access.noteStore(member('alpha'), betaId, 'note:read')).resolves.toBeNull()
  })

  it('keeps a same-space copy on the existing duplicate contract — no rewrite, no ref move', async () => {
    const { meta, space } = world()
    const alpha = space('alpha')

    write(alpha.dir, 'original.md', noteWith(SHARED_ID, 'Original', 'original body'))
    write(alpha.dir, 'copy.md', noteWith(SHARED_ID, 'Copy', 'copied body'))
    await alpha.store.start()

    const notes = await alpha.store.list()
    const owner = await meta.identity.findById!(SHARED_ID)

    // Exactly one of the two holds the id (inventory order decides, as before);
    // the other keeps its own, and NEITHER file is eagerly rewritten.
    expect(owner).toMatchObject({ space: 'alpha' })
    expect(notes.map((n) => n.id).filter((id) => id === SHARED_ID)).toHaveLength(1)
    expect(notes.find((n) => n.filePath === owner!.filePath)!.id).toBe(SHARED_ID)
    for (const name of ['original.md', 'copy.md']) {
      expect(readFileSync(join(alpha.dir, name), 'utf8')).toContain(
        `${NOTE_ID_FRONTMATTER_KEY}: ${SHARED_ID}`,
      )
    }
  })
})
