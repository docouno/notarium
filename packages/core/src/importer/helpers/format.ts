// Shared importer helpers — pure, deterministic.

import { slugify } from '../../libs/slug'

/** FNV-1a 32-bit → 8 base36 chars. A stable, short filename disambiguator keyed
 *  on the source id: two "Untitled" conversations get distinct files, and the
 *  SAME export re-imports to the SAME filename (idempotent). Not crypto — an
 *  identity tag in a path, so the cheap sync hash (no async WebCrypto) is right. */
export const shortHash = (input: string): string => {
  let h = 0x811c9dc5

  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }

  return (h >>> 0).toString(36).padStart(8, '0')
}

/** A unix epoch (chatgpt float seconds, or ms) → ISO. < 1e11 is read as seconds
 *  (covers any plausible chat date; an ms value that small would be pre-1973). */
const epochToIso = (n: number): Date => new Date(n < 1e11 ? n * 1000 : n)

/** Parse a Claude/ChatGPT timestamp into an ISO-8601 UTC string, or null when
 *  unparseable. Accepts an ISO string (claude `created_at`) and a unix epoch in
 *  SECONDS/ms (chatgpt `create_time`, number). A numeric STRING is only treated
 *  as an epoch when it actually looks like one (≥10 digits) — otherwise `"2024"`
 *  is read as the YEAR (`new Date("2024")`), not epoch-seconds = 1970. */
export const toIso = (ts: unknown): string | null => {
  if (ts == null) {
    return null
  }
  let d: Date

  if (typeof ts === 'number') {
    d = epochToIso(ts)
  } else if (typeof ts === 'string') {
    const t = ts.trim()
    d = /^\d{10,}(\.\d+)?$/.test(t) ? epochToIso(Number(t)) : new Date(t)
  } else {
    return null
  }

  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** `YYYYMMDD` (UTC) prefix for a conversation filename, or empty when the date
 *  is unknown — date-prefixed conversation files group chronologically in the
 *  file browser. */
export const datePrefix = (iso: string | null): string => {
  if (!iso) {
    return ''
  }

  return iso.slice(0, 10).replace(/-/g, '')
}

/** `YYYY-MM-DD HH:MM:SS` (UTC) for a per-message heading. Empty when the
 *  timestamp is unknown. */
export const stampOf = (iso: string | null): string => {
  if (!iso) {
    return ''
  }

  return iso.slice(0, 19).replace('T', ' ')
}

/** Slug capped to `max` chars so the final filename component stays well under
 *  the OS 255-byte limit (cyrillic/CJK expand under transliteration). May return
 *  '' — callers supply their own fallback. The hash suffix on a conversation
 *  filename guarantees uniqueness, so truncating the readable part is safe. */
export const cappedSlug = (s: string, max = 80): string =>
  slugify(s).slice(0, max).replace(/-+$/, '')

/** Deterministic, collision-free filename (sans `.md`) for a conversation:
 *  `<YYYYMMDD>-<slug(title)>-<hash8(sourceId)>`. The date prefix groups
 *  chronologically, the source-id hash guarantees a re-import of the same export
 *  overwrites the same file and two same-titled chats never clash. */
export const convoFileName = (title: string, iso: string | null, sourceId: string): string => {
  const date = datePrefix(iso)
  return `${date ? `${date}-` : ''}${cappedSlug(title) || 'untitled'}-${shortHash(sourceId)}`
}
