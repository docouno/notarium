import type { NoteMeta, Preview } from '../../../knowledgeStore'
import { derivePreviewFromFile } from '../../../snippet'
import type { PreviewCacheOptions } from './types'

/** The read-model's preview cache: derived previews (NOT bodies — those
 *  would be 10-50× the memory), read-through with real invalidation. Kept warm
 *  for free by the bodies that already pass through the read-model (write-through,
 *  read, delta upserts with content); an external change without a body just drops
 *  the entry and the next view recomputes it lazily. Map insertion order is the
 *  LRU: hits re-insert, inserts past the cap evict the oldest.
 *  @see docs/core.md#read-model */
export class PreviewCache {
  private readonly cache = new Map<string, Preview>()
  private readonly maxSize: number
  private readonly readBody?: (filePath: string) => Promise<string | null>
  private readonly getMeta: (id: string) => NoteMeta | undefined
  private readonly innerPeek: (id: string) => Preview | null

  constructor({ maxSize, readBody, getMeta, innerPeek }: PreviewCacheOptions) {
    this.maxSize = maxSize
    this.readBody = readBody
    this.getMeta = getMeta
    this.innerPeek = innerPeek
  }

  /** Raw cache lookup, no LRU touch — the engine-path fallback re-checks an
   *  entry a concurrent read may have just warmed. */
  get(id: string): Preview | undefined {
    return this.cache.get(id)
  }

  /** Cache-only peek (the inline `?preview=1` decoration of a notes window):
   *  warm value or null, never an engine read. A hit refreshes LRU recency. */
  peek(id: string): Preview | null {
    const hit = this.cache.get(id)

    if (!hit) {
      return this.innerPeek(id)
    }
    this.cache.delete(id)
    this.cache.set(id, hit)
    return hit
  }

  /** The storage fast path: derive the preview from the note's raw file when
   *  the host wired a readBody (P5 capability). Needs the snapshot to know the
   *  id (filePath lives there); any miss/error returns null → engine path. */
  async fromFile(id: string): Promise<Preview | null> {
    if (!this.readBody) {
      return null
    }
    const meta = this.getMeta(id)

    if (!meta) {
      return null
    }
    try {
      const raw = await this.readBody(meta.filePath)

      if (raw === null) {
        return null
      }
      const preview = derivePreviewFromFile(raw, meta.title)
      this.set(id, preview)
      return preview
    } catch {
      return null
    }
  }

  /** Insert with LRU eviction: re-insert to refresh recency, drop the oldest
   *  once past the cap. */
  set(id: string, preview: Preview): void {
    if (this.cache.has(id)) {
      this.cache.delete(id)
    }
    this.cache.set(id, preview)
    if (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value

      if (oldest !== undefined) {
        this.cache.delete(oldest)
      }
    }
  }

  delete(id: string): void {
    this.cache.delete(id)
  }

  clear(): void {
    this.cache.clear()
  }
}
