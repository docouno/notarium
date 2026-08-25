// Feed-card / graph enrichment derived from a note body: the shared
// derivation behind every store's `preview`. The body a store hands out is already
// engine-normalised (frontmatter object split off, storage-format title heading
// stripped), and these derivations know nothing engine-specific. Where a leading block
// still has to be answered for, exactly ONE derivation asks — see `derivePreview`.

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
 * First image in a note BODY, for the Feed card preview. Markdown image first,
 * then a bare `<img src>`. Only absolute http(s) URLs are returned — local
 * attachment paths can't be resolved through the current proxy, so we skip them
 * rather than render a broken thumbnail (our own API will serve these later).
 */
export const firstImage = (body: string): string | null => {
  const md = body.match(/!\[[^\]]*\]\(\s*(\S+?)(?:\s+["'][^)]*)?\s*\)/)
  const html = body.match(/<img[^>]*\bsrc=["']([^"']+)["']/i)
  const url = md ? md[1] : html ? html[1] : null
  return url && /^https?:\/\//i.test(url) ? url : null
}

/**
 * Reduce a note BODY to a short plain-text preview for Feed cards: drop fenced
 * code, tables, images and the noisier inline markdown, flatten lists to prose,
 * then collapse whitespace and clamp at a word boundary. Plain text only — the
 * card never renders raw markdown syntax.
 */
export const makeSnippet = (body: string, max = 1600): string => {
  const text = body
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
 * The whole Feed-card preview in one call — the shared derivation behind every store's
 * `preview`. It takes a note BODY and asks nothing about a leading block.
 *
 * That is the whole point. A body a store hands out has already been through the file
 * parse, and normalising it can leave bytes that READ like a block (a paragraph that
 * opened with a rule, once its leading blank line is gone). Asking again over that
 * shape is how one file grew two previews — a snippet holding a paragraph its own word
 * count had discarded. A caller who genuinely holds unparsed text strips it ITSELF,
 * visibly, at the call site; see `derivePreviewFromFile` for the file-shaped one.
 *
 * `tags` accepts whatever the engine's frontmatter carries (string, array, anything) and
 * normalises it the same way the editor does, so one note shows the same chips whichever
 * engine served it.
 */
export const derivePreview = (body: string, tags?: unknown): Preview => ({
  snippet: makeSnippet(body),
  image: firstImage(body),
  tags: normTags(tags) || [],
  words: countWords(body),
  tokens: estimateTokens(body),
})

/**
 * Preview from a RAW markdown file (frontmatter still attached, storage-format
 * "# Title" heading still in place) — the read-from-disk fast path a host with
 * filesystem access to the notes takes instead of an engine round-trip. Must
 * produce the same preview the engine-normalised path does: tags come from the
 * frontmatter block, the duplicate title heading is stripped so it doesn't
 * lead the snippet text.
 */
export const derivePreviewFromFile = (raw: string, title?: string): Preview =>
  derivePreview(stripTitleHeading(stripFrontmatter(raw), title), frontmatterTags(raw))
