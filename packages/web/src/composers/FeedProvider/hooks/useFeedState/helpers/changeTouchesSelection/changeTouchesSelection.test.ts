import { describe, expect, it } from 'vitest'

import { changeTouchesSelection } from './changeTouchesSelection'

/** The session's resolution cache: ids it never saw resolve to null. */
const seen =
  (locations: Record<string, string>) =>
  (id: string): string | null =>
    locations[id] ?? null

describe('changeTouchesSelection', () => {
  it('follows a move INTO the selection the session cache still places outside it', () => {
    const selected = new Set(['demo'])
    const dirOfId = seen({ moved: 'archive/2020' })

    expect(changeTouchesSelection(selected, ['moved'], dirOfId, ['demo'])).toBe(true)
    // The old axis alone — the cache holding the folder the note LEFT — misses it.
    expect(changeTouchesSelection(selected, ['moved'], dirOfId, [])).toBe(false)
  })

  it('cascades the event folders into subtrees, like the filter itself', () => {
    expect(
      changeTouchesSelection(new Set(['demo']), ['moved'], seen({ moved: 'archive' }), [
        'demo/sub',
      ]),
    ).toBe(true)
  })

  it('matches an event folder under any of several selected subtrees', () => {
    expect(
      changeTouchesSelection(new Set(['demo', 'archive']), ['moved'], seen({ moved: 'notes' }), [
        'archive/2020',
      ]),
    ).toBe(true)
  })

  it('skips a change whose both ends sit outside the selection', () => {
    expect(
      changeTouchesSelection(new Set(['demo']), ['moved'], seen({ moved: 'notes' }), [
        'archive/2020',
      ]),
    ).toBe(false)
  })

  it('keeps a removed note relevant by its old location (the event advertises none)', () => {
    expect(changeTouchesSelection(new Set(['demo']), ['gone'], seen({ gone: 'demo' }), [])).toBe(
      true,
    )
  })

  it('falls back to the cached location when a legacy frame omits event folders', () => {
    const selected = new Set(['demo'])

    expect(changeTouchesSelection(selected, ['inside'], seen({ inside: 'demo' }), undefined)).toBe(
      true,
    )
    expect(
      changeTouchesSelection(selected, ['outside'], seen({ outside: 'archive' }), undefined),
    ).toBe(false)
  })

  it('treats an id the session cannot place as possibly visible', () => {
    expect(changeTouchesSelection(new Set(['demo']), ['unknown'], seen({}), [])).toBe(true)
  })
})
