import { describe, expect, it } from 'vitest'

import {
  analyzeDocumentState,
  bindStorageOwnerProof,
  decodeDocumentState,
  documentRestoreCompatibility,
  documentSourceText,
  documentStateVersionToken,
  encodeDocumentState,
  exactOwnerObservation,
  opaqueDocumentState,
  planDocumentMutation,
} from './index'
import { DOCUMENT_ROLE, DOCUMENT_STATE_FORMAT, STORAGE_OWNER_KEY } from './types'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
/** Read planned bytes back WITHOUT the default decoder's BOM strip: a leading byte-order
 *  mark is one of the things these assertions are about, and `new TextDecoder()` eats it
 *  before the expectation ever sees it. */
const exactText = (value: Uint8Array): string =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(value)

describe('document state', () => {
  it('observes an exact owner only from unambiguous source bytes', () => {
    expect(exactOwnerObservation(bytes('body'))).toEqual({ kind: 'absent' })
    expect(exactOwnerObservation(bytes('---\nnotarium-id: note-id\n---\nbody'))).toEqual({
      kind: 'claimed',
      id: 'note-id',
    })
    expect(
      exactOwnerObservation(bytes('---\nnotarium-id: one\nnotarium-id: two\n---\nbody')),
    ).toEqual({ kind: 'unproven' })
    expect(exactOwnerObservation(bytes('---\nnotarium-id: [one]\n---\nbody'))).toEqual({
      kind: 'unproven',
    })
    expect(exactOwnerObservation(bytes('---\nnotarium-id: foreign\nbody'))).toEqual({
      kind: 'unproven',
    })
    expect(exactOwnerObservation(Uint8Array.of(0xff))).toEqual({ kind: 'unproven' })
  })

  it.each([
    '---   \nnotarium-id: note-id\n',
    '---\t\nnotarium-id: note-id\n',
    '---\r',
    '---\rnotarium-id: foreign-id01\r---\rbody',
    '--- # authored\nnotarium-id: foreign-id01\n',
  ])('treats malformed opener-like bytes as unproven: %j', (source) => {
    expect(exactOwnerObservation(bytes(source))).toEqual({ kind: 'unproven' })
  })
  it('keeps exact authored bytes and translates YAML ranges across Unicode', () => {
    const raw = [
      '---\r',
      '# authored\r',
      'title: "Привет 🚀"\r',
      'plugin: &base { answer: 42 }\r',
      'copy: *base\r',
      '---\r',
      '\r',
      '# Привет 🚀\r',
      '\r',
      'body\r',
    ].join('\n')
    const state = analyzeDocumentState({ source: bytes(raw), pathFallbackTitle: 'fallback' })

    expect(state.format).toBe(DOCUMENT_STATE_FORMAT.markdown)
    expect(state.restoreSafety).toEqual({ status: 'safe' })
    expect(state.projection).toMatchObject({ title: 'Привет 🚀', body: 'body\r' })
    expect(documentSourceText(state)).toBe(raw)

    const plan = planDocumentMutation(state, { title: 'Новый 🚀' })
    const changed = new TextDecoder().decode(plan.source)

    expect(changed).toContain('title: "Новый 🚀"\r\n')
    expect(changed).toContain('# Новый 🚀\r\n')
    expect(changed).toContain('plugin: &base { answer: 42 }\r\ncopy: *base\r\n')
  })

  it('returns the identical source for semantic-equal title and body intents', () => {
    const state = analyzeDocumentState({
      source: bytes('---\n# keep\ntitle: Same\n---\n\n# Same\n\nbody\n'),
    })
    const plan = planDocumentMutation(state, { title: 'Same', body: 'body\n' })

    expect(plan.patches).toEqual([])
    expect(plan.source).toBe(state.source)
  })

  it('groups a new owner envelope and patches legacy fixed fields losslessly', () => {
    const state = analyzeDocumentState({
      source: bytes('plain body\n'),
      pathFallbackTitle: 'note',
    })
    const plan = planDocumentMutation(state, {
      title: 'Restored',
      fallbackPolicy: 'pinned',
      body: 'old body\n',
      tags: ['one', 'two words'],
      slug: 'stable-slug',
      owners: {
        [STORAGE_OWNER_KEY.id]: 'note-id',
        [STORAGE_OWNER_KEY.created]: '2026-08-11T00:00:00.000Z',
      },
    })
    const source = new TextDecoder().decode(plan.source)

    expect(source.match(/^---$/gm)).toHaveLength(2)
    expect(source).toContain('title: Restored\n')
    expect(source).toContain('tags: [one, two words]\n')
    expect(source).toContain('slug: stable-slug\n')
    expect(source).toContain('notarium-id: note-id\n')
    expect(source).toContain('notarium-created: 2026-08-11T00:00:00.000Z\n')
    expect(source.endsWith('old body\n')).toBe(true)
    expect(plan.proposedOwnerProof.generatedContainer).toBe(true)
    expect(plan.proposedOwnerProof.claims).toEqual([
      expect.objectContaining({ key: STORAGE_OWNER_KEY.id, ownership: 'entry' }),
      expect.objectContaining({ key: STORAGE_OWNER_KEY.created, ownership: 'entry' }),
    ])
  })

  // An imported document carries the reserved keys with no proof behind them. The
  // planner owns the one answer for that state, and it is the physical serializer's:
  // rewrite the field that is there. Appending a second one bound the proposed proof to
  // the untouched first field and left the document with two of a unique key.
  it('rewrites an unclaimed reserved owner field where it stands', () => {
    const source = bytes(
      '---\ntitle: Imported\nnotarium-id: foreign-vault-id\nnotarium-created: 2019-05-05T00:00:00.000Z\n---\n\n# Imported\n\nbody\n',
    )
    const state = analyzeDocumentState({ source, pathFallbackTitle: 'imported' })

    expect(state.provenance.claims).toEqual([])
    const plan = planDocumentMutation(state, {
      owners: {
        [STORAGE_OWNER_KEY.id]: 'AbCdefGhij_1',
        [STORAGE_OWNER_KEY.created]: '2026-08-18T00:00:00.000Z',
      },
    })
    const written = new TextDecoder().decode(plan.source)

    expect(written.match(/^notarium-id:/gm)).toHaveLength(1)
    expect(written.match(/^notarium-created:/gm)).toHaveLength(1)
    expect(written).toContain('notarium-id: AbCdefGhij_1')
    expect(written).toContain('notarium-created: 2026-08-18T00:00:00.000Z')
    // The proof must name the field the plan actually wrote.
    const rewritten = analyzeDocumentState({
      source: plan.source,
      // A PROPOSED proof has no evidence yet — evidence is the receipt of the mutation
      // that is about to be written. What `analyzeDocumentState` reads is the PERSISTED
      // form, so the receipt is supplied here rather than the two shapes conflated.
      ownerProof: {
        ...plan.proposedOwnerProof,
        claims: plan.proposedOwnerProof.claims.map((claim) => ({
          ...claim,
          evidence: { kind: 'mutation-receipt' as const, id: 'receipt-1' },
        })),
      },
      pathFallbackTitle: 'imported',
    })

    expect(exactOwnerObservation(plan.source)).toEqual({ kind: 'claimed', id: 'AbCdefGhij_1' })
    expect(rewritten.restoreSafety).toEqual({ status: 'safe' })
    expect(
      plan.proposedOwnerProof.claims.map((claim) => [
        claim.key,
        new TextDecoder().decode(plan.source.slice(claim.valueRange.start, claim.valueRange.end)),
      ]),
    ).toEqual([
      [STORAGE_OWNER_KEY.id, 'AbCdefGhij_1'],
      [STORAGE_OWNER_KEY.created, '2026-08-18T00:00:00.000Z'],
    ])
  })

  // Every channel of this planner writes a single-line value into a range the analyzer
  // reported for the authored one — and an authored value is not obliged to live on its
  // key's line. When it does not, its range ends past the line break that ends the
  // entry, so a value-sized patch eats the terminator and glues the next line onto the
  // value. Each case below is one channel, on the shape that has no in-place slot.
  it.each([
    {
      channel: 'a block-list tags projection',
      source: '---\ntitle: A\ntags:\n  - one\n  - two\nplugin: kept\n---\nbody\n',
      intent: { tags: ['three'] },
      expected: '---\ntitle: A\ntags: [three]\nplugin: kept\n---\nbody\n',
    },
    {
      channel: 'a nested-map slug projection',
      source: '---\ntitle: A\nslug:\n  legacy: old\n---\nbody\n',
      intent: { slug: 'new-slug' },
      expected: '---\ntitle: A\nslug: new-slug\n---\nbody\n',
    },
    {
      channel: 'a block-scalar title',
      source: '---\ntitle: |\n  Authored\nplugin: kept\n---\nbody\n',
      intent: { title: 'Renamed' },
      expected: '---\ntitle: Renamed\nplugin: kept\n---\nbody\n',
    },
    {
      channel: 'a reserved owner key with no value at all',
      source: '---\ntitle: A\nnotarium-created:\nplugin: kept\n---\nbody\n',
      intent: { owners: { [STORAGE_OWNER_KEY.created]: '2026-08-18T00:00:00.000Z' } },
      expected:
        '---\ntitle: A\nnotarium-created: 2026-08-18T00:00:00.000Z\nplugin: kept\n---\nbody\n',
    },
    {
      channel: 'a CRLF block-list owner key',
      source: '---\r\ntitle: A\r\nnotarium-id:\r\n  - foreign\r\n---\r\nbody\r\n',
      intent: { owners: { [STORAGE_OWNER_KEY.id]: 'AbCdefGhij_1' } },
      expected: '---\r\ntitle: A\r\nnotarium-id: AbCdefGhij_1\r\n---\r\nbody\r\n',
    },
  ])('rewrites $channel as a whole entry rather than over its line break', (probe) => {
    const state = analyzeDocumentState({ source: bytes(probe.source), pathFallbackTitle: 'note' })

    expect(state.restoreSafety).toEqual({ status: 'safe' })
    const plan = planDocumentMutation(state, probe.intent)

    expect(new TextDecoder().decode(plan.source)).toBe(probe.expected)
    expect(
      analyzeDocumentState({ source: plan.source, pathFallbackTitle: 'note' }).restoreSafety,
    ).toEqual({ status: 'safe' })
  })

  // The proof channel binds to whatever field the physical authority named, and
  // `bindStorageOwnerProof` proves uniqueness, not a scalar shape.
  it('rewrites a proof-bound owner value that spans more than its key line', () => {
    const source = bytes('---\nnotarium-id:\n  - first\ntitle: A\n---\nbody\n')
    const proof = bindStorageOwnerProof({
      source,
      owners: [{ key: STORAGE_OWNER_KEY.id, ownership: 'value' }],
      evidence: { kind: 'mutation-receipt', id: 'receipt-1' },
    })
    const state = analyzeDocumentState({ source, ownerProof: proof })

    expect(state.provenance.claims).toHaveLength(1)
    const plan = planDocumentMutation(state, {
      owners: { [STORAGE_OWNER_KEY.id]: 'AbCdefGhij_1' },
    })

    expect(new TextDecoder().decode(plan.source)).toBe(
      '---\nnotarium-id: AbCdefGhij_1\ntitle: A\n---\nbody\n',
    )
    expect(exactOwnerObservation(plan.source)).toEqual({ kind: 'claimed', id: 'AbCdefGhij_1' })
  })

  it('excludes only receipt-proven owner values from the fingerprint', () => {
    const first = bytes('---\ntitle: A\nnotarium-id: first\ncustom: kept\n---\n\n# A\n')
    const firstProof = bindStorageOwnerProof({
      source: first,
      owners: [{ key: STORAGE_OWNER_KEY.id, ownership: 'value' }],
      evidence: { kind: 'mutation-receipt', id: 'receipt-1' },
    })
    const state = analyzeDocumentState({ source: first, ownerProof: firstProof })
    const plan = planDocumentMutation(state, { owners: { [STORAGE_OWNER_KEY.id]: 'second' } })
    const secondProof = bindStorageOwnerProof({
      source: plan.source,
      owners: [{ key: STORAGE_OWNER_KEY.id, ownership: 'value' }],
      evidence: { kind: 'mutation-receipt', id: 'receipt-2' },
    })
    const replaced = analyzeDocumentState({ source: plan.source, ownerProof: secondProof })
    const unproven = analyzeDocumentState({ source: plan.source })

    expect(replaced.semanticFingerprint).toBe(state.semanticFingerprint)
    expect(documentStateVersionToken(replaced)).toBe(documentStateVersionToken(state))
    expect(unproven.semanticFingerprint).not.toBe(state.semanticFingerprint)
    expect(replaced.provenance.claims[0].evidence.id).toBe('receipt-2')
  })

  it('includes proof shape but not evidence lineage or absolute range shifts', () => {
    const source = bytes('---\nnotarium-id: first\ntitle: A\n---\nbody')
    const valueProof = bindStorageOwnerProof({
      source,
      owners: [{ key: STORAGE_OWNER_KEY.id, ownership: 'value' }],
      evidence: { kind: 'mutation-receipt', id: 'one' },
    })
    const sameShape = bindStorageOwnerProof({
      source,
      owners: [{ key: STORAGE_OWNER_KEY.id, ownership: 'value' }],
      evidence: { kind: 'audited-repair', id: 'two' },
    })
    const entryProof = bindStorageOwnerProof({
      source,
      owners: [{ key: STORAGE_OWNER_KEY.id, ownership: 'entry' }],
      evidence: { kind: 'mutation-receipt', id: 'three' },
    })

    expect(analyzeDocumentState({ source, ownerProof: valueProof }).semanticFingerprint).toBe(
      analyzeDocumentState({ source, ownerProof: sameShape }).semanticFingerprint,
    )
    expect(analyzeDocumentState({ source, ownerProof: entryProof }).semanticFingerprint).not.toBe(
      analyzeDocumentState({ source, ownerProof: valueProof }).semanticFingerprint,
    )
  })

  it('blocks an alias graph that crosses an excluded owner entry', () => {
    const source = bytes('---\nnotarium-id: &owner abc\ncopy: *owner\ntitle: A\n---\nbody')
    const proof = bindStorageOwnerProof({
      source,
      owners: [{ key: STORAGE_OWNER_KEY.id, ownership: 'value' }],
      evidence: { kind: 'mutation-receipt', id: 'owner-anchor' },
    })

    expect(analyzeDocumentState({ source, ownerProof: proof }).restoreSafety).toEqual({
      status: 'blocked',
      reason: 'owner-anchor-dependency',
    })
    expect(analyzeDocumentState({ source }).restoreSafety).toEqual({ status: 'safe' })
  })

  it('fails closed without cross-wiring quoted and plain duplicate target keys', () => {
    const source = bytes(
      '---\n"title": quoted\ntitle: plain\n"notarium-id": authored\nnotarium-id: runtime\n---\nbody',
    )
    const state = analyzeDocumentState({ source })

    expect(state.restoreSafety).toEqual({
      status: 'blocked',
      reason: 'duplicate-target-mapping',
    })
    expect(() =>
      bindStorageOwnerProof({
        source,
        owners: [{ key: STORAGE_OWNER_KEY.id, ownership: 'value' }],
        evidence: { kind: 'mutation-receipt', id: 'must-not-cross-wire' },
      }),
    ).toThrow(/not a unique scalar/)
  })

  it('distinguishes titleless path history without fabricating authored metadata', () => {
    const source = bytes('plain body\n')
    const a = analyzeDocumentState({ source, pathFallbackTitle: 'A' })
    const b = analyzeDocumentState({ source, pathFallbackTitle: 'B' })
    const renamed = planDocumentMutation(a, { title: 'B', fallbackPolicy: 'title-derived' })
    const pinned = planDocumentMutation(a, { title: 'B', fallbackPolicy: 'pinned' })
    const pinnedState = analyzeDocumentState({
      source: pinned.source,
      pathFallbackTitle: pinned.pathFallbackTitle,
    })

    expect(a.semanticFingerprint).not.toBe(b.semanticFingerprint)
    expect(renamed.source).toBe(a.source)
    expect(renamed.pathFallbackTitle).toBe('B')
    expect(new TextDecoder().decode(pinned.source)).toBe('---\ntitle: B\n---\nplain body\n')
    expect(pinned.pathFallbackTitle).toBeNull()
    expect(
      documentRestoreCompatibility(a, {
        role: DOCUMENT_ROLE.generic,
        pathFallbackTitle: 'B',
      }),
    ).toEqual({ status: 'non-restorable', reason: 'path-fallback-mismatch' })
    expect(
      documentRestoreCompatibility(pinnedState, {
        role: DOCUMENT_ROLE.generic,
        pathFallbackTitle: 'B',
      }),
    ).toEqual({ status: 'compatible' })
  })

  it('keeps arbitrary bytes opaque and round-trips them through the binary codec', () => {
    const source = Uint8Array.from([0xff, 0xfe, 0x00, 0x61])
    const state = analyzeDocumentState({ source, pathFallbackTitle: 'binary' })
    const decoded = decodeDocumentState(encodeDocumentState(state))

    expect(state).toMatchObject({
      format: DOCUMENT_STATE_FORMAT.opaque,
      role: DOCUMENT_ROLE.opaque,
      projection: null,
    })
    expect([...decoded.source]).toEqual([...source])
    expect(decoded.semanticFingerprint).toBe(state.semanticFingerprint)
  })

  it('classifies a skill root by package position instead of its directory name', () => {
    const valid = analyzeDocumentState({
      source: bytes(
        '---\nname: review\ndescription: Review changes\nmetadata:\n  notarium.kind: role\n  notarium.skills: "[[evidence]]"\n---\nInstructions\n',
      ),
      role: DOCUMENT_ROLE.skillRoot,
      skillDirectoryName: 'review',
    })
    const renamed = analyzeDocumentState({
      source: bytes('---\nname: other\ndescription: Wrong directory\n---\nInstructions\n'),
      role: DOCUMENT_ROLE.skillRoot,
      skillDirectoryName: 'AbCdefGhij_1',
    })

    expect(valid.format).toBe(DOCUMENT_STATE_FORMAT.skill)
    expect(valid.projection?.skill).toMatchObject({
      name: 'review',
      linkedSkills: [{ kind: 'name', name: 'evidence' }],
      role: true,
    })
    expect(
      analyzeDocumentState({
        source: valid.source,
        role: DOCUMENT_ROLE.skillRoot,
        skillDirectoryName: 'AbCdefGhij_1',
      }).semanticFingerprint,
    ).toBe(valid.semanticFingerprint)
    expect(renamed).toMatchObject({
      format: DOCUMENT_STATE_FORMAT.skill,
      role: DOCUMENT_ROLE.skillRoot,
      projection: { skill: { name: 'other' } },
    })
  })

  it('projects an authored H1 as the Ability title and accepts no description', () => {
    const state = analyzeDocumentState({
      source: bytes('---\nname: stable-review-key\n---\n\n# Review changes\n\nInspect the diff.\n'),
      role: DOCUMENT_ROLE.skillRoot,
      skillDirectoryName: 'AbCdefGhij_1',
    })

    expect(state).toMatchObject({
      format: DOCUMENT_STATE_FORMAT.skill,
      projection: {
        title: 'Review changes',
        body: 'Inspect the diff.\n',
        skill: {
          name: 'stable-review-key',
          title: 'Review changes',
          description: '',
          instructions: 'Inspect the diff.',
        },
      },
    })
  })

  it('does not classify an ordinary markdown document as a skill by frontmatter alone', () => {
    const state = analyzeDocumentState({
      source: bytes('---\nname: ordinary\ndescription: Ordinary note\n---\nBody\n'),
      role: DOCUMENT_ROLE.generic,
      pathFallbackTitle: 'ordinary',
    })

    expect(state).toMatchObject({
      format: DOCUMENT_STATE_FORMAT.markdown,
      role: DOCUMENT_ROLE.generic,
    })
    expect(state.projection?.skill).toBeUndefined()
  })

  it('parses exact owned skill locators without treating their labels as identity', () => {
    const state = analyzeDocumentState({
      source: bytes(
        '---\nname: exact-role\ndescription: Exact role\nmetadata:\n  notarium.kind: role\n  notarium.skills: "[[notarium-id:personal:AbCdefGhij_1|old-label]] [[plain-skill]] [[notarium-id:personal:too-short|ignored]]"\n---\nInstructions\n',
      ),
      role: DOCUMENT_ROLE.skillRoot,
      skillDirectoryName: 'ZyXwvUtsrq_2',
    })

    expect(state.projection?.skill?.linkedSkills).toEqual([
      {
        kind: 'locator',
        source: 'owned',
        scope: 'personal',
        packageId: 'AbCdefGhij_1',
        label: 'old-label',
        raw: '[[notarium-id:personal:AbCdefGhij_1|old-label]]',
      },
      { kind: 'name', name: 'plain-skill' },
      {
        kind: 'invalid',
        raw: '[[notarium-id:personal:too-short|ignored]]',
        reason: 'invalid-locator',
      },
    ])
  })

  // A blank line inside frontmatter is legal YAML, and the raw parser drops it: it is
  // not an entry, and one that BELONGS to an entry (block-scalar content, a paragraph
  // break inside a continued value) is carried in that entry's own lines. So the entry
  // walk has to step over exactly the dropped ones. It did not, and the desync was not
  // theoretical: writing an owner key before the closing fence turns a trailing blank
  // into an interior one, which made an ordinary note unreadable the moment Notarium
  // claimed it.
  it.each([
    { name: 'a trailing', frontmatter: 'title: Historical\n\n' },
    { name: 'a separating', frontmatter: 'title: Historical\n\ntags: [vault]\n' },
    { name: 'a leading', frontmatter: '\ntitle: Historical\n' },
    {
      name: 'a comment-wrapped',
      frontmatter: 'title: Historical\n\n# authored\n\ntags: [vault]\n',
    },
    { name: 'a horizontally padded', frontmatter: 'title: Historical\n \t\ntags: [vault]\n' },
  ])('walks frontmatter entries across $name blank line', ({ frontmatter }) => {
    const source = bytes(`---\n${frontmatter}---\nbody\n`)
    const state = analyzeDocumentState({ source, pathFallbackTitle: 'note' })

    expect(state.format).toBe(DOCUMENT_STATE_FORMAT.markdown)
    expect(state.restoreSafety).toEqual({ status: 'safe' })
    expect(state.projection?.title).toBe('Historical')

    const plan = planDocumentMutation(state, { owners: { [STORAGE_OWNER_KEY.id]: 'note-id' } })
    const text = new TextDecoder().decode(plan.source)

    // The blank line is authored bytes: it survives, and the owner key lands before
    // the closing fence, not inside somebody else's entry.
    expect(text).toBe(`---\n${frontmatter}notarium-id: note-id\n---\nbody\n`)
    expect(plan.proposedOwnerProof.claims).toEqual([
      expect.objectContaining({ key: STORAGE_OWNER_KEY.id, ownership: 'entry' }),
    ])

    const proof = bindStorageOwnerProof({
      source: plan.source,
      owners: [{ key: STORAGE_OWNER_KEY.id, ownership: 'entry' }],
      evidence: { kind: 'mutation-receipt', id: 'receipt' },
    })
    const claim = proof.claims[0]
    const decode = (range: { start: number; end: number }): string =>
      new TextDecoder().decode(plan.source.slice(range.start, range.end))

    // The ranges are what a later mutation writes through: they must name the owner's
    // own bytes, not the ones the skipped blank line shifted them by.
    expect(decode(claim.entryRange)).toBe('notarium-id: note-id\n')
    expect(decode(claim.valueRange)).toBe('note-id')
    expect(
      analyzeDocumentState({ source: plan.source, pathFallbackTitle: 'note', ownerProof: proof })
        .restoreSafety,
    ).toEqual({ status: 'safe' })
  })

  // U+2028 and a lone CR end a Markdown line but not a YAML one, and the raw parser
  // reads frontmatter by the YAML rule. Reading the same block by the Markdown rule
  // split an entry the parser had kept whole, so an ordinary title carrying one of
  // them made the whole document unreadable — and, once restore had written the owner
  // keys into it, unbindable.
  it.each([
    { name: 'a line separator', title: 'a\u2028b' },
    { name: 'a paragraph separator', title: 'a\u2029b' },
  ])('reads a frontmatter line carrying $name as one entry', ({ title }) => {
    const source = bytes(`---\ntitle: "${title}"\nslug: keep\n---\nbody\n`)
    const state = analyzeDocumentState({ source, pathFallbackTitle: 'note' })

    expect(state.restoreSafety).toEqual({ status: 'safe' })
    expect(state.projection?.title).toBe(title)

    const plan = planDocumentMutation(state, { owners: { [STORAGE_OWNER_KEY.id]: 'note-id' } })

    expect(new TextDecoder().decode(plan.source)).toBe(
      `---\ntitle: "${title}"\nslug: keep\nnotarium-id: note-id\n---\nbody\n`,
    )
    expect(plan.proposedOwnerProof.claims).toHaveLength(1)
  })

  // A UTF-8 BOM is a file-encoding prologue, not document content, and every range this
  // module hands out is a UTF-16 index into the DECODED text translated onto a byte
  // offset in SOURCE. That translation is only true while the decoding is faithful: the
  // default decoder swallows a leading BOM, so text and source stood three bytes apart
  // and every range addressed bytes three earlier than the ones it named. The planner
  // then spliced its patch into the middle of somebody else's entry — and whenever the
  // wreckage still parsed as YAML nothing downstream objected, so a restore reported
  // success over a document that had lost the identity it was being written to claim.
  // These files are expected in a vault, not exotic: `parseFrontmatterBlock` accepts a
  // BOM on purpose, and one arrives from a Windows editor, a backup, or a hand-dropped
  // `.md` — every route into the directory that does not pass the importer, which strips
  // it. The mark itself is content of no channel: it survives every mutation untouched
  // and appears in neither the title nor the body projection.
  it.each([
    {
      channel: 'the owner keys a restore appends',
      source: '\uFEFF---\ntitle: Historical\nx: 1\ny: 2\nz: 3\n---\nold body\n',
      intent: {
        owners: {
          [STORAGE_OWNER_KEY.id]: 'AbCdefGhij_1',
          [STORAGE_OWNER_KEY.created]: '2026-08-11T00:00:00.000Z',
        },
      },
      expected:
        '\uFEFF---\ntitle: Historical\nx: 1\ny: 2\nz: 3\nnotarium-id: AbCdefGhij_1\nnotarium-created: 2026-08-11T00:00:00.000Z\n---\nold body\n',
    },
    {
      channel: 'the owner keys on CRLF bytes',
      source: '\uFEFF---\r\ntitle: Historical\r\n---\r\nold body\r\n',
      intent: { owners: { [STORAGE_OWNER_KEY.id]: 'AbCdefGhij_1' } },
      expected:
        '\uFEFF---\r\ntitle: Historical\r\nnotarium-id: AbCdefGhij_1\r\n---\r\nold body\r\n',
    },
    {
      channel: 'a frontmatter title',
      source: '\uFEFF---\ntitle: A\nz: 3\n---\nbody\n',
      intent: { title: 'Renamed' },
      expected: '\uFEFF---\ntitle: Renamed\nz: 3\n---\nbody\n',
    },
    {
      channel: 'a tags projection',
      source: '\uFEFF---\ntitle: A\ntags: [a]\n---\nbody\n',
      intent: { tags: ['b'] },
      expected: '\uFEFF---\ntitle: A\ntags: [b]\n---\nbody\n',
    },
    {
      channel: 'a hidden H1 title with no frontmatter at all',
      source: '\uFEFF# Title\n\nbody\n',
      intent: { title: 'Renamed' },
      expected: '\uFEFF# Renamed\n\nbody\n',
    },
    {
      channel: 'a body with no frontmatter at all',
      source: '\uFEFFplain body\n',
      intent: { body: 'new body\n' },
      expected: '\uFEFFnew body\n',
    },
    {
      channel: 'a generated owner envelope, which belongs AFTER the mark',
      source: '\uFEFFplain body\n',
      intent: { owners: { [STORAGE_OWNER_KEY.id]: 'AbCdefGhij_1' } },
      expected: '\uFEFF---\nnotarium-id: AbCdefGhij_1\n---\nplain body\n',
    },
  ])('addresses source bytes through a leading byte-order mark: $channel', (probe) => {
    const state = analyzeDocumentState({ source: bytes(probe.source), pathFallbackTitle: 'note' })

    expect(state.restoreSafety).toEqual({ status: 'safe' })
    const plan = planDocumentMutation(state, probe.intent)

    expect(exactText(plan.source)).toBe(probe.expected)
    expect(
      analyzeDocumentState({ source: plan.source, pathFallbackTitle: 'note' }).restoreSafety,
    ).toEqual({ status: 'safe' })
    if (probe.intent.owners?.[STORAGE_OWNER_KEY.id]) {
      expect(exactOwnerObservation(plan.source)).toEqual({
        kind: 'claimed',
        id: probe.intent.owners[STORAGE_OWNER_KEY.id],
      })
    }
  })

  it('projects a byte-order-marked document without carrying the mark into a channel', () => {
    const source = bytes('\uFEFF---\ntitle: A\nz: 3\n---\n\n# A\n\nbody\n')
    const state = analyzeDocumentState({ source, pathFallbackTitle: 'note' })
    const slice = (range: { start: number; end: number }): string =>
      exactText(source.slice(range.start, range.end))
    const origin = state.projection?.titleOrigin

    expect(documentSourceText(state)).toBe('\uFEFF---\ntitle: A\nz: 3\n---\n\n# A\n\nbody\n')
    expect(state.projection?.title).toBe('A')
    expect(state.projection?.body).toBe('body\n')
    expect(slice(state.projection!.bodyRange)).toBe('body\n')
    // Narrowed rather than asserted-through: `path-fallback` carries no `valueRange`,
    // so a non-null assertion here would be the compiler taking our word for it.
    expect(origin?.kind).toBe('frontmatter')
    expect(origin && 'valueRange' in origin ? slice(origin.valueRange) : null).toBe('A')
    expect(
      analyzeDocumentState({ source: bytes('\uFEFFplain body\n'), pathFallbackTitle: 'note' })
        .projection?.body,
    ).toBe('plain body\n')
  })

  // Observation and the raw parser must agree about what frontmatter IS, because the
  // parser is the writer: a claim read out of a block the writer does not see would let
  // the next write generate a second envelope beside it. Exactly one BOM is a prologue —
  // a second U+FEFF is content, `FM_OPEN` refuses the block, and absence is not proven.
  it.each([
    {
      name: 'a byte-order mark',
      source: '\uFEFF---\nnotarium-id: note-id\n---\nbody',
      expected: { kind: 'claimed', id: 'note-id' },
    },
    {
      name: 'two byte-order marks',
      source: '\uFEFF\uFEFF---\nnotarium-id: note-id\n---\nbody',
      expected: { kind: 'unproven' },
    },
  ])('observes an owner through $name only when the parser agrees', ({ source, expected }) => {
    expect(exactOwnerObservation(bytes(source))).toEqual(expected)
  })

  // The planner is asked for identity, so it must answer for identity. These shapes are
  // legal YAML the analyzer reads as safe, but they have no top-level mapping to take a
  // key: the appended entry lands in bytes that no longer name the owner. Returning a
  // plan whose proposed proof quietly lacks the key it was told to write is how a
  // corrupted splice reaches the caller wearing a receipt for work it did not do.
  it.each([
    { shape: 'a top-level sequence', frontmatter: '- one\n- two\n' },
    { shape: 'a top-level scalar', frontmatter: 'just a string\n' },
  ])('refuses a mutation whose storage owner did not land: $shape', ({ frontmatter }) => {
    const state = analyzeDocumentState({
      source: bytes(`---\n${frontmatter}---\nbody\n`),
      pathFallbackTitle: 'note',
    })

    expect(state.restoreSafety).toEqual({ status: 'safe' })
    expect(() =>
      planDocumentMutation(state, { owners: { [STORAGE_OWNER_KEY.id]: 'AbCdefGhij_1' } }),
    ).toThrow(/storage owner/)
  })

  // A persisted `opaque-v1` snapshot records what the analyzer of the day could prove
  // about those bytes — a statement about the reader, not about the file. A later
  // reader that CAN parse them does not make the stored row a forgery, so decoding it
  // must still hand back the state it was written as instead of failing history.
  it('reads a stored opaque snapshot back after the analyzer learned its shape', () => {
    const source = bytes('---\ntitle: Historical\n\ntags: [vault]\n---\nbody\n')
    const blob = encodeDocumentState(
      opaqueDocumentState({ source, role: DOCUMENT_ROLE.generic, pathFallbackTitle: 'note' }),
    )
    const decoded = decodeDocumentState(blob)

    expect(analyzeDocumentState({ source, pathFallbackTitle: 'note' }).format).toBe(
      DOCUMENT_STATE_FORMAT.markdown,
    )
    expect(decoded.format).toBe(DOCUMENT_STATE_FORMAT.opaque)
    expect(decoded.projection).toBeNull()
    expect(documentSourceText(decoded)).toBe(new TextDecoder().decode(source))

    const tampered = encodeDocumentState(
      opaqueDocumentState({ source, role: DOCUMENT_ROLE.generic, pathFallbackTitle: 'note' }),
    )

    tampered[tampered.length - 1] ^= 1
    expect(() => decodeDocumentState(tampered)).toThrow(/metadata does not match/)
  })

  it('rejects persisted metadata that does not match the source', () => {
    const state = analyzeDocumentState({ source: bytes('---\ntitle: A\n---\nbody') })
    const blob = encodeDocumentState(state)
    blob[blob.length - 1] ^= 1

    expect(() => decodeDocumentState(blob)).toThrow(/metadata does not match/)
  })

  it('rejects an unknown persisted owner evidence kind', () => {
    const source = bytes('---\nnotarium-id: one\n---\nbody')
    const proof = bindStorageOwnerProof({
      source,
      owners: [{ key: STORAGE_OWNER_KEY.id, ownership: 'value' }],
      evidence: { kind: 'mutation-receipt', id: 'receipt' },
    })
    const blob = encodeDocumentState(analyzeDocumentState({ source, ownerProof: proof }))
    const mutated = bytes(
      new TextDecoder().decode(blob).replace('mutation-receipt', 'invalid-evidence'),
    )

    expect(mutated).toHaveLength(blob.byteLength)
    expect(() => decodeDocumentState(mutated)).toThrow(/invalid document-state blob metadata/)
  })

  it('drops a runtime owner proof with an unknown evidence kind', () => {
    const source = bytes('---\nnotarium-id: one\n---\nbody')
    const proof = bindStorageOwnerProof({
      source,
      owners: [{ key: STORAGE_OWNER_KEY.id, ownership: 'value' }],
      evidence: { kind: 'mutation-receipt', id: 'receipt' },
    })
    const forged = {
      ...proof,
      claims: proof.claims.map((claim) => ({
        ...claim,
        evidence: { kind: 'fabricated-proof', id: claim.evidence.id },
      })),
    }
    const state = analyzeDocumentState({ source, ownerProof: forged as never })

    expect(state.provenance.claims).toEqual([])
    expect(state.semanticFingerprint).toBe(analyzeDocumentState({ source }).semanticFingerprint)
  })
})
