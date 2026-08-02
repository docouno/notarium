/**
 * Cut a leading YAML frontmatter block off a markdown document.
 * Tolerates a BOM and CRLF line endings; returns the body unchanged when no
 * frontmatter is present.
 */
export const stripFrontmatter = (content: string): string =>
  (content || '').replace(/^\uFEFF?\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')

/** The scalar value of one frontmatter key (`key: value`), or null. Same
 *  non-parser honesty as frontmatterTags: a top-level `key:` line inside the
 *  leading YAML block, quotes trimmed — anything fancier yields null. */
export const frontmatterValue = (content: string, key: string): string | null => {
  const fm = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content || '')

  if (!fm) {
    return null
  }
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\s*:\\s*(.*)$`, 'm')
  const m = re.exec(fm[1])

  if (!m) {
    return null
  }
  const v = unquoteScalar(m[1])
  return v || null
}

/** Unwrap a YAML scalar SYMMETRICALLY with the engine's serializer: strip
 *  the wrapping quotes AND reverse the escaping. A double-quoted scalar un-escapes
 *  `\\`→`\` and `\"`→`"`; a single-quoted one un-escapes `''`→`'`; a plain scalar
 *  carries no escapes. The read-model snippet path and the engine must read the
 *  same bytes identically — the old asymmetric `replace(outer).trim()` left a
 *  serialized `"\"Gameverse\""` as `\"Gameverse\"` here. */
export const unquoteScalar = (s: string): string => {
  const t = s.trim()
  const dq = /^"([\s\S]*)"$/.exec(t)

  if (dq) {
    return dq[1].replace(/\\(["\\])/g, '$1')
  }
  const sq = /^'([\s\S]*)'$/.exec(t)

  if (sq) {
    return sq[1].replace(/''/g, "'")
  }

  return t
}

/** Set (or replace) one scalar key in a document's leading frontmatter block,
 *  creating the block when the document has none. Used to materialize the
 *  internal note-id on write: the engine merges content-frontmatter into the
 *  file's, so injecting here is the whole write channel. */
export const upsertFrontmatterKey = (content: string, key: string, value: string): string => {
  const body = content || ''
  const fm = /^(\uFEFF?\s*---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(body)

  if (!fm) {
    return `---\n${key}: ${value}\n---\n${body}`
  }
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\s*:.*$`, 'm')
  const block = re.test(fm[2])
    ? fm[2].replace(re, `${key}: ${value}`)
    : `${fm[2]}\n${key}: ${value}`
  return fm[1] + block + fm[3] + body.slice(fm[0].length)
}

/**
 * The `tags:` entry of a raw document's YAML frontmatter, in the three shapes
 * notes actually carry: a block list (`- a`), a flow list (`[a, b]`) or a
 * scalar (`a, b`). NOT a YAML parser — anything fancier (anchors, nested maps)
 * honestly yields no tags, the same degradation an engine-less host accepts
 * everywhere else. Quotes around individual values are trimmed.
 */
export const frontmatterTags = (content: string): string[] => {
  const fm = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content || '')

  if (!fm) {
    return []
  }
  const lines = fm[1].split(/\r?\n/)
  const unquote = unquoteScalar
  const i = lines.findIndex((l) => /^tags\s*:/.test(l))

  if (i === -1) {
    return []
  }
  const inline = lines[i].replace(/^tags\s*:/, '').trim()

  if (inline) {
    const flow = /^\[(.*)\]$/.exec(inline)

    if (flow) {
      return flow[1].split(',').map(unquote).filter(Boolean)
    }

    // A scalar splits on commas AFTER unquoting — the same reading the
    // engine path gets from normTags over a frontmatter string.
    return unquote(inline)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  const out: string[] = []

  for (let j = i + 1; j < lines.length; j++) {
    // Indentation optional: the engine writes its block lists flush-left
    // (`- tag`), and that form is what the whole dogfooding corpus carries.
    const item = /^\s*-\s+(.*)$/.exec(lines[j])

    if (!item) {
      break
    }
    const v = unquote(item[1])

    if (v) {
      out.push(v)
    }
  }

  return out
}
