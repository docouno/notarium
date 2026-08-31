import { describe, expect, it } from 'vitest'

import { CachedStore } from '@notarium/core'

import { InMemoryStore } from './inMemoryStore'

const carrier = [
  'Visible prose.',
  '',
  '```nota',
  'version: 1',
  'source: { kind: notes }',
  'views: [{ name: Board, type: board }]',
  '```',
].join('\n')

describe('InMemoryStore view parity behind the read model', () => {
  it('derives, preserves and clears the typed marker from full body writes', async () => {
    const inner = new InMemoryStore({ notes: [], now: '2026-08-30T00:00:00Z' })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })

    await store.start()
    const created = await store.write({ title: 'Sprint', content: carrier })

    expect((await store.list())[0]?.viewType).toBe('board')
    expect((await store.read(created.id!)).frontmatter.view).toBe('board')

    const live = await store.read(created.id!)
    await store.write({
      title: 'Sprint',
      content: 'ordinary prose',
      originalId: created.id,
      versionToken: live.versionToken,
    })

    expect((await store.list())[0]?.viewType).toBeUndefined()
    expect((await store.read(created.id!)).frontmatter.view).toBeUndefined()
    store.stop()
    await store.settle()
  })
})
