import { useMemo } from 'react'
import { labelOfBucket } from '../../../../libs/feed/feedDates'
import type { FeedState } from '../../../FeedProvider'

// Section starts from the server histogram (#64): window index → header label.
// Grouped layouts are laid out from counts alone — no neighbouring items
// needed, so sparse windows can land anywhere without moving a header.
export const useSectionStarts = (feed: FeedState): Map<number, string> | null => {
  // Render by the grouping the CURRENT buckets describe, not the selected group —
  // they swap together so a grouping change never flashes ungrouped (see useFeedState).
  const { buckets, bucketsGroup } = feed
  return useMemo(() => {
    if (bucketsGroup === 'off' || !buckets) {
      return null
    }
    const starts = new Map<number, string>()
    let acc = 0

    for (const b of buckets) {
      starts.set(acc, labelOfBucket(b.key, bucketsGroup))
      acc += b.count
    }

    return starts
  }, [buckets, bucketsGroup])
}
