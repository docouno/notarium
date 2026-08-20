// Shared importer helpers — pure, deterministic.

import { shortHash } from '../../libs/hash'
import { boundNameToBytes, clipToBytes } from '../../libs/path'
import { legacyImportSlug } from '../../libs/slug'
import { IMPORT_DIRECTORY_MAX_BYTES, IMPORT_SLUG_MAX_BYTES } from '../consts'

export { shortHash }

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

/** Slug capped so the final filename component stays under the OS 255-byte limit.
 *  TWO caps, and both are load-bearing. The character cap is the historical one and
 *  must not move: an imported file name is deterministic, and lengthening it would make
 *  a re-import miss its own file and land a duplicate beside it instead of overwriting.
 *  The BYTE cap remains an explicit part of the importer contract; its storage keys
 *  intentionally stay on the legacy ASCII algebra, so a slug implementation upgrade
 *  cannot move an old deterministic path. The shared `noteFileBase` bound is the final
 *  filesystem backstop, but ordinary imported names already fit here byte-for-byte.
 *
 *  May return '' — callers supply their own fallback. Conversation names carry a
 *  deterministic short hash; the streamed import guard arbitrates its rare collision. */
export const cappedSlug = (s: string, max = 80): string =>
  clipToBytes(legacyImportSlug(s).slice(0, max), IMPORT_SLUG_MAX_BYTES).replace(/-+$/, '')

/** A frozen-legacy-ASCII directory component with a final byte fence. Short
 *  historical paths are unchanged; an overlong source name gets a hash of the WHOLE
 *  slug so two names sharing the clipped prefix do not collapse onto one folder. */
export const importerDirectorySlug = (s: string): string =>
  boundNameToBytes(legacyImportSlug(s), IMPORT_DIRECTORY_MAX_BYTES)

/** Exact pre-source-locator conversation basename. New source-aware notes use
 * `sourceNoteFileName`; this survives only as legacy predecessor evidence. */
export const convoFileName = (title: string, iso: string | null, sourceId: string): string => {
  const date = datePrefix(iso)
  return `${date ? `${date}-` : ''}${cappedSlug(title) || 'untitled'}-${shortHash(sourceId)}`
}
