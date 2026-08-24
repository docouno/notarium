// @vitest-environment jsdom

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ToastProvider } from '../../core/Toast'
import { NoteReader } from './NoteReader'

describe('reader note titles', () => {
  it.each(['[MCP] Review', '[[Foo]]'])('renders %s as literal React text', (title) => {
    const html = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(NoteReader, {
          note: {
            id: 'literal-title-id',
            title,
            content: '',
            frontmatter: {},
            versionToken: 'v1',
          },
        }),
      ),
    )
    const host = document.createElement('div')

    host.innerHTML = html
    expect(host.querySelector('.doc-title')?.textContent).toBe(title)
    expect(host.querySelector('.doc-title')?.querySelector('a')).toBeNull()
  })
})
