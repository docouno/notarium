// Refusal diagnostics at the write chokepoint (task 392): a refusal names the
// violating code point and its position in the value the CHOKEPOINT received — the
// merged document on an edit path, the merged tag list on a pin. The pre-seeded files
// below model the incident shape: bytes already on disk from before the fence existed,
// readable today, and refused with an address (not a bare-engine constant) on write.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CachedStore, type WriteInput } from '@notarium/core'
import { createNotariumStore } from '@notarium/engine'
import { InMemoryStore } from '@notarium/engine-memory'

const memoryStore = async (): Promise<CachedStore> => {
  const store = new CachedStore({
    inner: new InMemoryStore({ space: 'main', now: '2026-08-24T12:00:00.000Z', notes: [] }),
    pollIntervalMs: 0,
  })

  await store.start()

  return store
}

describe('write refusal diagnostics — caller input', () => {
  it.each([
    {
      name: 'a control character in content, with line and column',
      input: { title: 'Note', content: 'line one\nline two\nabcd\u0000rest\n' },
      message: 'content contains a control character U+0000 at line 3, column 5',
    },
    {
      name: 'an unpaired surrogate in content',
      input: { title: 'Note', content: 'a\uD800b' },
      message: 'content contains an unpaired UTF-16 surrogate U+D800 at line 1, column 2',
    },
    {
      name: 'a dirty body with NO explicit title names content, not the promoted title',
      input: { content: '# Bad\u0000name\n\nbody\n' } as WriteInput,
      message: 'content contains a control character U+0000 at line 1, column 6',
    },
    {
      name: 'several violations name the first and count the rest',
      input: { title: 'Note', content: 'a\u0000b\u0007c\u0000\n' },
      message: 'content contains a control character U+0000 at line 1, column 2 (and 2 more)',
    },
    {
      name: 'a dirty explicit title, with the coordinate shifted back past the trim prefix',
      input: { title: '\u000b Mid\u0000dle', content: 'body\n' },
      message: 'title contains a control character U+0000 at column 6',
    },
    {
      name: 'a dirty title behind a line-broken trim prefix names its true column',
      input: { title: '\nMid\u0000dle', content: 'body\n' },
      message: 'title contains a control character U+0000 at column 4',
    },
    {
      name: 'an astral-bearing title counts its column in code points, not UTF-16 units',
      input: { title: '\u{1F389}\u{1F389}Mid\u0000dle', content: 'body\n' },
      message: 'title contains a control character U+0000 at column 6',
    },
    {
      name: 'a multi-line title stays a plain single-line refusal',
      input: { title: 'A\nB', content: 'body\n' },
      message: 'title must be a single-line string',
    },
    {
      name: 'a dirty scalar field answers with a column',
      input: { title: 'Note', content: 'body\n', slug: 'ab\u001bcd' },
      message: 'slug contains a control character U+001B at column 3',
    },
    {
      name: 'a dirty tag is named by value, violator printed as ?',
      input: { title: 'Note', content: 'body\n', tags: ['gu\u0000ide'] },
      message: 'tag "gu?ide" contains a control character U+0000 at column 3',
    },
  ])('refuses $name', async ({ input, message }) => {
    const store = await memoryStore()

    try {
      await expect(store.write(input)).rejects.toThrow(message)
    } finally {
      store.stop()
      await store.settle()
    }
  })

  // The verdict comes from the PROMOTED title: a violator that trim() strips was
  // accepted before this diagnostic existed, and must stay accepted after it.
  it('still accepts a title whose only violator sits in the trimmed prefix', async () => {
    const store = await memoryStore()

    try {
      const created = await store.write({ title: '\u000bFoo', content: 'body\n' })

      await expect(store.read(created.id!)).resolves.toMatchObject({ title: 'Foo' })
    } finally {
      store.stop()
      await store.settle()
    }
  })
})

describe('write refusal diagnostics — the pin path over pre-existing bytes', () => {
  it('addresses a pin refusal into the live note, not a bare-engine constant', async () => {
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-dirty-note-'))

    writeFileSync(
      join(notesDir, 'dirty-body.md'),
      '# Dirty body\n\nfirst line\nse\u0000cond tail\n',
    )
    writeFileSync(
      join(notesDir, 'dirty-tag.md'),
      '---\ntags:\n  - gu\u0000ide\n---\n\nclean body\n',
    )
    const store = new CachedStore({
      inner: createNotariumStore({ mounts: [{ class: 'user-doc', dir: notesDir, prefix: '' }] }),
      pollIntervalMs: 0,
    })

    try {
      await store.start()
      const notes = await store.list()
      const dirtyBody = notes.find((note) => note.filePath === 'dirty-body.md')!
      const dirtyTag = notes.find((note) => note.filePath === 'dirty-tag.md')!

      // The byte reads back as-is: the note is not quarantined, only unwritable.
      const read = await store.read(dirtyBody.id!)

      expect(read.content).toContain('se\u0000cond')
      // The refusal coordinate lives in the reader frame: for a pin, the merged
      // content IS what get_note shows.
      await expect(store.mutateTags({ id: dirtyBody.id!, add: ['pinned'] })).rejects.toThrow(
        'content contains a control character U+0000 at line 2, column 3',
      )
      await expect(store.mutateTags({ id: dirtyTag.id!, add: ['pinned'] })).rejects.toThrow(
        'tag "gu?ide" contains a control character U+0000 at column 3',
      )
      // A dirty tag in the CALLER delta refuses before any read or claim.
      await expect(store.mutateTags({ id: dirtyTag.id!, add: ['ba\u0000d'] })).rejects.toThrow(
        'tag "ba?d" contains a control character U+0000 at column 3',
      )
    } finally {
      store.stop()
      await store.settle()
      rmSync(notesDir, { recursive: true, force: true })
    }
  })
})
