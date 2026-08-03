// Read-model visibility hardening from the #78 review: restore of a hidden note
// in a prefixed mount must not corrupt its path; the degraded (error-mode) graph
// path must not leak ghost titles from inside agent-memory bodies; and the
// status count must report only the user-visible population.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMemoryIndex, CachedStore } from '@notarium/core'
import { createNotariumStore } from '@notarium/engine'
import { InMemoryStore } from '@notarium/engine-memory'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) {
    await c()
  }
})

describe('CachedStore visibility hardening (#78 review)', () => {
  it('restore of an agent-memory note keeps its path (no double-prefix) and stays hidden', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nt-restore-'))
    const inner = createNotariumStore({
      mounts: [
        { class: 'user-doc', dir, prefix: '' },
        { class: 'agent-memory', dir: join(dir, '.notarium/memory'), prefix: '.notarium/memory' },
      ],
    })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    await store.start()
    cleanups.push(async () => {
      store.stop()
      await store.settle()
      rmSync(dir, { recursive: true, force: true })
    })

    const created = await store.write({
      title: 'My Mem',
      content: 'v1 body',
      targetClass: 'agent-memory',
    })
    const id = created.id!
    expect(created.filePath).toBe('.notarium/memory/my-mem.md')

    // Edit → a second revision so there is an older state to restore to.
    const t1 = (await store.read(id)).versionToken!
    await store.write({ title: 'My Mem', content: 'v2 body', originalId: id, versionToken: t1 })

    const { items } = await store.revisions!(id, { offset: 0, limit: 10 })
    const oldest = items[items.length - 1] // the create (v1)
    const t2 = (await store.read(id)).versionToken!
    await store.restore!({ id, revisionId: oldest.id, versionToken: t2 })

    const after = await store.read(id)
    expect(after.filePath).toBe('.notarium/memory/my-mem.md') // NOT .notarium/memory/.notarium/...
    expect(after.content).toContain('v1 body')
    expect(after.class).toBe('agent-memory')
    // Still hidden from the user list, still reachable via scope:'all'.
    expect((await store.list()).some((n) => n.id === id)).toBe(false)
    expect((await store.list({ scope: 'all' })).some((n) => n.id === id)).toBe(true)
  })

  it('error-mode graph does not leak ghost titles from inside agent-memory bodies', async () => {
    const inner = new InMemoryStore({
      space: 'main',
      now: '2026-06-14T00:00:00.000Z',
      notes: [
        {
          id: 'fake-mem',
          title: 'Mem',
          class: 'agent-memory',
          filePath: '.notarium/memory/m.md',
          content: 'private, see [[Secret Codename Falcon]]',
        },
        { id: 'fake-doc', title: 'Doc', filePath: 'doc.md', content: 'plain note' },
      ],
    })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    cleanups.push(() => store.stop())
    // Force the boot scan to fail once → phase 'error' → graph() serves the
    // engine's graph through filterGraphForUser (the degraded passthrough).
    vi.spyOn(inner, 'changes').mockRejectedValueOnce(new Error('boot fail'))
    await store.start()

    const g = await store.graph()
    // The hidden note is gone AND its orphan ghost (titled from the [[link]]
    // text the user wrote inside the memory) must not leak.
    expect(g.nodes.some((n) => n.id === 'fake-mem')).toBe(false)
    expect(g.nodes.some((n) => /Falcon/i.test(n.title))).toBe(false)
    expect(g.nodes.some((n) => n.id === 'fake-doc')).toBe(true)
  })

  it('status counts report only the user-visible population (no count side-channel)', async () => {
    const inner = new InMemoryStore({
      space: 'main',
      now: '2026-06-14T00:00:00.000Z',
      notes: [
        { id: 'fake-doc', title: 'Doc', filePath: 'doc.md', content: 'x' },
        {
          id: 'fake-mem',
          title: 'Mem',
          class: 'agent-memory',
          filePath: '.notarium/memory/m.md',
          content: 'y',
        },
      ],
    })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    cleanups.push(() => store.stop())
    await store.start()

    const status = await store.syncStatus()
    expect(status.counts?.notes).toBe(1) // only the user-doc, not the agent-memory
    expect((await store.list({ scope: 'all' })).length).toBe(2)
  })

  it('pushes class narrowing into the engine, then restores read-model metadata', async () => {
    const inner = new InMemoryStore({
      space: 'main',
      now: '2026-06-14T00:00:00.000Z',
      notes: [
        { id: 'fake-doc', title: 'Doc', filePath: 'doc.md', content: 'x' },
        {
          id: 'fake-mem',
          title: 'Mem',
          class: 'agent-memory',
          filePath: '.notarium/memory/m.md',
          content: 'y',
        },
      ],
    })
    const list = vi.spyOn(inner, 'list')
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    cleanups.push(() => store.stop())
    await store.start()
    list.mockClear()

    const rows = await store.list({ scope: 'agentRecall', classes: ['agent-memory'] })

    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith({ classes: ['agent-memory'] })
    expect(rows.map((row) => row.id)).toEqual(['fake-mem'])
  })

  it('keeps ReadScope authoritative over a selective engine candidate set', async () => {
    const inner = new InMemoryStore({
      space: 'main',
      now: '2026-06-14T00:00:00.000Z',
      notes: [
        { id: 'fake-doc', title: 'Doc', filePath: 'doc.md', content: 'x' },
        {
          id: 'fake-mem',
          title: 'Mem',
          class: 'agent-memory',
          filePath: '.notarium/memory/m.md',
          content: 'y',
        },
      ],
    })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    cleanups.push(() => store.stop())
    await store.start()

    await expect(store.list({ scope: 'user', classes: ['agent-memory'] })).resolves.toEqual([])
  })

  it('projects bare-engine identity after a graph-only boot failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nt-memory-list-error-'))
    const memoryDir = join(dir, '.notarium/memory')
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(dir, 'doc.md'), '# Document\n\nBody')
    writeFileSync(
      join(memoryDir, 'workflow.md'),
      '---\nsummary: Degraded memory.\n---\n# workflow\n\nBody',
    )
    const inner = createNotariumStore({
      mounts: [
        { class: 'user-doc', dir },
        { class: 'agent-memory', dir: memoryDir, prefix: '.notarium/memory' },
      ],
    })
    vi.spyOn(inner, 'graph').mockRejectedValue(new Error('derived graph unavailable'))
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    cleanups.push(async () => {
      store.stop()
      await store.settle()
      rmSync(dir, { recursive: true, force: true })
    })
    await store.start()

    expect((await store.syncStatus()).scan.phase).toBe('error')
    await expect(buildMemoryIndex(store)).resolves.toMatchObject([
      { category: 'workflow', summary: 'Degraded memory.' },
    ])
  })

  it('keeps fresh engine metadata authoritative during graph-only degradation', async () => {
    const inner = new InMemoryStore({
      space: 'main',
      now: '2026-06-14T00:00:00.000Z',
      notes: [
        {
          id: 'fake-mem',
          title: 'Memory before',
          class: 'agent-memory',
          filePath: '.notarium/memory/memory-before.md',
          content: 'before',
        },
      ],
    })
    vi.spyOn(inner, 'graph').mockRejectedValue(new Error('derived graph unavailable'))
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    cleanups.push(() => store.stop())
    await store.start()
    const before = await inner.read('fake-mem')
    await inner.write({
      originalId: 'fake-mem',
      versionToken: before.versionToken,
      title: 'Memory after',
      content: 'after',
    })

    await expect(
      store.list({ scope: 'agentRecall', classes: ['agent-memory'] }),
    ).resolves.toMatchObject([
      {
        id: 'fake-mem',
        title: 'Memory after',
        filePath: '.notarium/memory/memory-after.md',
      },
    ])
  })

  it('falls back to the authoritative snapshot when the selective query fails', async () => {
    const inner = new InMemoryStore({
      space: 'main',
      now: '2026-06-14T00:00:00.000Z',
      notes: [
        { id: 'fake-doc', title: 'Doc', filePath: 'doc.md', content: 'x' },
        {
          id: 'fake-mem',
          title: 'Mem',
          class: 'agent-memory',
          filePath: '.notarium/memory/m.md',
          content: 'y',
        },
      ],
    })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    cleanups.push(() => store.stop())
    await store.start()
    vi.spyOn(inner, 'list').mockRejectedValueOnce(new Error('derived list unavailable'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(
        store.list({ scope: 'agentRecall', classes: ['agent-memory'] }),
      ).resolves.toMatchObject([{ id: 'fake-mem', class: 'agent-memory' }])
      expect(error).toHaveBeenCalledWith(
        '[cached-store] selective list failed; serving snapshot:',
        'derived list unavailable',
      )
    } finally {
      error.mockRestore()
    }
  })
})

describe('CachedStore pathPrefix narrowing (#13 I2)', () => {
  const build = async (): Promise<CachedStore> => {
    const inner = new InMemoryStore({
      space: 'team',
      now: '2026-06-14T00:00:00.000Z',
      notes: [
        { id: 'fake-root', title: 'Root xtopic', filePath: 'root.md', content: 'xtopic' },
        { id: 'fake-bill', title: 'Bill xtopic', filePath: 'billing/b.md', content: 'xtopic' },
        {
          id: 'fake-billsub',
          title: 'BillSub xtopic',
          filePath: 'billing/sub/c.md',
          content: 'xtopic',
        },
        {
          id: 'fake-billish',
          title: 'Billish xtopic',
          filePath: 'billingZZ/d.md',
          content: 'xtopic',
        }, // segment-boundary trap
        { id: 'fake-other', title: 'Other xtopic', filePath: 'other/e.md', content: 'xtopic' },
      ],
    })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })
    cleanups.push(() => store.stop())
    await store.start()
    return store
  }

  it('list narrows to the subtree (folder + descendants), on a segment boundary', async () => {
    const store = await build()
    const ids = (await store.list({ pathPrefix: 'billing' })).map((n) => n.id).sort()
    // billing/b.md AND billing/sub/c.md — but NOT billingZZ/d.md (not under 'billing/').
    expect(ids).toEqual(['fake-bill', 'fake-billsub'])
  })

  it('list with pathPrefix "" is the whole space (a root project owns it)', async () => {
    const store = await build()
    expect((await store.list({ pathPrefix: '' })).length).toBe(5)
  })

  it('search narrows by pathPrefix in-query (before any limit cut)', async () => {
    const store = await build()
    const ids = (await store.search('xtopic', { pathPrefix: 'billing' })).map((r) => r.id).sort()
    expect(ids).toEqual(['fake-bill', 'fake-billsub'])
    // No prefix → the whole space matches.
    expect((await store.search('xtopic')).length).toBe(5)
  })
})
