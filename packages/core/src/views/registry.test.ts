import { describe, expect, it } from 'vitest'

import { compileReaderView, createReaderRegistry, type ReaderDefinition } from './registry'

const stub: ReaderDefinition<{ label: string }> = {
  type: 'stub',
  compileOptions: (raw) =>
    typeof raw === 'object' && raw != null && typeof (raw as { label?: unknown }).label === 'string'
      ? { status: 'ready', options: { label: (raw as { label: string }).label } }
      : { status: 'invalid', diagnostics: ['label is required'] },
  dataNeeds: (_options, view) => ({
    properties: view.fields ?? [],
    window: 'source',
  }),
  mutationCapabilities: () => ({ editOptions: true }),
  project: (data, options) => ({ data, label: options.label }),
}

describe('reader registry', () => {
  it('adds a second reader through one registration without changing carrier shape', () => {
    const registry = createReaderRegistry([stub])
    const compiled = compileReaderView(registry, {
      name: 'Example',
      type: 'stub',
      fields: ['note.status'],
      options: { label: 'Rows' },
    })

    expect(compiled).toMatchObject({
      status: 'ready',
      options: { label: 'Rows' },
      dataNeeds: { properties: ['note.status'], window: 'source' },
    })
  })

  it('keeps unknown and malformed reader options as distinct local states', () => {
    const registry = createReaderRegistry([stub])

    expect(compileReaderView(registry, { name: 'Later', type: 'later' })).toEqual({
      status: 'unsupported',
    })
    expect(compileReaderView(registry, { name: 'Broken', type: 'stub', options: {} })).toEqual({
      status: 'invalid',
      diagnostics: ['label is required'],
    })
  })

  it('fails composition on duplicate ids', () => {
    expect(() => createReaderRegistry([stub, stub])).toThrow('duplicate reader type: stub')
  })
})
