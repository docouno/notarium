// @vitest-environment jsdom

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NoteView } from '../../libs/wire'
import { dropPreviews, primePreviews } from '../../services/previews'
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
  afterEach(() => dropPreviews(['unavailable-board']))
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

  it('prefers an immediate primary-view summary over the generic preview skeleton', () => {
    const note: NoteView = {
      id: 'board-id',
      title: 'Board',
      filePath: 'board.md',
      modifiedAt: null,
      createdAt: null,
      viewType: 'board',
      viewSummary: { status: 'ready', text: '4 columns · 12 cards' },
    }
    const card = dom(
      renderToStaticMarkup(
        createElement(FeedCard, { note, dateValue: null, onOpen: () => {}, lines: 2 }),
      ),
    )

    expect(card.textContent).toContain('4 columns · 12 cards')
    expect(card.querySelector('.feed-snippet-skeleton')).toBeNull()
  })

  it('falls back to authored prose instead of rendering an unavailable-view label', () => {
    primePreviews([
      [
        'unavailable-board',
        { snippet: 'Useful board prose.', image: null, tags: [], words: 3, tokens: 4 },
      ],
    ])
    const note: NoteView = {
      id: 'unavailable-board',
      title: 'Board',
      filePath: 'board.md',
      modifiedAt: null,
      createdAt: null,
      viewType: 'board',
      viewSummary: { status: 'unavailable', text: 'View unavailable' },
    }
    const card = dom(
      renderToStaticMarkup(
        createElement(FeedCard, { note, dateValue: null, onOpen: () => {}, lines: 2 }),
      ),
    )

    expect(card.textContent).toContain('Useful board prose.')
    expect(card.textContent).not.toContain('View unavailable')
  })
})
