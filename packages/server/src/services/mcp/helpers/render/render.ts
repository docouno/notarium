// Markdown rendering for the read/bootstrap tools: the prose projection of each tool's structured payload.
import {
  type AgentSession,
  type DeltaEntry,
  type FolderEntry,
  type FolderPageMarker,
  type FolderPageSlot,
  type ListNotesItem,
  type NextAbilityAction,
  type NoteLink,
  type PresentFolderPage,
  type ProjectSummary,
  type Provenance,
  type RecentActivityItem,
  type RecentAgentSession,
  RESPONSE_FORMAT,
  type RuntimeAbilitySummary,
  type SearchHit,
  type ToolHelp,
  type UseRoleOutput,
  type UseSkillOutput,
} from '@notarium/contract/tools'

import { renderProvenance } from '../provenance'

type SessionStructured = {
  session?: AgentSession
  recentSessions?: RecentAgentSession[]
  profile: {
    memory: Array<{ noteId: string; category: string; summary: string }>
    alwaysLoad: Array<{ noteId: string; title: string }>
  }
  abilities: RuntimeAbilitySummary[]
  abilitiesTruncated?: boolean
  nextAction?: NextAbilityAction
  activeRole?: UseRoleOutput
  roleDiagnostic?: string
  projectResolutionHint?: string
  projects: ProjectSummary[]
  project?: {
    index: { noteCount: number; folders: FolderEntry[] }
    alwaysLoad: Array<{ noteId: string; title: string }>
    folderPage?: PresentFolderPage
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
  if (s.projectResolutionHint) {
    lines.push('', s.projectResolutionHint)
  }
  if (s.abilities.length) {
    lines.push('', '**Available abilities:**')
    for (const ability of s.abilities) {
      lines.push(
        `- \`${ability.name}\` (${ability.kind}, ${ability.source === 'system' ? 'system' : ability.scope}) — ${ability.description}`,
      )
    }
  } else if (s.abilitiesTruncated) {
    lines.push('', 'No abilities fit in this bounded summary.')
  } else {
    lines.push('', 'No abilities are available in this scope; continue in the base mode.')
  }
  if (s.abilitiesTruncated && s.nextAction) {
    lines.push('', `Required next action: \`${JSON.stringify(s.nextAction)}\``)
  }
  if (s.activeRole) {
    lines.push('', renderRole(s.activeRole))
  }
  if (s.roleDiagnostic) {
    lines.push('', `**Saved role was not restored:** ${s.roleDiagnostic}`)
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
    if (s.project.folderPage) {
      // Mirrors the structured marker for a text-only client. It earns its line in the
      // state the marker exists FOR: a page that is present but not pinned rides in no
      // always-load list, so without this the bootstrap simply would not mention it.
      const page = s.project.folderPage
      lines.push(
        '',
        `**Folder page:** ${page.title} \`${page.noteId}\` — the authored cover of \`${project}\`. Read it with get_note.`,
      )
    }
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
    lines.push('', `## Linked skill: ${skill.name}`, '')
    if (skill.state === 'loaded') {
      lines.push(skill.instructions)
    } else {
      lines.push(
        `_(instructions omitted by the role budget — call \`use_skill\` with \`skill: "${skill.name}"\` to load them)_`,
      )
    }
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

export const renderSkill = (loaded: UseSkillOutput): string =>
  [`# Active skill: ${loaded.skill.name}`, '', loaded.instructions].join('\n').trim()

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
    unsafeFrontmatterKeysOmitted?: number
    provenance?: Provenance
    folderPage?: FolderPageMarker
    outline?: Array<{ level: number; title: string }>
    links?: { outgoing: NoteLink[]; incoming: NoteLink[] }
  },
  format: 'concise' | 'detailed',
): string => {
  const where = whereLabel(note)
  // The third mirror of the structural marker. `list_notes` and `start_session` both say
  // the role in prose; without this the ONE step the flow sends an agent to next — read
  // the page you were just told about — is the step where a text-only client stops being
  // told what it is holding.
  const role = note.folderPage
    ? `\n\n_The Folder page of ${note.folderPage.folderPath ? `\`${note.folderPage.folderPath}\`` : 'the root'} — this note IS that folder's cover._`
    : ''
  const unsafeFrontmatterWarning = note.unsafeFrontmatterKeysOmitted
    ? `_${note.unsafeFrontmatterKeysOmitted} unsafe frontmatter ${note.unsafeFrontmatterKeysOmitted === 1 ? 'key was' : 'keys were'} omitted from the agent view._`
    : ''

  if (format === RESPONSE_FORMAT.concise) {
    const firstPara = note.content.split('\n\n')[0]?.trim() ?? ''
    const brief = firstPara.length > 500 ? `${firstPara.slice(0, 500)}…` : firstPara
    return `# ${note.title}${where}${role}\n\n${brief}${unsafeFrontmatterWarning ? `\n\n${unsafeFrontmatterWarning}` : ''}`
  }
  const parts = [`# ${note.title}${where}${role}\n\n${note.content}`]

  if (note.unsafeFrontmatterKeysOmitted) {
    parts.push(unsafeFrontmatterWarning)
  }

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

/** Why a missing slot carries no create action. Server-internal on purpose: the slot on
 *  the wire has no reason vocabulary, and this only chooses between two sentences —
 *  "you may not write here" and "this call cannot express the action", which used to
 *  share one, untrue in the second case. */
export type CreateUnavailable = 'no-write' | 'unaddressed'

/** The folder-page slot in prose — the exact mirror of the structured slot, so a
 *  text-only client reads the same folder state (and the same create action) a
 *  structured one does. The missing branch says capability, not instruction:
 *  an agent that browses a folder has not been asked to author its page. */
const folderPageLines = (
  slot: FolderPageSlot,
  where: string,
  unavailable?: CreateUnavailable,
): string[] => {
  if (slot.status === 'present') {
    return [
      `Folder page: **${slot.title}** \`${slot.noteId}\` — the authored cover of ${where}. Read it with get_note.`,
    ]
  }
  if (!slot.createWith) {
    // Two different facts used to share one sentence, and one of them was a lie: a
    // listing of the personal domain carries no project handle to build the action
    // FROM, while its owner may create pages there perfectly well. Only the caller who
    // actually cannot write is told so — and the other branch points at the shape of the
    // call that CAN express it without promising that a project covers this folder.
    return [
      unavailable === 'unaddressed'
        ? `Folder page is missing for ${where}; this listing carries no create action. A project-scoped listing of the same folder offers one, where the folder belongs to a project.`
        : `Folder page is missing for ${where}; creating one is not available to you here.`,
    ]
  }

  return [
    `Folder page is missing for ${where}.`,
    'Create only if the user explicitly asked for folder-level authored content.',
    `createWith: ${JSON.stringify(slot.createWith)}`,
    'Pass createWith unchanged to create_note and add body.',
  ]
}

/** The list_notes (ls) rendering: the folder's own page, then subfolders, then notes. */
export const renderListNotes = (
  items: ListNotesItem[],
  folders: FolderEntry[],
  total: number,
  folder: string,
  folderPage?: FolderPageSlot,
  unavailable?: CreateUnavailable,
): string => {
  const where = folder ? `\`${folder}\`` : 'the root'
  // The slot outlives an empty listing: a folder holding ONLY its `index.md` is
  // exactly the case the early return used to report as "Nothing in …", which would
  // have contradicted a `present` structured slot on the first non-trivial folder.
  const pageLines = folderPage ? folderPageLines(folderPage, where, unavailable) : []

  if (!items.length && !folders.length) {
    // The slot does not ANSWER `ls`: a page is the folder's cover, not its content, and
    // a missing one is not content either. Both statements travel together, or a text
    // client cannot tell an empty folder from one whose contents it was never told —
    // and a folder that does not exist at all would read as the more informative of
    // the two, since only IT still got a plain "Nothing in".
    const empty =
      folderPage?.status === 'present' ? `No other notes in ${where}.` : `Nothing in ${where}.`

    return [...pageLines, empty].join('\n')
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
  const body = `Contents of ${where}${more}:\n${lines.join('\n')}`
  return pageLines.length ? `${pageLines.join('\n')}\n\n${body}` : body
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
