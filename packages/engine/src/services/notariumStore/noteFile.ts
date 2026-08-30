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
  assertFieldPatchWritable,
  buildNoteFieldsBlob,
  CREATED_FALLBACK_FRONTMATTER_KEY,
  type FieldPatch,
  fieldPatchEmissions,
  type FrontmatterBlock,
  frontmatterBlockEol,
  type FrontmatterEntry,
  frontmatterEntryIsBlockScalar,
  frontmatterEntryOf,
  frontmatterEntrySpans,
  frontmatterEntryValue,
  FrontmatterGeometryError,
  frontmatterHasYamlNodeReferences,
  FrontmatterLimitError,
  frontmatterListEntry,
  type FrontmatterPayloadBounds,
  frontmatterPayloadBounds,
  frontmatterScalar,
  frontmatterScalarEntry,
  type FrontmatterSpan,
  IMPORT_SOURCE_FRONTMATTER_KEY,
  isImportNoteSourceLocator,
  isValidNoteId,
  isWithinFrontmatterByteCap,
  mutedFrontmatter,
  nextPhysicalLineSpan,
  normAliases,
  normTags,
  NOTE_ID_FRONTMATTER_KEY,
  noteTypeFrontmatter,
  parseBodyFrontmatterBlock,
  parseFrontmatterBlock,
  singleLine,
  slugify,
  stripTitleHeading,
  summaryFrontmatter,
  type TypedFrontmatterEmission,
  yamlNodeReferenceWriteError,
} from '@notarium/core'

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
  /** Canonical reserved import provenance, kept out of `frontmatter`. */
  sourceLocator: string | null
  /** Frontmatter `created:` as ISO-8601 UTC (#11), null when the file makes no
   *  claim — the index then falls back to the filesystem birthtime. */
  createdAt: string | null
  /** Parsed top-level frontmatter (scalars + lists); unmodelled lines are
   *  honestly absent here (but preserved by serializeNoteFile). */
  frontmatter: Record<string, unknown>
  /** Exact raw entries behind the projection above. Consumers that protect or
   * version the whole logical note must use these rather than reverse-engineer
   * YAML from the deliberately-small Record view. */
  frontmatterEntries: FrontmatterEntry[]
  /** The author's frontmatter as the index column stores it: the serialized fields
   *  blob. Derived from the entries rather than the Record above, which cannot tell
   *  an absent key from one whose value the reader could not project. Built on FIRST
   *  READ and memoized: most callers of the parse (the heal pass, the identity
   *  materialization loop on every write, `read()`) never look at it, while a note at
   *  the frontmatter cap costs milliseconds to build on a shared event loop. */
  fields: string
  /** The body as read() serves it: frontmatter and encoding prologue split off, the
   *  storage-format title heading stripped. */
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
  // A leading U+FEFF is the file's encoding prologue, not content: the frontmatter
  // reader already steps over it, so only the block-less branch met the mark — sitting
  // where the title scan and the heading strip expect the first character, it cost the
  // note its own `# heading` title. Exactly one mark leads a file; a second is content.
  // Stripped here and put back by `serializeNoteFile` from the file's own previous
  // bytes: the mark belongs to the file, so an ordinary save and a strict restore give
  // it the same answer, and neither invents one for a file that had none.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  // A SECOND mark is content, so it cannot open a block: `FM_OPEN` tolerates one mark
  // before the fence, which is right for the raw file and wrong for the text left after
  // the prologue has already been taken off — it swallowed the author's byte and an
  // ordinary save then wrote the file back with one mark fewer.
  const fm = text.charCodeAt(0) === 0xfeff ? null : parseFrontmatterBlock(text)
  const afterFm = fm ? text.slice(fm.bodyStart) : text
  const frontmatter = Object.create(null) as Record<string, unknown>

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
  const sourceLocator = frontmatter[IMPORT_SOURCE_FRONTMATTER_KEY]
  delete frontmatter[IMPORT_SOURCE_FRONTMATTER_KEY]
  // Canonicalise the frontmatter slug to URL form (#100 phase 1): our writes already
  // slugify it, but an externally-authored `slug: My Custom Slug` is normalised
  // here so the resolve key and the URL tail stay the same clean slug.
  const fmSlug = typeof frontmatter.slug === 'string' ? slugify(frontmatter.slug) : ''
  const entries = fm?.entries ?? []
  let fields: string | undefined

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
    sourceLocator: isImportNoteSourceLocator(sourceLocator) ? sourceLocator : null,
    createdAt: fmDate(frontmatter.created) ?? fmDate(frontmatter[CREATED_FALLBACK_FRONTMATTER_KEY]),
    frontmatter,
    frontmatterEntries: entries,
    get fields(): string {
      fields ??= buildNoteFieldsBlob(entries)
      return fields
    },
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
   *  `muted:` alone (passthrough), a boolean sets or clears it. */
  muted?: boolean
  /** The identity materialization channel (P7/#51). */
  id?: string
  /** Trusted typed provenance. Undefined preserves the existing file field. */
  sourceLocator?: string
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
  fields?: FieldPatch
  fieldsUnquoted?: string[]
  /** Full-state restore: incoming entries replace the authored set rather than
   * merge under the live file. System title/id are still materialized below. */
  frontmatterMode?: 'replace'
  /** The body the editor saved (may itself open with a frontmatter block —
   *  merged into the file's). */
  body: string
  /** The current file bytes when overwriting; null/undefined = fresh file. */
  existingRaw?: string | null
}

export type NoteFileSource = {
  raw: string
  block: FrontmatterBlock | null
  bounds: FrontmatterPayloadBounds | null
  spans: readonly FrontmatterSpan[] | null
}

export type NoteFileAssembly = {
  title: string
  cleanBody: string
  keyless: readonly FrontmatterEntry[]
  entries: readonly FrontmatterEntry[]
  live: readonly boolean[]
  touched: readonly boolean[]
  replacing: boolean
  source: NoteFileSource | null
}

const entryInline = (entry: FrontmatterEntry): string | null => {
  const line = entry.lines[0]

  if (!entry.key || line == null) {
    return null
  }
  const colon = line.indexOf(':')
  return colon < 0 ? null : line.slice(colon + 1).trim()
}

const rawFlowItems = (inline: string): string[] | null => {
  if (!inline.startsWith('[') || !inline.endsWith(']')) {
    return null
  }
  const body = inline.slice(1, -1)

  if (!body.trim()) {
    return []
  }
  const out: string[] = []
  let start = 0
  let quote: '"' | "'" | null = null

  for (let i = 0; i < body.length; i++) {
    const char = body[i]

    if (quote === '"') {
      if (char === '\\') {
        i++
      } else if (char === '"') {
        quote = null
      }
      continue
    }
    if (quote === "'") {
      if (char === "'" && body[i + 1] === "'") {
        i++
      } else if (char === "'") {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
    } else if (char === ',') {
      const item = body.slice(start, i).trim()

      if (!item) {
        return null
      }
      out.push(item)
      start = i + 1
    }
  }
  if (quote) {
    return null
  }
  const tail = body.slice(start).trim()

  if (!tail) {
    return null
  }
  out.push(tail)
  return out
}

const rawListItems = (entry: FrontmatterEntry): string[] | null => {
  const inline = entryInline(entry)

  if (inline?.startsWith('[')) {
    return entry.lines.length === 1 ? rawFlowItems(inline) : null
  }
  if (inline !== '' || entry.lines.length < 2) {
    return null
  }
  const out: string[] = []

  for (const line of entry.lines.slice(1)) {
    const item = /^ *-[ \t]+(.*)$/.exec(line)

    if (!item) {
      return null
    }
    out.push(item[1].trim())
  }

  return out
}

const isQuoted = (raw: string | null | undefined): boolean => {
  const first = raw?.trim()[0]
  return first === '"' || first === "'"
}

const sameValues = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const LIST_CHANNELS: Readonly<Record<string, (value: unknown) => string[] | undefined>> = {
  aliases: normAliases,
  tags: normTags,
}

type AlignedChannelItem = { value: string; raw: string }

/** Keep each normalized channel item paired with the raw YAML item it came from.
 * A normalizer may trim or drop an item (aliases drops blanks), so indexing the
 * original raw list by a normalized index can validate the next item against the
 * wrong quoting. */
const alignedChannelItems = (
  projected: readonly string[],
  raw: readonly string[],
  normalise: (value: unknown) => string[] | undefined,
): AlignedChannelItem[] | null => {
  if (projected.length !== raw.length) {
    return null
  }
  const aligned: AlignedChannelItem[] = []

  for (let index = 0; index < projected.length; index++) {
    const value = normalise([projected[index]])

    if (!value || value.length > 1) {
      return null
    }
    if (value.length === 1) {
      aligned.push({ value: value[0], raw: raw[index] })
    }
  }

  return aligned
}

/** Preserve an authored typed entry only when both the line reader and a real
 * YAML reader keep seeing the same channel value. This is a data-integrity gate,
 * not a formatting optimisation: unreadable, lossy or under-quoted forms must be
 * canonicalised once so later readers do not disagree with the index. */
const sameChannelValue = (
  existing: FrontmatterEntry,
  incoming: FrontmatterEntry,
  key: string,
): boolean => {
  if (frontmatterEntryIsBlockScalar(existing) || frontmatterEntryIsBlockScalar(incoming)) {
    return false
  }
  const current = frontmatterEntryValue(existing)
  const next = frontmatterEntryValue(incoming)

  if (current === null || next === null) {
    return false
  }
  if (typeof current === 'string' || typeof next === 'string') {
    if (typeof current !== 'string' || typeof next !== 'string' || current !== next) {
      return false
    }

    return !frontmatterScalar(next).startsWith('"') || isQuoted(entryInline(existing))
  }
  const normalise = LIST_CHANNELS[key]

  if (!normalise) {
    return false
  }
  const currentValue = normalise(current)
  const nextValue = normalise(next)
  const currentRaw = rawListItems(existing)
  const nextRaw = rawListItems(incoming)
  const currentItems = currentRaw && alignedChannelItems(current, currentRaw, normalise)
  const nextItems = nextRaw && alignedChannelItems(next, nextRaw, normalise)

  if (
    !currentValue ||
    !nextValue ||
    !currentItems ||
    !nextItems ||
    !sameValues(
      currentValue,
      currentItems.map((item) => item.value),
    ) ||
    !sameValues(
      nextValue,
      nextItems.map((item) => item.value),
    ) ||
    !sameValues(currentValue, nextValue)
  ) {
    return false
  }

  return nextValue.every(
    (value, index) =>
      !frontmatterScalar(value).startsWith('"') || isQuoted(currentItems[index]?.raw),
  )
}

const emitEntries = (entries: readonly FrontmatterEntry[], eol: '\n' | '\r\n'): string =>
  entries
    .flatMap((entry) => entry.lines)
    .map((line) => `${line}${eol}`)
    .join('')

const assertFrontmatterPayload = (payload: string): void => {
  if (!isWithinFrontmatterByteCap(payload)) {
    throw new FrontmatterLimitError()
  }
}

const canonicalNoteFile = (
  assembly: NoteFileAssembly,
  eol: '\n' | '\r\n',
  preserveBom: boolean,
): string => {
  const { title, cleanBody, keyless, entries, live, source } = assembly
  const payload = emitEntries([...keyless, ...entries.filter((_, index) => live[index])], eol)

  assertFrontmatterPayload(payload)
  const bom = preserveBom && source?.raw.charCodeAt(0) === 0xfeff ? '\uFEFF' : ''
  const head = `${bom}---${eol}${payload}---${eol}${eol}# ${singleLine(title)}${eol}`
  return cleanBody ? `${head}${eol}${cleanBody}` : head
}

const splicedNoteFile = (assembly: NoteFileAssembly, source: NoteFileSource): string => {
  const { title, cleanBody, keyless, entries, live, touched } = assembly
  const { raw, block, bounds, spans } = source

  if (!block || !bounds || !spans || spans.length > entries.length) {
    throw new FrontmatterGeometryError('geometry')
  }
  const blockEol = frontmatterBlockEol(raw, bounds)
  let payload = emitEntries(keyless, blockEol)
  let cursor = bounds.payloadStart

  for (let index = 0; index < spans.length; index++) {
    const span = spans[index]

    if (span.start < cursor || span.end < span.start || span.end > bounds.payloadEnd) {
      throw new FrontmatterGeometryError('geometry')
    }
    payload += raw.slice(cursor, span.start)
    if (live[index]) {
      if (touched[index]) {
        const terminator = raw.slice(span.start, span.end).endsWith('\r\n') ? '\r\n' : '\n'
        payload += emitEntries([entries[index]], terminator)
      } else {
        payload += raw.slice(span.start, span.end)
      }
    }
    cursor = span.end
  }
  payload += raw.slice(cursor, bounds.payloadEnd)
  payload += emitEntries(
    entries.slice(spans.length).filter((_, offset) => live[spans.length + offset]),
    blockEol,
  )
  assertFrontmatterPayload(payload)

  let closingRaw = raw.slice(bounds.payloadEnd, block.bodyStart)
  const headEol = closingRaw.endsWith('\r\n') ? '\r\n' : closingRaw.endsWith('\n') ? '\n' : blockEol

  if (!closingRaw.endsWith('\n')) {
    closingRaw += blockEol
  }
  const head = `${raw.slice(0, bounds.payloadStart)}${payload}${closingRaw}${headEol}# ${singleLine(title)}${headEol}`
  return cleanBody ? `${head}${headEol}${cleanBody}` : head
}

/** Pure final assembler. Existing geometry enables a lossless splice; an
 * impossible parser/source mismatch falls back to the former canonical rebuild
 * instead of guessing a span or publishing partial bytes. */
export const assembleNoteFile = (assembly: NoteFileAssembly): string => {
  const { source, replacing } = assembly

  if (!source) {
    return canonicalNoteFile(assembly, '\n', false)
  }
  if (replacing) {
    return canonicalNoteFile(assembly, '\n', true)
  }
  if (!source.block) {
    return canonicalNoteFile(assembly, frontmatterBlockEol(source.raw), true)
  }
  try {
    return splicedNoteFile(assembly, source)
  } catch (error) {
    if (!(error instanceof FrontmatterGeometryError)) {
      throw error
    }
    const eol = source.bounds
      ? frontmatterBlockEol(source.raw, source.bounds)
      : frontmatterBlockEol(source.raw)
    return canonicalNoteFile(assembly, eol, true)
  }
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
  sourceLocator,
  createdAt,
  frontmatter,
  fields,
  fieldsUnquoted,
  frontmatterMode,
  body,
  existingRaw,
}: SerializeInput): string => {
  const replacing = frontmatterMode === 'replace'
  assertFieldPatchWritable(fields, undefined, { frontmatterMode })
  const existingBlock =
    !replacing && existingRaw != null ? parseFrontmatterBlock(existingRaw) : null
  const source: NoteFileSource | null =
    existingRaw == null
      ? null
      : { raw: existingRaw, block: existingBlock, bounds: null, spans: null }

  if (source?.block) {
    try {
      source.bounds = frontmatterPayloadBounds(source.raw, source.block.bodyStart)
      source.spans = frontmatterEntrySpans(source.raw, source.block)
    } catch (error) {
      if (!(error instanceof FrontmatterGeometryError)) {
        throw error
      }
    }
  }
  const existingEntries: FrontmatterEntry[] = replacing
    ? (frontmatter ?? []).map((entry) => ({ key: entry.key, lines: [...entry.lines] }))
    : (existingBlock?.entries ?? [])
  // Inline frontmatter riding the body is another incoming metadata channel. Parse
  // it before the safety gate so a caller cannot bypass the raw-entry check by
  // placing `&anchor` / `*alias` in `body` instead of WriteInput.frontmatter.
  let cleanBody = body
  // A full-state restore already split its canonical snapshot into authored
  // frontmatter and body. Reinterpreting a leading fenced block in that body
  // would hoist user prose into metadata and make restore destructive.
  const inline = replacing ? null : parseBodyFrontmatterBlock(body)

  // Anchors and aliases are order-dependent, while this serializer merges by key
  // and always replaces at least `title`. Refuse them on every incoming channel,
  // fresh write included. An existing file may predate this restriction; any
  // mutation of such a file is refused too so its dependency order cannot change.
  // This happens before candidate bytes are built, therefore the caller publishes
  // nothing.
  if (
    (!replacing && frontmatterHasYamlNodeReferences(frontmatter)) ||
    frontmatterHasYamlNodeReferences(inline?.entries) ||
    (!replacing && existingRaw != null && frontmatterHasYamlNodeReferences(existingEntries))
  ) {
    throw yamlNodeReferenceWriteError()
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
  const touched = entries.map(() => false)
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

    if (
      occupied?.length === 1 &&
      live[occupied[0]] &&
      sameChannelValue(entries[occupied[0]], entry, key)
    ) {
      return
    }
    if (occupied?.length) {
      // Replace at the first live occurrence: this preserves the key's anchor
      // among surrounding authored fields/comments while collapsing every later
      // duplicate. Repeated puts keep using that same slot; only a genuinely new
      // key appends.
      const [anchor, ...duplicates] = occupied
      entries[anchor] = entry
      live[anchor] = true
      touched[anchor] = true
      for (const i of duplicates) {
        live[i] = false
      }
      positions.set(key, [anchor])
      return
    }
    const appended = entries.push(entry) - 1
    live.push(true)
    touched.push(true)
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

  if (!replacing) {
    for (const e of frontmatter ?? []) {
      if (e.key === IMPORT_SOURCE_FRONTMATTER_KEY) {
        continue
      }
      if (e.key) {
        put(e)
      } else if (!existingKeyless.has(e.lines[0])) {
        // Do not add this line to `existingKeyless`: two identical comments in the
        // SAME source are two authored lines and both survive. Only an already
        // occupied file suppresses a repeated line on a later re-import.
        keyless.push(e)
      }
    }
  }

  // Inline frontmatter riding the body merges in next (ours below override).
  if (inline) {
    for (const e of inline.entries) {
      if (e.key === IMPORT_SOURCE_FRONTMATTER_KEY) {
        continue
      }
      if (e.key) {
        put(e)
      } else {
        keyless.push(e)
      }
    }
    cleanBody = body.slice(inline.bodyStart).replace(/^\r?\n/, '')
  }

  for (const emission of fieldPatchEmissions(fields ?? {}, fieldsUnquoted)) {
    if (emission.entry) {
      put(emission.entry)
    } else {
      drop(emission.key)
    }
  }

  // Three of the typed channels below have no metadata field of their own and reach
  // the index only through the key they write here, so what they write is decided
  // once, in core, and the write path's optimistic mirror asks the same function.
  const emit = (emission: TypedFrontmatterEmission | undefined): void => {
    if (!emission) {
      return
    }
    if (emission.entry) {
      put(emission.entry)
    } else {
      drop(emission.key)
    }
  }

  put(frontmatterScalarEntry('title', title))
  emit(noteTypeFrontmatter(noteType))
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
  emit(summaryFrontmatter(summary))
  emit(mutedFrontmatter(muted))
  if (id) {
    put(frontmatterScalarEntry(NOTE_ID_FRONTMATTER_KEY, id))
  }
  if (sourceLocator) {
    put(frontmatterScalarEntry(IMPORT_SOURCE_FRONTMATTER_KEY, sourceLocator))
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

  return assembleNoteFile({
    title,
    cleanBody,
    keyless,
    entries,
    live,
    touched,
    replacing,
    source,
  })
}
