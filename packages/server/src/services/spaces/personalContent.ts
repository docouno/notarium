// Human-UI read/write helpers over the personal-domain store: audit the agent's
// memory and curate the reserved profile note.
// canon: docs/projects.md#memory-two-axes · docs/note-model.md#agent-memory

import { NOTE_CLASS } from '@notarium/contract'
import type { MemoryCategory, Profile } from '@notarium/contract'
import {
  buildMemoryIndex,
  type KnowledgeStore,
  READ_SCOPE,
  slugify,
  STORE_ERROR_REASON,
} from '@notarium/core'

/** The ONE reserved note backing the Profile tab: lives in the hidden
 *  `profile`-class mount, human-authored content (NOT agent-memory).
 *  canon: docs/note-model.md#note-classes */
export const PROFILE_NOTE_TITLE = 'Profile'
export const PROFILE_NOTE_SLUG = slugify(PROFILE_NOTE_TITLE)
export const ALWAYS_LOAD_TAG = 'always-load'
export const PROFILE_NOTE_TYPE = 'person'
/** Reserved class hidden from every discovery surface (tree/graph/feed/search),
 *  readable/editable only by id. */
export const PROFILE_NOTE_CLASS = NOTE_CLASS.profile

/** Audit feed order, newest write first; `?? ''` sorts timestamp-less rows last. */
const byModifiedDesc = (a: { modifiedAt: string | null }, b: { modifiedAt: string | null }) =>
  (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? '')

/** List one mount subdir's agent-memory categories, decorated with journal
 *  provenance. `subdir`: '' = about-user memory, a project id = about-project.
 */
export const listMemoryCategories = async (
  store: KnowledgeStore,
  subdir = '',
  opts: { order?: 'modified' | 'eager' } = {},
): Promise<Array<Omit<MemoryCategory, 'author'>>> => {
  // `author` is attached at the route boundary — it needs the viewer + pat
  // registry, which this builder lacks.
  const index = await buildMemoryIndex(store, { subdir })

  if (index.length === 0) {
    return []
  }

  // modifiedAt fallback for a bare engine with no journal: the meta date.
  const metaById = new Map(
    (await store.list({ scope: READ_SCOPE.agentRecall })).map((m) => [m.id, m] as const),
  )

  const out: Array<Omit<MemoryCategory, 'author'>> = []

  for (const entry of index) {
    let modifiedAt = metaById.get(entry.noteId)?.modifiedAt ?? null
    let principal: string | null = null
    let kind: MemoryCategory['kind'] = null

    if (store.revisions) {
      const { items } = await store.revisions(entry.noteId, { offset: 0, limit: 1 })
      const latest = items[0]

      if (latest) {
        principal = latest.principal
        kind = latest.kind
        modifiedAt = latest.createdAt
      }
    }
    out.push({
      noteId: entry.noteId,
      category: entry.category,
      summary: entry.summary,
      tokens: entry.tokens,
      muted: entry.muted,
      modifiedAt,
      principal,
      kind,
    })
  }

  // `eager` preserves buildMemoryIndex order = the order the agent loads memory
  // in, so curation's loaded/trimmed flags match start_session (never re-sort
  // before curating).
  return opts.order === 'eager' ? out : out.sort(byModifiedDesc)
}

/** Locate the reserved profile note; undefined = not created yet. Scoped `all`
 *  because the profile class is hidden from the user/agentRecall discovery scopes.
 *  Identity is the CLASS (the mount holds one note), so a title change never
 *  orphans it; the slug is only a tiebreaker if more than one ever slips in. */
const findProfileNote = async (store: KnowledgeStore) => {
  const metas = await store.list({ scope: READ_SCOPE.all })
  const candidates = metas.filter((m) => m.id != null && m.class === PROFILE_NOTE_CLASS)
  return candidates.find((m) => slugify(m.title) === PROFILE_NOTE_SLUG) ?? candidates[0]
}

/** Read the curated profile note. null = never saved (the route returns an empty form, not a 404). */
export const readProfileNote = async (
  store: KnowledgeStore,
): Promise<{ noteId: string; content: string; versionToken: string | null } | null> => {
  const meta = await findProfileNote(store)

  if (!meta?.id) {
    return null
  }
  const note = await store.read(meta.id)
  return {
    noteId: note.id ?? meta.id,
    content: note.content,
    versionToken: note.versionToken ?? null,
  }
}

/** Upsert the profile note: create on first save, else edit via CAS. A caller
 *  `versionToken` is ENFORCED (stale → the store's conflict propagates); absent,
 *  we own the token and retry a lost race (last-writer-wins beats failing the save).
 *  canon: docs/contract.md#cas */
export const writeProfileNote = async (
  store: KnowledgeStore,
  input: { content: string; versionToken?: string; principal?: string },
): Promise<Pick<Profile, 'noteId' | 'versionToken'>> => {
  for (let attempt = 0; ; attempt++) {
    const existing = await findProfileNote(store)

    if (!existing?.id) {
      try {
        const res = await store.write({
          title: PROFILE_NOTE_TITLE,
          content: input.content,
          tags: [ALWAYS_LOAD_TAG],
          noteType: PROFILE_NOTE_TYPE,
          // targetClass is ENFORCED by the engine but ignored on edits (an edit
          // keeps the note in its mount), so we set the hidden profile mount
          // only here on first save.
          targetClass: PROFILE_NOTE_CLASS,
          principal: input.principal,
        })
        return { noteId: res.id ?? null, versionToken: res.versionToken ?? null }
      } catch (err) {
        // Lost the create race (a concurrent first-save) → re-find and edit
        // instead of failing.
        if (
          (err as { reason?: string }).reason === STORE_ERROR_REASON.noteAlreadyExists &&
          attempt < 2
        ) {
          continue
        }
        throw err
      }
    }
    const note = await store.read(existing.id)
    const id = note.id ?? existing.id
    const token = input.versionToken ?? note.versionToken ?? ''

    try {
      const res = await store.write({
        title: note.title ?? PROFILE_NOTE_TITLE,
        content: input.content,
        originalId: id,
        versionToken: token,
        tags: [ALWAYS_LOAD_TAG],
        noteType: PROFILE_NOTE_TYPE,
        principal: input.principal,
      })
      return { noteId: res.id ?? id, versionToken: res.versionToken ?? null }
    } catch (err) {
      // No caller token → we own it, retry onto the newer body. A caller's stale
      // token is THEIRS to see — propagate the conflict.
      if (!input.versionToken && (err as { isConflict?: boolean }).isConflict && attempt < 2) {
        continue
      }
      throw err
    }
  }
}
