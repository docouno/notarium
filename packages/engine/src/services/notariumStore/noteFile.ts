// One note file, both directions: parse (file → index row / read() view) and
// serialize (write() input → file bytes). The frontmatter primitives come from
// core (`libs/markdown/frontmatter`) — ONE line-based reader for the whole
// product, shared with the importer: top-level scalars and block lists are
// understood, anything fancier passes through VERBATIM (preserved on rewrite,
// absent from the parsed object). Preservation is the point: a write merges into
// the existing block instead of regenerating it, so keys we don't know (a user's
// own fields) survive our edits — a last-write-wins merge semantic, which is what
// lets two writers share one base (#69), and what lets an IMPORTED file keep the
// frontmatter its author wrote (#280).

import {
  CREATED_FALLBACK_FRONTMATTER_KEY,
  DEFAULT_NOTE_TYPE,
  type FrontmatterEntry,
  frontmatterEntryOf,
  frontmatterEntryValue,
  frontmatterHasYamlNodeReferences,
  FrontmatterLimitError,
  frontmatterListEntry,
  frontmatterScalarEntry,
  isValidNoteId,
  isWithinFrontmatterByteCap,
  nextPhysicalLineSpan,
  normAliases,
  normTags,
  NOTE_ID_FRONTMATTER_KEY,
  parseFrontmatterBlock,
  singleLine,
  slugify,
  stripTitleHeading,
} from '@notarium/core'

const YAML_NODE_REFERENCE_WRITE_ERROR =
  'frontmatter with YAML anchors or aliases is not supported by writes'

/** A frontmatter date → ISO-8601 UTC, or null when absent/unparseable. The file
 *  is the creation date's source of truth (#11 import / round-trip): a `created:`
 *  claim overrides the filesystem birthtime in the index. */
const fmDate = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v.trim()) {
    return null
  }
  const d = new Date(v.trim())
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export type ParsedNote = {
  /** frontmatter `title` → first `# heading` → filename sans .md. */
  title: string
  /** Decorative note type from frontmatter `type:`; absent on externally-authored
   *  files that omit it. */
  noteType: string | null
  tags: string[]
  /** Past human names the resolver still honours (#100), from frontmatter
   *  `aliases:` (Obsidian-native). Empty when the note was never renamed. */
  aliases: string[]
  /** The editable display slug (#100 phase 1) from frontmatter `slug:`, null when the
   *  note has no custom slug (the implicit slug(title) default isn't written). */
  slug: string | null
  /** The file's notarium-id claim (P7), when present. */
  idClaim: string | null
  /** Frontmatter `created:` as ISO-8601 UTC (#11), null when the file makes no
   *  claim — the index then falls back to the filesystem birthtime. */
  createdAt: string | null
  /** Parsed top-level frontmatter (scalars + lists); unmodelled lines are
   *  honestly absent here (but preserved by serializeNoteFile). */
  frontmatter: Record<string, unknown>
  /** The body as read() serves it: frontmatter split off, the storage-format
   *  title heading stripped. */
  body: string
}

/** Preserve the engine's legacy title semantics exactly: unlike the importer, a
 *  COLUMN-ZERO H1 anywhere in a frontmatter-less body may title an on-disk note,
 *  and a trailing `#` run remains part of that legacy title. Changing either rule
 *  would retitle existing files during an index pass. The shared physical-line
 *  parser removes the old quadratic regex; its raw projection retains those two
 *  deliberate legacy differences. */
const legacyWhitespace = (char: string): boolean => /\s/.test(char)
const legacyLineTerminator = (char: string): boolean =>
  char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029'

const anywhereH1Title = (content: string): string => {
  let start = 0
  let line = nextPhysicalLineSpan(content, start)

  while (line) {
    // Compatibility with the old `/^#\s+(.+?)\s*$/m` reader: JavaScript `\s`
    // includes NBSP/em-space and crosses physical lines, so a bare `#` followed
    // by prose on the next line historically titled the note from that prose.
    // Scan that exact capture algebra linearly rather than delegating to the
    // CommonMark parser, whose horizontal-space rule is intentionally narrower.
    if (content[line.start] === '#') {
      const firstWhitespace = line.start + 1
      let valueStart = firstWhitespace
      let lastDotWhitespace = -1

      if (valueStart < content.length && legacyWhitespace(content[valueStart])) {
        while (valueStart < content.length && legacyWhitespace(content[valueStart])) {
          if (!legacyLineTerminator(content[valueStart])) {
            lastDotWhitespace = valueStart
          }
          valueStart++
        }
        // When the remainder is whitespace-only, greedy `\s+` leaves the final
        // dot-compatible whitespace for `(.+?)` (provided it consumed at least
        // one earlier whitespace). Preserve that odd, observable legacy title.
        if (valueStart === content.length) {
          if (lastDotWhitespace > firstWhitespace) {
            return content[lastDotWhitespace]
          }
          start = line.next
          line = nextPhysicalLineSpan(content, start)
          continue
        }
        let valueEnd = valueStart

        while (valueEnd < content.length && !legacyLineTerminator(content[valueEnd])) {
          valueEnd++
        }
        let trimmedEnd = valueEnd

        while (trimmedEnd > valueStart && legacyWhitespace(content[trimmedEnd - 1])) {
          trimmedEnd--
        }

        return content.slice(valueStart, trimmedEnd)
      }
    }
    start = line.next
    line = nextPhysicalLineSpan(content, start)
  }

  return ''
}

export const parseNoteFile = (raw: string, path: string): ParsedNote => {
  const fm = parseFrontmatterBlock(raw)
  const afterFm = fm ? raw.slice(fm.bodyStart) : raw
  const frontmatter: Record<string, unknown> = {}

  for (const e of fm?.entries ?? []) {
    if (!e.key) {
      continue
    }
    const v = frontmatterEntryValue(e)

    if (v != null) {
      frontmatter[e.key] = v
    } else {
      // Frontmatter is last-wins even when the last duplicate is a shape this
      // deliberately-small reader cannot model. Leaving the earlier readable
      // projection in place would resurrect a value the file replaced with a
      // nested/map/annotated form.
      delete frontmatter[e.key]
    }
  }
  const fmTitle = typeof frontmatter.title === 'string' ? frontmatter.title : ''
  const h1Title = anywhereH1Title(afterFm)
  const fileName = path.split('/').pop()?.replace(/\.md$/, '') || path
  const title = fmTitle || h1Title || fileName
  const claim = frontmatter[NOTE_ID_FRONTMATTER_KEY]
  // Canonicalise the frontmatter slug to URL form (#100 phase 1): our writes already
  // slugify it, but an externally-authored `slug: My Custom Slug` is normalised
  // here so the resolve key and the URL tail stay the same clean slug.
  const fmSlug = typeof frontmatter.slug === 'string' ? slugify(frontmatter.slug) : ''
  return {
    title,
    noteType:
      typeof frontmatter.type === 'string' && frontmatter.type.trim()
        ? frontmatter.type.trim()
        : null,
    tags: normTags(frontmatter.tags) ?? [],
    aliases: normAliases(frontmatter.aliases) ?? [],
    slug: fmSlug || null,
    idClaim: typeof claim === 'string' && isValidNoteId(claim) ? claim : null,
    createdAt: fmDate(frontmatter.created) ?? fmDate(frontmatter[CREATED_FALLBACK_FRONTMATTER_KEY]),
    frontmatter,
    body: stripTitleHeading(afterFm.replace(/^\r?\n/, ''), title),
  }
}

export type SerializeInput = {
  title: string
  noteType?: string
  /** undefined = leave the file's tags alone; [] = drop them. */
  tags?: string[]
  /** Alias-history (#100), same carry-forward semantics as tags: undefined =
   *  leave the file's `aliases:` block untouched (preserved as a passthrough
   *  entry on edits that don't rename); a provided set REPLACES it; [] drops it.
   *  The engine computes the set with nextAliases on a rename (old title in). */
  aliases?: string[]
  /** The editable display slug (#100 phase 1), same three-state carry as tags/aliases:
   *  undefined leaves the file's `slug:` untouched (passthrough), a string sets
   *  it, '' drops it. The write path passes the lazy-cleaned value (storedSlug),
   *  so a slug equal to slug(title) arrives as '' and stays implicit. */
  slug?: string
  /** The agent-memory `summary` frontmatter (#21): undefined leaves the file's
   *  summary alone (preserved as a passthrough entry), a string sets it. */
  summary?: string
  /** The agent-memory `muted` opt-out flag (#165): undefined leaves any existing
   *  `muted:` alone (passthrough), true writes `muted: true`, false drops it.
   *  Re-read via the generic frontmatter map as the STRING 'true' (valueOf doesn't
   *  coerce) — the read-side normalises ('true'|true), see core memory.ts. */
  muted?: boolean
  /** The identity materialization channel (P7/#51). */
  id?: string
  /** Authored creation instant (ISO-8601 UTC) → `created:` frontmatter. undefined =
   *  leave any existing date alone (a normal body save); a value SETS/overwrites it.
   *  Import (#11) and the agent `create_note` (#21) SET it on create; the UI EDITs it
   *  deliberately on an existing note (#186). (No `modified` — it tracks the real mtime.) */
  createdAt?: string
  /** Frontmatter the note ARRIVES with, carried verbatim (#280): an imported
   *  file's own keys, entry by entry. Merged BELOW the existing file's block and
   *  ABOVE our typed fields — so a re-import can refresh a foreign key, while
   *  title/tags/created stay ours to decide. The importer strips the keys it lifts
   *  into typed channels and the `notarium-id` claim, so this never smuggles in an
   *  identity. */
  frontmatter?: readonly FrontmatterEntry[]
  /** The body the editor saved (may itself open with a frontmatter block —
   *  merged into the file's). */
  body: string
  /** The current file bytes when overwriting; null/undefined = fresh file. */
  existingRaw?: string | null
}

/** Build the file: existing frontmatter ∪ the imported note's own ∪ the body's
 *  inline frontmatter ∪ our fields (ours win), then the storage-format `# title`
 *  heading and the body. */
export const serializeNoteFile = ({
  title,
  noteType,
  tags,
  aliases,
  slug,
  summary,
  muted,
  id,
  createdAt,
  frontmatter,
  body,
  existingRaw,
}: SerializeInput): string => {
  const existingEntries: FrontmatterEntry[] =
    existingRaw != null ? (parseFrontmatterBlock(existingRaw)?.entries ?? []) : []
  // Inline frontmatter riding the body is another incoming metadata channel. Parse
  // it before the safety gate so a caller cannot bypass the raw-entry check by
  // placing `&anchor` / `*alias` in `body` instead of WriteInput.frontmatter.
  let cleanBody = body
  const inline = parseFrontmatterBlock(body)

  // Anchors and aliases are order-dependent, while this serializer merges by key
  // and always replaces at least `title`. Refuse them on every incoming channel,
  // fresh write included. An existing file may predate this restriction; any
  // mutation of such a file is refused too so its dependency order cannot change.
  // This happens before candidate bytes are built, therefore the caller publishes
  // nothing.
  if (
    frontmatterHasYamlNodeReferences(frontmatter) ||
    frontmatterHasYamlNodeReferences(inline?.entries) ||
    (existingRaw != null && frontmatterHasYamlNodeReferences(existingEntries))
  ) {
    throw new Error(YAML_NODE_REFERENCE_WRITE_ERROR)
  }
  const entries = existingEntries
  const incomingCreated = frontmatter && frontmatterEntryOf(frontmatter, 'created')
  const preserveUnreadableCreated = Boolean(
    createdAt && incomingCreated && fmDate(frontmatterEntryValue(incomingCreated)) === null,
  )
  // Positions are tombstoned instead of repeatedly splicing/scanning the array.
  // A large imported block may contain tens of thousands of distinct authored
  // keys, so `findIndex` per entry turns one upload into quadratic event-loop work.
  const live = entries.map(() => true)
  const positions = new Map<string, number[]>()

  for (let i = 0; i < entries.length; i++) {
    const key = entries[i].key

    if (key) {
      const found = positions.get(key)

      if (found) {
        found.push(i)
      } else {
        positions.set(key, [i])
      }
    }
  }

  const drop = (key: string): void => {
    for (const i of positions.get(key) ?? []) {
      live[i] = false
    }
    positions.delete(key)
  }

  const put = (entry: FrontmatterEntry): void => {
    const key = entry.key

    if (!key) {
      return
    }
    const occupied = positions.get(key)

    if (occupied?.length) {
      // Replace at the first live occurrence: this preserves the key's anchor
      // among surrounding authored fields/comments while collapsing every later
      // duplicate. Repeated puts keep using that same slot; only a genuinely new
      // key appends.
      const [anchor, ...duplicates] = occupied
      entries[anchor] = entry
      live[anchor] = true
      for (const i of duplicates) {
        live[i] = false
      }
      positions.set(key, [anchor])
      return
    }
    const appended = entries.push(entry) - 1
    live.push(true)
    positions.set(key, [appended])
  }

  // An imported file's own frontmatter (#280) merges next: below anything the
  // occupied file already had, above our typed fields. Keyless passthrough lines
  // (a YAML comment) cannot be `put` — there is no key to match them on — and
  // dropping them would silently eat a line of the author's file, so they are kept
  // and moved to the FRONT of the block below. Front, not back: a keyless line that
  // is indented or starts with `- ` re-reads as a CONTINUATION of whatever key
  // precedes it, so appending one after our own keys let it swallow `created:` or
  // `notarium-id:`. At the top of the block there is nothing for it to attach to.
  const keyless: FrontmatterEntry[] = []
  const existingKeyless = new Set(
    entries.filter((entry) => !entry.key).map((entry) => entry.lines[0]),
  )

  for (const e of frontmatter ?? []) {
    if (e.key) {
      put(e)
    } else if (!existingKeyless.has(e.lines[0])) {
      // Do not add this line to `existingKeyless`: two identical comments in the
      // SAME source are two authored lines and both survive. Only an already
      // occupied file suppresses a repeated line on a later re-import.
      keyless.push(e)
    }
  }

  // Inline frontmatter riding the body merges in next (ours below override).
  if (inline) {
    for (const e of inline.entries) {
      if (e.key) {
        put(e)
      }
    }
    cleanBody = body.slice(inline.bodyStart).replace(/^\r?\n/, '')
  }

  put(frontmatterScalarEntry('title', title))
  if (noteType !== undefined) {
    if (noteType && noteType !== DEFAULT_NOTE_TYPE) {
      put(frontmatterScalarEntry('type', noteType))
    } else {
      drop('type')
    }
  }
  if (tags !== undefined) {
    if (tags.length) {
      put(frontmatterListEntry('tags', tags))
    } else {
      drop('tags')
    }
  }
  // Alias-history (#100), tags-parity: undefined leaves the file's `aliases:`
  // block as a passthrough entry; a set replaces it; [] drops it.
  if (aliases !== undefined) {
    if (aliases.length) {
      put(frontmatterListEntry('aliases', aliases))
    } else {
      drop('aliases')
    }
  }
  // The editable slug (#100 phase 1), tags-parity: undefined leaves the file's `slug:`
  // as a passthrough; a value sets it; '' drops it (a slug that collapsed onto the
  // implicit slug(title) default stays out of the file).
  if (slug !== undefined) {
    if (slug) {
      put(frontmatterScalarEntry('slug', slug))
    } else {
      drop('slug')
    }
  }
  // undefined = leave any existing summary as a passthrough entry; a string
  // sets/overwrites it (an empty string drops it — an explicit clear).
  if (summary !== undefined) {
    if (summary) {
      put(frontmatterScalarEntry('summary', summary))
    } else {
      drop('summary')
    }
  }
  // The human-set memory opt-out (#165): undefined leaves it as a passthrough,
  // true writes `muted: true`, false clears it (an explicit un-mute).
  if (muted !== undefined) {
    if (muted) {
      put(frontmatterScalarEntry('muted', 'true'))
    } else {
      drop('muted')
    }
  }
  if (id) {
    put(frontmatterScalarEntry(NOTE_ID_FRONTMATTER_KEY, id))
  }
  // Dates-as-data (#11/#186): write `created:` whenever a value is provided —
  // SET/overwrite, so an authored date edit lands and a re-import re-stamps the
  // same value harmlessly. One preservation exception: an incoming unreadable
  // authored `created:` remains byte-lines, while its resolved source-mtime uses
  // our distinct reserved key. Duplicate YAML keys would not be valid YAML. A
  // later explicit date edit has no incoming carry and collapses both back to the
  // normal `created:` key. Absent leaves the file's date alone; `modified` always
  // tracks the file's real mtime.
  if (createdAt) {
    if (preserveUnreadableCreated) {
      put(frontmatterScalarEntry(CREATED_FALLBACK_FRONTMATTER_KEY, createdAt))
    } else {
      drop(CREATED_FALLBACK_FRONTMATTER_KEY)
      put(frontmatterScalarEntry('created', createdAt))
    }
  }

  const fmLines = [...keyless, ...entries.filter((_, index) => live[index])].flatMap((e) => e.lines)
  const frontmatterPayload = `${fmLines.join('\n')}\n`

  // Check the exact bytes that will sit between the fences, including the final
  // line break. Otherwise a near-cap existing block can accept one more typed
  // field, write bytes that our own parser rejects, and only discover the damage
  // after the atomic file replacement has already happened.
  if (!isWithinFrontmatterByteCap(frontmatterPayload)) {
    throw new FrontmatterLimitError()
  }
  // The heading repeats the title, so it must repeat the SAME string the frontmatter
  // states — `singleLine`, not the raw value. Writing the raw one let a title with a
  // line terminator disagree with its own `title:`, and a heading that does not match
  // the title is never stripped on read: one stray copy stayed in the body forever.
  const head = `---\n${frontmatterPayload}---\n\n# ${singleLine(title)}\n`
  return cleanBody ? `${head}\n${cleanBody}` : head
}
