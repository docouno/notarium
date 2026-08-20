// Claude `projects.json` → notes. The export ships a JSON ARRAY of
// projects; each project becomes a folder holding its docs (`docs/<file>.md`)
// and, when present, its custom instructions (`prompt-template.md`). Docs keep
// their content verbatim — they're already markdown the user authored.

import { IMPORT_SOURCE } from '../consts'
import { cappedSlug, importerDirectorySlug, toIso } from '../helpers/format'
import { failedImportRecord, importedNote, partitionImportOutcomes } from '../outcomes'
import { sourceNoteFileName, sourceProjectDirectoryName } from '../placement'
import {
  claudeProjectDocSourceLocator,
  claudeProjectPlacementLocator,
  claudeProjectPromptSourceLocator,
} from '../sourceLocator'
import type { ImportRecordOutcome } from '../types'

type ClaudeDoc = { uuid?: string; filename?: string; content?: string; created_at?: string }
type ClaudeProject = {
  uuid?: string
  name?: string
  created_at?: string
  updated_at?: string
  prompt_template?: string
  docs?: ClaudeDoc[]
}

/** One project → its notes (prompt template + each doc) — the streaming unit. */
export const claudeProjectToNotes = (proj: ClaudeProject, index = 0): ImportRecordOutcome[] => {
  const outcomes: ImportRecordOutcome[] = []
  const name = (proj?.name || '').trim() || `Project ${proj?.uuid || index + 1}`
  const dirSlug = importerDirectorySlug(name)
  // Keep the exact predecessor placement for the host's source-less legacy
  // refusal. It is evidence to fence, never a destination fallback.
  const legacyDirectory = `projects/${dirSlug || 'project'}`
  const placementLocator = claudeProjectPlacementLocator(proj.uuid)
  const directory = placementLocator
    ? `projects/${sourceProjectDirectoryName(name, placementLocator)}`
    : null
  const projCreated = toIso(proj.created_at)

  if (proj.prompt_template && proj.prompt_template.trim()) {
    const title = `Prompt Template: ${name}`
    const sourceLocator = claudeProjectPromptSourceLocator(proj.uuid)

    if (!sourceLocator || !directory) {
      outcomes.push(
        failedImportRecord(title, 'claude project prompt: missing durable project uuid'),
      )
    } else {
      outcomes.push(
        importedNote({
          title: `Prompt Template: ${name}`,
          body: proj.prompt_template,
          directory,
          tags: ['claude', 'project'],
          noteType: 'prompt_template',
          createdAt: projCreated ?? undefined,
          fileName: 'prompt-template',
          legacyDirectory,
          legacyFileName: 'prompt-template',
          source: IMPORT_SOURCE.claude,
          sourceLocator,
        }),
      )
    }
  }

  for (const doc of proj.docs ?? []) {
    const filename = (doc?.filename || '').trim() || `doc-${doc?.uuid || outcomes.length + 1}`
    const title = filename.replace(/\.md$/i, '')
    const sourceLocator = claudeProjectDocSourceLocator(proj.uuid, doc.uuid)

    if (!sourceLocator || !directory) {
      outcomes.push(
        failedImportRecord(title, 'claude project document: missing durable project/doc uuid'),
      )
      continue
    }
    outcomes.push(
      importedNote({
        title,
        body: doc.content ?? '',
        directory: `${directory}/docs`,
        tags: ['claude', 'project'],
        noteType: 'project_doc',
        createdAt: toIso(doc.created_at) ?? projCreated ?? undefined,
        fileName: sourceNoteFileName(title, sourceLocator),
        legacyDirectory: `${legacyDirectory}/docs`,
        legacyFileName: cappedSlug(title) || 'doc',
        source: IMPORT_SOURCE.claude,
        sourceLocator,
      }),
    )
  }

  return outcomes
}

/** Is a value a single Claude project object (the per-file `projects/<uuid>.json`
 *  shape) rather than the classic `projects.json` array? */
export const isClaudeProjectObject = (o: unknown): boolean => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    return false
  }
  const p = o as Record<string, unknown>
  return Array.isArray(p.docs) || typeof p.prompt_template === 'string'
}

/** The classic `projects.json` is a JSON ARRAY; the evolved export ships one
 *  project OBJECT per file (`projects/<uuid>.json`). Accept both. */
export const parseClaudeProjects = (
  data: unknown,
): ReturnType<typeof partitionImportOutcomes> & { warnings: string[] } => {
  const projects: ClaudeProject[] = Array.isArray(data)
    ? (data as ClaudeProject[])
    : isClaudeProjectObject(data)
      ? [data as ClaudeProject]
      : []

  if (!projects.length && !Array.isArray(data)) {
    return {
      notes: [],
      failures: [],
      skipped: 0,
      warnings: ['claude projects: expected a project array or object'],
    }
  }
  const partitioned = partitionImportOutcomes(
    projects.flatMap((proj, i) => claudeProjectToNotes(proj, i)),
  )
  const warnings =
    partitioned.notes.length || partitioned.failures.length
      ? []
      : ['claude projects: no project documents found']
  return { ...partitioned, warnings }
}
