// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { FieldRows } from './FieldRows'
import { FieldValueControl } from './FieldValueControl'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mount = async (element: ReturnType<typeof createElement>) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(element))
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

const typeInto = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

describe('FieldValueControl metadata seams', () => {
  it('keeps a mismatched date raw instead of coercing it through Date', async () => {
    const view = await mount(
      createElement(FieldValueControl, {
        declaration: { key: 'due', label: 'Due', type: 'date' },
        fieldLabel: 'Due',
        value: '01/02/2026',
        present: true,
        unreadable: false,
        readOnly: true,
        disabled: false,
        onChange: () => undefined,
      }),
    )

    expect(view.container.textContent).toBe('01/02/2026')
    await view.unmount()
  })

  it('offers Remove for a present explicit-empty custom date', async () => {
    const view = await mount(
      createElement(FieldValueControl, {
        declaration: { key: 'due', label: 'Due', type: 'date' },
        fieldLabel: 'Due',
        value: '',
        present: true,
        unreadable: false,
        readOnly: false,
        appearance: 'inline',
        disabled: false,
        onChange: () => undefined,
      }),
    )

    expect(view.container.querySelector('button[aria-label="Clear Due value"]')).not.toBeNull()
    await view.unmount()
  })

  it('disables enum and date controls while another inline field write is busy', async () => {
    const onSetField = vi.fn()
    const view = await mount(
      createElement(FieldRows, {
        frontmatter: {},
        details: {
          keys: { status: 'doing', due: '2026-09-01' },
          order: ['status', 'due'],
        },
        schema: [
          {
            key: 'status',
            label: 'Status',
            type: 'enum',
            values: [{ key: 'doing', label: 'Doing' }],
          },
          { key: 'due', label: 'Due', type: 'date' },
        ],
        readOnly: false,
        appearance: 'inline',
        busyKey: 'status',
        onSetField,
      }),
    )

    expect(
      (view.container.querySelector('button[aria-label^="Status value"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(
      (view.container.querySelector('button[aria-label^="Due value"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await view.unmount()
  })

  it('renders skill manifest name as read-only even for a writer', async () => {
    const onSetField = vi.fn()
    const view = await mount(
      createElement(FieldRows, {
        frontmatter: {},
        details: { keys: { name: 'Research skill' }, order: ['name'] },
        schema: [{ key: 'name', label: 'Name', type: 'text' }],
        readOnly: false,
        agentKind: 'skill',
        onSetField,
      }),
    )

    expect(view.container.querySelector('input[aria-label="Name value"]')).toBeNull()
    expect(view.container.textContent).toContain('Research skill')
    await view.unmount()
  })

  it('publishes text into an editor-owned draft immediately but keeps point writes blur-bound', async () => {
    const editorChange = vi.fn()
    const editor = await mount(
      createElement(FieldValueControl, {
        declaration: { key: 'client', label: 'Client', type: 'text' },
        fieldLabel: 'Client',
        value: 'Acme',
        present: true,
        unreadable: false,
        readOnly: false,
        appearance: 'inline',
        disabled: false,
        liveDraft: true,
        onChange: editorChange,
      }),
    )
    const editorInput = editor.container.querySelector('input') as HTMLInputElement
    await typeInto(editorInput, 'Globex')
    expect(editorChange).toHaveBeenLastCalledWith('Globex')
    await editor.unmount()

    const pointChange = vi.fn()
    const point = await mount(
      createElement(FieldValueControl, {
        declaration: { key: 'client', label: 'Client', type: 'text' },
        fieldLabel: 'Client',
        value: 'Acme',
        present: true,
        unreadable: false,
        readOnly: false,
        appearance: 'inline',
        disabled: false,
        onChange: pointChange,
      }),
    )
    const pointInput = point.container.querySelector('input') as HTMLInputElement
    await typeInto(pointInput, 'Globex')
    expect(pointChange).not.toHaveBeenCalled()
    await act(async () => pointInput.blur())
    expect(pointChange).toHaveBeenLastCalledWith('Globex')
    await point.unmount()
  })

  it('does not expose write controls for opaque details or unsafe YAML keys', async () => {
    const view = await mount(
      createElement(FieldRows, {
        frontmatter: { client: 'Acme', '__proto__.bad': 'unsafe' },
        values: { client: 'Acme', '__proto__.bad': 'unsafe' },
        schema: [
          { key: 'client', label: 'Client', type: 'text' },
          { key: '__proto__.bad', label: 'Unsafe', type: 'text' },
        ],
        structured: false,
        readOnly: false,
        onSetField: vi.fn(),
      }),
    )

    expect(view.container.querySelector('input')).toBeNull()
    expect(view.container.textContent).toContain('Acme')
    expect(view.container.textContent).toContain('unsafe')
    await view.unmount()

    const unsafe = Object.create(null) as Record<string, string>
    unsafe['__proto__'] = 'unsafe'
    const unsafeView = await mount(
      createElement(FieldRows, {
        frontmatter: unsafe,
        details: { keys: unsafe, order: ['__proto__'] },
        values: unsafe,
        structured: true,
        readOnly: false,
        onSetField: vi.fn(),
      }),
    )
    expect(unsafeView.container.querySelector('input')).toBeNull()
    expect(unsafeView.container.textContent).toContain('unsafe')
    await unsafeView.unmount()
  })

  it('associates a declared-type mismatch with its editable control', async () => {
    const view = await mount(
      createElement(FieldRows, {
        frontmatter: {},
        details: { keys: { priority: 'high' }, order: ['priority'] },
        schema: [{ key: 'priority', label: 'Priority', type: 'number' }],
        readOnly: false,
        onSetField: vi.fn(),
      }),
    )
    const input = view.container.querySelector('input[aria-label="Priority value"]')
    const describedBy = input?.getAttribute('aria-describedby')

    expect(input?.getAttribute('aria-invalid')).toBe('true')
    expect(describedBy).toBeTruthy()
    expect(view.container.querySelector(`[id="${describedBy}"]`)?.textContent).toContain(
      'Does not match declared type',
    )
    await view.unmount()
  })
})
