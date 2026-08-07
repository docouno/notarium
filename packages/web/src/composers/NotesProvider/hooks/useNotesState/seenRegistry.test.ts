import { describe, expect, it } from 'vitest'
import { encodeWikilinkIdentity } from '@notarium/core'

import type { NoteView } from '../../../../libs/wire'
import { resolveKnownWiki } from '../../../../widgets/NoteReader/resolveKnownWiki'
import {
  isSeenObservationAccepted,
  rememberSeenNotes,
  removeSeenIds,
  replaceSeenFolder,
} from './seenRegistry'

const note = (id: string, filePath: string): NoteView => ({
  id,
  filePath,
  title: 'Deleted target',
  class: 'user-doc',
  modifiedAt: null,
  createdAt: null,
})

const resolvesStableId = (id: string, seen: ReadonlyMap<string, NoteView>): boolean =>
  resolveKnownWiki(encodeWikilinkIdentity(id), [...seen.values()]) !== null

describe('useNotesState seen registry', () => {
  it('does not resurrect a removed id from a late observation', () => {
    const provisional = note('P', 'old.md')
    const removed = new Map([['P', 1]])
    const afterEvent = removeSeenIds(new Map([['P', provisional]]), ['P'])
    const result = rememberSeenNotes(afterEvent, [provisional], removed, [], 1)

    expect([...result.seen.keys()]).toEqual([])
    expect(result.accepted).toEqual([])
  })

  it('atomically replaces a provisional observation with its durable id', () => {
    const provisional = note('P', 'note.md')
    const durable = note('D', 'note.md')
    const result = rememberSeenNotes(new Map([['P', provisional]]), [durable], new Map(), ['P'])

    expect([...result.seen.keys()]).toEqual(['D'])
    expect(result.accepted).toEqual([durable])
  })

  it('accepts an id again after an authoritative upsert advances the truth epoch', () => {
    const restored = note('P', 'restored.md')
    const removed = new Map([['P', 1]])
    const result = rememberSeenNotes(new Map(), [restored], removed, [], 2)

    expect(result.seen.get('P')).toEqual(restored)
  })

  it('reconciles a missed upsert only from a newer authoritative observation', () => {
    const old = note('P', 'old.md')
    const restored = note('P', 'restored.md')
    const removed = new Map([['P', 1]])
    const stale = rememberSeenNotes(new Map(), [old], removed, [], 1)
    const fresh = rememberSeenNotes(stale.seen, [restored], removed, [], 2)
    const lateStale = rememberSeenNotes(fresh.seen, [old], removed, [], 1)

    expect(stale.accepted).toEqual([])
    expect(fresh.accepted).toEqual([restored])
    expect(lateStale.accepted).toEqual([])
    expect(lateStale.seen.get('P')).toEqual(restored)
  })

  it('rejects request D@1 after removed D@2 but admits a fresh deleted detail', () => {
    const removed = new Map([['D', 2]])

    expect(isSeenObservationAccepted('D', false, removed, 1, 2)).toBe(false)
    expect(isSeenObservationAccepted('D', true, removed, 2, 2)).toBe(true)
    expect(isSeenObservationAccepted('D', false, removed, 3, 3)).toBe(true)
  })

  it('rejects a deleted response superseded by a later restore/upsert epoch', () => {
    const removed = new Map([['D', 1]])

    // Deleted request starts at epoch 1; restore/upsert advances truth to 2
    // before the response lands. The retry at 2 returns the live note.
    expect(isSeenObservationAccepted('D', true, removed, 1, 2)).toBe(false)
    expect(isSeenObservationAccepted('D', false, removed, 2, 2)).toBe(true)
  })

  it('evicts an SSE removed id so stable-id links are reclassified unresolved', () => {
    const deleted = note('deleted-id', 'docs/deleted.md')
    const before = new Map([[deleted.id, deleted]])

    expect(resolvesStableId(deleted.id, before)).toBe(true)
    const after = removeSeenIds(before, [deleted.id])

    expect(after.has(deleted.id)).toBe(false)
    expect(resolvesStableId(deleted.id, after)).toBe(false)
  })

  it('evicts a deleted id when an authoritative folder reload becomes empty', () => {
    const deleted = note('deleted-id', 'docs/deleted.md')
    const before = new Map([[deleted.id, deleted]])

    const after = replaceSeenFolder(before, [deleted], [])

    expect(after.has(deleted.id)).toBe(false)
    expect(resolvesStableId(deleted.id, after)).toBe(false)
  })

  it('does not let an older folder reload evict a note already observed at a new path', () => {
    const stale = note('moved-id', 'docs/moved.md')
    const moved = note('moved-id', 'archive/moved.md')

    const after = replaceSeenFolder(new Map([[moved.id, moved]]), [stale], [])

    expect(after.get(moved.id)).toBe(moved)
  })
})
