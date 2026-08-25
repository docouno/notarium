import type { NoteMeta } from '../../../knowledgeStore'

export type NoteFactsCacheOptions = {
  readBody?: (filePath: string) => Promise<string | null>
  getMeta: (id: string) => NoteMeta | undefined
}
