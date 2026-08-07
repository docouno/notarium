import { describe, expect, it } from 'vitest'

import type { KnowledgeStore, NoteContent, WriteInput, WriteResult } from '../../knowledgeStore'
import { encodeWikilinkIdentity, parseWikilinks } from '../../libs/markdown'
import { computeVersionToken } from '../../libs/versionToken'
import { applyLink, applyLinks, hasLink, linkNotes, linkNotesMany } from './link'

// ── applyLink / hasLink: the pure splice (no I/O) ────────────────────────────

describe('applyLink', () => {
  it('appends a typed relation line, separated from prose by a blank line', () => {
    expect(applyLink('Some prose.', { toTitle: 'Carbon', relation: 'depends_on' })).toBe(
      'Some prose.\n\n- depends_on [[Carbon]]',
    )
  })

  it('onto an empty body is just the relation line', () => {
    expect(applyLink('', { toTitle: 'Carbon', relation: 'relates_to' })).toBe(
      '- relates_to [[Carbon]]',
    )
  })

  it('keeps relation lines a contiguous block (single newline onto a trailing one)', () => {
    const body = 'prose\n\n- relates_to [[Carbon]]'
    expect(applyLink(body, { toTitle: 'Titanium', relation: 'depends_on' })).toBe(
      'prose\n\n- relates_to [[Carbon]]\n- depends_on [[Titanium]]',
    )
  })

  it('re-linking the same (relation, target) is a referential no-op (same string back)', () => {
    const body = 'x\n\n- depends_on [[Carbon]]'
    expect(applyLink(body, { toTitle: 'Carbon', relation: 'depends_on' })).toBe(body)
  })

  it('a different relation to the same target is a DISTINCT edge — it adds a line', () => {
    const body = '- depends_on [[Carbon]]'
    expect(applyLink(body, { toTitle: 'Carbon', relation: 'relates_to' })).toBe(
      '- depends_on [[Carbon]]\n- relates_to [[Carbon]]',
    )
  })

  it('the materialized line is a wikilink the graph parser sees', () => {
    const next = applyLink('prose', { toTitle: 'Carbon', relation: 'depends_on' })
    expect(parseWikilinks(next)).toContain('Carbon')
  })

  it('rejects relation/target text that could materialize extra wikilinks', () => {
    expect(() => applyLink('', { toTitle: 'Carbon', relation: 'rel [[Injected]]' })).toThrow(
      /relation/,
    )
    expect(() => applyLink('', { toTitle: 'Carbon]] [[Injected', relation: 'depends_on' })).toThrow(
      /target/,
    )
  })
})

describe('applyLinks (batch fold)', () => {
  it('folds several links into one contiguous relation block', () => {
    expect(
      applyLinks('prose', [
        { toTitle: 'Carbon', relation: 'depends_on' },
        { toTitle: 'Titanium', relation: 'relates_to' },
      ]),
    ).toBe('prose\n\n- depends_on [[Carbon]]\n- relates_to [[Titanium]]')
  })

  it('an all-already-present batch is a referential no-op (same string back)', () => {
    const body = 'x\n\n- depends_on [[Carbon]]\n- relates_to [[Titanium]]'
    expect(
      applyLinks(body, [
        { toTitle: 'Carbon', relation: 'depends_on' },
        { toTitle: 'Titanium', relation: 'relates_to' },
      ]),
    ).toBe(body)
  })

  it('an empty list leaves the body untouched', () => {
    expect(applyLinks('x', [])).toBe('x')
  })

  it('adds only the new edges when some are already present', () => {
    expect(
      applyLinks('x\n\n- depends_on [[Carbon]]', [
        { toTitle: 'Carbon', relation: 'depends_on' }, // present
        { toTitle: 'Titanium', relation: 'relates_to' }, // new
      ]),
    ).toBe('x\n\n- depends_on [[Carbon]]\n- relates_to [[Titanium]]')
  })
})

describe('hasLink', () => {
  it('matches by slugged target and trimmed relation', () => {
    const body = '- depends_on [[Carbon]]'
    expect(hasLink(body, 'depends_on', 'Carbon')).toBe(true)
    expect(hasLink(body, ' depends_on ', 'carbon')).toBe(true) // slug + trim tolerant
    expect(hasLink(body, 'relates_to', 'Carbon')).toBe(false) // relation differs
    expect(hasLink(body, 'depends_on', 'Titanium')).toBe(false) // target differs
  })

  it('ignores a plain prose wikilink (untyped mention is not a typed relation)', () => {
    expect(hasLink('see [[Carbon]] for context', 'depends_on', 'Carbon')).toBe(false)
  })

  it('strips an alias/fragment from the matched target', () => {
    expect(hasLink('- depends_on [[Carbon|the element]]', 'depends_on', 'Carbon')).toBe(true)
    expect(hasLink('- depends_on [[Carbon#intro]]', 'depends_on', 'Carbon')).toBe(true)
  })

  it('dedupes an identity-preserving target with a human-readable alias', () => {
    const address = encodeWikilinkIdentity('abc123')
    expect(
      hasLink(`- depends_on [[${address}|Old Title]]`, 'depends_on', `${address}|New Title`),
    ).toBe(true)
  })

  it('compares identity-preserving targets exactly, including case', () => {
    const upper = encodeWikilinkIdentity('A')
    const lower = encodeWikilinkIdentity('a')
    const body = `- depends_on [[${upper}|upper]]`
    expect(hasLink(body, 'depends_on', `${lower}|lower`)).toBe(false)
    expect(applyLink(body, { toTitle: `${lower}|lower`, relation: 'depends_on' })).toContain(
      `[[${lower}|lower]]`,
    )
  })

  it('dedupes a legacy plain exact id against its canonical envelope', () => {
    const body = '- depends_on [[fake-target]]'
    const address = encodeWikilinkIdentity('fake-target')
    expect(hasLink(body, 'depends_on', `${address}|Target`)).toBe(true)
    expect(applyLink(body, { toTitle: `${address}|Target`, relation: 'depends_on' })).toBe(body)
  })

  it('does not suppress a human forward target behind a stale identity envelope', () => {
    const address = encodeWikilinkIdentity('Future')
    const body = `- depends_on [[${address}|Deleted]]`

    expect(hasLink(body, 'depends_on', 'Future')).toBe(false)
    expect(applyLink(body, { toTitle: 'Future', relation: 'depends_on' })).toBe(
      `${body}\n- depends_on [[Future]]`,
    )
  })

  it('keeps malformed reserved targets exact instead of case-folding them', () => {
    const body = '- depends_on [[notarium-id:%ZZ]]'
    expect(hasLink(body, 'depends_on', 'notarium-id:%zz')).toBe(false)
    expect(applyLink(body, { toTitle: 'notarium-id:%zz', relation: 'depends_on' })).toContain(
      '[[notarium-id:%zz]]',
    )
  })
})

// ── linkNotes: read → splice → CAS-write ─────────────────────────────────────

/** A minimal CAS+identity store driving linkNotes, mirroring the engines' token
 *  discipline. `writes` records every write that actually landed (so a
 *  no-op can be asserted to write nothing). `raceOnce` simulates a concurrent
 *  edit landing right before the FIRST write's CAS check — the lost-race path. */
const fakeStore = (
  initial: string,
  opts: { title?: string; frontmatter?: Record<string, unknown>; raceOnce?: boolean } = {},
): KnowledgeStore & { writes: WriteInput[]; body: string } => {
  let raced = false
  const store = {
    body: initial,
    title: opts.title ?? 'From Note',
    frontmatter: opts.frontmatter ?? {},
    writes: [] as WriteInput[],
    read: async (): Promise<NoteContent> => ({
      id: 'from-1',
      title: store.title,
      content: store.body,
      frontmatter: store.frontmatter,
      versionToken: computeVersionToken(store.body),
    }),
    write: async (input: WriteInput): Promise<WriteResult> => {
      if (opts.raceOnce && !raced) {
        raced = true
        store.body += '\n\n[concurrent]' // a writer landed → the caller's token is now stale
      }
      if (input.versionToken !== computeVersionToken(store.body)) {
        const err = new Error('conflict') as Error & { isConflict: boolean }
        err.isConflict = true
        throw err
      }
      store.body = input.content ?? ''
      store.writes.push(input)
      return { id: 'from-1', versionToken: computeVersionToken(store.body) }
    },
  }
  return store as unknown as KnowledgeStore & { writes: WriteInput[]; body: string }
}

describe('linkNotes', () => {
  it('materializes the typed wikilink through a real CAS write and returns the fresh token', async () => {
    const store = fakeStore('intro')
    const r = await linkNotes(store, {
      fromId: 'from-1',
      toTitle: 'Carbon',
      relation: 'depends_on',
    })
    expect(store.body).toBe('intro\n\n- depends_on [[Carbon]]')
    expect(store.writes).toHaveLength(1)
    expect(r.versionToken).toBe(computeVersionToken(store.body))
  })

  it('stamps the principal into the write (journal attribution)', async () => {
    const store = fakeStore('x')
    await linkNotes(store, {
      fromId: 'from-1',
      toTitle: 'Carbon',
      relation: 'rel',
      principal: 'pat:alice:abc',
    })
    expect(store.writes[0].principal).toBe('pat:alice:abc')
  })

  it('re-linking the same pair writes NOTHING and returns the current token', async () => {
    const store = fakeStore('x\n\n- depends_on [[Carbon]]')
    const before = computeVersionToken('x\n\n- depends_on [[Carbon]]')
    const r = await linkNotes(store, {
      fromId: 'from-1',
      toTitle: 'Carbon',
      relation: 'depends_on',
    })
    expect(store.writes).toHaveLength(0) // idempotent — no spurious revision
    expect(r.versionToken).toBe(before)
  })

  it('preserves the note tags/type on the link write (an omitted-tags write clears them)', async () => {
    const store = fakeStore('x', { frontmatter: { tags: ['keep'], type: 'spec' } })
    await linkNotes(store, { fromId: 'from-1', toTitle: 'Carbon', relation: 'rel' })
    expect(store.writes[0].tags).toEqual(['keep'])
    expect(store.writes[0].noteType).toBe('spec')
  })

  it('retries a lost CAS race transparently (link has no caller token to re-pass)', async () => {
    const store = fakeStore('intro', { raceOnce: true })
    await linkNotes(store, { fromId: 'from-1', toTitle: 'Carbon', relation: 'depends_on' })
    expect(store.writes).toHaveLength(1) // first attempt conflicted, the retry landed
    expect(store.body).toBe('intro\n\n[concurrent]\n\n- depends_on [[Carbon]]')
  })

  it('surfaces a persistent conflict after exhausting retries', async () => {
    const store = {
      read: async (): Promise<NoteContent> => ({
        id: 'from-1',
        title: 'N',
        content: 'x',
        frontmatter: {},
        versionToken: 'whatever',
      }),
      write: async (): Promise<WriteResult> => {
        const err = new Error('conflict') as Error & { isConflict: boolean }
        err.isConflict = true
        throw err
      },
    } as unknown as KnowledgeStore
    await expect(
      linkNotes(store, { fromId: 'from-1', toTitle: 'Carbon', relation: 'rel' }),
    ).rejects.toMatchObject({ isConflict: true })
  })
})

describe('linkNotesMany (#102: several edges, one write)', () => {
  it('rejects a self-link when a provisional source resolves to the target durable id', async () => {
    const store = fakeStore('intro')

    await expect(
      linkNotesMany(store, {
        fromId: 'provisional-source',
        links: [
          {
            toTitle: `${encodeWikilinkIdentity('from-1')}|From Note`,
            relation: 'links_to',
          },
        ],
      }),
    ).rejects.toThrow(/cannot be linked to itself/i)
    expect(store.writes).toHaveLength(0)
  })

  it('materializes all edges from a note in a SINGLE CAS write', async () => {
    const store = fakeStore('intro')
    const r = await linkNotesMany(store, {
      fromId: 'from-1',
      links: [
        { toTitle: 'Carbon', relation: 'depends_on' },
        { toTitle: 'Titanium', relation: 'relates_to' },
      ],
    })
    expect(store.body).toBe('intro\n\n- depends_on [[Carbon]]\n- relates_to [[Titanium]]')
    expect(store.writes).toHaveLength(1) // N edges, ONE revision
    expect(r.versionToken).toBe(computeVersionToken(store.body))
  })

  it('a forward-reference materializes the wikilink even with no such target note yet', async () => {
    const store = fakeStore('intro')
    await linkNotesMany(store, {
      fromId: 'from-1',
      links: [{ toTitle: 'Not Created Yet', relation: 'depends_on' }],
    })
    // The graph picks the wikilink up by slugged title — it resolves when a note
    // named "Not Created Yet" later exists; until then it is a benign ghost edge.
    expect(parseWikilinks(store.body)).toContain('Not Created Yet')
    expect(store.writes).toHaveLength(1)
  })

  it('a whole-batch no-op (every edge already present) writes NOTHING', async () => {
    const store = fakeStore('x\n\n- depends_on [[Carbon]]')
    const before = computeVersionToken('x\n\n- depends_on [[Carbon]]')
    const r = await linkNotesMany(store, {
      fromId: 'from-1',
      links: [{ toTitle: 'Carbon', relation: 'depends_on' }],
    })
    expect(store.writes).toHaveLength(0)
    expect(r.versionToken).toBe(before)
  })

  it('linkNotes is the one-edge case of linkNotesMany (single write path)', async () => {
    const store = fakeStore('intro')
    await linkNotes(store, { fromId: 'from-1', toTitle: 'Carbon', relation: 'depends_on' })
    expect(store.body).toBe('intro\n\n- depends_on [[Carbon]]')
    expect(store.writes).toHaveLength(1)
  })
})

// #296 — a target with nothing sluggable in it is still a distinct target. On the bare
// slug every such name shared the empty key, so a second `link` found the first one's
// line, reported the edge as already present, and never wrote it.
describe('typed links to a letterless target', () => {
  it('does not mistake one letterless target for another', () => {
    expect(hasLink('- links-to [[🎉🎉]]', 'links-to', '🎉🎉')).toBe(true)
    expect(hasLink('- links-to [[🎉🎉]]', 'links-to', '✨✨')).toBe(false)
  })

  it('writes BOTH edges instead of collapsing them onto one line', () => {
    const body = applyLinks('', [
      { relation: 'links-to', toTitle: '🎉🎉' },
      { relation: 'links-to', toTitle: '✨✨' },
    ])
    expect(body).toContain('[[🎉🎉]]')
    expect(body).toContain('[[✨✨]]')
  })
})

// #296 — the same defect one rung up: a PATH-form target must key the way the resolver
// keys it. `nameKey` flattens the path, so targets `resolveLink` sends to different
// notes shared one key here — and the second `link` call reported success for an edge
// it never wrote. Every case below is a pair of targets the resolver keeps apart.
describe('typed links to a path-form target', () => {
  it('keeps two path-form targets apart when only the last segment differs', () => {
    expect(hasLink('- links-to [[journal/🎉]]', 'links-to', 'journal/🎉')).toBe(true)
    expect(hasLink('- links-to [[journal/🎉]]', 'links-to', 'journal/✨')).toBe(false)
    // …and apart from the FOLDER itself, which is the key the flat form handed them.
    expect(hasLink('- links-to [[journal/🎉]]', 'links-to', 'journal')).toBe(false)
  })

  it('keeps a path-form target apart from the flat name it slugs to', () => {
    // Pure ASCII: the path axis was conflated for every alphabet, not just unromanisable
    // ones. `journal/notes.md` and `journal-notes.md` are two notes that coexist.
    expect(hasLink('- links-to [[journal/notes]]', 'links-to', 'journal-notes')).toBe(false)
  })

  it('still dedupes the same target written in a different case', () => {
    expect(hasLink('- links-to [[Journal/Notes]]', 'links-to', 'journal/notes')).toBe(true)
  })

  it('keeps two targets apart when the path key empties BOTH', () => {
    // A blank last segment names nothing, so the path key alone is '' for both — and
    // an empty key matching an empty key is exactly how a second edge goes missing.
    // This is the pin on `linkKey`'s raw rung: without it, this flips to `true`.
    expect(hasLink('- links-to [[journal/]]', 'links-to', 'archive/')).toBe(false)
    expect(hasLink('- links-to [[journal/]]', 'links-to', 'journal/')).toBe(true)
  })

  it('writes every distinct path-form edge', () => {
    const body = applyLinks('', [
      { relation: 'links-to', toTitle: 'journal/🎉' },
      { relation: 'links-to', toTitle: 'journal/✨' },
      { relation: 'links-to', toTitle: 'journal' },
    ])
    expect(body.split('\n')).toHaveLength(3)
  })
})
