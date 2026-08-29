import { describe, expect, it } from 'vitest'

import { decodeDocumentState, documentStateSourceByteLength, encodeDocumentState } from './codec'
import { analyzeDocumentState } from './documentState'
import * as publicDocumentState from './index'

describe('document-state frame geometry', () => {
  it('reads the exact source length from a sliced NDS1 frame', () => {
    const state = analyzeDocumentState({ source: new TextEncoder().encode('# Title\nbody') })
    const encoded = encodeDocumentState(state)
    const carrier = new Uint8Array(encoded.byteLength + 11)

    carrier.set(encoded, 7)
    const sliced = carrier.subarray(7, 7 + encoded.byteLength)

    expect(documentStateSourceByteLength(sliced)).toBe(state.source.byteLength)
    expect(decodeDocumentState(sliced).semanticFingerprint).toBe(state.semanticFingerprint)
  })

  it.each([
    ['short frame', new Uint8Array(7), 'magic'],
    ['wrong magic', new TextEncoder().encode('NOPE0000'), 'magic'],
    ['truncated header', Uint8Array.from([78, 68, 83, 49, 0, 0, 0, 20]), 'truncated'],
    ['invalid JSON header', Uint8Array.from([78, 68, 83, 49, 0, 0, 0, 1, 123]), 'JSON'],
  ])('rejects a %s instead of returning a fabricated length', (_name, blob, message) => {
    expect(() => documentStateSourceByteLength(blob)).toThrow(message)
  })

  it('keeps the frame helper outside the public document-state barrel', () => {
    expect('documentStateSourceByteLength' in publicDocumentState).toBe(false)
  })
})
