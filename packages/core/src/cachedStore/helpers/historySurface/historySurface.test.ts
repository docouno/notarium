// The restore/purge branches carry the load-bearing safety guards — a
// collision must not clobber a live note (P3), a bogus/cross-space id must never
// reach purge and nuke a live note's journal, and a batch restore must survive a
// bad row. These drive HistorySurface directly on a fake HistoryHost (no engine), so
// the guards are pinned independently of the store-contract suite.

import { describe, expect, it } from 'vitest'

import type { IdentityRegistry } from '../../../identity'
import { noteAlreadyExists, type WriteInput, type WriteResult } from '../../../knowledgeStore'
import { MutationCoordinator } from '../../../libs/mutationCoordinator'
import type { RevisionJournal } from '../../../revisionJournal'
import { trashMutationPath } from '../../consts'
import { HistorySurface } from './historySurface'
import type { HistoryHost } from './types'

type Seed = {
  kind?: 'delete' | 'update'
  space?: string
  title?: string
  tags?: string[]
  slug?: string | null
  class?: string | null
  contentHash?: string | null
  content?: string | null
  lastPath?: string
}

const makeHost = (opts: {
  space?: string
  seeds?: Record<string, Seed>
  writeError?: unknown
  trashedPage?: { noteId: string; contentHash?: string | null }[]
  reresolve?: boolean
}) => {
  const space = opts.space ?? 'main'
  const seeds = opts.seeds ?? {}
  const page = opts.trashedPage ?? []
  const calls = {
    writes: [] as WriteInput[],
    purged: [] as string[][],
    emitChanged: [] as [string[], string[]][],
    listTrashedQ: [] as (string | undefined)[],
    reload: 0,
    beginBulk: 0,
    endBulk: 0,
  }

  const tombOf = (id: string) => {
    const s = seeds[id]

    if (!s) {
      return null
    }

    return {
      id: `rev-${id}`,
      noteId: id,
      kind: s.kind ?? 'delete',
      space: s.space ?? space,
      title: s.title ?? id,
      tags: s.tags ?? [],
      slug: s.slug ?? null,
      class: s.class ?? null,
      contentHash: s.contentHash === undefined ? 'hash' : s.contentHash,
      createdAt: '2026-01-01T00:00:00.000Z',
      principal: 'tester',
    }
  }

  const journal = {
    latestFor: async (id: string) => tombOf(id),
    detail: async (id: string) => {
      const s = seeds[id]

      if (!s) {
        return null
      }

      return { ...tombOf(id), content: s.content === undefined ? 'body' : s.content }
    },
    drain: async () => {},
    purge: async (ids: string[]) => {
      calls.purged.push(ids)
      return ids
    },
    listTrashed: async (o: { offset: number; limit: number; q?: string }) => {
      calls.listTrashedQ.push(o.q)
      const items = page
        .slice(o.offset, o.offset + o.limit)
        .map((t) => ({ noteId: t.noteId, contentHash: t.contentHash ?? 'hash' }))
      return { items, total: page.length, restorableTotal: page.length }
    },
  }

  const identity = {
    recordFor: (id: string) => {
      const p = seeds[id]?.lastPath
      return p ? { filePath: p } : undefined
    },
  }

  const write = async (input: WriteInput): Promise<WriteResult> => {
    calls.writes.push(input)
    if (opts.writeError) {
      throw opts.writeError
    }

    return { id: input.id ?? 'new', versionToken: 'tok', filePath: 'x.md' }
  }
  const host: HistoryHost = {
    journal: journal as unknown as RevisionJournal,
    identity: identity as unknown as IdentityRegistry,
    space,
    write,
    writeAdmitted: write,
    emitChanged: (u, r) => {
      calls.emitChanged.push([u, r])
    },
    reloadHistoricalNames: async () => {
      calls.reload++
    },
    reresolveGhostsFromIndex: () => opts.reresolve ?? false,
    beginBulk: () => {
      calls.beginBulk++
    },
    endBulk: async () => {
      calls.endBulk++
    },
  }
  return { host, trash: new HistorySurface(host), calls }
}

describe('HistorySurface restore/purge guards', () => {
  it('delegates the restore-path collision guard to the write checkpoint', async () => {
    const { trash, calls } = makeHost({
      seeds: { n1: { title: 'Note One', lastPath: 'note-one.md' } },
      writeError: noteAlreadyExists('Note One'),
    })

    await expect(trash.restoreFromTrash('n1')).rejects.toMatchObject({
      reason: 'note_already_exists',
    })
    expect(calls.writes).toHaveLength(1)
    // A restore is an ordinary create as far as collisions go: it names no policy and
    // therefore inherits the never-clobber default, rather than reviving the note over
    // whatever took its path.
    expect(calls.writes[0]).toMatchObject({ id: 'n1' })
    expect(calls.writes[0].ifExists).toBeUndefined()
  })

  it('restoreFromTrash revives the id at its exact last path, writes via the CAS path, and heals aliases', async () => {
    const { trash, calls } = makeHost({
      seeds: {
        n1: { title: 'Note One', lastPath: 'sub/note-one.md', slug: 'custom', tags: ['t'] },
      },
      reresolve: true,
    })

    const res = await trash.restoreFromTrash('n1', { principal: 'alice' })
    expect(res).toBeTruthy()
    expect(calls.writes).toHaveLength(1)
    expect(calls.writes[0]).toMatchObject({
      id: 'n1',
      title: 'Note One',
      content: 'body',
      restorePath: 'sub/note-one.md',
      slug: 'custom',
      principal: 'alice',
    })
    expect(calls.writes[0].directory).toBeUndefined()
    expect(calls.writes[0].journal).toMatchObject({ kind: 'restore' })
    expect(calls.reload).toBe(1)
    expect(calls.emitChanged).toEqual([[['n1'], []]]) // reresolve moved an edge
  })

  it('restoreTrash restores the good ids and reports per-id failures without aborting the batch', async () => {
    const { trash, calls } = makeHost({
      // 'ok' is restorable; 'bad' has no tombstone → restoreFromTrash throws noteNotInTrash
      seeds: { ok: { title: 'Ok', lastPath: 'ok.md' } },
    })

    const out = await trash.restoreTrash({ ids: ['ok', 'bad'], principal: 'p' })
    expect(out.restored).toHaveLength(1)
    expect(out.failed).toHaveLength(1)
    expect(out.failed[0]).toMatchObject({ id: 'bad', reason: 'note_not_in_trash' })
    // The REAL thrown message must propagate, not the 'restore failed' fallback — a
    // regression that swallows the error text would otherwise pass silently.
    expect(out.failed[0].error).toMatch(/trash/i)
    expect(calls.beginBulk).toBe(1)
    expect(calls.endBulk).toBe(1) // bracket balanced via try/finally
  })

  it('purgeTrash (ids) erases only same-space delete tombstones, never a live or cross-space note', async () => {
    const { trash, calls } = makeHost({
      space: 'main',
      seeds: {
        live: { kind: 'update', space: 'main' }, // newest is not a delete → skip
        cross: { kind: 'delete', space: 'other' }, // another space → skip
        trashed: { kind: 'delete', space: 'main' }, // the only purgeable one
        // 'ghost' has no tombstone → skip
      },
    })

    const out = await trash.purgeTrash({ ids: ['live', 'cross', 'ghost', 'trashed'] })
    expect(out.purged).toBe(1)
    expect(calls.purged).toEqual([['trashed']])
  })

  it('purgeTrash (all) scans the trash page, forwards q, and purges every matched id', async () => {
    const { trash, calls } = makeHost({
      seeds: { t1: { kind: 'delete' }, t2: { kind: 'delete' } },
      trashedPage: [{ noteId: 't1' }, { noteId: 't2' }],
    })

    const out = await trash.purgeTrash({ all: true, q: 'foo' })
    expect(out.purged).toBe(2)
    expect(calls.purged).toEqual([['t1', 't2']])
    expect(calls.listTrashedQ).toContain('foo')
  })

  it('keeps purge-all pagination stable while a new delete waits on the trash prefix', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `t${i}`)
    const page = ids.map((noteId) => ({ noteId }))
    const seeds = Object.fromEntries(ids.map((id) => [id, { kind: 'delete' as const }]))
    const { host, calls } = makeHost({ seeds, trashedPage: page })
    const coordinator = new MutationCoordinator()
    const trash = new HistorySurface(host, coordinator)
    const listTrashed = host.journal.listTrashed.bind(host.journal)
    let deleteTask: Promise<void> | undefined
    let pages = 0
    let pagesWhenDeleteLanded = -1

    host.journal.listTrashed = async (opts, excludeClasses) => {
      const result = await listTrashed(opts, excludeClasses)

      if (++pages === 1) {
        deleteTask = coordinator.run({ paths: [trashMutationPath('new-delete')] }, async () => {
          pagesWhenDeleteLanded = pages
          page.unshift({ noteId: 'new-delete' })
        })
      }

      return result
    }

    await expect(trash.purgeTrash({ all: true })).resolves.toEqual({ purged: 501 })
    expect(new Set(calls.purged[0])).toEqual(new Set(ids))
    await deleteTask
    expect(pagesWhenDeleteLanded).toBe(2)
    expect(page[0]?.noteId).toBe('new-delete')
  })

  it('keeps restore-all pagination stable while a new delete waits on the trash prefix', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `t${i}`)
    const page = ids.map((noteId) => ({ noteId }))
    const seeds = Object.fromEntries(ids.map((id) => [id, { kind: 'delete' as const }]))
    const { host, calls } = makeHost({ seeds, trashedPage: page })
    const coordinator = new MutationCoordinator()
    const trash = new HistorySurface(host, coordinator)
    const listTrashed = host.journal.listTrashed.bind(host.journal)
    let deleteTask: Promise<void> | undefined
    let pages = 0
    let pagesWhenDeleteLanded = -1

    host.journal.listTrashed = async (opts, excludeClasses) => {
      const result = await listTrashed(opts, excludeClasses)

      if (++pages === 1) {
        deleteTask = coordinator.run({ paths: [trashMutationPath('new-delete')] }, async () => {
          pagesWhenDeleteLanded = pages
          page.unshift({ noteId: 'new-delete' })
        })
      }

      return result
    }

    const result = await trash.restoreTrash({ all: true })
    expect(result.failed).toEqual([])
    expect(new Set(result.restored.map((item) => item.id))).toEqual(new Set(ids))
    expect(calls.writes).toHaveLength(501)
    await deleteTask
    expect(pagesWhenDeleteLanded).toBe(2)
    expect(page[0]?.noteId).toBe('new-delete')
  })

  it('restore surfaces revisionNotFound / revisionHasNoContent honestly', async () => {
    const missing = makeHost({ seeds: {} })
    await expect(
      missing.trash.restore({ id: 'n1', revisionId: 'rX', versionToken: 't' }),
    ).rejects.toMatchObject({ reason: 'revision_not_found' })

    const gapped = makeHost({ seeds: { n1: { content: null } } })
    await expect(
      gapped.trash.restore({ id: 'n1', revisionId: 'rev-n1', versionToken: 't' }),
    ).rejects.toMatchObject({ reason: 'revision_has_no_content' })
  })
})
