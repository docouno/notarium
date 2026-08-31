// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FieldDeclaration } from '@notarium/contract'
import type { NoteDetailView } from '../../libs/wire'
import { MetaPanel } from './MetaPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const note: Pick<NoteDetailView, 'frontmatter' | 'fields' | 'class' | 'createdAt' | 'modifiedAt'> =
  {
    class: 'user-doc',
    createdAt: '2026-08-20T09:00:00.000Z',
    modifiedAt: '2026-08-22T10:00:00.000Z',
    frontmatter: {
      status: 'doing',
      priority: 'high',
      approved: 'true',
      due: '2026-09-01T10:00:00Z',
      reviewers: ['ann', 'bo'],
      keeper: '',
      view: 'board',
      'notarium-created': '2026-08-22',
    },
    fields: {
      keys: {
        status: 'doing',
        priority: 'high',
        approved: 'true',
        due: '2026-09-01T10:00:00Z',
        reviewers: ['ann', 'bo'],
        keeper: '',
        view: 'board',
        large: 'visible from detail',
      },
      unreadable: ['broken'],
      unreadableMore: 3,
      truncated: ['large'],
      truncatedMore: 2,
      order: [
        'status',
        'priority',
        'approved',
        'due',
        'broken',
        'reviewers',
        'keeper',
        'view',
        'large',
        'notarium-created',
      ],
    },
  }

const schema: FieldDeclaration[] = [
  {
    key: 'status',
    label: 'Status',
    type: 'enum',
    values: [
      { key: 'todo', label: 'Todo', color: 'slate' },
      { key: 'doing', color: 'amber' },
    ],
  },
  { key: 'priority', label: 'Priority', type: 'number' },
  { key: 'approved', label: 'Approved', type: 'checkbox' },
  { key: 'due', label: 'Due', type: 'date' },
  { key: 'missing', label: 'Missing field', type: 'text' },
]

describe('MetaPanel field rows', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const render = async (props: Record<string, unknown> = {}) => {
    await act(async () => {
      root.render(
        createElement(MetaPanel, {
          note,
          schema,
          ...props,
        }),
      )
    })
  }

  it('separates declared and open-world rows without hiding field states', async () => {
    await render()

    expect(container.querySelectorAll('[data-field="Status"]')).toHaveLength(1)
    expect(container.querySelector('[data-field="Status"]')?.textContent).toContain('Doing')
    expect(container.querySelector('[data-field="Missing field"] input')).toBeNull()
    expect(container.querySelector('[data-field="Missing field"]')?.textContent).toContain('—')
    expect(container.querySelector('[data-field="Missing field"]')?.textContent).not.toContain(
      'Not set',
    )
    expect(container.querySelector('[data-field="Priority"]')?.textContent).toContain(
      'Does not match declared type',
    )
    expect(container.querySelector('[data-field="broken"]')?.textContent).toContain(
      'Unreadable value',
    )
    expect(container.querySelector('[data-field="keeper"]')?.textContent).toContain('—')
    expect(container.querySelector('[data-field="keeper"]')?.textContent).not.toContain(
      'Empty value',
    )
    expect(container.querySelector('[data-field="view"]')).toBeNull()
    expect(container.textContent).not.toContain('Read-only metadata')
    expect(container.querySelector('[data-field="Folder"]')).toBeNull()
    const rows = [...container.querySelectorAll('[data-field]')].map((row) =>
      row.getAttribute('data-field'),
    )
    expect(rows[0]).toBe('Type')
    expect(rows.slice(-4)).toEqual(['Class', 'Created', 'Modified', 'Tags'])
    expect(container.textContent).not.toContain('notarium-created')
    expect(container.querySelector('[data-testid="unindexed-fields"]')?.textContent).toContain(
      '6 fields not fully indexed',
    )

    const openRows = [
      ...container.querySelectorAll('[data-testid="undeclared-fields"] [data-field]'),
    ].map((element) => element.getAttribute('data-field'))
    expect(openRows).toEqual(['broken', 'reviewers', 'keeper', 'large'])
  })

  it('offers no field mutation affordance in read mode', async () => {
    await render()

    for (const label of ['Status', 'Priority', 'Missing field', 'reviewers', 'keeper', 'large']) {
      expect(container.querySelector(`[data-field="${label}"] input`), label).toBeNull()
      expect(container.querySelector(`[data-field="${label}"] button`), label).toBeNull()
    }
  })

  it('progressively reveals cap-sized open-world metadata in authored order', async () => {
    const keys = Object.fromEntries(
      Array.from({ length: 130 }, (_, index) => [`open-${String(index).padStart(3, '0')}`, 'v']),
    )
    const order = Object.keys(keys)

    await render({
      schema: [],
      note: {
        ...note,
        frontmatter: keys,
        fields: { keys, order },
      },
    })

    const rows = () =>
      container.querySelectorAll('[data-testid="undeclared-fields"] [data-field]').length

    expect(rows()).toBe(64)
    expect(container.querySelector('[data-field="open-000"]')).not.toBeNull()
    expect(container.querySelector('[data-field="open-064"]')).toBeNull()

    await act(async () => {
      ;(
        container.querySelector('[data-testid="show-more-undeclared-fields"]') as HTMLElement
      ).click()
    })
    expect(rows()).toBe(128)
    expect(container.querySelector('[data-field="open-127"]')).not.toBeNull()
  })

  it('renders every declared field immediately instead of paging the schema', async () => {
    const declarations = Array.from({ length: 128 }, (_, index) => ({
      key: `declared-${String(index).padStart(3, '0')}`,
      type: 'text' as const,
    }))

    await render({ schema: declarations })

    expect(container.querySelectorAll('[data-testid="declared-fields"] [data-field]')).toHaveLength(
      128,
    )
    expect(container.querySelector('[data-testid="show-more-undeclared-fields"]')).toBeNull()
  })

  it('offers quiet custom controls to a writer without exposing protected values', async () => {
    const onSetField = vi.fn()

    await render({ canWrite: true, onSetField })

    expect(container.querySelector('[data-field="Status"] button')).not.toBeNull()
    expect(container.querySelector('[data-field="Priority"] input')).not.toBeNull()
    expect(container.querySelector('[data-field="Approved"] [role="switch"]')).not.toBeNull()
    expect(container.querySelector('[data-field="Due"] button')).not.toBeNull()
    expect(container.querySelector('[data-field="Due"] input')).toBeNull()
    expect(container.querySelector('[data-field="Missing field"] input')).not.toBeNull()
    expect(container.querySelector('[data-field="reviewers"] input')).not.toBeNull()
    expect(container.querySelector('[data-field="view"] input')).toBeNull()
    expect(
      container.querySelector('[data-field="Priority"] input')?.getAttribute('aria-label'),
    ).toBe('Priority value')
    expect(container.querySelector('[data-field="Due"] button')?.getAttribute('aria-label')).toBe(
      'Due value: Sep 1, 2026',
    )
    expect(
      container.querySelector('[data-field="reviewers"] input')?.getAttribute('aria-label'),
    ).toBe('reviewers value')
  })

  it('keeps an explicit typed empty neutral and on its declared control', async () => {
    const empty = {
      ...note,
      frontmatter: { ...note.frontmatter, due: '' },
      fields: {
        ...note.fields!,
        keys: { ...note.fields!.keys, due: '' },
      },
    }

    await render({ note: empty, canWrite: true, onSetField: vi.fn() })

    expect(container.querySelector('[data-field="Due"]')?.textContent).not.toContain(
      'Does not match declared type',
    )
    expect(container.querySelector('[data-field="Due"] button')).not.toBeNull()
    expect(container.querySelector('[data-field="Due"] input')).toBeNull()
  })
})
