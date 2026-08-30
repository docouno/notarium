// The class-visibility policy matrix (#74 §2 / #78) — the single source of truth
// every discovery surface consults. This locks the exact policy ROWS against
// silent drift: the `profile` row (#159) flipped userSearch true→false mid-review
// precisely because nothing pinned it, so pin it (and the scope derivations) here.

import { describe, expect, it } from 'vitest'
import {
  CLASS_POLICY,
  classesForScope,
  isVisibleOn,
  NOTE_CLASS,
  NOTE_CLASSES,
  SURFACE,
} from '@notarium/core'

describe('class visibility policy (#78)', () => {
  it('the profile class (#159) is hidden from EVERY discovery surface', () => {
    expect(CLASS_POLICY.profile).toEqual({
      index: true,
      graph: false,
      feed: false,
      tree: false,
      userSearch: false,
      agentRecall: false,
      versioned: true,
      replicate: true,
      providerEgress: true,
    })
    // Every read-facing surface answers false for the profile.
    for (const surface of ['feed', 'tree', 'userSearch', 'graph', 'agentRecall'] as const) {
      expect(isVisibleOn(surface, 'profile')).toBe(false)
    }
  })

  it('profile is admitted only by the `all` scope, never user/agentRecall', () => {
    expect(classesForScope('user').has('profile')).toBe(false)
    expect(classesForScope('agentRecall').has('profile')).toBe(false)
    expect(classesForScope('all').has('profile')).toBe(true)
    // Sanity: the visible default class IS in the user scope.
    expect(classesForScope('user').has('user-doc')).toBe(true)
  })

  it('skill truth is retained but hidden from every generic discovery scope', () => {
    expect(CLASS_POLICY.skill).toEqual({
      index: true,
      graph: false,
      feed: false,
      tree: false,
      userSearch: false,
      agentRecall: false,
      versioned: true,
      replicate: true,
      providerEgress: true,
    })
    for (const surface of ['feed', 'tree', 'userSearch', 'graph', 'agentRecall'] as const) {
      expect(isVisibleOn(surface, 'skill')).toBe(false)
    }
    expect(classesForScope('user').has('skill')).toBe(false)
    expect(classesForScope('agentRecall').has('skill')).toBe(false)
    expect(classesForScope('all').has('skill')).toBe(true)
  })

  it('the registry includes profile and agent-memory stays recall-visible', () => {
    expect(NOTE_CLASSES).toEqual(expect.arrayContaining(['profile', 'skill']))
    // Guard the contrast that makes profile distinct from memory: agent-memory is
    // recall-visible, profile is not.
    expect(classesForScope('agentRecall').has('agent-memory')).toBe(true)
  })

  it('declares model-provider egress as a separate policy axis for every class', () => {
    expect(CLASS_POLICY.attachment.providerEgress).toBe(false)
    expect(CLASS_POLICY.derived.providerEgress).toBe(false)
    expect(new Set(NOTE_CLASSES.filter((cls) => CLASS_POLICY[cls].providerEgress))).toEqual(
      new Set([NOTE_CLASS.userDoc, NOTE_CLASS.agentMemory, NOTE_CLASS.profile, NOTE_CLASS.skill]),
    )

    for (const cls of NOTE_CLASSES) {
      expect(CLASS_POLICY[cls]).toHaveProperty('providerEgress')
    }

    expect(Object.keys(CLASS_POLICY['user-doc'])).toHaveLength(9)
    expect(Object.keys(SURFACE)).toHaveLength(5)
  })
})
