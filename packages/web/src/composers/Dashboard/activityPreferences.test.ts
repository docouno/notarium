// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEYS } from '../../libs/storageKeys'
import {
  activityScopeChrome,
  effectiveActivityScope,
  readActivityGroup,
  readActivityScope,
  writeActivityGroup,
  writeActivityScope,
} from './activityPreferences'

describe('Dashboard Activity preferences', () => {
  beforeEach(() => localStorage.clear())

  it('uses Note and Everyone for missing or unknown values', () => {
    expect(readActivityGroup()).toBe('note')
    expect(readActivityScope()).toBe('all')

    localStorage.setItem(STORAGE_KEYS.dashboardActivityGroup, 'future')
    localStorage.setItem(STORAGE_KEYS.dashboardActivityScope, 'team')

    expect(readActivityGroup()).toBe('note')
    expect(readActivityScope()).toBe('all')
  })

  it('writes the frozen literals under the exact keys', () => {
    writeActivityGroup('folder')
    writeActivityScope('mine')

    expect(localStorage.getItem('bm-dashboard-activity-group')).toBe('folder')
    expect(localStorage.getItem('bm-dashboard-activity-scope')).toBe('mine')
  })

  it('degrades when browser storage is blocked', () => {
    const real = localStorage
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })

    expect(readActivityGroup()).toBe('note')
    expect(readActivityScope()).toBe('all')
    expect(() => writeActivityGroup('none')).not.toThrow()
    expect(() => writeActivityScope('mine')).not.toThrow()

    vi.stubGlobal('localStorage', real)
  })

  it('keeps scope chrome across same-Space Groups but clears it across A → B → A', () => {
    let cached = activityScopeChrome(
      'alpha',
      { resolved: true, canScope: true, scope: 'mine' },
      null,
    )

    cached = activityScopeChrome(
      'alpha',
      { resolved: false, canScope: false, scope: 'all' },
      cached,
    )
    expect(cached).toEqual({ space: 'alpha', committed: true, canScope: true, scope: 'mine' })

    cached = activityScopeChrome('beta', { resolved: false, canScope: false, scope: 'all' }, cached)
    expect(cached).toEqual({ space: 'beta', committed: false, canScope: false, scope: 'all' })

    cached = activityScopeChrome(
      'alpha',
      { resolved: false, canScope: false, scope: 'all' },
      cached,
    )
    expect(cached).toEqual({ space: 'alpha', committed: false, canScope: false, scope: 'all' })

    expect(
      activityScopeChrome('alpha', { resolved: true, canScope: false, scope: 'all' }, cached),
    ).toEqual({ space: 'alpha', committed: true, canScope: false, scope: 'all' })
  })

  it('makes an explicit Everyone choice effective without reusing committed Mine', () => {
    const committedMine = {
      space: 'alpha',
      committed: true,
      canScope: true,
      scope: 'mine' as const,
    }

    expect(effectiveActivityScope('all', committedMine)).toBe('all')
    expect(effectiveActivityScope('mine', committedMine)).toBe('mine')
  })
})
