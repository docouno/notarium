// Identity settlement: which id each planned note writes under.
//
// Nothing above this file can observe a wrong answer until it is too late — a
// missed occupant becomes a second note over someone else's file, and a fresh id
// that collides with the archive's own becomes a link pointing at two things.
// Both are settled here, so both are proven here.

import { describe, expect, it } from 'vitest'

import { serializedImportPlanBytes } from '../../libs/importStaging'
import { PLAN_SETTLED_ENTRY_BYTES } from './consts'
import {
  assertSettledPlanFits,
  asSettledPlan,
  identityMapOf,
  type IdentityPlanStore,
  settleTreeIdentities,
} from './identityPlan'
import type { MarkdownTreePlanEntry, MarkdownTreePlanV1 } from './types'

type Note = { id: string; filePath: string }

/** A store whose inventory is only visible AFTER a forced checkpoint — the shape
 *  of a localfs store that has not reconciled a file yet (an externally created
 *  note, or one whose watcher event never arrived). */
const storeOf = (notes: Note[], opts: { onlyAfterCheckpoint?: boolean } = {}) => {
  let visible = !opts.onlyAfterCheckpoint
  const calls = { checkpoint: 0, list: 0 }

  return {
    calls,
    store: {
      checkpoint: async () => {
        calls.checkpoint++
        visible = true
      },
      list: async () => {
        calls.list++

        return visible ? notes : []
      },
    } as unknown as IdentityPlanStore,
  }
}

const entryOf = (over: Partial<MarkdownTreePlanEntry> = {}): MarkdownTreePlanEntry => ({
  archivePath: 'vault/a.md',
  directory: 'vault',
  fileName: 'a',
  destinationPath: 'vault/a.md',
  expandedBytes: 12,
  ...over,
})

const planOf = (entries: MarkdownTreePlanEntry[], root = ''): MarkdownTreePlanV1 => ({
  version: 1,
  uploadRef: 'S/job.import',
  root,
  entriesTotal: entries.length,
  expandedBytes: 12 * entries.length,
  ignored: { count: 0, files: [] },
  entries,
})

describe('settleTreeIdentities', () => {
  // The whole reason `checkpoint()` is required rather than optional: a
  // destination map built off an unforced snapshot misses the file nobody told
  // the read-model about, and the import then mints a NEW identity over a note
  // that already exists.
  it('sees a destination the read-model had not reconciled yet', async () => {
    const { store, calls } = storeOf([{ id: 'existing-1', filePath: 'root/vault/a.md' }], {
      onlyAfterCheckpoint: true,
    })
    const settled = await settleTreeIdentities(store, planOf([entryOf()], 'root'))

    expect(calls.checkpoint).toBe(1)
    expect(settled.entries[0]).toMatchObject({
      targetId: 'existing-1',
      expectedDestinationId: 'existing-1',
      ownership: 'existing-reference',
    })
  })

  it('refuses to plan at all against a store that cannot force file truth', async () => {
    await expect(
      settleTreeIdentities(
        { list: async () => [] } as unknown as IdentityPlanStore,
        planOf([entryOf()]),
      ),
    ).rejects.toThrow(/checkpoint/)
  })

  // Overwriting a note's body is an import; overwriting its identity is data loss
  // for every link that already points at it.
  it('keeps an occupied destination’s identity instead of minting one', async () => {
    const { store } = storeOf([{ id: 'existing-1', filePath: 'vault/a.md' }])
    let minted = 0
    const settled = await settleTreeIdentities(store, planOf([entryOf()]), () => {
      minted++

      return 'fresh-1'
    })

    expect(settled.entries[0].targetId).toBe('existing-1')
    expect(minted).toBe(0)
  })

  // An id equal to ANY of the archive's own source ids would make a rewritten
  // link ambiguous — it could mean the copy or the note the archive came from —
  // even though no note here holds that id at all.
  it('re-mints a fresh id that collides with one of the archive’s own source ids', async () => {
    const { store } = storeOf([])
    const drawn = ['src-alpha', 'fresh-1']
    const settled = await settleTreeIdentities(
      store,
      planOf([entryOf({ sourceId: 'src-alpha' })]),
      () => drawn.shift() ?? 'exhausted',
    )

    expect(settled.entries[0].targetId).toBe('fresh-1')
    expect(drawn).toEqual([])
  })

  it('re-mints a fresh id that collides with a note already in the space', async () => {
    const { store } = storeOf([{ id: 'taken-1', filePath: 'elsewhere/other.md' }])
    const drawn = ['taken-1', 'fresh-2']
    const settled = await settleTreeIdentities(
      store,
      planOf([entryOf()]),
      () => drawn.shift() ?? 'x',
    )

    expect(settled.entries[0].targetId).toBe('fresh-2')
  })

  it('never draws one fresh id twice within a plan', async () => {
    const { store } = storeOf([])
    const drawn = ['fresh-1', 'fresh-1', 'fresh-2']
    const settled = await settleTreeIdentities(
      store,
      planOf([entryOf(), entryOf({ archivePath: 'vault/b.md', destinationPath: 'vault/b.md' })]),
      () => drawn.shift() ?? 'exhausted',
    )

    expect(settled.entries.map((entry) => entry.targetId)).toEqual(['fresh-1', 'fresh-2'])
  })

  // The reserve preflight charges per entry against the metadata ceiling. It is a
  // forecast of THIS function's output, so it is worth exactly as much as this
  // assertion: without it the ceiling would guard a document nobody writes.
  it('grows a plan by no more than the reserve preflight charges for it', async () => {
    const { store } = storeOf([{ id: 'existing-1', filePath: 'vault/a.md' }])
    const plan = planOf([
      entryOf({ sourceId: 'src-alpha' }),
      entryOf({ archivePath: 'vault/b.md', destinationPath: 'vault/b.md' }),
      entryOf({ archivePath: 'vault/c.md', destinationPath: 'vault/c.md' }),
    ])
    const settled = await settleTreeIdentities(store, plan)
    const grown =
      Buffer.byteLength(JSON.stringify(settled)) - Buffer.byteLength(JSON.stringify(plan))

    expect(grown / plan.entries.length).toBeLessThanOrEqual(PLAN_SETTLED_ENTRY_BYTES)
  })

  // Existing identities are authored file data and have no length ceiling. The
  // per-entry reserve can cheaply predict normal settlement, but only weighing
  // the completed artifact can bound a destination carrying a very long id.
  it('refuses the exact settled sidecar when an existing id outruns the reserve', async () => {
    const targetId = `existing-${'x'.repeat(300)}`
    const { store } = storeOf([{ id: targetId, filePath: 'vault/a.md' }])
    const plan = planOf([entryOf()])
    const forecast = serializedImportPlanBytes(plan) + PLAN_SETTLED_ENTRY_BYTES
    const settled = await settleTreeIdentities(store, plan)

    expect(serializedImportPlanBytes(settled)).toBeGreaterThan(forecast)
    expect(() => assertSettledPlanFits(settled, forecast)).toThrow(/metadata is too large/)
    expect(asSettledPlan(settled, forecast)).toBeNull()
  })
})

describe('identityMapOf', () => {
  it('maps every source id onto the identity its copy received', async () => {
    const { store } = storeOf([])
    const settled = await settleTreeIdentities(
      store,
      planOf([
        entryOf({ sourceId: 'src-alpha' }),
        entryOf({ archivePath: 'vault/b.md', destinationPath: 'vault/b.md' }),
      ]),
      (() => {
        let n = 0

        return () => `fresh-${++n}`
      })(),
    )

    // Read off the SETTLED plan, which is what a retry adopts: a map rebuilt from
    // fresh ids would repoint the second run's links at notes the first never wrote.
    expect([...identityMapOf(settled)]).toEqual([['src-alpha', 'fresh-1']])
  })
})

describe('asSettledPlan', () => {
  it('refuses a plan whose entries carry no settled identity', () => {
    // Same `version: 1`, written before identities were part of a plan. Accepting
    // it let the write path compensate with `targetId ?? ''` — a reservation on an
    // empty id while the store minted its own, which is precisely the divergence
    // between a retry's links and its notes that versioning exists to prevent.
    expect(asSettledPlan(planOf([entryOf()]))).toBeNull()
  })

  it('refuses a plan with an unknown ownership kind or a blank target id', () => {
    const withSettlement = (over: Record<string, unknown>): MarkdownTreePlanEntry =>
      ({ ...entryOf(), ...over }) as MarkdownTreePlanEntry
    const blank = planOf([
      withSettlement({ targetId: '', expectedDestinationId: null, ownership: 'fresh-owned' }),
    ])
    const strange = planOf([
      withSettlement({ targetId: 't1', expectedDestinationId: null, ownership: 'borrowed' }),
    ])

    expect(asSettledPlan(blank)).toBeNull()
    expect(asSettledPlan(strange)).toBeNull()
  })

  it('refuses a plan of another version, and a missing one', () => {
    expect(asSettledPlan(null)).toBeNull()
    expect(asSettledPlan({ ...planOf([]), version: 2 } as unknown as MarkdownTreePlanV1)).toBeNull()
  })

  it('refuses an older root spelling the writer would otherwise execute verbatim', async () => {
    const { store } = storeOf([])
    const settled = await settleTreeIdentities(store, planOf([entryOf()], 'imported//./2026/'))

    expect(asSettledPlan(settled)).toBeNull()
  })

  it('accepts what settlement produced', async () => {
    const { store } = storeOf([])
    const settled = await settleTreeIdentities(store, planOf([entryOf()]))

    expect(asSettledPlan(settled)).toBe(settled)
  })
})
