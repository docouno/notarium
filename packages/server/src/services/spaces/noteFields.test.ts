import { describe, expect, it, vi } from 'vitest'

import { InMemoryStore } from '@notarium/engine-memory'

import { createInMemoryFieldSchemaStore } from '../fields'
import { setNoteFields } from './noteFields'

describe('setNoteFields', () => {
  it('writes one schema-shaped patch and returns a fresh version token', async () => {
    const store = new InMemoryStore()
    const schema = createInMemoryFieldSchemaStore()
    const created = await store.write({ title: 'Fields', content: 'body' })
    schema.seed('s1', {
      version: 1,
      fields: [
        { key: 'priority', type: 'number' },
        { key: 'done', type: 'checkbox' },
      ],
    })

    const result = await setNoteFields({
      store,
      fieldSchemaStore: schema,
      space: 's1',
      id: created.id!,
      fields: { priority: '3', done: 'true', status: 'doing' },
    })
    const read = await store.read(created.id!)

    expect(result.versionToken).toBe(read.versionToken)
    expect(read.logicalState?.markdown).toContain('priority: 3')
    expect(read.logicalState?.markdown).toContain('done: true')
    expect(read.logicalState?.markdown).toContain('status: doing')
  })

  it('preserves a legacy storage path on a fields-only intent', async () => {
    const store = new InMemoryStore({
      notes: [{ id: 'legacy', title: 'My Note', filePath: 'demo/My Note.md', content: 'body' }],
    })

    const schema = createInMemoryFieldSchemaStore()

    await setNoteFields({
      store,
      fieldSchemaStore: schema,
      space: 's1',
      id: 'legacy',
      fields: { status: 'doing' },
    })

    expect((await store.read('legacy')).filePath).toBe('demo/My Note.md')
  })

  it('does not call the store writer for an equal fields-only intent', async () => {
    const store = new InMemoryStore()
    const schema = createInMemoryFieldSchemaStore()
    const created = await store.write({
      title: 'Fields',
      content: 'body',
      fields: { status: 'doing' },
    })
    const write = vi.spyOn(store, 'write')

    const result = await setNoteFields({
      store,
      fieldSchemaStore: schema,
      space: 's1',
      id: created.id!,
      fields: { status: 'doing' },
    })

    expect(write).not.toHaveBeenCalled()
    expect(result.versionToken).toBe((await store.read(created.id!)).versionToken)
  })
})
