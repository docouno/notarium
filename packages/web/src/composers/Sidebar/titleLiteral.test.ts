// @vitest-environment jsdom

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'

import type { NoteView } from '../../libs/wire'
import { NoteRow } from './NoteRow'
import type { DndBag, TreeApi } from './types'

const dnd = {
  selectedKeys: new Set<string>(),
  draggingKeys: new Set<string>(),
  contextItems: () => [],
  onSelect: () => {},
  beginDrag: () => {},
  endItemDrag: () => {},
} as unknown as DndBag

const tree = {
  renaming: null,
  menuTarget: null,
  canWrite: false,
  openMenu: () => {},
} as unknown as TreeApi

describe('sidebar note titles', () => {
  it.each(['[MCP] Review', '[[Foo]]'])('renders %s as literal React text', (title) => {
    const note: NoteView = {
      id: 'literal-title-id',
      title,
      filePath: 'literal-title.md',
      modifiedAt: null,
      createdAt: null,
    }
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(NoteRow, {
          note,
          depth: 0,
          activeId: null,
          onOpen: () => {},
          dnd,
          tree,
        }),
      ),
    )
    const host = document.createElement('div')

    host.innerHTML = html
    expect(host.textContent).toContain(title)
    expect(host.querySelectorAll('a')).toHaveLength(1)
  })
})
