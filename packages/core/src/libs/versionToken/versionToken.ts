// The version token behind optimistic writes: a content hash of the note body AS read() serves it,
// so both sides of the compare see the same normalised text (stable across storage quirks that
// never reach the reader). Wire-opaque — clients echo it back, so we can later swap the value for
// a journal revision-id without touching the contract (the `v1:` prefix is that escape hatch).
// FNV-1a 64-bit, pure JS: an identity check between concurrent versions, not a crypto boundary,
// and no node:crypto dependency keeps it usable from any package.

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK_64 = 0xffffffffffffffffn

export const computeVersionToken = (content: string): string => {
  let hash = FNV_OFFSET

  for (let i = 0; i < content.length; i++) {
    hash ^= BigInt(content.charCodeAt(i))
    hash = (hash * FNV_PRIME) & MASK_64
  }

  return `v1:${hash.toString(16).padStart(16, '0')}`
}
