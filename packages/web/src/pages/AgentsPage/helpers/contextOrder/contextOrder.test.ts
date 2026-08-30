import { describe, expect, it } from 'vitest'

import { orderItemsBy } from './contextOrder'

describe('context set optimistic order', () => {
  it('mirrors the server by refilling only named slots', () => {
    const items = ['a', 'hidden-1', 'b', 'hidden-2', 'c'].map((noteId) => ({ noteId }))

    expect(orderItemsBy(items, ['c', 'a', 'b']).map((item) => item.noteId)).toEqual([
      'c',
      'hidden-1',
      'a',
      'hidden-2',
      'b',
    ])
  })
})
