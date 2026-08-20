// The importer entry point: one uploaded file's raw text → notes to create.
// Auto-detects the format (overridable) and dispatches to the format parser.
// Pure — the host consumes notes plus explicit per-record failures/skips.

import { IMPORT_FORMAT } from './consts'
import type { ImportFormat } from './consts'
import { detectFormat } from './detect'
import { ImportError } from './errors'
import { parseChatGpt } from './formats/chatgpt'
import { parseClaudeConversations } from './formats/claudeConversations'
import { parseClaudeDesignChat } from './formats/claudeDesignChat'
import { parseClaudeMemory } from './formats/claudeMemory'
import { parseClaudeProjects } from './formats/claudeProjects'
import { markdownFileToNote } from './formats/markdown'
import { parseMemoryJson } from './formats/memoryJson'
import type { ImportParseResult, ImportRecordFailure } from './types'

export { ImportError } from './errors'

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
    return { format: fmt, notes: [markdownFileToNote(raw, fileName)], failures: [], warnings: [] }
  }
  if (fmt === IMPORT_FORMAT.memoryJson) {
    const { notes, warnings } = parseMemoryJson(raw)
    return { format: fmt, notes, failures: [], warnings }
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
  const parsed = parse(data)
  return {
    format: fmt,
    notes: parsed.notes,
    failures: 'failures' in parsed ? (parsed.failures as ImportRecordFailure[]) : [],
    warnings: parsed.warnings,
  }
}
