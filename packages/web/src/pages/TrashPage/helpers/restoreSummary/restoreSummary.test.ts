import { describe, expect, it } from 'vitest'
import { restoreSummary } from './restoreSummary'

describe('restoreSummary', () => {
  it('names the available subset and the rows intentionally left in Trash', () => {
    expect(restoreSummary(2, 2, [], 4)).toEqual({
      tone: 'success',
      text: 'Restored 2 available items. 4 unavailable items remain in Trash.',
    })
  })

  it('keeps an operational conflict separate from intrinsic unavailability', () => {
    expect(
      restoreSummary(
        2,
        1,
        [{ id: 'collision', error: 'Restore conflict', reason: 'physical-target-changed' }],
        3,
      ),
    ).toEqual({
      tone: 'warning',
      text: 'Restored 1 of 2 available items. 1 couldn’t be restored. The original path is occupied by another note. Move or rename that note, then try restoring again. 3 unavailable items remain in Trash.',
    })
  })

  it('explains how to clear a single occupied restore target', () => {
    expect(
      restoreSummary(1, 0, [
        {
          id: 'collision',
          error: 'Restore conflict',
          reason: 'physical-target-changed',
        },
      ]),
    ).toEqual({
      tone: 'error',
      text: 'The original path is occupied by another note. Move or rename that note, then try restoring again.',
    })
  })
})
