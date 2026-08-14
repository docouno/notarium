/**
 * Where the lexer's wikilink tokens sit in the document the author wrote.
 *
 * The lexer decides what a link IS, so it also has to say WHERE the link is:
 * a second grammar asked for positions can disagree with the first, and two
 * disagreeing readings of one document cannot be reconciled — "one extra
 * construct" and "one missed link" look identical from the outside.
 *
 * Marked hands out `raw` for every token, and at each level those raws follow one
 * another through the string that level was lexed from, which carries an offset
 * down the tree. Two things break the run and each is handled where it happens:
 * the lexer keeps some of what it read to itself, or hands back a raw that is not
 * a slice of this string — assembled, or one `\n` longer than what it read
 * (`beginsAt`, `visitChildren`); and it TRANSFORMS a string before lexing it
 * deeper — a blockquote loses its `>`, a list item its marker and indent, either
 * one gets its leading tabs expanded, a table cell loses its surrounding spaces
 * and the backslash of an escaped separator (`reindentedLocate`,
 * `expandLeadingTabs`, `visitRow`).
 *
 * Where none of that holds, the position is `null`. Guessing is the one thing
 * this module never does: a guessed offset rewrites bytes the author wrote, and
 * no later check can tell it apart from a correct one.
 */

/** The token our wikilink extension emits. */
export const WIKILINK_TOKEN = 'notariumWikilink'

/** One wikilink the lexer found. `start` is the offset in the LEXED source where
 *  its `[[` begins, or `null` when the offset could not be reconstructed. */
export type LocatedWikilink = {
  target: string
  start: number | null
}

type Node = Record<string, unknown>

/** Maps an index of the string a token list was lexed from onto the lexed
 *  source; `null` where that string is a transformed copy of it. */
type Locate = (index: number) => number | null

const NOWHERE: Locate = () => null
const ITSELF: Locate = (index) => index

/** Build the mapping only if a wikilink inside actually asks for a position: a
 *  container holding no link must cost nothing to walk, and the graph walks
 *  every note this way. */
const lazily = (build: () => Locate): Locate => {
  let locate: Locate | null = null

  return (index) => (locate ??= build())(index)
}

const shifted =
  (locate: Locate, offset: number): Locate =>
  (index) =>
    locate(offset + index)

const stringOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const nodesOf = (value: unknown): readonly Node[] => (Array.isArray(value) ? (value as Node[]) : [])

type Line = { start: number; text: string }

const linesOf = (source: string): Line[] => {
  const lines: Line[] = []

  for (let start = 0; ;) {
    const newline = source.indexOf('\n', start)

    if (newline === -1) {
      lines.push({ start, text: source.slice(start) })

      return lines
    }
    lines.push({ start, text: source.slice(start, newline) })
    start = newline + 1
  }
}

/** Index of the last line starting at or before `index`. */
const lineOf = (starts: readonly number[], index: number): number => {
  let low = 0
  let high = starts.length - 1

  while (low < high) {
    const middle = (low + high + 1) >> 1

    if (starts[middle] <= index) {
      low = middle
    } else {
      high = middle - 1
    }
  }

  return low
}

/** Re-indented, line for line: a blockquote and a list item are lexed from their
 *  own content with the marker stripped off the front of every line, so what the
 *  marker left is a SUFFIX of the line it came from, and the suffix gives the
 *  offset. Only the indent may differ, which is what makes a re-indented line (a
 *  tab the list tokenizer expands, a setext underline it pads) locatable anyway;
 *  an offset INSIDE that indent has no answer, and a `[[` never stands there. A
 *  line whose content is not a suffix at all stays unlocatable. */
const reindentedLocate = (raw: string, text: string, locate: Locate, at: number): Locate =>
  lazily(() => {
    const rawLines = linesOf(raw)
    const lines = linesOf(text)
    const indents = lines.map((line) => line.text.length - line.text.trimStart().length)
    const offsets = lines.map((line) => line.start)
    const starts = lines.map(({ text: line }, index) => {
      const content = line.trimStart()
      const from = rawLines[index]

      return from && from.text.endsWith(content)
        ? locate(at + from.start + from.text.length - content.length)
        : null
    })

    return (index) => {
      const line = lineOf(offsets, index)
      const start = starts[line]
      const inset = index - offsets[line] - indents[line]

      return start === null || inset < 0 ? null : start + inset
    }
  })

const LEADING_TABS = /^( *)(\t+)/
const LEADING_TABS_PER_LINE = new RegExp(LEADING_TABS.source, 'gm')

/** Four columns per tab, the way marked pads a leading tab run. */
const expandedIndent = (spaces: string, tabs: string): string =>
  spaces + ' '.repeat(4 * tabs.length)

/** Marked expands leading tabs at the top of `blockTokens` — and `blockTokens`
 *  runs AGAIN on the content of every container, so it expands at every level of
 *  nesting, not once over the document. A tab that only becomes leading after the
 *  `> ` or the list marker comes off is expanded there and nowhere else, which is
 *  exactly the shape Obsidian writes by default (`> - a` / `> \t- b`, a callout
 *  with a nested list). Normalization has to follow the recursion, or the child
 *  raws stop being verbatim and the whole note is refused. */
const expandLeadingTabs = (text: string): string =>
  text.includes('\t')
    ? text.replace(LEADING_TABS_PER_LINE, (_, spaces: string, tabs: string) =>
        expandedIndent(spaces, tabs),
      )
    : text

const pipesBefore = (text: string, index: number): number => {
  let count = 0

  for (let at = text.indexOf('|'); at !== -1 && at < index; at = text.indexOf('|', at + 1)) {
    count++
  }

  return count
}

/** A table cell is lexed from text the row tokenizer trimmed and unescaped, so
 *  it is not a slice of the row. Its source form is the same text with the
 *  backslash back in front of every separator — an unescaped `|` would have
 *  ended the cell, so every `|` left in the text is one. Searching forward per
 *  row keeps the cells in order, and counting those backslashes back in maps an
 *  offset inside the cell. */
const visitRow = (
  cells: readonly Node[],
  line: Line | undefined,
  locate: Locate,
  at: number,
  out: LocatedWikilink[],
): void => {
  let cursor = 0

  for (const cell of cells) {
    const children = nodesOf(cell.tokens)
    const text = stringOf(cell.text)
    const escaped = text === null ? null : text.replace(/\|/g, '\\|')
    const found = line && escaped !== null ? line.text.indexOf(escaped, cursor) : -1

    if (found === -1 || line === undefined || text === null || escaped === null) {
      visitInline(children, text ?? '', 0, NOWHERE, out)
      continue
    }
    const base = at + line.start + found

    visitInline(children, text, 0, (index) => locate(base + index + pipesBefore(text, index)), out)
    cursor = found + escaped.length
  }
}

const visitTable = (token: Node, locate: Locate, at: number, out: LocatedWikilink[]): void => {
  const raw = stringOf(token.raw)
  // A GFM row is exactly one line, and the two lines before the first one are the
  // header and the alignment row — that is the whole mapping from a row to a line.
  const lines = raw === null ? null : linesOf(raw)

  visitRow(nodesOf(token.header), lines?.[0], locate, at, out)
  nodesOf(token.rows).forEach((row, index) => {
    visitRow(nodesOf(row), lines?.[index + 2], locate, at, out)
  })
}

/** Anything this walker does not model is still REPORTED — a link dropped by the
 *  extractor is a lost graph edge — but reported without a position, so an
 *  unmodelled shape refuses a rewrite instead of guessing one. */
const sweep = (value: unknown, out: LocatedWikilink[], seen = new Set<object>()): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      sweep(item, out, seen)
    }

    return
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return
  }
  seen.add(value)
  const node = value as Node

  if (node.type === WIKILINK_TOKEN) {
    const target = stringOf(node.target)

    if (target !== null) {
      out.push({ target, start: null })
    }

    return
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== 'raw' && key !== 'text') {
      sweep(child, out, seen)
    }
  }
}

/** Where a token begins in the string this level was lexed from. Normally the
 *  cursor, since a level's raws follow one another — except that marked keeps a
 *  link definition for its own reference table and puts no token in the tree, so
 *  the gap it leaves has to be stepped over rather than shift every offset after
 *  it. `-1` means the token is not in this string at all, which happens when the
 *  lexer ASSEMBLED the raw instead of reading it: a paragraph an extension clipped
 *  is re-joined with a newline the author never wrote.
 *
 *  One assembly is small enough to undo rather than give up on: a blockquote that
 *  swallowed a lazy continuation closes with a `\n` the string may not have — the
 *  document ended without one, or the list tokenizer trimmed the last item's text
 *  after the blockquote inside it was built. Dropping that one newline is not a
 *  guess and not a search: the shortened raw has to be exactly the rest of the
 *  string from the cursor on, byte for byte, which is the only shape the phantom
 *  newline can take and leaves no second candidate to pick between. */
const beginsAt = (source: string, raw: string, cursor: number): number => {
  if (source.startsWith(raw, cursor)) {
    return cursor
  }
  const at = source.indexOf(raw, cursor)

  if (at !== -1) {
    return at
  }

  return raw.endsWith('\n') &&
    cursor + raw.length - 1 === source.length &&
    source.startsWith(raw.slice(0, -1), cursor)
    ? cursor
    : -1
}

/** Walk what a token was lexed from. Normally that is its own `text`, a slice of
 *  its `raw` at a known inset. When the raw is not in this string — assembled,
 *  see `beginsAt` — the children are walked against THIS string instead: the
 *  assembling only ever inserted newlines, and every child raw is still verbatim
 *  here, so the search re-syncs on the next one it does find. */
const visitChildren = (
  token: Node,
  children: readonly Node[],
  source: string,
  cursor: number,
  at: number,
  locate: Locate,
  out: LocatedWikilink[],
): number => {
  const raw = stringOf(token.raw)
  const text = stringOf(token.text)
  const inset = raw !== null && text !== null ? raw.indexOf(text) : -1

  if (at !== -1 && inset !== -1 && text !== null) {
    visitInline(children, text, 0, shifted(locate, at + inset), out)

    return at + (raw?.length ?? 0)
  }

  return visitInline(children, source, at === -1 ? cursor : at, locate, out)
}

/** Returns where the walk ended, so a caller that could not place the token by
 *  its own raw still knows where its children left off. */
const visitInline = (
  tokens: readonly Node[],
  source: string,
  from: number,
  locate: Locate,
  out: LocatedWikilink[],
): number => {
  let cursor = from

  for (const token of tokens) {
    const raw = stringOf(token.raw)
    const at = raw === null ? -1 : beginsAt(source, raw, cursor)

    if (token.type === WIKILINK_TOKEN) {
      const target = stringOf(token.target)

      if (target !== null) {
        out.push({ target, start: at === -1 ? null : locate(at) })
      }
    } else {
      const children = nodesOf(token.tokens)

      if (children.length) {
        cursor = visitChildren(token, children, source, cursor, at, locate, out)
        continue
      }
    }
    cursor = at === -1 || raw === null ? cursor : at + raw.length
  }

  return cursor
}

const visitBlock = (
  token: Node,
  source: string,
  cursor: number,
  at: number,
  locate: Locate,
  out: LocatedWikilink[],
): number => {
  const raw = stringOf(token.raw)
  const text = stringOf(token.text)
  const done = at === -1 ? cursor : at + (raw?.length ?? 0)

  switch (token.type) {
    case 'list':
      // A list is its items' raws, one after the other, in this same string.
      if (at === -1) {
        break
      }

      return visitBlocks(nodesOf(token.items), source, at, locate, out)
    case 'blockquote':
    case 'list_item': {
      if (at === -1 || raw === null || text === null) {
        break
      }
      // Not `text` but what `blockTokens` made of it: the children were lexed
      // from this string AFTER their own round of tab expansion, so their raws
      // and offsets are into the expanded copy. Expansion only ever rewrites the
      // whitespace at the head of a line, which `reindentedLocate` already treats
      // as re-indentation, so both sides stay line-for-line aligned.
      const inner = expandLeadingTabs(text)

      visitBlocks(nodesOf(token.tokens), inner, 0, reindentedLocate(raw, inner, locate, at), out)

      return done
    }
    case 'table':
      if (at === -1) {
        break
      }
      visitTable(token, locate, at, out)

      return done
    case 'paragraph':
    case 'heading':
    case 'text': {
      const children = nodesOf(token.tokens)

      if (!children.length) {
        return done
      }

      return visitChildren(token, children, source, cursor, at, locate, out)
    }
    default:
      break
  }
  sweep(token, out)

  return done
}

const visitBlocks = (
  tokens: readonly Node[],
  source: string,
  from: number,
  locate: Locate,
  out: LocatedWikilink[],
): number => {
  let cursor = from

  for (const token of tokens) {
    const raw = stringOf(token.raw)

    cursor = visitBlock(
      token,
      source,
      cursor,
      raw === null ? -1 : beginsAt(source, raw, cursor),
      locate,
      out,
    )
  }

  return cursor
}

/** Every wikilink the lexer produced, in document order, each with the offset in
 *  `lexed` — the very string the lexer was handed — where its construct begins. */
export const locateWikilinks = (tokens: readonly unknown[], lexed: string): LocatedWikilink[] => {
  const out: LocatedWikilink[] = []

  visitBlocks(tokens as readonly Node[], lexed, 0, ITSELF, out)

  return out
}

/** The exact string the lexer tokenizes at the TOP level, and the way back to the
 *  author's bytes. Marked collapses line endings to `\n` once, over the whole
 *  document, and expands a leading tab run to four columns per tab — the latter
 *  again inside every container, which is `expandLeadingTabs`' business, not this
 *  one's. A top-level offset is therefore an offset into THIS string, while the
 *  only string a rewrite may edit is the original. */
export type LexerSource = {
  text: string
  toSource: (index: number) => number
}

export const lexerSource = (source: string): LexerSource => {
  if (!source.includes('\r') && !source.includes('\t')) {
    return { text: source, toSource: (index) => index }
  }
  const starts: number[] = []
  const deltas: number[] = []
  let text = ''

  for (let at = 0; ;) {
    const carriage = source.indexOf('\r', at)
    const newline = source.indexOf('\n', at)
    const end = Math.min(
      carriage === -1 ? source.length : carriage,
      newline === -1 ? source.length : newline,
    )
    const line = source.slice(at, end)
    const tabs = LEADING_TABS.exec(line)
    const indent = tabs ? expandedIndent(tabs[1], tabs[2]) : ''

    // Both transformations rewrite the head of a line, so past that head the rest
    // of the line is a plain shift. Nothing located here ever falls inside the
    // head: a `[[` cannot stand in leading whitespace.
    starts.push(text.length)
    deltas.push(at + (tabs?.[0].length ?? 0) - text.length - indent.length)
    text += tabs ? indent + line.slice(tabs[0].length) : line
    if (end === source.length) {
      break
    }
    text += '\n'
    at = end + (source.startsWith('\r\n', end) ? 2 : 1)
  }

  return { text, toSource: (index) => index + deltas[lineOf(starts, index)] }
}
