// Claude `projects.json` → notes. The export ships a JSON ARRAY of
// projects; each project becomes a folder holding its docs (`docs/<file>.md`)
// and, when present, its custom instructions (`prompt-template.md`). Docs keep
// their content verbatim — they're already markdown the user authored.

import { IMPORT_SOURCE } from '../consts'
import { cappedSlug, importerDirectorySlug, toIso } from '../helpers/format'
import type { ImportNote } from '../types'

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
export const claudeProjectToNotes = (proj: ClaudeProject, index = 0): ImportNote[] => {
  const notes: ImportNote[] = []
  const name = (proj?.name || '').trim() || `Project ${proj?.uuid || index + 1}`
  const dirSlug = importerDirectorySlug(name)
  // Keep the historical fallback too: a new source-keyed path would duplicate
  // an existing unromanised project on its first re-import. Collisions within
  // one upload are rejected by the host's whole-run destination reservation.
  const dir = `projects/${dirSlug || 'project'}`
  const projCreated = toIso(proj.created_at)

  if (proj.prompt_template && proj.prompt_template.trim()) {
    notes.push({
      title: `Prompt Template: ${name}`,
      body: proj.prompt_template,
      directory: dir,
      tags: ['claude', 'project'],
      noteType: 'prompt_template',
      createdAt: projCreated ?? undefined,
      fileName: 'prompt-template',
      source: IMPORT_SOURCE.claude,
    })
  }

  for (const doc of proj.docs ?? []) {
    const filename = (doc?.filename || '').trim() || `doc-${doc?.uuid || notes.length + 1}`
    const title = filename.replace(/\.md$/i, '')
    notes.push({
      title,
      body: doc.content ?? '',
      directory: `${dir}/docs`,
      tags: ['claude', 'project'],
      noteType: 'project_doc',
      createdAt: toIso(doc.created_at) ?? projCreated ?? undefined,
      fileName: cappedSlug(title) || 'doc',
      source: IMPORT_SOURCE.claude,
    })
  }

  return notes
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
export const parseClaudeProjects = (data: unknown): { notes: ImportNote[]; warnings: string[] } => {
  const projects: ClaudeProject[] = Array.isArray(data)
    ? (data as ClaudeProject[])
    : isClaudeProjectObject(data)
      ? [data as ClaudeProject]
      : []

  if (!projects.length && !Array.isArray(data)) {
    return { notes: [], warnings: ['claude projects: expected a project array or object'] }
  }
  const notes: ImportNote[] = []
  projects.forEach((proj, i) => notes.push(...claudeProjectToNotes(proj, i)))
  const warnings = notes.length ? [] : ['claude projects: no project documents found']
  return { notes, warnings }
}
