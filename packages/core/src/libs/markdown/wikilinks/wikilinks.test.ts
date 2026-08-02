import { describe, expect, it } from 'vitest'

import { parseWikilinks } from './wikilinks'

describe('parseWikilinks', () => {
  it('extracts targets in order, keeping duplicates', () => {
    expect(parseWikilinks('a [[One]] b [[Two]] c [[One]]')).toEqual(['One', 'Two', 'One'])
  })

  it('takes the target side of [[target|alias]]', () => {
    expect(parseWikilinks('[[Real Note|shown as this]]')).toEqual(['Real Note'])
  })

  it('drops #fragments — links resolve to whole notes', () => {
    expect(parseWikilinks('[[Note#section]]')).toEqual(['Note'])
  })

  it('ignores empty and whitespace-only targets', () => {
    expect(parseWikilinks('[[ ]] [[|alias]] [[#only-fragment]]')).toEqual([])
  })

  it('handles paths and an empty body', () => {
    expect(parseWikilinks('see [[dir/Sub Note]]')).toEqual(['dir/Sub Note'])
    expect(parseWikilinks('')).toEqual([])
  })
})
