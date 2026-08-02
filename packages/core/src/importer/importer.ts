// The importer entry point: one uploaded file's raw text → notes to create.
// Auto-detects the format (overridable) and dispatches to the format parser.
// Pure — the host (server) feeds it bytes and consumes the ImportNote[].

import { IMPORT_FORMAT } from './consts'
import type { ImportFormat } from './consts'
import { detectFormat } from './detect'
import { parseChatGpt } from './formats/chatgpt'
import { parseClaudeConversations } from './formats/claudeConversations'
import { parseClaudeDesignChat } from './formats/claudeDesignChat'
import { parseClaudeMemory } from './formats/claudeMemory'
import { parseClaudeProjects } from './formats/claudeProjects'
import { markdownFileToNote } from './formats/markdown'
import { parseMemoryJson } from './formats/memoryJson'
import type { ImportParseResult } from './types'

export class ImportError extends Error {}

/** Parse one export file. `format` forces a parser; omitted = auto-detect.
 *  `fileName` names the source (the markdown format uses it for the title
 *  fallback + storage filename). Throws ImportError when the format can't be
 *  determined or the JSON is unparseable — the host turns that into a 400. */
export const parseImport = (
  raw: string,
  format?: ImportFormat,
  fileName = 'upload',
): ImportParseResult => {
  const fmt = format ?? detectFormat(raw)

  if (!fmt) {
    throw new ImportError(
      'Unrecognised export format. Expected a Claude or ChatGPT conversations.json, a Claude projects.json, or an MCP memory.json.',
    )
  }
  // A dropped text file: the whole file IS the note — no JSON parse.
  if (fmt === IMPORT_FORMAT.markdown) {
    return { format: fmt, notes: [markdownFileToNote(raw, fileName)], warnings: [] }
  }
  if (fmt === IMPORT_FORMAT.memoryJson) {
    const { notes, warnings } = parseMemoryJson(raw)
    return { format: fmt, notes, warnings }
  }
  let data: unknown

  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new ImportError(`Invalid JSON: ${(err as Error).message}`)
  }
  const parse =
    fmt === IMPORT_FORMAT.chatgpt
      ? parseChatGpt
      : fmt === IMPORT_FORMAT.claudeProjects
        ? parseClaudeProjects
        : fmt === IMPORT_FORMAT.claudeMemory
          ? parseClaudeMemory
          : fmt === IMPORT_FORMAT.claudeDesignChat
            ? parseClaudeDesignChat
            : parseClaudeConversations
  const { notes, warnings } = parse(data)
  return { format: fmt, notes, warnings }
}
