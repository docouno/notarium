// The production dual-run composition of cachedNotarium.test.ts, exercised on ONE note
// whose size is a function of user data rather than of the spec corpus: an imported
// dialog of hundreds of kilobytes must ride through every lifecycle door. 830 KB is the
// incident size (task 392) — the largest live note the fingerprint rewrite locked out.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CachedStore } from '@notarium/core'
import { createNotariumStore } from '@notarium/engine'

const NOTE_BYTES = 830_000

// No leading heading on purpose: the store promotes an H1 into the note title, and the
// round-trip below asserts `content` byte-for-byte.
const largeBody = (): string => {
  const line = 'An imported dialog line that pushes the note far past any spread limit.\n'

  return line.repeat(Math.ceil(NOTE_BYTES / line.length)).slice(0, NOTE_BYTES - 1) + '\n'
}

describe('CachedStore(NotariumStore) large-note lifecycle', () => {
  it('creates, reads, appends, renames and removes an 830 KB note', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-engine-large-'))
    const inner = createNotariumStore({
      mounts: [
        { class: 'user-doc', dir: notesDir, prefix: '' },
        {
          class: 'agent-memory',
          dir: join(notesDir, '.notarium/memory'),
          prefix: '.notarium/memory',
        },
      ],
    })
    const store = new CachedStore({ inner, pollIntervalMs: 0 })

    try {
      await store.start()
      const body = largeBody()

      expect(body.length).toBe(NOTE_BYTES)
      const created = await store.write({ title: 'Large import', content: body })

      await store.settle()
      const afterCreate = await store.read(created.id!)

      expect(afterCreate.content).toBe(body)
      await store.write({
        title: 'Large import',
        content: afterCreate.content,
        originalId: created.id!,
        versionToken: afterCreate.versionToken,
        fields: { status: 'review' },
      })
      await store.settle()
      const afterField = await store.read(created.id!)

      expect(afterField.content).toBe(body)
      expect(afterField.frontmatter.status).toBe('review')

      const appended = body + 'appended tail line\n'

      await store.write({
        title: 'Large import',
        content: appended,
        originalId: created.id!,
        versionToken: afterField.versionToken,
      })
      await store.settle()
      const afterAppend = await store.read(created.id!)

      expect(afterAppend.content).toBe(appended)

      await store.write({
        title: 'Large import, renamed',
        content: appended,
        originalId: created.id!,
        versionToken: afterAppend.versionToken,
      })
      await store.settle()
      const afterRename = await store.read(created.id!)

      expect(afterRename.title).toBe('Large import, renamed')

      await store.remove(created.id!)
      await store.settle()
      await expect(store.read(created.id!)).rejects.toThrow()
    } finally {
      store.stop()
      await store.settle()
      rmSync(notesDir, { recursive: true, force: true })
    }
  }, 30_000)
})
