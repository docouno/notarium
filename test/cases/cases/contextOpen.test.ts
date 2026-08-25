import { describe, expect, it } from 'vitest'

import { buildCaseWorld } from '../build'

const creates = (scale: number) =>
  buildCaseWorld('context-open', { scale }).events.filter((event) => event.op === 'create')

describe('context-open seed shape', () => {
  it.each([
    [0.045, 4],
    [1, 90],
    [3, 270],
  ])('scales only project-memory categories at SCALE=%s', (scale, categories) => {
    const events = creates(scale)
    const projectMemory = events.filter((event) => event.projectMemory).length
    const projectCorpus = events.filter((event) => event.path.startsWith('product/corpus/')).length
    const personalCorpus = events.filter(
      (event) => event.space === 'context-me' && event.path.startsWith('corpus/'),
    ).length
    const pins = events.filter((event) => event.pin || event.tags?.includes('always-load')).length

    expect(projectMemory).toBe(categories)
    expect(projectCorpus).toBe(1_100)
    expect(personalCorpus).toBe(2_700)
    // Twelve authored pins plus the profile note, which is itself always-load.
    expect(pins).toBe(13)
    expect(events.filter((event) => event.class === 'profile')).toHaveLength(1)
  })
})
