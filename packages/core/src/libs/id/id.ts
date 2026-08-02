// The internal note-id (P7): a short URL-safe random string that lives in the
// note's frontmatter and in the identity registry. 12 chars over a 64-symbol
// alphabet = 72 bits — collisions are out of the picture even at millions of
// notes. Web-crypto based so the same code runs in Node hosts and (if ever
// needed) the browser; no dependency.

import { NOTE_ID_LENGTH } from './consts'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'

export const freshNoteId = (size = NOTE_ID_LENGTH): string => {
  const bytes = new Uint8Array(size)
  crypto.getRandomValues(bytes)
  let id = ''

  // 64 symbols exactly → masking has no modulo bias.
  for (let i = 0; i < size; i++) {
    id += ALPHABET[bytes[i] & 63]
  }

  return id
}
