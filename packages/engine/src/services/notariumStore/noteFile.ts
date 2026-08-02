// One note file, both directions: parse (file → index row / read() view) and
// serialize (write() input → file bytes). The line-based frontmatter handling
// mirrors core/libs/markdown's honesty contract — top-level scalars and block
// lists are understood, anything fancier passes through VERBATIM (preserved on
// rewrite, absent from the parsed object). Preservation is the point: a write
// merges into the existing block instead of regenerating it, so keys we don't
// know (a user's own fields) survive our edits — a last-write-wins merge
// semantic, which is what lets two writers share one base (#69).

import {
  DEFAULT_NOTE_TYPE,
  normAliases,
  normTags,
  NOTE_ID_FRONTMATTER_KEY,
  slugify,
  stripTitleHeading,
  unquoteScalar,
} from '@notarium/core'

/** One frontmatter entry as raw lines. `key` is null for passthrough lines the
 *  parser doesn't model (nested maps, comments) — they re-emit verbatim. */
type FmEntry = { key: string | null; lines: string[] }

const FM_OPEN = /^\uFEFF?---\r?\n/
const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/
// Indentation is optional: flush-left `- item` is exactly the YAML our own
// serializer writes \u2014 requiring leading whitespace silently dropped every
// real tag list (caught live on the stand).
const LIST_ITEM = /^\s*-\s+(.*)$/

// Symmetric with fmScalar (#113): stripping the wrapping quotes must also REVERSE
// the escaping the serializer applied, or the round-trip mangles the value (a title
// like `"Gameverse"` came back as `\"Gameverse\"`). The canonical inverse lives in
// core/libs/markdown as unquoteScalar — shared so the engine and the read-model
// snippet path read identical bytes identically (the bug was two divergent copies).
const unquote = unquoteScalar

type FmBlock = { entries: FmEntry[]; bodyStart: number }

/** Split a document's leading frontmatter into entries; null when there is
 *  none. bodyStart points right after the closing delimiter line. */
export const parseFmBlock = (raw: string): FmBlock | null => {
  const open = FM_OPEN.exec(raw)

  if (!open) {
    return null
  }
  const rest = raw.slice(open[0].length)
  const close = /^---(?:\r?\n|$)/m.exec(rest)

  if (!close) {
    return null
  }
  const block = rest.slice(0, close.index)
  const bodyStart = open[0].length + close.index + close[0].length
  const entries: FmEntry[] = []

  for (const line of block.split(/\r?\n/)) {
    if (line === '' && entries.length === 0) {
      continue
    }
    const kv = KEY_LINE.exec(line)

    if (kv) {
      entries.push({ key: kv[1], lines: [line] })
    } else if (entries.length && (LIST_ITEM.test(line) || /^\s/.test(line))) {
      entries[entries.length - 1].lines.push(line) // continuation of the entry
    } else if (line !== '') {
      entries.push({ key: null, lines: [line] }) // passthrough
    }
  }

  // A trailing empty line inside the block belongs to nobody — drop it.
  return { entries, bodyStart }
}

/** An entry's value: scalar string, block list, or null (passthrough/empty). */
const valueOf = (e: FmEntry): string | string[] | null => {
  if (!e.key) {
    return null
  }
  const inline = e.lines[0].slice(e.lines[0].indexOf(':') + 1).trim()

  if (inline) {
    const flow = /^\[(.*)\]$/.exec(inline)

    if (flow) {
      return flow[1].split(',').map(unquote).filter(Boolean)
    }

    return unquote(inline)
  }
  const items = e.lines
    .slice(1)
    .map((l) => LIST_ITEM.exec(l)?.[1])
    .filter((v): v is string => v != null)

  if (items.length) {
    return items.map(unquote).filter(Boolean)
  }

  return null
}

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

export const parseNoteFile = (raw: string, path: string): ParsedNote => {
  const fm = parseFmBlock(raw)
  const afterFm = fm ? raw.slice(fm.bodyStart) : raw
  const frontmatter: Record<string, unknown> = {}

  for (const e of fm?.entries ?? []) {
    if (!e.key) {
      continue
    }
    const v = valueOf(e)

    if (v != null) {
      frontmatter[e.key] = v
    }
  }
  const fmTitle = typeof frontmatter.title === 'string' ? frontmatter.title : ''
  const h1 = /^#\s+(.+?)\s*$/m.exec(afterFm)
  const fileName = path.split('/').pop()?.replace(/\.md$/, '') || path
  const title = fmTitle || h1?.[1] || fileName
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
    idClaim: typeof claim === 'string' && claim ? claim : null,
    createdAt: fmDate(frontmatter.created),
    frontmatter,
    body: stripTitleHeading(afterFm.replace(/^\r?\n/, ''), title),
  }
}

/** YAML-safe scalar for the values we emit: quote when the raw form would
 *  parse as something else (leading/trailing space, a colon-space, #, quotes, or a
 *  leading YAML indicator). A real YAML parser must read back what we wrote — this is
 *  load-bearing for interop now that #156 lets ARBITRARY first-line prose become a
 *  `title`: a title opening with a flow indicator (`[[wiki]]` → `[`, `{a}` → `{`,
 *  `, leading` → `,`) would otherwise emit `title: [[wiki]]`, which a strict YAML
 *  reader (Obsidian, exporters) parses as a nested flow collection, not a string. */
const fmScalar = (v: string): string =>
  /(^\s|\s$|: |#|^["'&*?|>%@`![\]{},-]|: *$)/.test(v) || v === ''
    ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : v

const scalarEntry = (key: string, v: string): FmEntry => ({
  key,
  lines: [`${key}: ${fmScalar(v)}`],
})

const listEntry = (key: string, items: string[]): FmEntry => ({
  key,
  lines: [`${key}:`, ...items.map((t) => `- ${fmScalar(t)}`)],
})

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
  /** The body the editor saved (may itself open with a frontmatter block —
   *  merged into the file's). */
  body: string
  /** The current file bytes when overwriting; null/undefined = fresh file. */
  existingRaw?: string | null
}

/** Build the file: existing frontmatter ∪ body's inline frontmatter ∪ our
 *  fields (ours win), then the storage-format `# title` heading and the body. */
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
  body,
  existingRaw,
}: SerializeInput): string => {
  const entries: FmEntry[] = existingRaw ? (parseFmBlock(existingRaw)?.entries ?? []) : []

  const put = (entry: FmEntry): void => {
    const i = entries.findIndex((e) => e.key === entry.key)

    if (i === -1) {
      entries.push(entry)
    } else {
      entries[i] = entry
    }
  }

  const drop = (key: string): void => {
    const i = entries.findIndex((e) => e.key === key)

    if (i !== -1) {
      entries.splice(i, 1)
    }
  }

  // Inline frontmatter riding the body merges in first (ours below override).
  let cleanBody = body
  const inline = parseFmBlock(body)

  if (inline) {
    for (const e of inline.entries) {
      if (e.key) {
        put(e)
      }
    }
    cleanBody = body.slice(inline.bodyStart).replace(/^\r?\n/, '')
  }

  put(scalarEntry('title', title))
  if (noteType !== undefined) {
    if (noteType && noteType !== DEFAULT_NOTE_TYPE) {
      put(scalarEntry('type', noteType))
    } else {
      drop('type')
    }
  }
  if (tags !== undefined) {
    if (tags.length) {
      put(listEntry('tags', tags))
    } else {
      drop('tags')
    }
  }
  // Alias-history (#100), tags-parity: undefined leaves the file's `aliases:`
  // block as a passthrough entry; a set replaces it; [] drops it.
  if (aliases !== undefined) {
    if (aliases.length) {
      put(listEntry('aliases', aliases))
    } else {
      drop('aliases')
    }
  }
  // The editable slug (#100 phase 1), tags-parity: undefined leaves the file's `slug:`
  // as a passthrough; a value sets it; '' drops it (a slug that collapsed onto the
  // implicit slug(title) default stays out of the file).
  if (slug !== undefined) {
    if (slug) {
      put(scalarEntry('slug', slug))
    } else {
      drop('slug')
    }
  }
  // undefined = leave any existing summary as a passthrough entry; a string
  // sets/overwrites it (an empty string drops it — an explicit clear).
  if (summary !== undefined) {
    if (summary) {
      put(scalarEntry('summary', summary))
    } else {
      drop('summary')
    }
  }
  // The human-set memory opt-out (#165): undefined leaves it as a passthrough,
  // true writes `muted: true`, false clears it (an explicit un-mute).
  if (muted !== undefined) {
    if (muted) {
      put(scalarEntry('muted', 'true'))
    } else {
      drop('muted')
    }
  }
  if (id) {
    put(scalarEntry(NOTE_ID_FRONTMATTER_KEY, id))
  }
  // Dates-as-data (#11/#186): write `created:` whenever a value is provided —
  // SET/overwrite, so an authored date edit (the metadata aside) lands and a
  // re-import re-stamps the same value harmlessly. Absent leaves the file's date
  // alone (a normal body save never restamps it; the index then keeps using the
  // existing `created:` or the file birthtime). `modified` is never written: it
  // tracks the file's real mtime (no staleness, no journal fight).
  if (createdAt) {
    put(scalarEntry('created', createdAt))
  }

  const fmLines = entries.flatMap((e) => e.lines)
  const head = `---\n${fmLines.join('\n')}\n---\n\n# ${title}\n`
  return cleanBody ? `${head}\n${cleanBody}` : head
}
