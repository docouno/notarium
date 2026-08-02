import { describe, expect, it } from 'vitest'

import { foldTag, matchesTags, normTags, noteHasTag } from './tags'

describe('normTags', () => {
  it('passes an array through; splits a comma string; rejects other shapes', () => {
    expect(normTags(['a', 'b'])).toEqual(['a', 'b'])
    expect(normTags('a, b ,c')).toEqual(['a', 'b', 'c'])
    expect(normTags(undefined)).toBeUndefined()
    expect(normTags(42)).toBeUndefined()
  })
})

describe('foldTag (#109 the match/grouping key)', () => {
  it('case-folds and trims so ML / ml / Ml are one key', () => {
    expect(foldTag('ML')).toBe('ml')
    expect(foldTag('  Ml  ')).toBe('ml')
  })
  it('folds hierarchical tags per segment, collapsing empties and spaces', () => {
    expect(foldTag('Work/Projects')).toBe('work/projects')
    expect(foldTag('Work / Projects ')).toBe('work/projects')
    expect(foldTag('a//b')).toBe('a/b')
    expect(foldTag('  /  ')).toBe('')
  })
  it('case-folds non-ASCII too (cyrillic — the app is RU-heavy)', () => {
    expect(foldTag('Проект')).toBe('проект')
    expect(foldTag('Проект / Альфа')).toBe('проект/альфа')
  })
})

describe('noteHasTag (#109 hierarchical, case-insensitive)', () => {
  it('matches exactly, case-insensitively', () => {
    expect(noteHasTag(['ML'], 'ml')).toBe(true)
    expect(noteHasTag(['ml'], 'ML')).toBe(true)
    expect(noteHasTag(['design'], 'ml')).toBe(false)
  })
  it('a parent query matches a descendant tag (subtree cascade)', () => {
    expect(noteHasTag(['ml/nlp'], 'ml')).toBe(true)
    expect(noteHasTag(['ML/NLP/bert'], 'ml/nlp')).toBe(true)
    // but a leaf query does NOT match an ancestor tag
    expect(noteHasTag(['ml'], 'ml/nlp')).toBe(false)
    // and `ml` must not match an unrelated `mlops` (segment boundary, not prefix)
    expect(noteHasTag(['mlops'], 'ml')).toBe(false)
  })
  it('an empty query tag or empty note tags match nothing', () => {
    expect(noteHasTag(['ml'], '')).toBe(false)
    expect(noteHasTag([], 'ml')).toBe(false)
    expect(noteHasTag(undefined, 'ml')).toBe(false)
  })
})

describe('matchesTags (#109 OR across the set — the unified "add to filter" model)', () => {
  it('an empty/absent query set is no constraint', () => {
    expect(matchesTags(['ml'], undefined)).toBe(true)
    expect(matchesTags(['ml'], [])).toBe(true)
    expect(matchesTags(undefined, [])).toBe(true)
  })
  it('passes on ANY query tag (OR), each hierarchical', () => {
    expect(matchesTags(['ml', 'design'], ['ml', 'design'])).toBe(true) // has both
    expect(matchesTags(['ml'], ['ml', 'design'])).toBe(true) // has ml → union match
    expect(matchesTags(['design'], ['ml', 'design'])).toBe(true) // has design → union match
    expect(matchesTags(['ops'], ['ml', 'design'])).toBe(false) // carries neither
    expect(matchesTags(['ml/nlp'], ['ml', 'design'])).toBe(true) // ml via descendant
  })
})
