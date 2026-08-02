import { describe, expect, it } from 'vitest'

import type { KnowledgeStore, NoteContent, WriteInput, WriteResult } from '../../knowledgeStore'
import { sha256Hex } from '../../libs/hash'
import { computeVersionToken } from '../../libs/versionToken'
import { applyEdit, EditError, editNote } from './editNote'

// ── applyEdit: the pure splice (no I/O) ──────────────────────────────────────

describe('applyEdit', () => {
  it('append adds content after a blank line, normalising trailing whitespace', () => {
    expect(applyEdit('line one', { noteId: 'n', operation: 'append', content: 'line two' })).toBe(
      'line one\n\nline two',
    )
    expect(applyEdit('line one\n\n', { noteId: 'n', operation: 'append', content: 'x' })).toBe(
      'line one\n\nx',
    )
  })

  it('append onto an empty body is just the content', () => {
    expect(applyEdit('', { noteId: 'n', operation: 'append', content: 'first' })).toBe('first')
  })

  it('prepend adds content before the body', () => {
    expect(applyEdit('old', { noteId: 'n', operation: 'prepend', content: 'new' })).toBe(
      'new\n\nold',
    )
  })

  it('an empty append/prepend is a referential no-op (same string back)', () => {
    const body = 'unchanged'
    expect(applyEdit(body, { noteId: 'n', operation: 'append', content: '' })).toBe(body)
    expect(applyEdit(body, { noteId: 'n', operation: 'prepend', content: '' })).toBe(body)
  })

  it('replaceSection swaps the body under a heading', () => {
    const body = '## A\nold\n\n## B\nkeep'
    expect(
      applyEdit(body, { noteId: 'n', operation: 'replaceSection', content: 'new', section: 'A' }),
    ).toBe('## A\n\nnew\n\n## B\nkeep')
  })

  it('replaceSection throws EditError naming the headings present when none match', () => {
    expect(() =>
      applyEdit('## A\nx', {
        noteId: 'n',
        operation: 'replaceSection',
        content: 'y',
        section: 'Z',
      }),
    ).toThrow(/No section titled "Z".*"A"/s)
  })

  it('replaceSection without a section is a caller-fault EditError', () => {
    const call = () =>
      applyEdit('## A\nx', { noteId: 'n', operation: 'replaceSection', content: 'y' })
    expect(call).toThrow(EditError)
    expect(call).toThrow(/requires a `section`/)
  })

  it('findReplace swaps a unique snippet', () => {
    expect(
      applyEdit('the quick brown fox', {
        noteId: 'n',
        operation: 'findReplace',
        content: 'red',
        find: 'brown',
      }),
    ).toBe('the quick red fox')
  })

  it('findReplace rejects a snippet that is missing or ambiguous', () => {
    expect(() =>
      applyEdit('abc', { noteId: 'n', operation: 'findReplace', content: 'x', find: 'zzz' }),
    ).toThrow(/not found/)
    expect(() =>
      applyEdit('a a a', { noteId: 'n', operation: 'findReplace', content: 'x', find: 'a' }),
    ).toThrow(/more than once/)
  })

  it('findReplace replacing text with itself is a no-op', () => {
    const body = 'keep me'
    expect(
      applyEdit(body, { noteId: 'n', operation: 'findReplace', content: 'keep', find: 'keep' }),
    ).toBe(body)
  })

  it('replace overwrites the WHOLE body, verbatim (#102)', () => {
    expect(
      applyEdit('## old\nstuff', { noteId: 'n', operation: 'replace', content: 'brand new body' }),
    ).toBe('brand new body')
    // An empty replace clears the note (editNote's no-op guard still skips a true no-op).
    expect(applyEdit('something', { noteId: 'n', operation: 'replace', content: '' })).toBe('')
  })

  const del = (body: string, find: string): string =>
    applyEdit(body, { noteId: 'n', operation: 'findReplace', find, content: '' })

  it('findReplace EMPTY content deletes a paragraph block and heals to ONE blank line (#102)', () => {
    expect(del('first fact.\n\nremove me.\n\nlast fact.', 'remove me.')).toBe(
      'first fact.\n\nlast fact.',
    )
    // Leading / trailing / only block: the dangling separator is dropped, no edge blank.
    expect(del('remove me.\n\nkept.', 'remove me.')).toBe('kept.')
    expect(del('a.\n\nremove me.', 'remove me.')).toBe('a.')
    expect(del('only.', 'only.')).toBe('')
  })

  it('findReplace EMPTY content keeps a TIGHT list intact — no injected blank line', () => {
    // Single-\n separated lines must NOT become a loose list (the heal must not
    // upgrade a line separator to a paragraph break).
    expect(del('- item a\n- item b\n- item c', '- item b')).toBe('- item a\n- item c')
    expect(del('1. one\n2. two\n3. three', '2. two')).toBe('1. one\n3. three')
  })

  it('findReplace EMPTY content preserves the next block’s indentation', () => {
    // Deleting the first block must not eat the following indented code/list block.
    expect(del('intro\n\n    code line\n\nouter', 'intro')).toBe('    code line\n\nouter')
  })

  it('findReplace EMPTY content heals a CRLF body without piling up blank lines', () => {
    expect(del('fact one\r\n\r\nremove me\r\n\r\nfact three', 'remove me')).toBe(
      'fact one\n\nfact three',
    )
  })

  it('findReplace EMPTY content on an INLINE snippet closes up — never a paragraph break', () => {
    // Include the surrounding space in `find` for a clean close; either way NO newline.
    expect(del('keep REMOVE me', ' REMOVE')).toBe('keep me')
    expect(del('fooXbar', 'X')).toBe('foobar') // mid-word: exact splice, no invented space
  })
})

// ── editNote: read → splice → CAS-write ──────────────────────────────────────

/** A minimal CAS+identity store: just enough read/write to drive editNote, with
 *  the same token discipline the real engines enforce — the token hashes
 *  the live body, a stale one conflicts. `writes` records every write that
 *  actually happened so a no-op can be asserted to write nothing. */
const fakeStore = (
  initial: string,
  opts: { title?: string; frontmatter?: Record<string, unknown> } = {},
): KnowledgeStore & { writes: WriteInput[]; body: string } => {
  const store = {
    body: initial,
    title: opts.title ?? 'Note',
    frontmatter: opts.frontmatter ?? {},
    writes: [] as WriteInput[],
    read: async (): Promise<NoteContent> => ({
      id: 'note-1',
      title: store.title,
      content: store.body,
      frontmatter: store.frontmatter,
      versionToken: computeVersionToken(store.body),
    }),
    write: async (input: WriteInput): Promise<WriteResult> => {
      const live = computeVersionToken(store.body)

      if (input.versionToken !== live) {
        const err = new Error('conflict') as Error & { isConflict: boolean }
        err.isConflict = true
        throw err
      }
      store.body = input.content ?? ''
      store.title = input.title
      store.writes.push(input)
      return { id: 'note-1', versionToken: computeVersionToken(store.body) }
    },
  }
  return store as unknown as KnowledgeStore & { writes: WriteInput[]; body: string }
}

describe('editNote', () => {
  it('appends through a real CAS write and returns the fresh token', async () => {
    const store = fakeStore('hello')
    const r = await editNote(store, { noteId: 'note-1', operation: 'append', content: 'world' })
    expect(store.body).toBe('hello\n\nworld')
    expect(store.writes).toHaveLength(1)
    expect(store.writes[0].principal).toBeUndefined()
    expect(r.versionToken).toBe(computeVersionToken('hello\n\nworld'))
  })

  it('stamps the principal into the write (journal attribution)', async () => {
    const store = fakeStore('hello')
    await editNote(store, {
      noteId: 'note-1',
      operation: 'append',
      content: 'x',
      principal: 'pat:alice:abc',
    })
    expect(store.writes[0].principal).toBe('pat:alice:abc')
  })

  it('a no-op edit writes NOTHING and returns the current token', async () => {
    const store = fakeStore('unchanged')
    const before = computeVersionToken('unchanged')
    const r = await editNote(store, { noteId: 'note-1', operation: 'append', content: '' })
    expect(store.writes).toHaveLength(0) // no spurious revision → no misattribution
    expect(store.body).toBe('unchanged')
    expect(r.versionToken).toBe(before)
  })

  it('detects an effective no-op the reader strips off (prepending the title heading)', async () => {
    // Prepending "# Foo" to a note titled "Foo": read() strips that heading, so
    // the note is unchanged to any reader — must NOT write (would lay a baseline).
    const store = fakeStore('body text', { title: 'Foo' })
    await editNote(store, { noteId: 'note-1', operation: 'prepend', content: '# Foo' })
    expect(store.writes).toHaveLength(0)
  })

  it('preserves the note tags on a body edit (an omitted-tags write would clear them)', async () => {
    const store = fakeStore('body', { frontmatter: { tags: ['keep', 'these'] } })
    await editNote(store, { noteId: 'note-1', operation: 'append', content: 'more' })
    expect(store.writes).toHaveLength(1)
    expect(store.writes[0].tags).toEqual(['keep', 'these'])
  })

  it('refuses a stale caller token with a conflict, before writing', async () => {
    const store = fakeStore('current state')
    await expect(
      editNote(store, {
        noteId: 'note-1',
        operation: 'append',
        content: 'x',
        versionToken: 'a-stale-token',
      }),
    ).rejects.toMatchObject({ isConflict: true })
    expect(store.writes).toHaveLength(0)
  })

  it('honours a matching caller token and writes', async () => {
    const store = fakeStore('current state')
    const token = computeVersionToken('current state')
    await editNote(store, {
      noteId: 'note-1',
      operation: 'append',
      content: 'more',
      versionToken: token,
    })
    expect(store.body).toBe('current state\n\nmore')
  })

  it('surfaces an unsatisfiable operation as an EditError without writing', async () => {
    const store = fakeStore('no headings here')
    await expect(
      editNote(store, {
        noteId: 'note-1',
        operation: 'replaceSection',
        content: 'x',
        section: 'Nope',
      }),
    ).rejects.toBeInstanceOf(EditError)
    expect(store.writes).toHaveLength(0)
  })

  it('a real edit echoes the integrity of the body it wrote (#102)', async () => {
    const store = fakeStore('hello')
    const r = await editNote(store, { noteId: 'note-1', operation: 'append', content: 'world' })
    const next = 'hello\n\nworld'
    expect(r.bodyBytes).toBe(Buffer.byteLength(next, 'utf8'))
    expect(r.bodyHash).toBe(await sha256Hex(next))
  })

  it('replace rewrites the whole body and echoes the new integrity (#102)', async () => {
    const store = fakeStore('## old\nstuff')
    const r = await editNote(store, { noteId: 'note-1', operation: 'replace', content: 'fresh' })
    expect(store.body).toBe('fresh')
    expect(r.bodyBytes).toBe(Buffer.byteLength('fresh', 'utf8'))
    expect(r.bodyHash).toBe(await sha256Hex('fresh'))
  })

  it('replace with EMPTY content clears the body (reversible via journal) and echoes bodyBytes 0 (#102)', async () => {
    const store = fakeStore('has content')
    const r = await editNote(store, { noteId: 'note-1', operation: 'replace', content: '' })
    expect(store.writes).toHaveLength(1) // a real write — NOT swallowed as a no-op
    expect(store.body).toBe('')
    expect(r.bodyBytes).toBe(0)
    expect(r.bodyHash).toBe(await sha256Hex(''))
  })

  it('a no-op edit carries NO integrity echo (nothing was written)', async () => {
    const store = fakeStore('unchanged')
    const r = await editNote(store, { noteId: 'note-1', operation: 'append', content: '' })
    expect(store.writes).toHaveLength(0)
    expect(r.bodyBytes).toBeUndefined()
    expect(r.bodyHash).toBeUndefined()
  })
})
