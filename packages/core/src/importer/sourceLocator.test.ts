import { describe, expect, it } from 'vitest'

import {
  chatGptConversationSourceLocator,
  claudeConversationSourceLocator,
  claudeDesignChatSourceLocator,
  claudeProjectDocSourceLocator,
  claudeProjectPlacementLocator,
  claudeProjectPromptSourceLocator,
  parseImportSourceLocator,
  serializeImportSourceLocator,
} from './sourceLocator'

describe('import source locators', () => {
  it('round-trips every v1 note and placement tuple with portable UTF-8 ids', () => {
    const locators = [
      claudeConversationSourceLocator(' 对话/α '),
      claudeProjectPromptSourceLocator(' 项目一 '),
      claudeProjectDocSourceLocator('项目一', '文档/一'),
      claudeDesignChatSourceLocator('设计一'),
      chatGptConversationSourceLocator('chat/一'),
      claudeProjectPlacementLocator('项目一'),
    ]

    expect(locators).not.toContain(null)
    for (const locator of locators) {
      expect(locator).toMatch(/^[A-Za-z0-9:_-]+$/u)
      const parsed = parseImportSourceLocator(locator)
      expect(parsed).not.toBeNull()
      expect(parsed && serializeImportSourceLocator(parsed)).toBe(locator)
    }
  })

  it('rejects missing ids, unknown tuples, wrong arity and non-canonical spelling', () => {
    expect(claudeConversationSourceLocator('  ')).toBeNull()
    expect(claudeConversationSourceLocator('bad\nvalue')).toBeNull()
    expect(parseImportSourceLocator('v2:claude:conversation:eA')).toBeNull()
    expect(parseImportSourceLocator('v1:unknown:conversation:eA')).toBeNull()
    expect(parseImportSourceLocator('v1:claude:conversation:eA:eQ')).toBeNull()
    expect(parseImportSourceLocator('v1:claude:project-doc:eA')).toBeNull()
    expect(parseImportSourceLocator('v1:claude:conversation:eA==')).toBeNull()
    expect(parseImportSourceLocator('v1:claude:conversation:ef')).toBeNull()
  })
})
