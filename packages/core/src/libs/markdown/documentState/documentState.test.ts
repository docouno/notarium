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
  planDocumentMutation,
} from './index'
import { DOCUMENT_ROLE, DOCUMENT_STATE_FORMAT, STORAGE_OWNER_KEY } from './types'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

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

  it('classifies a valid direct skill root and keeps an invalid root opaque', () => {
    const valid = analyzeDocumentState({
      source: bytes(
        '---\nname: review\ndescription: Review changes\nmetadata:\n  notarium.kind: role\n  notarium.skills: "[[evidence]]"\n---\nInstructions\n',
      ),
      role: DOCUMENT_ROLE.skillRoot,
      skillDirectoryName: 'review',
    })
    const invalid = analyzeDocumentState({
      source: bytes('---\nname: other\ndescription: Wrong directory\n---\nInstructions\n'),
      role: DOCUMENT_ROLE.skillRoot,
      skillDirectoryName: 'review',
    })

    expect(valid.format).toBe(DOCUMENT_STATE_FORMAT.skill)
    expect(valid.projection?.skill).toMatchObject({
      name: 'review',
      linkedSkills: ['evidence'],
      role: true,
    })
    expect(invalid).toMatchObject({
      format: DOCUMENT_STATE_FORMAT.opaque,
      role: DOCUMENT_ROLE.skillRoot,
    })
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
