import { describe, expect, it } from 'vitest'

import { MAX_SKILL_TOKEN, parseSkillLinks, serializeSkillLocator } from './skillLinks'

describe('skill attachment syntax', () => {
  it('preserves malformed exact-looking tokens and authored order without deduplication', () => {
    const malformed = '[[notarium-id:space:broken|evidence]]'
    const system = '[[notarium-id:system:_55UeQqGnMrH|research-evidence]]'

    expect(parseSkillLinks(`${malformed} ${system} ${system}`)).toEqual([
      { kind: 'invalid', raw: malformed, reason: 'invalid-locator' },
      {
        kind: 'locator',
        source: 'system',
        packageId: '_55UeQqGnMrH',
        label: 'research-evidence',
        raw: system,
      },
      {
        kind: 'locator',
        source: 'system',
        packageId: '_55UeQqGnMrH',
        label: 'research-evidence',
        raw: system,
      },
    ])
  })

  it('serializes the exact System and Owned persisted forms', () => {
    expect(
      serializeSkillLocator({
        source: 'system',
        packageId: '_55UeQqGnMrH',
        label: 'research-evidence',
      }),
    ).toBe('[[notarium-id:system:_55UeQqGnMrH|research-evidence]]')
    expect(
      serializeSkillLocator({
        scope: 'space',
        packageId: 'AbCdefGhij_1',
        label: 'shared-skill',
      }),
    ).toBe('[[notarium-id:space:AbCdefGhij_1|shared-skill]]')
  })

  it('keeps a token it cannot read instead of deciding it was never there', () => {
    // A package edited on disk or arriving by import may hold anything. The parser is
    // not the authority on what belongs in the list — the file is.
    expect(parseSkillLinks('[[Research Evidence]] [[not a skill]] [[]]')).toEqual([
      { kind: 'invalid', raw: '[[Research Evidence]]', reason: 'invalid-locator' },
      { kind: 'invalid', raw: '[[not a skill]]', reason: 'invalid-locator' },
    ])
  })
})

describe('skill attachment syntax stays inside what the wire can carry', () => {
  /** A hand-edited or imported `SKILL.md` may name a real package under a label no
   *  skill may have. Reading it as an EXACT attachment handed the wire a label past
   *  its 64-character bound, and the detail door answered 500 for a package the host
   *  had just called valid. Unresolvable is the honest reading, and it keeps the raw. */
  it('reads a locator whose label is not a skill name as unresolvable, not as exact', () => {
    const long = `[[notarium-id:system:_55UeQqGnMrH|${'a'.repeat(65)}]]`
    const trailing = '[[notarium-id:system:_55UeQqGnMrH|evidence-]]'
    const doubled = '[[notarium-id:system:_55UeQqGnMrH|ev--idence]]'

    expect(parseSkillLinks(`${long} ${trailing} ${doubled}`)).toEqual([
      { kind: 'invalid', raw: long, reason: 'invalid-locator' },
      { kind: 'invalid', raw: trailing, reason: 'invalid-locator' },
      { kind: 'invalid', raw: doubled, reason: 'invalid-locator' },
    ])
    expect(parseSkillLinks(`[[notarium-id:system:_55UeQqGnMrH|${'a'.repeat(64)}]]`)).toEqual([
      {
        kind: 'locator',
        source: 'system',
        packageId: '_55UeQqGnMrH',
        label: 'a'.repeat(64),
        raw: `[[notarium-id:system:_55UeQqGnMrH|${'a'.repeat(64)}]]`,
      },
    ])
  })

  /** The bound is on the whole token because `raw` is what travels. Measured on the
   *  target instead, it produced four characters more than the wire accepts. */
  it('recognises a token exactly as long as the wire carries it, and no longer', () => {
    const longest = `[[${'a'.repeat(MAX_SKILL_TOKEN - 4)}]]`
    const over = `[[${'a'.repeat(MAX_SKILL_TOKEN - 3)}]]`

    expect(parseSkillLinks(longest)).toEqual([
      { kind: 'invalid', raw: longest, reason: 'invalid-locator' },
    ])
    expect(longest).toHaveLength(MAX_SKILL_TOKEN)
    expect(parseSkillLinks(over)).toEqual([])
  })

  it('refuses to serialize a label no skill may be called', () => {
    expect(() =>
      serializeSkillLocator({
        source: 'system',
        packageId: '_55UeQqGnMrH',
        label: 'a'.repeat(65),
      }),
    ).toThrow('invalid skill locator label')
  })
})
