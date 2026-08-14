// A dropped plain-text / markdown FILE → one note: imported verbatim as a single note, not
// run through the JSON content-detector (a markdown body can start with `{`/`[`, so the extension is
// the reliable signal). The file's own text IS the body, and its own FRONTMATTER is its own data
// (#280): `title`/`tags`/`created`/`type` are lifted into the note's typed channels, everything
// else rides along verbatim. Notarium is file-first — we are not the owner of the user's file.

import { isValidNoteId, NOTE_ID_FRONTMATTER_KEY } from '../../libs/id'
import {
  CREATED_FALLBACK_FRONTMATTER_KEY,
  type FrontmatterEntry,
  frontmatterEntryOf,
  frontmatterEntryValue,
  frontmatterHasYamlNodeReferences,
  FrontmatterLimitError,
  headingTitle,
  parseFrontmatterBlock,
  promoteBodyTitle,
} from '../../libs/markdown'
import { normTags } from '../../libs/tags'
import { IMPORT_SOURCE } from '../consts'
import { ImportError } from '../errors'
import { cappedSlug, shortHash, toIso } from '../helpers/format'
import type { ImportNote } from '../types'

/** Keys never carried verbatim from an anchor/alias-free source, whatever they hold.
 *  `title` — the write path asserts its own `title:` unconditionally, so a carried
 *  copy would be replaced anyway (an unreadable shape therefore degrades to the
 *  heading/file-name fallback and cannot survive under that key — the same
 *  collapse an ordinary engine resave of that file on disk performs).
 *  `notarium-id` — an identity claim is not the author's data to donate: the write
 *  path mints the id, and a foreign claim must never smuggle one in. */
const NEVER_CARRIED = new Set(['title', NOTE_ID_FRONTMATTER_KEY, CREATED_FALLBACK_FRONTMATTER_KEY])

/** Keys we LIFT into a typed channel in an anchor/alias-free source — dropped from
 *  the carry ONLY when the lift actually CAPTURED the value, or the file would
 *  assert them twice (and the stale copy would win on a later read).
 *  "In this set" and "we read it" are different facts, and conflating them deleted
 *  data: the value shapes we model are scalar / flow list / block list / block
 *  scalar, so a `type:` written as a nested map yields nothing — and dropping its
 *  lines anyway left the key asserted by NOBODY. Uncaptured ⇒ it is an unmodelled
 *  key like any other, and unmodelled keys ride along. */
const LIFTED_KEYS = ['tags', 'type'] as const

/** Frontmatter keys read as the creation date, in precedence order: ours first,
 *  then our reserved resolved-mtime companion, then the conventions a real
 *  archive actually carries — `date` (Jekyll / Hugo / 11ty front matter) and the
 *  programmatic `created_at`/`createdAt`. The first one that PARSES wins, so a
 *  garbage value doesn't shadow the fallback.
 *
 *  Deliberately NOT in LIFTED_KEYS: reading a date is not a claim on the key. The
 *  foreign ones (`date` and friends) are the author's and stay put. A parseable
 *  `created` is canonicalised by the typed write; when it is unreadable, its raw
 *  line survives and a resolved source-mtime uses the distinct reserved key so
 *  the resulting YAML stays valid without duplicate `created` claims.
 *  canon: docs/import.md#dates-as-data */
const DATE_KEYS = [
  'created',
  CREATED_FALLBACK_FRONTMATTER_KEY,
  'date',
  'created_at',
  'createdAt',
] as const

/** Strip the extension from an upload's basename for the title fallback
 *  (`My Note.md` → `My Note`). Only a known text extension is peeled so a dotted
 *  name (`v1.2 notes`) keeps its dots. */
const baseTitle = (fileName: string): string => {
  const base = fileName.split('/').pop() ?? fileName
  return base.replace(/\.(md|markdown|mdown|mkd|txt|text)$/i, '').trim() || base
}

const scalarOf = (e: FrontmatterEntry | undefined): string => {
  const v = e && frontmatterEntryValue(e)
  return typeof v === 'string' ? v.trim() : ''
}

/** Authored tags off the frontmatter. `normTags` already reads the three shapes a
 *  file carries (block list / flow list / comma scalar); the extra step here is
 *  peeling a leading `#`, which people do write by hand (`- #work`) even though
 *  Obsidian itself stores frontmatter tags bare. Hierarchy (`work/2025`) and case
 *  are NOT touched — foldTag does that at read time, non-destructively.
 *  canon: docs/note-model.md#note-ontology */
const authoredTags = (e: FrontmatterEntry | undefined): string[] | undefined => {
  const tags = normTags(e && frontmatterEntryValue(e))
    ?.map((t) => t.trim().replace(/^#/, '').trim())
    .filter(Boolean)
  return tags?.length ? tags : undefined
}

/** One dropped text file → one note. `raw` is the file's text, `fileName` its
 *  original name (used for the title fallback and the deterministic storage
 *  filename), `sourceCreatedAt` the file's own timestamp (its mtime, threaded
 *  from the client) — the fallback when the frontmatter names no date. Pure and
 *  deterministic — a re-drop of the same file lands on the same path (idempotent,
 *  slug of the basename), so `skipExisting` can no-op it. `directory` is '' — the
 *  host nests it under the drop target folder (`root`). */
export const markdownFileToNote = (
  raw: string,
  fileName: string,
  sourceCreatedAt?: string,
): ImportNote => {
  const text = raw.replace(/^\uFEFF/, '')
  let fm: ReturnType<typeof parseFrontmatterBlock>

  try {
    fm = parseFrontmatterBlock(text)
  } catch (err) {
    if (err instanceof FrontmatterLimitError) {
      throw new ImportError(`${fileName}: ${err.message}`)
    }
    throw err
  }
  const entries = fm?.entries ?? []
  const hasYamlNodeReferences = frontmatterHasYamlNodeReferences(entries)

  // Keywise lifting cannot safely rewrite YAML's order-dependent anchor graph.
  // Keep the COMPLETE parsed block in that case — including keys we would normally
  // lift/drop — so the engine can see the same graph and refuse a fresh write. The
  // refusal deliberately stays behind the store's collision/CAS fence: a DnD
  // `skipExisting` collision must remain a harmless skip without inspecting or
  // rewriting the incoming source. No referenced write reaches the merge below the
  // engine gate; this branch is preservation of the safety signal, not acceptance.
  // Frontmatter is last-wins on read (parseNoteFile and ordinary YAML readers
  // agree). Use the shared lookup so every projection chooses the same duplicate.
  const entry = (key: string): FrontmatterEntry | undefined => frontmatterEntryOf(entries, key)
  // Drop the blank lines the frontmatter left behind — otherwise the first
  // content line is not first and the title scan below misses the heading.
  const afterFm = (fm ? text.slice(fm.bodyStart) : text).replace(/^(?:\r?\n)+/, '')

  // A second confirmed block would be interpreted differently by the real file
  // serializer (which merges inline body frontmatter) and the in-memory engine
  // (which keeps it as body). Refuse that ambiguous source shape. A lone thematic
  // `---` with no closing fence still parses as null and remains ordinary prose.
  if (fm) {
    try {
      if (parseFrontmatterBlock(afterFm)) {
        throw new ImportError(`${fileName}: a second leading frontmatter block is unsupported`)
      }
    } catch (err) {
      if (err instanceof FrontmatterLimitError) {
        throw new ImportError(`${fileName}: ${err.message}`)
      }
      throw err
    }
  }

  // Title precedence — the SAME chain parseNoteFile applies to any .md already on
  // disk: frontmatter `title:` → the body's heading → the file name. The
  // explicit-beats-the-body half is the #156 rule the MCP `create_note` runs too
  // (deriveNoteTitle(body, title)). The fallback is the FILE NAME rather than Bear
  // prose promotion: for an Obsidian note the name IS the title.
  // The middle step is NOT byte-identical to parseNoteFile's: we ask headingTitle
  // (the body's LEADING heading, setext included — the #156 canon), it still scans
  // for a `# H1` anywhere in the document. Ours is the canonical one; aligning the
  // engine's would retitle existing on-disk notes, so it is a tail, not this fix.
  // canon: docs/import.md#the-dropped-files-frontmatter-is-the-authors-data-280
  // .trim() is load-bearing, not cosmetic: a BLANK-but-truthy title (an upload
  // named "   ") is falsy to promoteBodyTitle's `explicit?.trim()` gate, so it
  // would Bear-promote the first body line away while we kept the blank title —
  // the line would then exist nowhere in the note.
  const fallback = baseTitle(fileName).trim() || 'Untitled'
  const title = scalarOf(entry('title')) || headingTitle(afterFm) || fallback
  // promoteBodyTitle peels the leading heading only when it EQUALS the title — so a
  // `# H1` that merely differs from an authored `title:` stays in the body (nothing
  // is dropped), while our own exported file (`title: X` + `# X`) round-trips clean.
  const body = promoteBodyTitle(afterFm, title).body

  const createdAt =
    DATE_KEYS.map((k) => toIso(scalarOf(entry(k)) || null)).find(Boolean) ?? sourceCreatedAt
  const tags = authoredTags(entry('tags'))
  const noteType = scalarOf(entry('type')) || undefined
  // Everything we did not CAPTURE rides along verbatim — raw lines, so a nested map
  // or a plugin's own field survives byte-for-byte. A lifted key drops out of the
  // carry only once its value is really in a typed channel; otherwise it is just
  // another key we don't model, and dropping it would delete the author's data.
  const captured = new Set<string>(
    LIFTED_KEYS.filter((k) => (k === 'tags' ? tags : noteType) !== undefined),
  )
  const carried = hasYamlNodeReferences
    ? entries
    : entries.filter((e) => !e.key || (!NEVER_CARRIED.has(e.key) && !captured.has(e.key)))
  // The identity claim is READ but never carried (NEVER_CARRIED still holds it
  // out of the frontmatter above): a copy mints its own id, and the claim's only
  // job is to key the exact-link map between two notes of the same archive.
  // An unreadable claim is surfaced rather than silently treated as absent —
  // "this file named an identity and we could not use it" is information.
  const claimed = entry(NOTE_ID_FRONTMATTER_KEY)
  const sourceId = scalarOf(claimed)
  const hasReadableSourceId = Boolean(sourceId) && isValidNoteId(sourceId)

  return {
    title,
    // trimEnd (native, linear) — NOT `/\s+$/` which is a quadratic-backtracking
    // ReDoS on attacker-controlled content (a long whitespace run + a trailing char).
    body: body.trimEnd(),
    directory: '',
    tags,
    noteType,
    frontmatter: carried.length ? carried : undefined,
    // The storage key intentionally keeps the legacy ASCII algebra: changing an
    // importer's deterministic path across an upgrade makes a re-import duplicate its
    // own source. A basename outside that alphabet falls back to the raw source-name
    // hash, so distinct files stay distinct while the note TITLE remains Unicode.
    fileName: cappedSlug(fallback) || `note-${shortHash(fileName)}`,
    createdAt,
    source: IMPORT_SOURCE.file,
    ...(hasReadableSourceId ? { sourceId } : {}),
    ...(claimed && !hasReadableSourceId
      ? {
          sourceIdentityWarning: `${fileName}: unreadable ${NOTE_ID_FRONTMATTER_KEY} — imported with a fresh identity`,
        }
      : {}),
  }
}
