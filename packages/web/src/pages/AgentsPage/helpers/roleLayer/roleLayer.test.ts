import { describe, expect, it } from 'vitest'
import type { RoleContextIdentity, RoleContextView } from '@notarium/contract'
import { roleLayerRows } from './roleLayer'

const pin = (noteId: string, order: number) => ({ noteId, title: noteId, tokens: 100, order })

const layer = {
  pins: [pin('a', 0), pin('b', 1)],
  sets: [
    {
      id: 'set-1',
      name: 'One',
      homeSpace: 'me',
      order: 2,
      items: [{ ...pin('c', 0), space: 'me' }],
    },
    {
      id: 'set-2',
      name: 'Two',
      homeSpace: 'me',
      order: 3,
      items: [{ ...pin('c', 0), space: 'me' }],
    },
  ],
} as unknown as Pick<RoleContextIdentity, 'pins' | 'sets'>

describe('the role panel rows', () => {
  it('leaves a row unweighed when no preview weighed the layer', () => {
    const rows = roleLayerRows(layer, undefined)

    expect(rows.pins.map((row) => 'loaded' in row)).toEqual([false, false])
    expect(rows.sets.flatMap((set) => set.items.map((item) => 'loaded' in item))).toEqual([
      false,
      false,
    ])
    // The layer itself is untouched — this door decides nothing about WHAT is in it.
    expect(rows.pins.map((row) => row.noteId)).toEqual(['a', 'b'])
  })

  it('takes each verdict from the preview that weighed the budget', () => {
    const weighed = {
      pins: [
        { ...pin('a', 0), loaded: true },
        { ...pin('b', 1), loaded: false },
      ],
      sets: [
        {
          id: 'set-1',
          name: 'One',
          homeSpace: 'me',
          order: 2,
          items: [{ ...pin('c', 0), space: 'me', loaded: true }],
        },
        {
          id: 'set-2',
          name: 'Two',
          homeSpace: 'me',
          order: 3,
          items: [{ ...pin('c', 0), space: 'me', loaded: false }],
        },
      ],
    } as unknown as Pick<RoleContextView, 'pins' | 'sets'>
    const rows = roleLayerRows(layer, weighed)

    expect(rows.pins.map((row) => row.loaded)).toEqual([true, false])
    // The same note in two sets: the budget trims a SET ITEM, so the verdict follows
    // the pair. Keyed by note alone, the second set would inherit the first's answer.
    expect(rows.sets.map((set) => set.items[0].loaded)).toEqual([true, false])
  })

  it('marks an unprocessed active-role tail unloaded unless a dedup winner loaded', () => {
    const withDedupWinner = {
      ...layer,
      sets: [{ ...layer.sets[0], items: [{ ...pin('a', 0), space: 'me' }] }, layer.sets[1]],
    } as unknown as Pick<RoleContextIdentity, 'pins' | 'sets'>
    const rows = roleLayerRows(withDedupWinner, {
      pins: [{ ...pin('a', 0), loaded: true }],
      sets: [],
    } as unknown as Pick<RoleContextView, 'pins' | 'sets'>)

    expect(rows.pins[0].loaded).toBe(true)
    expect(rows.pins[1].loaded).toBe(false)
    expect(rows.sets[0].items[0].loaded).toBe(true)
    expect(rows.sets[1].items[0].loaded).toBe(false)
  })
})
