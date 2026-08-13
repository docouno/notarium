// The version token behind optimistic writes: a hash of the canonical logical
// Markdown state (title + authored frontmatter + normalized body). Wire-opaque —
// clients echo it back. `v2:` deliberately invalidates legacy body-only tokens:
// letting one of those through after deploy would re-open the metadata lost-update.
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

  return `v2:${hash.toString(16).padStart(16, '0')}`
}
