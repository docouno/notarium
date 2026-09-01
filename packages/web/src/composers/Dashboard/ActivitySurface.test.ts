import { describe, expect, it } from 'vitest'
import type { ActivityResponse } from '@notarium/contract'
import { activityHeatmapSnapshot } from './ActivitySurface'

const activity: ActivityResponse = {
  days: [],
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-12-31T00:00:00.000Z',
  hasOtherAuthors: true,
}
const everyoneActivity: ActivityResponse = {
  ...activity,
  days: [{ date: '2026-08-31', created: 1, edited: 1, deleted: 0, unavailable: 0, total: 2 }],
}

describe('Dashboard Activity heatmap snapshot', () => {
  it('keeps an exact warm Mine aggregate while another Group resolves its gate', () => {
    expect(
      activityHeatmapSnapshot(activity, everyoneActivity, 'mine', 'mine', true, true, false),
    ).toBe(activity)
  })

  it('keeps the first preferred Mine load honest until its effective scope resolves', () => {
    expect(
      activityHeatmapSnapshot(activity, everyoneActivity, 'mine', 'all', false, false, false),
    ).toBeNull()
    expect(
      activityHeatmapSnapshot(activity, everyoneActivity, 'mine', 'mine', true, true, false),
    ).toBe(activity)
  })

  it('selects the true Everyone aggregate even while committed scope still points at Mine', () => {
    expect(
      activityHeatmapSnapshot(activity, everyoneActivity, 'all', 'mine', true, true, true),
    ).toBe(everyoneActivity)
    expect(activityHeatmapSnapshot(activity, null, 'all', 'mine', false, false, true)).toBeNull()
  })

  it('clears preferred Mine only for a typed projection rebuild', () => {
    expect(
      activityHeatmapSnapshot(activity, everyoneActivity, 'mine', 'mine', true, true, true),
    ).toBeNull()
  })

  it('retains committed Everyone in a solo Space with latent preferred Mine', () => {
    expect(
      activityHeatmapSnapshot(activity, everyoneActivity, 'mine', 'all', true, false, false),
    ).toBe(activity)
  })

  it('does not publish Everyone while a shared Space switches explicitly to Mine', () => {
    expect(
      activityHeatmapSnapshot(activity, everyoneActivity, 'mine', 'all', true, true, false),
    ).toBeNull()
  })
})
