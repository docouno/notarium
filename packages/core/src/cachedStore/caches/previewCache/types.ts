import type { NoteMeta, Preview } from '../../../knowledgeStore'

export type PreviewCacheOptions = {
  /** LRU cap — derived previews are ~2-3KB each, so this bounds the cache at
   *  tens of MB on a huge base. */
  maxSize: number
  /** Read a note's RAW markdown from storage (the P5 fast path); absent ⇒ the
   *  file path is skipped and the engine read serves. */
  readBody?: (filePath: string) => Promise<string | null>
  /** The snapshot's note meta by id — `fromFile` needs the filePath/title. */
  getMeta: (id: string) => NoteMeta | undefined
  /** The wrapped engine's own peek: an inner store that derives from memory
   *  (InMemoryStore) is always warm, so a cache miss falls through to it. */
  innerPeek: (id: string) => Preview | null
}
