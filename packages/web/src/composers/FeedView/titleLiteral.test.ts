// @vitest-environment jsdom

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { NoteView } from '../../libs/wire'
import { FeedCard } from './FeedItems'

vi.mock('../FieldSchemaProvider', () => ({
  useFieldSchema: () => ({ fields: [] }),
}))

const dom = (html: string): HTMLDivElement => {
  const host = document.createElement('div')

  host.innerHTML = html
  return host
}

describe('feed note titles', () => {
  it.each(['[MCP] Review', '[[Foo]]'])('renders %s as literal React text', (title) => {
    const note: NoteView = {
      id: 'literal-title-id',
      title,
      filePath: 'literal-title.md',
      modifiedAt: null,
      createdAt: null,
    }
    const card = dom(
      renderToStaticMarkup(
        createElement(FeedCard, { note, dateValue: null, onOpen: () => {}, lines: 2 }),
      ),
    )

    expect(card.textContent).toContain(title)
    expect(card.querySelectorAll('a')).toHaveLength(1)
  })
})
