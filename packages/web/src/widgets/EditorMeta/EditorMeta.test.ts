// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { EditorMeta } from './EditorMeta'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('EditorMeta opaque fallback', () => {
  it('shows fallback custom metadata without offering unproven field controls', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        createElement(EditorMeta, {
          editor: {
            title: 'Opaque',
            slug: '',
            setSlug: vi.fn(),
            noteType: 'note',
            setNoteType: vi.fn(),
            fields: {},
            frontmatter: { custom: 'visible' },
            fieldsStructured: false,
            setField: vi.fn(),
            setPendingField: vi.fn(),
            tags: [],
            setTags: vi.fn(),
            createdDate: '2026-08-22',
            setCreatedDate: vi.fn(),
          },
        }),
      )
    })

    const row = container.querySelector('[data-field="custom"]')
    expect(row?.textContent).toContain('visible')
    expect(row?.querySelector('input')).toBeNull()
    expect(row?.querySelector('button')).toBeNull()
    expect(
      container.querySelector('[data-field="Created"] button')?.getAttribute('aria-label'),
    ).toBe('Creation date: Aug 22, 2026')
    await act(async () => root.unmount())
    container.remove()
  })
})
