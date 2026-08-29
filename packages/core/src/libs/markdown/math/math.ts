export type MathSyntaxMatch = {
  raw: string
  tex: string
  display: boolean
}

const BLOCK_DOLLAR = /^ {0,3}\$\$((?:(?!\n[ \t]*\n)(?!\$\$)[\s\S])+?)\$\$(?=[ \t]*(?:\n|$))/
const BLOCK_BRACKET = /^ {0,3}\\\[((?:(?!\n[ \t]*\n)(?!\\\])[\s\S])+?)\\\](?=[ \t]*(?:\n|$))/

/** Match a display-math block at the beginning of Markdown block source. */
export const matchMathBlock = (source: string): MathSyntaxMatch | undefined => {
  const match = BLOCK_DOLLAR.exec(source) ?? BLOCK_BRACKET.exec(source)
  const tex = match?.[1].trim()

  return match && tex ? { raw: match[0], tex, display: true } : undefined
}

/** Locate a later display-math opener which may interrupt a paragraph. */
export const mathBlockStart = (source: string): number | undefined => {
  const afterLineBreak = (marker: string): number | undefined => {
    let markerAt = source.indexOf(marker)

    while (markerAt !== -1) {
      let lineBreakAt = markerAt - 1
      let spaces = 0

      while (spaces < 3 && source[lineBreakAt] === ' ') {
        lineBreakAt--
        spaces++
      }
      if (source[lineBreakAt] === '\n') {
        return lineBreakAt + 1
      }
      markerAt = source.indexOf(marker, markerAt + 1)
    }

    return undefined
  }
  const dollar = afterLineBreak('$$')
  const bracket = afterLineBreak('\\[')

  if (dollar === undefined) {
    return bracket
  }
  if (bracket === undefined) {
    return dollar
  }

  return Math.min(dollar, bracket)
}

const INLINE_PAREN = /^\\\(([\s\S]+?)\\\)/
const INLINE_BRACKET = /^\\\[([\s\S]+?)\\\]/
const INLINE_DDOLLAR = /^\$\$(?!\$)([\s\S]+?)\$\$/
const INLINE_DOLLAR =
  /^\$(?![\s$])((?:\\.|[^\\\n$])*?(?:\\.|[^\\\n$]))\$(?=[\s?!.,:;)"'》」』？！。，：]|$)/

/** Match one inline/display math span at the beginning of inline source. */
export const matchMathInline = (source: string): MathSyntaxMatch | undefined => {
  let match = INLINE_PAREN.exec(source)

  if (match) {
    const tex = match[1].trim()
    return tex ? { raw: match[0], tex, display: false } : undefined
  }
  match = INLINE_BRACKET.exec(source)
  if (match) {
    const tex = match[1].trim()
    return tex ? { raw: match[0], tex, display: true } : undefined
  }
  match = INLINE_DDOLLAR.exec(source)
  if (match) {
    const tex = match[1].trim()
    return tex ? { raw: match[0], tex, display: true } : undefined
  }
  match = INLINE_DOLLAR.exec(source)
  if (match) {
    const tex = match[1].trim()
    return tex ? { raw: match[0], tex, display: false } : undefined
  }

  return undefined
}

/** Locate the next possible inline math opener. */
export const mathInlineStart = (source: string): number | undefined => {
  const index = source.indexOf('$')
  return index === -1 ? undefined : index
}
