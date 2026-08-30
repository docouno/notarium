import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

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
/** The YAML between the fences — so a test can assert what a STRICT reader makes of a
 *  document, independently of this module's own conservative projection. */
const payloadOf = (document: string): string =>
  document.slice(document.indexOf('\n') + 1, document.lastIndexOf('\n---\n') + 1)

describe('document state', () => {
  it('projects __proto__ as own frontmatter data on a null-prototype map', () => {
    const state = analyzeDocumentState({
      source: bytes('---\n__proto__:\n- attacker\nnormal: value\n---\nbody'),
      pathFallbackTitle: 'note',
    })
    const projection = state.projection!.frontmatter

    expect(Object.getPrototypeOf(projection)).toBeNull()
    expect(Object.getOwnPropertyNames(projection)).toEqual(['__proto__', 'normal'])
    expect(projection.__proto__).toEqual(['attacker'])
  })

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

  // An entry-wide rewrite carries off whatever the entry defined — an anchor included —
  // and an orphaned alias is not a PARSE error, so nothing downstream objects: the source
  // still parses, the plan still verifies its own key, and the document quietly stops
  // meaning what it said. `restoreSafety` cannot be the gate (it is hashed into stored
  // revisions), so the plan checks its own candidate instead.
  it('refuses a mutation that leaves a neighbour aliasing an anchor it just deleted', () => {
    const source = '---\ntitle: A\ntags: &t\n  - a\nmirror: *t\n---\nbody\n'
    const state = analyzeDocumentState({ source: bytes(source), pathFallbackTitle: 'note' })

    // Everything the old gates look at says this document is fine, before and after.
    expect(state.restoreSafety).toEqual({ status: 'safe' })
    expect(parseYaml(payloadOf(source))).toEqual({ title: 'A', tags: ['a'], mirror: ['a'] })
    expect(() => planDocumentMutation(state, { tags: ['x'] })).toThrow(/frontmatter unreadable/)
  })

  it.each([
    {
      shape: 'an anchor in a flow list, which keeps its slot on the key line',
      source: '---\ntitle: A\ntags: &t [a, b]\nmirror: *t\n---\nbody\n',
      intent: { tags: ['x'] },
      expected: '---\ntitle: A\ntags: &t [x]\nmirror: *t\n---\nbody\n',
    },
    {
      shape: 'an anchor on a scalar title',
      source: '---\ntitle: &t A\nmirror: *t\n---\nbody\n',
      intent: { title: 'Renamed' },
      expected: '---\ntitle: &t Renamed\nmirror: *t\n---\nbody\n',
    },
    {
      shape: 'an anchor in an entry the mutation never touches',
      source: '---\ntitle: A\nkeep: &k v\ntags: [a]\nmirror: *k\n---\nbody\n',
      intent: { tags: ['x'] },
      expected: '---\ntitle: A\nkeep: &k v\ntags: [x]\nmirror: *k\n---\nbody\n',
    },
  ])('still plans over $shape', ({ source, intent, expected }) => {
    const state = analyzeDocumentState({ source: bytes(source), pathFallbackTitle: 'note' })
    const plan = planDocumentMutation(state, intent)

    expect(new TextDecoder().decode(plan.source)).toBe(expected)
    expect(() => parseYaml(payloadOf(expected))).not.toThrow()
  })

  // The check is asymmetric on purpose: a document that already had no readable projection
  // is not something this plan broke, and refusing it would be a new prohibition.
  it('still plans over a source whose projection was already unbuildable', () => {
    const source = '---\ntitle: A\nmirror: *gone\n---\nbody\n'
    const state = analyzeDocumentState({ source: bytes(source), pathFallbackTitle: 'note' })

    expect(() => parseYaml(payloadOf(source))).toThrow(/alias/i)
    expect(new TextDecoder().decode(planDocumentMutation(state, { tags: ['x'] }).source)).toBe(
      '---\ntitle: A\nmirror: *gone\ntags: [x]\n---\nbody\n',
    )
  })

  // Where a candidate loses its projection ENTIRELY, this planner deliberately stays
  // quiet: `candidateFm` is null, the per-key promise has nothing to check, and the
  // callers refuse in their own more precise words. Pinning it here keeps that division
  // honest — the docblock above claims it, and a claim about callers needs a test.
  it('hands back a plan whose candidate went opaque, leaving the verdict to its caller', () => {
    const source =
      '---\nname: my-skill\ndescription: does things\ntags: &t\n  - a\nmirror: *t\n---\n# My Skill\n\ninstructions\n'
    const state = analyzeDocumentState({
      source: bytes(source),
      role: DOCUMENT_ROLE.skillRoot,
      skillDirectoryName: 'my-skill',
      pathFallbackTitle: 'SKILL',
    })

    expect(state.projection).not.toBeNull()
    const plan = planDocumentMutation(state, { tags: ['x'] })
    const candidate = analyzeDocumentState({
      source: plan.source,
      role: DOCUMENT_ROLE.skillRoot,
      skillDirectoryName: 'my-skill',
      pathFallbackTitle: 'SKILL',
    })

    // The plan exists, and it is unusable — which is exactly what the caller's own gate
    // reads off it. The same document as a generic note is refused by the planner.
    expect(candidate.projection).toBeNull()
    expect(() =>
      planDocumentMutation(
        analyzeDocumentState({ source: bytes(source), pathFallbackTitle: 'note' }),
        { tags: ['x'] },
      ),
    ).toThrow(/frontmatter unreadable/u)
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

  it('uses the shared block EOL rule for owner insertions', () => {
    const probes = [
      {
        source: '---\r\ntitle: Historical\na: one\r\nb: two\r\n---\r\nbody\r\n',
        expected: 'notarium-id: note-id\r\n---\r\n',
      },
      {
        source: '---\ntitle: Historical\r\na: one\n---\nbody\n',
        expected: 'notarium-id: note-id\n---\n',
      },
      {
        source: '# Historical\n```\r\ncode\r\n```\n',
        expected: '---\nnotarium-id: note-id\n---\n',
      },
    ]

    for (const probe of probes) {
      const state = analyzeDocumentState({ source: bytes(probe.source), pathFallbackTitle: 'note' })
      const plan = planDocumentMutation(state, { owners: { [STORAGE_OWNER_KEY.id]: 'note-id' } })

      expect(new TextDecoder().decode(plan.source)).toContain(probe.expected)
    }
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

// Every `ds1:` value below is a contract with ALREADY-PERSISTED data: live `v3:` version
// tokens are this fingerprint verbatim, and `decodeDocumentState` recomputes it from a
// stored blob's own bytes and refuses the revision FOREVER on a mismatch — there is no
// error a caller can retry out of. So no value here may ever change, and none may be
// re-snapped from the current code: a pin captured after an implementation change would
// prove only that the change agrees with itself.
describe('document state fingerprint pins', () => {
  const ownedSource = bytes('---\nnotarium-id: AbCdefGhij_1\n---\n# T\n\nbody\n')
  const ownedProof = (generatedContainer: boolean) =>
    bindStorageOwnerProof({
      source: ownedSource,
      owners: [{ key: STORAGE_OWNER_KEY.id, ownership: 'entry' }],
      evidence: { kind: 'mutation-receipt', id: 'receipt-1' },
      generatedContainer,
    })
  const anchorSource = bytes('---\nnotarium-id: &owner abc\ncopy: *owner\ntitle: A\n---\nbody')

  // The length pairs pin the 8-byte big-endian length prefix exactly on its carry
  // boundaries (255→256, 65535→65536) — the bytes that break first when `frame` is
  // rewritten.
  it.each([
    { name: 'empty', input: { source: bytes('') }, pin: 'ds1:4189321331c74634' },
    {
      name: 'plain-body',
      input: { source: bytes('# Title\n\nbody text\n') },
      pin: 'ds1:e31279b2d991d747',
    },
    {
      name: 'no-heading',
      input: { source: bytes('just a body line\n') },
      pin: 'ds1:b78f572f4efa8f6e',
    },
    {
      name: 'frontmatter',
      input: { source: bytes('---\ntitle: T\ntags:\n  - a\n---\n\n# Title\n\nbody\n') },
      pin: 'ds1:25c71a405272da20',
    },
    {
      name: 'path-fallback',
      input: { source: bytes('body only\n'), pathFallbackTitle: 'From Path' },
      pin: 'ds1:a29d45cbdaec2530',
    },
    {
      name: 'multibyte',
      input: { source: bytes('# Заголовок\n\nтело 🎉 текст\n') },
      pin: 'ds1:6c413af799bfcd89',
    },
    { name: 'crlf', input: { source: bytes('# T\r\n\r\nbody\r\n') }, pin: 'ds1:8dd280a28b5d1383' },
    {
      name: 'bom',
      input: { source: bytes('﻿# T\n\nbody\n') },
      pin: 'ds1:d5b87dddefe9cfcb',
    },
    { name: 'len-255', input: { source: bytes('a'.repeat(255)) }, pin: 'ds1:00559dda5583e562' },
    { name: 'len-256', input: { source: bytes('a'.repeat(256)) }, pin: 'ds1:b153b0ef447fbe5d' },
    {
      name: 'len-65535',
      input: { source: bytes('a'.repeat(65535)) },
      pin: 'ds1:3130b22ccbf16ccf',
    },
    {
      name: 'len-65536',
      input: { source: bytes('a'.repeat(65536)) },
      pin: 'ds1:2f25c080b34c44df',
    },
    {
      name: 'invalid-yaml',
      input: { source: bytes('---\ntitle: [unclosed\n---\n\nbody\n') },
      pin: 'ds1:935ab3ecb46e1380',
    },
    {
      name: 'opaque-bytes',
      input: { source: Uint8Array.of(0xff, 0xfe, 0x00, 0x01, 0x02) },
      pin: 'ds1:0179e7b0ad0c8361',
    },
    {
      name: 'skill-root',
      input: {
        source: bytes(
          '---\nname: demo-skill\ndescription: A demo skill\n---\n\n# Demo Skill\n\ninstructions\n',
        ),
        role: DOCUMENT_ROLE.skillRoot,
        skillDirectoryName: 'demo-skill',
      },
      pin: 'ds1:944b87a0b9a41221',
    },
    {
      name: 'skill-auxiliary',
      input: { source: bytes('# Title\n\nbody text\n'), role: DOCUMENT_ROLE.skillAuxiliary },
      pin: 'ds1:d462e3a38bc76604',
    },
    {
      name: 'blocked-duplicate-target-mapping',
      input: { source: bytes('---\ntitle: A\ntitle: B\n---\n\nbody\n') },
      pin: 'ds1:73484355816bb38f',
    },
  ])('pins $name', ({ input, pin }) => {
    expect(analyzeDocumentState(input).semanticFingerprint).toBe(pin)
  })

  it('pins blocked/owner-anchor-dependency under a value claim', () => {
    const proof = bindStorageOwnerProof({
      source: anchorSource,
      owners: [{ key: STORAGE_OWNER_KEY.id, ownership: 'value' }],
      evidence: { kind: 'mutation-receipt', id: 'receipt-1' },
    })
    const state = analyzeDocumentState({ source: anchorSource, ownerProof: proof })

    expect(state.restoreSafety).toEqual({ status: 'blocked', reason: 'owner-anchor-dependency' })
    expect(state.semanticFingerprint).toBe('ds1:fc8617474058aa10')
  })

  // The `generatedContainer` flag is dropped when there are no claims, so this pair is
  // only a pair UNDER a claim — with an empty claim list both inputs collapse to one
  // fingerprint and the container branch goes unpinned behind a green test.
  it('pins both container provenances under a claim, and they differ', () => {
    const generated = analyzeDocumentState({ source: ownedSource, ownerProof: ownedProof(true) })
    const authored = analyzeDocumentState({ source: ownedSource, ownerProof: ownedProof(false) })

    expect(generated.provenance.claims).toHaveLength(1)
    expect(generated.semanticFingerprint).toBe('ds1:1f2d5bb60421fc0e')
    expect(authored.semanticFingerprint).toBe('ds1:86c91ceebb05c202')
    expect(generated.semanticFingerprint).not.toBe(authored.semanticFingerprint)
  })

  // Claims are handed over in the REVERSE of their key-sorted order on purpose: the
  // fingerprint sorts them, and a pin built from an already-sorted input would keep
  // passing if the sort were lost.
  it('pins a multi-slice fingerprint over claims given in unsorted order', () => {
    const source = bytes(
      '---\nnotarium-id: AbCdefGhij_1\nnotarium-created: 2026-08-18T00:00:00.000Z\ntitle: A\n---\n\nbody\n',
    )
    const proof = bindStorageOwnerProof({
      source,
      owners: [
        { key: STORAGE_OWNER_KEY.id, ownership: 'value' },
        { key: STORAGE_OWNER_KEY.created, ownership: 'entry' },
      ],
      evidence: { kind: 'mutation-receipt', id: 'receipt-1' },
    })
    const state = analyzeDocumentState({ source, ownerProof: proof })

    expect(proof.claims.map((claim) => claim.key)).toEqual([
      STORAGE_OWNER_KEY.id,
      STORAGE_OWNER_KEY.created,
    ])
    expect(state.provenance.claims).toHaveLength(2)
    expect(state.semanticFingerprint).toBe('ds1:e866acf77ccb4c36')
  })

  // Blobs captured from a live stand BEFORE any fingerprint change (task 392, V1.0
  // snapshot). Unlike the input pins above, these prove the irreversible surface
  // directly: a stored blob's header fingerprint must keep matching a fresh reading of
  // its own bytes, or `decodeDocumentState` turns the revision into
  // `revisionHasNoContent` for good. The claims blob is the load-bearing one — its
  // fingerprint depends on header provenance, which no source-only pin exercises.
  it.each([
    {
      name: 'a claimed generated-container note',
      pin: 'ds1:6db45937e12d4370',
      claims: 1,
      base64:
        'TkRTMQAAAZF7ImZvcm1hdCI6Im1hcmtkb3duLXYyIiwicm9sZSI6ImdlbmVyaWMiLCJwcm92ZW5hbmNlIjp7InZlcnNpb24iOjEsImNsYWltcyI6W3sia2V5Ijoibm90YXJpdW0taWQiLCJvd25lcnNoaXAiOiJlbnRyeSIsInZhbHVlUmFuZ2UiOnsic3RhcnQiOjUyLCJlbmQiOjY2fSwiZW50cnlSYW5nZSI6eyJzdGFydCI6MzksImVuZCI6Njd9LCJldmlkZW5jZSI6eyJraW5kIjoibXV0YXRpb24tcmVjZWlwdCIsImlkIjoiZUJoeGQ1SW5JbzJfOnJlY2VpcHQtMSJ9fV0sImdlbmVyYXRlZENvbnRhaW5lciI6dHJ1ZX0sInJlc3RvcmVTYWZldHkiOnsic3RhdHVzIjoic2FmZSJ9LCJwYXRoRmFsbGJhY2tUaXRsZSI6Im1lZXRpbmctbm90ZXMiLCJzZW1hbnRpY0ZpbmdlcnByaW50IjoiZHMxOjZkYjQ1OTM3ZTEyZDQzNzAifS0tLQp0aXRsZTogTWVldGluZyBub3Rlcwp0eXBlOiBtZWV0aW5nCm5vdGFyaXVtLWlkOiAiLVlmX2tMTm53R0gxIgpjcmVhdGVkOiAyMDIwLTAzLTA0VDEwOjAwOjAwLjAwMFoKLS0tCgojIE1lZXRpbmcgbm90ZXMKCkFuIG9sZCBtZWV0aW5nIGZyb20gdGhlIGFyY2hpdmUg4oCUIHllYXItZm9ybWF0IGRhdGUu',
    },
    {
      name: 'a directly-authored skill note',
      pin: 'ds1:324dc38a8dca02e8',
      claims: 0,
      base64:
        'TkRTMQAAAOV7ImZvcm1hdCI6InNraWxsLW1hcmtkb3duLXYxIiwicm9sZSI6InNraWxsLXJvb3QiLCJwcm92ZW5hbmNlIjp7InZlcnNpb24iOjEsImNsYWltcyI6W119LCJyZXN0b3JlU2FmZXR5Ijp7InN0YXR1cyI6InNhZmUifSwicGF0aEZhbGxiYWNrVGl0bGUiOm51bGwsInNlbWFudGljRmluZ2VycHJpbnQiOiJkczE6MzI0ZGMzOGE4ZGNhMDJlOCIsInNraWxsRGlyZWN0b3J5TmFtZSI6InZhbGlkLWRpcmVjdCJ9LS0tCm5hbWU6IHZhbGlkLWRpcmVjdApkZXNjcmlwdGlvbjogQSB2YWxpZCBkaXJlY3RseS1hdXRob3JlZCBza2lsbAotLS0KRm9sbG93IHRoZXNlIGV4YWN0IGluc3RydWN0aW9ucy4K',
    },
    {
      name: 'an opaque byte revision',
      pin: 'ds1:15887c37abd5d5c6',
      claims: 0,
      base64:
        'TkRTMQAAANx7ImZvcm1hdCI6Im9wYXF1ZS12MSIsInJvbGUiOiJvcGFxdWUiLCJwcm92ZW5hbmNlIjp7InZlcnNpb24iOjEsImNsYWltcyI6W119LCJyZXN0b3JlU2FmZXR5Ijp7InN0YXR1cyI6InVua25vd24iLCJyZWFzb24iOiJwYXJzZXItcmFuZ2UtdW5jZXJ0YWludHkifSwicGF0aEZhbGxiYWNrVGl0bGUiOm51bGwsInNlbWFudGljRmluZ2VycHJpbnQiOiJkczE6MTU4ODdjMzdhYmQ1ZDVjNiJ9/wD+YQ==',
    },
  ])('decodes a persisted pre-change revision blob: $name', ({ pin, claims, base64 }) => {
    const blob = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const decoded = decodeDocumentState(blob)

    expect(decoded.semanticFingerprint).toBe(pin)
    expect(decoded.provenance.claims).toHaveLength(claims)
    if (claims > 0) {
      expect(decoded.provenance.generatedContainer).toBe(true)
    }
  })
})

// The streaming accumulator against the retired BigInt reference, over the SAME framed
// stream — so the length prefix is under test, not just the hash arithmetic. The oracle
// collects its stream with a loop rather than a spread: the spread is exactly the form
// the reference died of (and the lint rule now bans), and it is no part of the framing
// contract — only the byte order is. Composition of `fingerprintOf` is NOT covered
// here; the golden pins above own that.
describe('fingerprint accumulator parity', () => {
  const oracleFingerprint = (source: Uint8Array): string => {
    const stream: number[] = []

    const frame = (payload: Uint8Array): void => {
      const length = BigInt(payload.byteLength)

      for (let shift = 56n; shift >= 0n; shift -= 8n) {
        stream.push(Number((length >> shift) & 0xffn))
      }
      for (const byte of payload) {
        stream.push(byte)
      }
    }
    const add = (value: string | Uint8Array): void =>
      frame(typeof value === 'string' ? new TextEncoder().encode(value) : value)

    // The framed sequence `fingerprintOf` emits for an opaque state with no claims.
    add('notarium.document-state.fingerprint.v1')
    add(DOCUMENT_STATE_FORMAT.opaque)
    add(DOCUMENT_ROLE.opaque)
    add('unknown')
    add('parser-range-uncertainty')
    add('')
    add('authored-container')
    add(source)

    let hash = 0xcbf29ce484222325n

    for (const byte of stream) {
      hash ^= BigInt(byte)
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
    }

    return `ds1:${hash.toString(16).padStart(16, '0')}`
  }
  const produced = (source: Uint8Array): string =>
    opaqueDocumentState({ source }).semanticFingerprint

  it('agrees on every single-byte input', () => {
    for (let byte = 0; byte < 256; byte++) {
      const source = Uint8Array.of(byte)

      expect(produced(source)).toBe(oracleFingerprint(source))
    }
  })

  it('agrees on 1000-byte runs of every byte value', () => {
    for (let byte = 0; byte < 256; byte++) {
      const source = new Uint8Array(1000).fill(byte)

      expect(produced(source)).toBe(oracleFingerprint(source))
    }
  }, 30_000)

  it('agrees on 2000 deterministic pseudo-random arrays', () => {
    // Math.imul keeps the LCG in exact 32-bit arithmetic — a float multiply would shed
    // low bits past 2^53 — so the corpus is reproducible: no Math.random() here.
    let seed = 123456789

    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff

      return seed
    }

    for (let run = 0; run < 2000; run++) {
      const source = new Uint8Array(next() % 401)

      for (let index = 0; index < source.length; index++) {
        source[index] = next() & 0xff
      }
      expect(produced(source)).toBe(oracleFingerprint(source))
    }
  }, 30_000)
})

// Document size and the caller's stack position must not decide whether a note has a
// state at all. No test here asserts a byte threshold: the old failure point was a
// function of REMAINING stack, not of any constant these assertions could pin.
describe('document state at size', () => {
  const markdownOf = (payloadBytes: number): Uint8Array =>
    bytes(`# Big\n\n${'a'.repeat(payloadBytes)}\n`)

  it.each([{ mib: 2 }, { mib: 8 }])('returns a state for a $mib MiB document', ({ mib }) => {
    const state = analyzeDocumentState({ source: markdownOf(mib * 1024 * 1024) })

    expect(state.format).toBe(DOCUMENT_STATE_FORMAT.markdown)
    expect(state.semanticFingerprint).toMatch(/^ds1:[0-9a-f]{16}$/)
  })

  it('returns a state from 2000 call frames deep', () => {
    const source = markdownOf(2 * 1024 * 1024)
    const descend = (depth: number): string =>
      depth > 0 ? descend(depth - 1) : analyzeDocumentState({ source }).semanticFingerprint

    expect(descend(2000)).toBe(analyzeDocumentState({ source }).semanticFingerprint)
  })
})
