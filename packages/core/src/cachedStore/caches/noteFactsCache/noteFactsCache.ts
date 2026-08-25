import type { NoteContent, NoteFacts } from '../../../knowledgeStore'
import { analyzeDocumentState, estimateTokens } from '../../../libs/markdown'
import { basenameOf } from '../../../libs/path'
import { makeSnippet } from '../../../snippet'
import type { NoteFactsCacheOptions } from './types'

const encoder = new TextEncoder()

const factsOf = (
  title: string,
  content: string,
  frontmatter: Record<string, unknown>,
): NoteFacts => ({
  title,
  summary: typeof frontmatter.summary === 'string' ? frontmatter.summary : null,
  snippet: makeSnippet(content, 160),
  muted: frontmatter.muted === true || frontmatter.muted === 'true',
  bodyTokens: estimateTokens(content),
})

/** Whole-population cache of tiny body facts. It intentionally stores no body and
 * has no LRU cap: eager context must not randomly fall back to O(file parsing) when
 * a large user corpus evicts its small memory/pin population. */
export class NoteFactsCache {
  private readonly cache = new Map<string, NoteFacts>()
  private readonly readBody?: (filePath: string) => Promise<string | null>
  private readonly getMeta: NoteFactsCacheOptions['getMeta']

  constructor({ readBody, getMeta }: NoteFactsCacheOptions) {
    this.readBody = readBody
    this.getMeta = getMeta
  }

  get(id: string): NoteFacts | undefined {
    return this.cache.get(id)
  }

  set(id: string, facts: NoteFacts): void {
    this.cache.set(id, facts)
  }

  setFromNote(id: string, note: NoteContent): void {
    this.set(
      id,
      factsOf(note.title ?? this.getMeta(id)?.title ?? '', note.content, note.frontmatter),
    )
  }

  setFromRaw(id: string, raw: string): boolean {
    const meta = this.getMeta(id)

    if (!meta) {
      return false
    }
    const projection = analyzeDocumentState({
      source: encoder.encode(raw),
      // Match NotariumStore.read exactly: an ambiguous authored title falls back
      // to the storage basename, never to the index row derived by a different
      // legacy parser.
      pathFallbackTitle: basenameOf(meta.filePath).replace(/\.md$/i, ''),
    }).projection

    if (!projection) {
      return false
    }
    this.set(id, factsOf(projection.title, projection.body, projection.frontmatter))
    return true
  }

  async fromFile(id: string): Promise<NoteFacts | null> {
    const hit = this.cache.get(id)

    if (hit) {
      return hit
    }
    const meta = this.getMeta(id)

    if (!this.readBody || !meta) {
      return null
    }
    try {
      const raw = await this.readBody(meta.filePath)

      return raw != null && this.setFromRaw(id, raw) ? (this.cache.get(id) ?? null) : null
    } catch {
      return null
    }
  }

  delete(id: string): void {
    this.cache.delete(id)
  }

  rekey(oldId: string, newId: string): void {
    const facts = this.cache.get(oldId)

    this.cache.delete(oldId)
    if (facts) {
      this.cache.set(newId, facts)
    }
  }

  clear(): void {
    this.cache.clear()
  }
}
