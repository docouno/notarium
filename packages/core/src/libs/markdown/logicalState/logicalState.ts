import { NOTE_ID_FRONTMATTER_KEY } from '../../id'
import {
  CREATED_FALLBACK_FRONTMATTER_KEY,
  type FrontmatterEntry,
  frontmatterEntryValue,
  frontmatterListEntry,
  frontmatterScalarEntry,
  parseFrontmatterBlock,
  singleLine,
} from '../frontmatter'

/** The durable format written by the revision journal. Keep this value opaque on
 * ordinary note reads; history exposes it only to distinguish complete snapshots
 * from legacy body-only rows. */
export const LOGICAL_NOTE_STATE_FORMAT = 'markdown-v1' as const

export type LogicalNoteState = {
  format: typeof LOGICAL_NOTE_STATE_FORMAT
  /** Canonical Markdown: one title entry, every authored frontmatter entry, then
   * the normalized body. Stable identity/runtime projections are deliberately absent. */
  markdown: string
}

export type ParsedLogicalNoteState = {
  title: string
  body: string
  /** Authored entries only. The canonical title is returned separately; reserved
   * identity/runtime keys can never enter a valid snapshot. */
  frontmatter: FrontmatterEntry[]
}

const INTERNAL_KEYS = new Set(['title', NOTE_ID_FRONTMATTER_KEY, CREATED_FALLBACK_FRONTMATTER_KEY])

const cloneEntry = (entry: FrontmatterEntry): FrontmatterEntry => ({
  key: entry.key,
  lines: [...entry.lines],
})

/** Build the ONE logical state used by CAS, journal, diff and restore.
 *
 * The title is canonicalized and placed first. Everything else remains raw and
 * ordered: comments, unknown plugin fields and nested values are data, not a map
 * we are allowed to reinterpret. `notarium-id` and `notarium-created` are storage
 * machinery rather than editable note content, so they never affect the token or
 * enter history. */
export const logicalNoteState = (input: {
  title: string
  body: string
  frontmatter?: readonly FrontmatterEntry[]
}): LogicalNoteState => {
  const body = input.body.replace(/\r\n?/g, '\n')
  const entries = [
    frontmatterScalarEntry('title', singleLine(input.title)),
    ...(input.frontmatter ?? [])
      .filter((entry) => !entry.key || !INTERNAL_KEYS.has(entry.key))
      .map(cloneEntry),
  ]
  const payload = entries.flatMap((entry) => entry.lines).join('\n')

  return {
    format: LOGICAL_NOTE_STATE_FORMAT,
    markdown: `---\n${payload}\n---\n${body}`,
  }
}

/** A compatibility projection for bare/test stores that have not supplied raw
 * entries. Repository engines never take this lossy branch: both attach their
 * exact state. It still protects all scalar/list fields visible in NoteContent. */
export const logicalNoteStateFromProjection = (input: {
  title?: string
  body: string
  frontmatter?: Readonly<Record<string, unknown>>
}): LogicalNoteState => {
  const entries: FrontmatterEntry[] = []

  for (const [key, value] of Object.entries(input.frontmatter ?? {})) {
    if (INTERNAL_KEYS.has(key) || value == null) {
      continue
    }
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      entries.push(frontmatterListEntry(key, value))
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      entries.push(frontmatterScalarEntry(key, String(value)))
    }
  }

  return logicalNoteState({
    title: input.title ?? '',
    body: input.body,
    frontmatter: entries,
  })
}

export const parseLogicalNoteState = (state: LogicalNoteState): ParsedLogicalNoteState => {
  if (state.format !== LOGICAL_NOTE_STATE_FORMAT) {
    throw new Error(`unsupported logical note state format: ${String(state.format)}`)
  }
  const block = parseFrontmatterBlock(state.markdown)

  if (!block) {
    throw new Error('logical note state has no canonical frontmatter')
  }
  const titleEntry = block.entries.find((entry) => entry.key === 'title')
  const title = titleEntry ? frontmatterEntryValue(titleEntry) : null

  if (typeof title !== 'string') {
    throw new Error('logical note state has no canonical title')
  }

  return {
    title,
    body: state.markdown.slice(block.bodyStart),
    frontmatter: block.entries
      .filter((entry) => !entry.key || !INTERNAL_KEYS.has(entry.key))
      .map(cloneEntry),
  }
}
