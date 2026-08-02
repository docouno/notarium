// Feed-card / graph enrichment derived from a note body: the shared
// derivation behind every store's `preview`. The body a store hands
// out is already engine-normalised (frontmatter object split off,
// storage-format title heading stripped) — these stay defensive about a stray
// frontmatter block but know nothing engine-specific. `derivePreviewFromFile`
// is the one entry point that accepts a RAW markdown file instead (the
// read-from-disk fast path): it does the normalising itself.

import type { Preview } from '../knowledgeStore'
import {
  countWords,
  estimateTokens,
  frontmatterTags,
  stripFrontmatter,
  stripTitleHeading,
} from '../libs/markdown'
import { normTags } from '../libs/tags'

/**
 * First image in a note body, for the Feed card preview. Markdown image first,
 * then a bare `<img src>`. Only absolute http(s) URLs are returned — local
 * attachment paths can't be resolved through the current proxy, so we skip them
 * rather than render a broken thumbnail (our own API will serve these later).
 */
export const firstImage = (content: string): string | null => {
  const body = stripFrontmatter(content)
  const md = body.match(/!\[[^\]]*\]\(\s*(\S+?)(?:\s+["'][^)]*)?\s*\)/)
  const html = body.match(/<img[^>]*\bsrc=["']([^"']+)["']/i)
  const url = md ? md[1] : html ? html[1] : null
  return url && /^https?:\/\//i.test(url) ? url : null
}

/**
 * Reduce a note body to a short plain-text preview for Feed cards: drop fenced
 * code, tables, images and the noisier inline markdown, flatten lists to prose,
 * then collapse whitespace and clamp at a word boundary. Plain text only — the
 * card never renders raw markdown syntax.
 */
export const makeSnippet = (content: string, max = 1600): string => {
  const text = stripFrontmatter(content)
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/<!--[\s\S]*?-->/g, ' ') // html comments
    .replace(/^\s*\|.*$/gm, ' ') // markdown table rows (header/separator/body)
    .replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, ' ') // horizontal rules --- *** ___
    .replace(/^#{1,6}\s+/gm, '') // heading markers
    .replace(/^\s*[-*+]\s+/gm, '') // unordered list markers → flow as prose
    .replace(/^\s*\d+\.\s+/gm, '') // ordered list markers → flow as prose
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, '$1') // wiki-links [[target|alias]] → alias
    .replace(/\[\[([^\]]+)\]\]/g, '$1') // wiki-links [[target]] → target
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → link text
    .replace(/<[^>]+>/g, '') // stray html tags
    .replace(/\[\^[^\]]+\]/g, '') // footnote references
    .replace(/[*_`>[\]]|[=~]{2,}/g, '') // inline markers, ==highlight==, ~~strike~~
    .replace(/\s+/g, ' ')
    .trim()

  if (text.length <= max) {
    return text
  }
  // Clamp at the last word boundary before `max` so we never cut mid-word, and
  // signal the truncation with an ellipsis.
  const cut = text.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:—-]+$/, '') + '…'
}

/**
 * The whole Feed-card preview in one call — the shared derivation behind every
 * store's `preview`. `tags` accepts whatever the engine's frontmatter
 * carries (string, array, anything) and normalises it the same way the editor
 * does, so one note shows the same chips whichever engine served it.
 */
export const derivePreview = (content: string, tags?: unknown): Preview => ({
  snippet: makeSnippet(content),
  image: firstImage(content),
  tags: normTags(tags) || [],
  words: countWords(content),
  tokens: estimateTokens(content),
})

/**
 * Preview from a RAW markdown file (frontmatter still attached, storage-format
 * "# Title" heading still in place) — the read-from-disk fast path a host with
 * filesystem access to the notes takes instead of an engine round-trip. Must
 * produce the same preview the engine-normalised path does: tags come from the
 * frontmatter block, the duplicate title heading is stripped so it doesn't
 * lead the snippet text.
 */
export const derivePreviewFromFile = (raw: string, title?: string): Preview => {
  const body = stripTitleHeading(stripFrontmatter(raw), title)
  return derivePreview(body, frontmatterTags(raw))
}
