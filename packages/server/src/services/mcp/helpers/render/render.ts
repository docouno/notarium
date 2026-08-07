// Markdown rendering for the read/bootstrap tools: the prose projection of each tool's structured payload.
import { type RoleSummary } from '@notarium/contract'
import {
  type AgentSession,
  type DeltaEntry,
  type FolderEntry,
  type ListNotesItem,
  type NoteLink,
  type ProjectSummary,
  type Provenance,
  type RecentActivityItem,
  type RecentAgentSession,
  RESPONSE_FORMAT,
  type SearchHit,
  type ToolHelp,
  type UseRoleOutput,
} from '@notarium/contract/tools'

import { renderProvenance } from '../provenance'

type SessionStructured = {
  session?: AgentSession
  recentSessions?: RecentAgentSession[]
  profile: {
    memory: Array<{ noteId: string; category: string; summary: string }>
    alwaysLoad: Array<{ noteId: string; title: string }>
  }
  roles: RoleSummary[]
  rolesTruncated?: boolean
  activeRole?: UseRoleOutput
  projects: ProjectSummary[]
  project?: {
    index: { noteCount: number; folders: FolderEntry[] }
    alwaysLoad: Array<{ noteId: string; title: string }>
    delta: { changes: DeltaEntry[]; total: number; truncated?: boolean }
    knownValues?: { categories: string[]; tags: string[] }
  }
  toolsHelp: ToolHelp[]
  truncated?: boolean
}

/** Renders the session bundle as prose; `concise` (default) vs `detailed`. */
export const renderSession = (
  s: SessionStructured,
  project: string | undefined,
  format: 'concise' | 'detailed',
): string => {
  const lines: string[] = []

  if (s.session) {
    // Deliberately the FIRST line: this survives aggressive context truncation and
    // makes the model carry the stable episode id into every subsequent tool call.
    lines.push(s.session.hint)
  } else if (s.recentSessions !== undefined) {
    lines.push('More than one session has that name; call start_session again with one id:')
  }
  if (s.recentSessions?.length) {
    for (const recent of s.recentSessions) {
      lines.push(
        `- ${recent.name} — ${recent.id} (${recent.active ? 'active' : 'sleeping'}, ${recent.calls} calls)`,
      )
    }
  }

  if (s.profile.memory.length) {
    lines.push('**What I remember about you:**')
    for (const m of s.profile.memory) {
      lines.push(`- _${m.category}_: ${m.summary}`)
    }
  }
  if (s.profile.alwaysLoad.length) {
    lines.push('', '**Always-load notes:**')
    for (const a of s.profile.alwaysLoad) {
      lines.push(`- ${a.title} \`${a.noteId}\``)
    }
  }
  if (s.roles.length) {
    lines.push('', '**Available roles** (call `use_role` when one matches the work):')
    for (const role of s.roles) {
      lines.push(`- \`${role.name}\` (${role.scope}) — ${role.description}`)
    }
  } else if (s.rolesTruncated) {
    lines.push('', 'No roles are visible in this bounded summary.')
  } else {
    lines.push('', 'No roles have been added in this scope; continue in the base mode.')
  }
  if (s.rolesTruncated) {
    lines.push(
      '',
      '_(role summaries were abbreviated or omitted — use `list_roles` for the bounded inventory)_',
    )
  }
  if (s.activeRole) {
    lines.push('', renderRole(s.activeRole))
  }
  lines.push(
    '',
    s.projects.length
      ? `**Your projects:** ${s.projects.map((p) => `\`${p.handle}\``).join(', ')}`
      : 'You have no project workspaces yet.',
  )
  if (s.project) {
    const idx = s.project.index
    const folderNames = idx.folders.map((f) => f.name)
    const folderTail =
      format === RESPONSE_FORMAT.detailed && folderNames.length
        ? ` — folders: ${folderNames.join(', ')}`
        : ''
    lines.push(
      '',
      `**\`${project}\`:** ${idx.noteCount} note${idx.noteCount === 1 ? '' : 's'}${folderTail} (enumerate with list_notes)`,
    )
    if (s.project.alwaysLoad.length) {
      lines.push('', `**Always-load notes in \`${project}\`:**`)
      for (const a of s.project.alwaysLoad) {
        lines.push(`- ${a.title} \`${a.noteId}\``)
      }
    }
    const d = s.project.delta
    const head = d.total
      ? `**Changes in \`${project}\` since you last looked** (${d.changes.length}${d.truncated ? ` of ${d.total}, more via search` : ''}):`
      : `Nothing changed in \`${project}\` since you last looked.`
    lines.push('', head)
    if (format === RESPONSE_FORMAT.detailed) {
      for (const c of d.changes) {
        const who = c.principal ? ` by \`${c.principal}\`` : ''
        lines.push(`- ${c.title} \`${c.noteId}\` (${c.kind}${who})`)
      }
    }
    const kv = s.project.knownValues

    if (format === RESPONSE_FORMAT.detailed && kv && (kv.categories.length || kv.tags.length)) {
      lines.push('', '**Known values** (reuse these, do not coin synonyms):')
      if (kv.categories.length) {
        lines.push(`- categories: ${kv.categories.join(', ')}`)
      }
      if (kv.tags.length) {
        lines.push(`- tags: ${kv.tags.join(', ')}`)
      }
    }
  }
  if (format === RESPONSE_FORMAT.detailed && s.toolsHelp.length) {
    lines.push('', '**Tools:**')
    for (const t of s.toolsHelp) {
      lines.push(`- \`${t.name}\` — ${t.summary}`)
    }
  }
  if (s.truncated) {
    lines.push(
      '',
      '_(note/profile context truncated — narrow by project; use list/search/get_note for the rest)_',
    )
  }

  return lines.join('\n').trim() || 'Session ready.'
}

export const renderRole = (loaded: UseRoleOutput): string => {
  const lines = [`# Active role: ${loaded.role.name}`, '', loaded.instructions ?? '']

  if (loaded.status === 'already_active') {
    lines.splice(1, 0, '', '_(already active; effective instructions reloaded)_')
  }

  for (const skill of loaded.skills ?? []) {
    lines.push('', `## Linked skill: ${skill.name}`, '', skill.instructions)
  }
  if (loaded.context?.alwaysLoad.length) {
    lines.push('', '**Role context:**')
    for (const note of loaded.context.alwaysLoad) {
      lines.push(`- ${note.title} \`${note.noteId}\``)
    }
  }
  if (loaded.context?.replacement) {
    const { profile, project } = loaded.context.replacement
    lines.push(
      '',
      '**Effective base context (replaces the base from `start_session`; omitted refs are evicted):**',
    )
    for (const memory of profile.memory) {
      lines.push(`- memory _${memory.category}_: ${memory.summary}`)
    }
    for (const note of profile.alwaysLoad) {
      lines.push(`- profile: ${note.title} \`${note.noteId}\``)
    }
    for (const note of project?.alwaysLoad ?? []) {
      lines.push(`- project: ${note.title} \`${note.noteId}\``)
    }
    if (
      profile.memory.length === 0 &&
      profile.alwaysLoad.length === 0 &&
      (project?.alwaysLoad.length ?? 0) === 0
    ) {
      lines.push('- _(empty)_')
    }
  }
  if (loaded.context?.truncated) {
    lines.push('', '_(effective context truncated by the shared session budget)_')
  }
  if (loaded.truncated) {
    lines.push('', '_(role bundle truncated to the requested token budget)_')
  }

  return lines.join('\n').trim()
}

/** Where a note lives, in prose: project handle, else space slug, else personal. */
const whereLabel = (loc: { space?: string; project?: string }): string => {
  if (loc.project) {
    return ` _(project: ${loc.project})_`
  }
  if (loc.space) {
    return ` _(${loc.space})_`
  }

  return ' _(personal)_'
}

export const renderSearch = (results: SearchHit[], format: 'concise' | 'detailed'): string => {
  if (!results.length) {
    return 'No matches.'
  }
  const lines = results.map((h) => {
    const head = `- **${h.title}** \`${h.noteId}\`${whereLabel(h)}`
    return format === RESPONSE_FORMAT.detailed && h.snippet ? `${head}\n  ${h.snippet}` : head
  })
  return `${results.length} match${results.length === 1 ? '' : 'es'}:\n${lines.join('\n')}`
}

export const renderNote = (
  note: {
    title: string
    content: string
    space?: string
    project?: string
    versionToken: string
    provenance?: Provenance
    outline?: Array<{ level: number; title: string }>
    links?: { outgoing: NoteLink[]; incoming: NoteLink[] }
  },
  format: 'concise' | 'detailed',
): string => {
  const where = whereLabel(note)

  if (format === RESPONSE_FORMAT.concise) {
    const firstPara = note.content.split('\n\n')[0]?.trim() ?? ''
    const brief = firstPara.length > 500 ? `${firstPara.slice(0, 500)}…` : firstPara
    return `# ${note.title}${where}\n\n${brief}`
  }
  const parts = [`# ${note.title}${where}\n\n${note.content}`]

  if (note.outline && note.outline.length) {
    const lines = note.outline.map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}- ${h.title}`)
    parts.push(`**Sections** (edit with replaceSection):\n${lines.join('\n')}`)
  }
  if (note.links && (note.links.outgoing.length || note.links.incoming.length)) {
    const lines: string[] = []

    for (const l of note.links.outgoing) {
      lines.push(
        `- → _${l.relation}_ ${l.title}${l.noteId ? ` \`${l.noteId}\`` : ' (not yet created)'}`,
      )
    }
    for (const l of note.links.incoming) {
      lines.push(`- ← _${l.relation}_ ${l.title}${l.noteId ? ` \`${l.noteId}\`` : ''}`)
    }
    parts.push(`**Links:**\n${lines.join('\n')}`)
  }
  if (note.provenance) {
    parts.push(renderProvenance(note.provenance))
  }

  return parts.join('\n\n')
}

/** The list_notes (ls) rendering: subfolders, then notes. */
export const renderListNotes = (
  items: ListNotesItem[],
  folders: FolderEntry[],
  total: number,
  folder: string,
): string => {
  const where = folder ? `\`${folder}\`` : 'the root'

  if (!items.length && !folders.length) {
    return `Nothing in ${where}.`
  }
  const lines: string[] = []

  for (const f of folders) {
    lines.push(`- 📁 **${f.name}/** \`${f.path}\` (${f.count})`)
  }
  for (const i of items) {
    lines.push(`- ${i.title} \`${i.noteId}\``)
  }
  const more =
    items.length < total ? ` (showing ${items.length} of ${total} notes — page with cursor)` : ''
  return `Contents of ${where}${more}:\n${lines.join('\n')}`
}

/** recent_activity rendering, newest-first. */
export const renderRecentActivity = (items: RecentActivityItem[]): string => {
  if (!items.length) {
    return 'No recent activity.'
  }
  const lines = items.map((i) => {
    const who = i.principal ? ` by \`${i.principal}\`` : ''
    return `- **${i.title}** \`${i.noteId}\`${whereLabel(i)} — ${i.kind}${who} (${i.modifiedAt})`
  })
  return `${items.length} recently changed:\n${lines.join('\n')}`
}
