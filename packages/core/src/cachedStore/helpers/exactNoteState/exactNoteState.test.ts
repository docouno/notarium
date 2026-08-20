import { describe, expect, it } from 'vitest'

import { claudeConversationSourceLocator } from '../../../importer'
import { parseLogicalNoteState } from '../../../libs/markdown'
import { IMPORT_SOURCE_FRONTMATTER_KEY } from '../../../sourceIdentity'
import { exactLogicalState, exactVersionToken } from './exactNoteState'

const base = {
  title: 'Projection',
  content: 'body',
  frontmatter: {},
}

describe('capability-thin exact note state', () => {
  it('ignores raw reserved claims and invalid typed locators', () => {
    const raw = claudeConversationSourceLocator('raw-rival')!
    const plain = exactVersionToken(base)

    expect(
      exactVersionToken({
        ...base,
        frontmatter: { [IMPORT_SOURCE_FRONTMATTER_KEY]: raw },
      }),
    ).toBe(plain)
    expect(exactVersionToken({ ...base, sourceLocator: 'not-a-locator' })).toBe(plain)
  })

  it('takes one valid typed locator over a competing raw claim', () => {
    const typed = claudeConversationSourceLocator('typed-owner')!
    const raw = claudeConversationSourceLocator('raw-rival')!
    const clean = { ...base, sourceLocator: typed }
    const rival = {
      ...clean,
      frontmatter: { [IMPORT_SOURCE_FRONTMATTER_KEY]: raw },
    }

    expect(exactVersionToken(rival)).toBe(exactVersionToken(clean))
    expect(parseLogicalNoteState(exactLogicalState(rival)).frontmatter).toEqual([
      expect.objectContaining({
        key: IMPORT_SOURCE_FRONTMATTER_KEY,
        lines: [`${IMPORT_SOURCE_FRONTMATTER_KEY}: ${typed}`],
      }),
    ])
  })
})
