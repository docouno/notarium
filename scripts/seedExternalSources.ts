import { writeFile } from 'node:fs/promises'

import { replaceSeedTokens } from '../test/cases/revisionStates'
import type { ExternalSourceDecl } from '../test/cases/types'

export type SeedExternalSource = {
  note: string
  filePath: string
  source: ExternalSourceDecl['source']
  tokens: { noteId: string; path: string; createdAt: string }
}

/** Plant whole-file bytes for shapes an authoring write cannot produce — a file led by an
 *  encoding prologue, prose opening with a `---` rule. Unlike the #267 rewrites this
 *  deliberately changes size and mtime: it is an ordinary external edit, and the engine
 *  is expected to notice it. Runs after those rewrites, so a size-preserving replacement
 *  still finds its own occurrence in the bytes the timeline wrote. */
export const applySeedExternalSources = async (sources: SeedExternalSource[]): Promise<number> => {
  for (const entry of sources) {
    const bytes = replaceSeedTokens(
      entry.source.encoding === 'utf8'
        ? new TextEncoder().encode(entry.source.data)
        : Uint8Array.from(Buffer.from(entry.source.data, 'base64')),
      entry.tokens,
    )

    await writeFile(entry.filePath, bytes)
  }

  return sources.length
}
